// ─────────────────────────────────────────────────────────────────────────────
// pipeline/sources/naver.js — 네이버 증권 JSON API (기본 소스)
//
// 한 번의 호출로 여러 지표를 받는 배치 엔드포인트를 우선 사용한다.
//  · polling        국내/해외 지수·종목 시세를 콤마로 묶어 1회 호출
//  · majors         환율·금리·원자재·기준금리 약 50개를 1회 호출
//  · integration    수급(당일 잠정)·프로그램·전 종목 등락수·52주 고저를 1회 호출
//  · chart          일/주/분봉 — 기간 전체(5년)를 1회 호출
//  · trend/daily    투자자별 일별 순매수 200일/호출 (예전 HTML 은 10일/페이지)
//
// 비공식 엔드포인트이므로 모든 파싱은 필드가 없어도 null 로 넘어가게 작성한다.
// 함수는 실패 시 throw 하고, 재시도·브레이커·마지막 정상값은 http.js / cache.js 가 맡는다.
// ─────────────────────────────────────────────────────────────────────────────

const POLLING = 'https://polling.finance.naver.com/api/realtime';
const MOBILE = 'https://m.stock.naver.com';
const CHART = 'https://api.stock.naver.com/chart';
const STOCK = 'https://stock.naver.com';
const AUTOCOMPLETE = 'https://ac.stock.naver.com/ac';
const STOCK_HEADERS = { Referer: 'https://stock.naver.com/' };

// stock.naver.com 투자자 구분 코드
const INVESTOR = {
  individual: ['8000'],
  foreign: ['9000', '9001'],                                       // 외국인 + 기타외국인 (HTS 와 동일)
  institution: ['1000', '2000', '3000', '3100', '4000', '5000', '6000'], // 기관계 = 금융투자~연기금
  pension: ['6000'],
};

const MARKETINDEX_PAGE_SIZE = 60;   // 이 API 가 허용하는 최대값
const FLOWS_PAGE_SIZE = 200;        // trend/daily 최대값
const DEPOSIT_PAGE_SIZE = 100;

