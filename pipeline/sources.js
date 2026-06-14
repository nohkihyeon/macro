// ─────────────────────────────────────────────────────────────────────────────
// pipeline/sources.js — 외부 데이터 소스 저수준 페처 (Yahoo Finance / 네이버 금융)
//
// server.js 와 pipeline/check.js 가 공유하는 단일 데이터 수집 계층.
// 모든 함수는 { ok, ... , error? } 형태로 결과를 돌려주며 throw 하지 않는다
// (호출부에서 소스별 상태를 한눈에 점검할 수 있도록).
// ─────────────────────────────────────────────────────────────────────────────
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const TIMEOUT = 9000;

// ── 1. Yahoo Finance 차트 (단일 티커 시계열) ──────────────────────────────────
// 반환: { ok, values:[close...], dates:[YYYY-MM-DD...], raw }
async function yahooChart(ticker, range = '1y', interval = '1d') {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`;
    const { data } = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: TIMEOUT });
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result) return { ok: false, error: 'empty chart result' };
    const closes = result.indicators.quote[0].close || [];
    const ts = result.timestamp || [];
    const values = [], dates = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] != null) {
        values.push(closes[i]);
        dates.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
      }
    }
    if (!values.length) return { ok: false, error: 'no valid closes' };
    return { ok: true, values, dates, raw: data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 2. Yahoo Spark (다중 티커 5일 수익률, 배치) ───────────────────────────────
// symbols: ['005930.KS', ...] → { ok, changes: { '005930': pct, ... } }
async function yahooSparkWeekly(symbols) {
  const changes = {};
  try {
    for (let i = 0; i < symbols.length; i += 10) {
      const batch = symbols.slice(i, i + 10).join(',');
      const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${batch}&range=5d&interval=1d`;
      try {
        const { data } = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: TIMEOUT });
        const results = data && data.spark && data.spark.result;
        if (!results) continue;
        results.forEach(r => {
          const code = r.symbol.split('.')[0];
          const q = r.response && r.response[0] && r.response[0].indicators &&
            r.response[0].indicators.quote && r.response[0].indicators.quote[0].close;
          if (q && q.length > 1) {
            const first = q[0], last = q[q.length - 1];
            if (first > 0) changes[code] = ((last - first) / first) * 100;
          }
        });
      } catch (_) { /* 배치 단위 실패는 무시하고 계속 */ }
    }
    return { ok: true, changes };
  } catch (e) {
    return { ok: false, error: e.message, changes };
  }
}