// '1,334.20', '+6,217', '-', 'N/A' 같은 문자열 → 숫자
function num(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim().replace(/,/g, '').replace(/^\+/, '');
  if (s === '' || s === '-' || s === 'N/A') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// 등락 방향 코드로 부호 보정 (일부 응답은 절대값만 준다)
function signed(value, direction) {
  if (value == null) return null;
  const name = direction && direction.name;
  if (name === 'FALLING' || name === 'LOWER_LIMIT') return -Math.abs(value);
  if (name === 'RISING' || name === 'UPPER_LIMIT') return Math.abs(value);
  return value;
}

// '20261030' 또는 '2026-10-30T...' → '2026-10-30'
function ymd(value) {
  const s = String(value || '');
  if (/^\d{8}/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.slice(0, 10);
}

function first(item, ...keys) {
  for (const k of keys) if (item[k] != null && item[k] !== '') return item[k];
  return null;
}

const scaled = (value, unit, digits = 1) => {
  const v = num(value);
  return v == null ? null : +(v / unit).toFixed(digits);
};

// ── 1. polling (국내/해외 지수 · 종목) ───────────────────────────────────────
function pollingQuote(item) {
  const direction = item.compareToPreviousPrice;
  const exchange = item.stockExchangeType || {};
  return {
    code: first(item, 'itemCode', 'reutersCode'),
    name: first(item, 'stockName', 'indexName'),
    price: num(first(item, 'closePriceRaw', 'closePrice')),
    change: signed(num(first(item, 'compareToPreviousClosePriceRaw', 'compareToPreviousClosePrice')), direction),
    change_percent: signed(num(first(item, 'fluctuationsRatioRaw', 'fluctuationsRatio')), direction),
    open: num(first(item, 'openPriceRaw', 'openPrice')),
    high: num(first(item, 'highPriceRaw', 'highPrice')),
    low: num(first(item, 'lowPriceRaw', 'lowPrice')),
    market_status: item.marketStatus || null,
    as_of: item.localTradedAt || null,
    delayed: Number(exchange.delayTime) || 0,
    market_cap: scaled(item.marketValueFullRaw, 1e8),            // 억원
    trading_value: scaled(item.accumulatedTradingValueRaw, 1e6), // 백만원
  };
}

async function polling(http, path, codes) {
  if (!codes.length) return {};
  const data = await http.getJson(`${POLLING}/${path}/${codes.join(',')}`);
  const out = {};
  for (const item of data.datas || []) {
    const q = pollingQuote(item);
    if (q.code) out[q.code] = q;
  }
  return out;
}

const domesticIndices = (http, codes) => polling(http, 'domestic/index', codes);
const worldIndices = (http, codes) => polling(http, 'worldstock/index', codes);
const stockQuotes = (http, codes) => polling(http, 'domestic/stock', codes);

// ── 2. 시장지표 일괄 (환율·금리·원자재·기준금리·운임) ────────────────────────
// reutersCode 기준 { FX_USDKRW: {...}, 'US10YT=RR': {...}, ... }
async function majors(http) {
  const data = await http.getJson(`${MOBILE}/front-api/marketIndex/majors`);
  const out = {};
  for (const [category, items] of Object.entries(data.result || {})) {
    for (const item of items || []) {
      const code = item.reutersCode;
      if (!code || out[code]) continue;
      const direction = item.fluctuationsType;
      out[code] = {
        code,
        name: item.name,
        category: item.categoryType || category,
        price: num(item.closePrice),
        change: signed(num(item.fluctuations), direction),
        change_percent: signed(num(item.fluctuationsRatio), direction),
        market_status: item.marketStatus || null,
        as_of: item.localTradedAt || null,
        delayed: Number(item.delayTime) || 0,
      };
    }
  }
  return out;
}

function marketindexRow(row) {
  const direction = row.fluctuationsType;
  return {
    date: ymd(row.localTradedAt),
    close: num(row.closePrice),
    change: signed(num(row.fluctuations), direction),
    change_percent: signed(num(row.fluctuationsRatio), direction),
    as_of: row.localTradedAt || null,
  };
}

async function marketindexPage(http, category, code, page, pageSize = MARKETINDEX_PAGE_SIZE) {
  const data = await http.getJson(`${MOBILE}/front-api/marketIndex/prices`, {
    params: { category, reutersCode: code, page, pageSize },
  });
  return (data.result || []).map(marketindexRow).filter(r => r.close != null && r.date);
}

// majors 에 없는 국채 만기물 등: 최신 1행을 시세로 사용
async function marketindexLatest(http, category, code) {
  const rows = await marketindexPage(http, category, code, 1, 10);
  if (!rows.length) throw new Error(`${code}: 빈 응답`);
  const r = rows[0];
  return { code, price: r.close, change: r.change, change_percent: r.change_percent, as_of: r.as_of, market_status: null, delayed: 0 };
}

// 은행 고시 환율 (매매기준율 · 현찰 살 때/팔 때 · 송금 보낼 때/받을 때)
async function fxBankRates(http, code = 'FX_USDKRW') {
  const data = await http.getJson(`${MOBILE}/front-api/marketIndex/prices`, {
    params: { category: 'exchange', reutersCode: code, page: 1, pageSize: 10 },
  });
  const row = (data.result || [])[0];
  if (!row || num(row.closePrice) == null) throw new Error(`${code}: 고시 환율 없음`);
  return {
    date: ymd(row.localTradedAt),
    base: num(row.closePrice),
    cash_buy: num(row.cashBuyValue),
    cash_sell: num(row.cashSellValue),
    send: num(row.sendValue),
    receive: num(row.receiveValue),
  };
}

// 일별 종가 (오래된 → 최신). 페이지당 60일, 페이지들은 동시에 요청
async function marketindexHistory(http, category, code, pages) {
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) => marketindexPage(http, category, code, i + 1)));
  const byDate = new Map();
  for (const rows of results) for (const r of rows) if (!byDate.has(r.date)) byDate.set(r.date, r.close);
  return [...byDate.keys()].sort().map(date => ({ date, close: byDate.get(date) }));
}

// ── 3. 지수 종합 (수급 잠정·프로그램·등락 종목수·52주 고저) ────────────────────
async function indexIntegration(http, code) {
  const data = await http.getJson(`${MOBILE}/api/index/${code}/integration`);
  const infos = Object.fromEntries((data.totalInfos || []).map(x => [x.code, x.value]));
  const deal = data.dealTrendInfo || {};
  const program = data.programTrendInfo || {};
  const updown = data.upDownStockInfo || null;
  const count = key => Math.round(num(updown && updown[key]) || 0);
  return {
    prev_close: num(infos.lastClosePrice),
    high_52w: num(infos.highPriceOf52Weeks),
    low_52w: num(infos.lowPriceOf52Weeks),
    trading_value: num(String(infos.accumulatedTradingValue || '').replace(/[^\d.,-]/g, '')), // 백만원
    flows: deal.bizdate ? {
      date: ymd(deal.bizdate),
      individual: num(deal.personalValue),
      foreign: num(deal.foreignValue),
      institution: num(deal.institutionalValue),
    } : null,
    program: program.bizdate || program.indexTotalReal != null ? {
      date: program.bizdate ? ymd(program.bizdate) : null,
      arbitrage: num(program.indexDifferenceReal),
      non_arbitrage: num(program.indexBiDifferenceReal),
      total: num(program.indexTotalReal),
    } : null,
    breadth: updown ? {
      upper: count('upperCount'), rising: count('riseCount'), unchanged: count('steadyCount'),
      falling: count('fallCount'), lower: count('lowerCount'),
    } : null,
  };
}

// ── 4. 종목 순위 (시총·거래대금) · 52주 신고가/신저가 수 ───────────────────────
function rankedStock(s, market) {
  const direction = s.compareToPreviousPrice;
  return {
    code: s.itemCode,
    name: s.stockName,
    market,
    type: s.stockEndType || 'stock',
    price: num(s.closePrice),
    change: signed(num(s.compareToPreviousClosePrice), direction),
    change_percent: signed(num(s.fluctuationsRatio), direction),
    market_cap: num(s.marketValue),               // 억원
    trading_value: num(s.accumulatedTradingValue), // 백만원
    as_of: s.localTradedAt || null,
    market_status: s.marketStatus || null,
  };
}

async function ranking(http, sort, market, pageSize) {
  const data = await http.getJson(`${MOBILE}/api/stocks/${sort}/${market}`, { params: { page: 1, pageSize } });
  return { total: Number(data.totalCount) || 0, stocks: (data.stocks || []).map(s => rankedStock(s, market)) };
}

const topMarketCap = async (http, market, limit) => (await ranking(http, 'marketValue', market, limit)).stocks;

// 거래대금 상위 (ETF·ETN 제외한 개별 종목)
async function topTradingValue(http, market, limit) {
  const { stocks } = await ranking(http, 'priceTop', market, Math.min(60, limit * 3));
  return stocks.filter(s => s.type === 'stock').slice(0, limit);
}

// 52주 신고가/신저가 종목 수 (totalCount 만 쓰므로 1건만 받는다)
async function highLowCounts(http, market) {
  const [high, low] = await Promise.all([
    ranking(http, 'high52week', market, 1),
    ranking(http, 'low52week', market, 1),
  ]);
  return { highs: high.total, lows: low.total };
}

// ── 5. 업종·테마 등락 ─────────────────────────────────────────────────────────
function group(g) {
  return {
    no: g.no, name: g.name, change: num(g.changeRate),
    rising: Number(g.riseCount) || 0, falling: Number(g.fallCount) || 0,
    unchanged: Number(g.steadyCount) || 0, total: Number(g.totalCount) || 0,
  };
}

async function industries(http) {
  const data = await http.getJson(`${MOBILE}/api/stocks/industry`, { params: { page: 1, pageSize: 100 } });
  return (data.groups || []).map(group).filter(g => g.change != null);
}

async function themes(http, limit = 15) {
  const data = await http.getJson(`${MOBILE}/api/stocks/theme`, { params: { page: 1, pageSize: limit } });
  return (data.groups || []).map(group).filter(g => g.change != null);
}

// 종목의 네이버 업종 코드 (트리맵 업종 그룹핑용, 결과는 오래 캐시)
async function stockIndustry(http, code) {
  const data = await http.getJson(`${MOBILE}/api/stock/${code}/integration`);
  return data.industryCode != null ? Number(data.industryCode) : null;
}

async function searchStocks(http, query) {
  const data = await http.getJson(AUTOCOMPLETE, { params: { q: query, target: 'stock' } });
  return (data.items || [])
    .filter(it => it.nationCode === 'KOR' && it.category === 'stock' && it.code)
    .map(it => ({ code: it.code, name: it.name, market: it.typeCode || null }));
}

// ── 6. 차트 (일/주봉 · 분봉) ──────────────────────────────────────────────────
const dt = (d, hhmm) => `${d.replace(/-/g, '')}${hhmm}`;