// ── 3. 네이버 금융 시가총액 상위 종목 (트리맵용) ───────────────────────────────
// market: 'kospi' | 'kosdaq' → { ok, stocks: [{code,name,dailyChange,marketCapCho}] }
async function naverMarketCap(market = 'kospi') {
  const sosok = market === 'kosdaq' ? '1' : '0';
  try {
    const url = `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=1`;
    const { data } = await axios.get(url, { responseType: 'arraybuffer', headers: { 'User-Agent': UA }, timeout: TIMEOUT });
    const $ = cheerio.load(iconv.decode(data, 'EUC-KR'));
    const stocks = [];
    $('table.type_2 tbody tr').each((i, el) => {
      const a = $(el).find('a.tltle');
      if (!a.length) return;
      const name = a.text().trim();
      const href = a.attr('href') || '';
      const code = (href.split('code=')[1] || '').trim();
      const tds = $(el).find('td.number');
      if (!tds.length || !code) return;
      const changeRate = parseFloat($(tds[2]).text().trim().replace(/[\n\t%]/g, '')) || 0;
      const cap = parseFloat($(tds[4]).text().trim().replace(/,/g, '')) || 0;
      stocks.push({ code, name, dailyChange: changeRate, marketCapCho: cap / 10000 });
    });
    if (!stocks.length) return { ok: false, error: 'no rows parsed (구조 변경 가능)' };
    return { ok: true, stocks };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 4. 네이버 투자자별 매매동향 (일자별 순매수) ────────────────────────────────
// 컬럼: 날짜 | 개인 | 외국인 | 기관계 | 금융투자 | 보험 | 투신(사모) | 은행 | 기타금융 | 연기금등 | 기타법인
// 2026.06 개편: 셀에 클래스(td.date/td.number)가 없고, bizdate 가 비면 빈 표가 내려온다.
//   → 기준일(bizdate=오늘)을 항상 명시하고, 첫 셀이 YY.MM.DD 인 행을 데이터로 파싱한다.
// 페이지당 10영업일. → { ok, rows: [{date:'YY.MM.DD', individual, foreigner, institution, pension}], empty? } (과거→현재)
function todayBizdate() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function parseInvestorRows(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('table tr').each((i, el) => {
    const cells = [];
    $(el).find('td').each((j, c) => cells.push($(c).text().trim()));
    if (!cells.length || !/^\d{2}\.\d{2}\.\d{2}$/.test(cells[0])) return;
    const nums = cells.slice(1).map(s => parseInt(s.replace(/,/g, ''), 10));
    if (nums.length >= 9 && nums.slice(0, 9).every(n => !isNaN(n))) {
      out.push({ date: cells[0], individual: nums[0], foreigner: nums[1], institution: nums[2], pension: nums[8] });
    }
  });
  return out;
}
// 단일 페이지 (페이지 내 순서: 최신→과거)
async function naverInvestorPage(page = 1, bizdate) {
  try {
    const biz = bizdate || todayBizdate();
    const url = `https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=${biz}&sosok=&page=${page}`;
    const { data } = await axios.get(url, { responseType: 'arraybuffer', headers: { 'User-Agent': UA }, timeout: TIMEOUT });
    return { ok: true, rows: parseInvestorRows(iconv.decode(data, 'EUC-KR')) };
  } catch (e) {
    return { ok: false, error: e.message, rows: [] };
  }
}
async function naverInvestors(pages = 2) {
  try {
    const biz = todayBizdate();
    const byDate = new Map();
    let netErr = null;
    for (let base = 1; base <= pages; base += 6) {
      const group = [];
      for (let p = base; p < base + 6 && p <= pages; p++) group.push(p);
      const results = await Promise.all(group.map(p => naverInvestorPage(p, biz)));
      results.forEach(r => { if (r.ok) r.rows.forEach(row => byDate.set(row.date, row)); else netErr = r.error; });
    }
    // YY.MM.DD 사전순 = 시간순 (과거→현재)
    const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) return netErr ? { ok: false, error: netErr } : { ok: true, rows: [], empty: true };
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 4b. 네이버 marketindex 국내금리 일별 (콜금리·국고채·CD·회사채) ────────────
// code: IRR_CALL | IRR_GOVT03Y | IRR_CD91 | IRR_CORP03Y …  (페이지당 약 7영업일)
// → { ok, values:[...], dates:['YYYY-MM-DD'...] }  (오래된 것이 앞)
async function naverRate(code, pages = 16) {
  try {
    const seen = new Set();
    const rows = [];
    // 6개씩 병렬로 페이지 수집
    for (let base = 1; base <= pages; base += 6) {
      const group = [];
      for (let p = base; p < base + 6 && p <= pages; p++) group.push(p);
      const htmls = await Promise.all(group.map(p =>
        axios.get(`https://finance.naver.com/marketindex/interestDailyQuote.naver?marketindexCd=${code}&page=${p}`,
          { responseType: 'arraybuffer', headers: { 'User-Agent': UA }, timeout: TIMEOUT })
          .then(r => iconv.decode(r.data, 'EUC-KR')).catch(() => null)));
      htmls.forEach(html => {
        if (!html) return;
        const $ = cheerio.load(html);
        $('table tr').each((i, el) => {
          const tds = $(el).find('td');
          if (tds.length < 2) return;
          const d = $(tds[0]).text().trim();
          const v = parseFloat($(tds[1]).text().trim());
          if (/^\d{4}\./.test(d) && !isNaN(v) && !seen.has(d)) {
            seen.add(d);
            rows.push([d.replace(/\./g, '-'), v]); // YYYY.MM.DD → YYYY-MM-DD
          }
        });
      });
    }
    if (!rows.length) return { ok: false, error: 'no rate rows (코드 확인)' };
    rows.sort((a, b) => a[0].localeCompare(b[0])); // 과거→현재
    return { ok: true, dates: rows.map(r => r[0]), values: rows.map(r => r[1]) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 4c. TradingView 스캐너 단일 심볼 시세 ─────────────────────────────────────
// V-KOSPI 선물(KRX:VKI1!) 등 야후/네이버 미보유 심볼의 현재가용 (20분 지연 스트리밍).
// → { ok, quote: { close, change(%), changeAbs, ... } }
async function tvScannerQuote(symbol, fields = 'close,change,change_abs,description') {
  try {
    const url = `https://scanner.tradingview.com/symbol?symbol=${encodeURIComponent(symbol)}&fields=${encodeURIComponent(fields)}`;
    const { data } = await axios.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, timeout: TIMEOUT });
    if (!data || data.close == null) return { ok: false, error: 'no close in scanner response' };
    return { ok: true, quote: { close: data.close, change: data.change, changeAbs: data.change_abs, raw: data } };
  } catch (e) {
    return { ok: false, error: e.response ? `HTTP ${e.response.status}` : e.message };
  }
}

// ── 5. 시장 폭(Breadth) — 상승/하락/보합 종목 수 ──────────────────────────────
// 시총 상위 종목 스크래핑 결과를 등락 부호로 집계 (별도 호출 없이 stocks 재활용)
function computeBreadth(stocks) {
  let up = 0, down = 0, flat = 0;
  stocks.forEach(s => {
    if (s.dailyChange > 0) up++;
    else if (s.dailyChange < 0) down++;
    else flat++;
  });
  return { up, down, flat, total: stocks.length };
}

module.exports = { yahooChart, yahooSparkWeekly, naverMarketCap, naverRate, naverInvestors, naverInvestorPage, tvScannerQuote, computeBreadth, UA };