// kind: domestic/index | foreign/index | domestic/item · start/end: 'YYYY-MM-DD'
async function chartHistory(http, kind, code, start, end, timeframe = 'day') {
  const data = await http.getJson(`${CHART}/${kind}/${encodeURIComponent(code)}/${timeframe}`, {
    params: { startDateTime: dt(start, '0000'), endDateTime: dt(end, '2359') },
  });
  const rows = [];
  for (const p of Array.isArray(data) ? data : []) {
    const close = num(p.closePrice);
    if (close == null || !p.localDate) continue;
    // 일부 지수는 시가가 0으로 내려온다
    rows.push({
      date: ymd(p.localDate),
      open: num(p.openPrice) || close,
      high: num(p.highPrice) || close,
      low: num(p.lowPrice) || close,
      close,
      volume: num(p.accumulatedTradingVolume),
    });
  }
  return rows;
}

// 국내 지수 1분봉 — 범위 안의 마지막 거래일만 [{t:'0901', v:5769.46}, ...]
async function intradayMinutes(http, code, start, end) {
  const data = await http.getJson(`${CHART}/domestic/index/${code}/minute`, {
    params: { startDateTime: dt(start, '0000'), endDateTime: dt(end, '2359') },
  });
  const rows = Array.isArray(data) ? data : [];
  const lastDay = rows.reduce((d, p) => (p.localDateTime && p.localDateTime.slice(0, 8) > d ? p.localDateTime.slice(0, 8) : d), '');
  if (!lastDay) return null;
  const points = rows
    .filter(p => p.localDateTime && p.localDateTime.startsWith(lastDay) && num(p.currentPrice) != null)
    .map(p => ({ t: p.localDateTime.slice(8, 12), v: num(p.currentPrice) }));
  return { date: ymd(lastDay), points };
}

// ── 7. 투자자별 일별 순매수 · 고객예탁금/신용잔고 ─────────────────────────────
const eok = v => (v == null ? null : +(v / 1e8).toFixed(1)); // 원 → 억원

function flowRow(row) {
  const amounts = {};
  for (const a of row.netAmounts || []) amounts[a.investorGubun] = num(a.diffValue);
  const sum = codes => {
    const parts = codes.map(c => amounts[c]).filter(v => v != null);
    return parts.length ? eok(parts.reduce((s, v) => s + v, 0)) : null;
  };
  return {
    date: ymd(row.bizdate),
    individual: sum(INVESTOR.individual),
    foreign: sum(INVESTOR.foreign),
    institution: sum(INVESTOR.institution),
    pension: sum(INVESTOR.pension),
  };
}

// startIdx 는 오프셋이 아니라 0부터 시작하는 페이지 번호. 페이지들은 동시에 요청
async function investorFlows(http, market, pages = 1, pageSize = FLOWS_PAGE_SIZE) {
  const results = await Promise.all(Array.from({ length: pages }, (_, n) =>
    http.getJson(`${STOCK}/api/domestic/market/trend/daily`, {
      params: { tradeType: 'KRX', marketType: market, startIdx: n, pageSize },
      headers: STOCK_HEADERS,
    })));
  const byDate = new Map();
  for (const data of results) {
    for (const row of data.content || []) if (row.bizdate) byDate.set(ymd(row.bizdate), flowRow(row));
  }
  return [...byDate.keys()].sort().map(d => byDate.get(d));
}

async function depositTrend(http, pages = 1, pageSize = DEPOSIT_PAGE_SIZE) {
  const results = await Promise.all(Array.from({ length: pages }, (_, n) =>
    http.getJson(`${STOCK}/api/domestic/market/trendDeposit`, {
      params: { startIdx: n, pageSize },
      headers: STOCK_HEADERS,
    })));
  const byDate = new Map();
  for (const data of results) {
    for (const row of data.content || []) {
      const deposit = num(row.customerDeposit), credit = num(row.creditLoan);
      if (row.bizdate && deposit != null && credit != null) {
        const d = ymd(row.bizdate);
        byDate.set(d, { date: d, customer_deposit: deposit, credit_loan: credit }); // 억원
      }
    }
  }
  return [...byDate.keys()].sort().map(d => byDate.get(d));
}

module.exports = {
  num, signed, ymd, pollingQuote, marketindexRow, flowRow,
  domesticIndices, worldIndices, stockQuotes, majors, marketindexLatest, marketindexHistory, fxBankRates,
  indexIntegration, topMarketCap, topTradingValue, highLowCounts, industries, themes, stockIndustry,
  searchStocks, chartHistory, intradayMinutes, investorFlows, depositTrend,
  MARKETINDEX_PAGE_SIZE, FLOWS_PAGE_SIZE, DEPOSIT_PAGE_SIZE,
};
