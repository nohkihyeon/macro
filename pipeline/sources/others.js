// ─────────────────────────────────────────────────────────────────────────────
// pipeline/sources/others.js — 보조 소스
//
//  · TradingView 스캐너: V-KOSPI 선물(KRX:VKI1!) 현재가 — 네이버·야후 미보유 (20분 지연)
//  · KRX OpenAPI (선택): VKOSPI 지수 일별 — KRX_API_KEY 가 있을 때만
//  · Yahoo Finance: 네이버 히스토리가 실패했을 때만 쓰는 대체 소스 (자주 429 를 준다)
// ─────────────────────────────────────────────────────────────────────────────
const { num } = require('./naver');
const { isKrxTradingDay, addDays } = require('../market-hours');

// ── TradingView 스캐너 단일 심볼 ──────────────────────────────────────────────
async function tvQuote(http, symbol) {
  const data = await http.getJson('https://scanner.tradingview.com/symbol', {
    params: { symbol, fields: 'close,change,change_abs,description,update_mode' },
    headers: { Referer: 'https://www.tradingview.com/' },
  });
  if (!data || data.close == null) throw new Error(`${symbol}: 시세 없음`);
  return {
    price: data.close,
    change: data.change_abs ?? null,
    change_percent: data.change ?? null,
    delayed: /delayed_streaming_(\d+)/.test(data.update_mode || '') ? Number(RegExp.$1) / 60 : 0,
  };
}

// ── KRX OpenAPI — VKOSPI (파생상품지수 시세정보 이용 신청 필요) ────────────────
// 일별 데이터라 당일 값이 없으면 직전 영업일로 거슬러 올라간다.
async function krxVkospi(http, apiKey, today) {
  let day = today;
  for (let i = 0; i < 10; i++, day = addDays(day, -1)) {
    if (!isKrxTradingDay(day)) continue;
    const data = await http.getJson('https://data-dbg.krx.co.kr/svc/apis/idx/drvprod_dd_trd', {
      params: { basDd: day.replace(/-/g, '') },
      headers: { AUTH_KEY: apiKey },
    });
    for (const row of data.OutBlock_1 || []) {
      const name = row.IDX_NM || '';
      if (name.includes('변동성') && name.includes('200')) {
        return {
          name, price: num(row.CLSPRC_IDX), change: num(row.CMPPREVDD_IDX),
          change_percent: num(row.FLUC_RT), date: day,
        };
      }
    }
  }
  return null;
}

// ── Yahoo Finance 일봉 (대체 소스) ────────────────────────────────────────────
async function yahooDaily(http, ticker, start, mult = 1) {
  const period1 = Math.floor(new Date(`${start}T00:00:00Z`).getTime() / 1000);
  const data = await http.getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`, {
    params: { period1, period2: Math.floor(Date.now() / 1000), interval: '1d' },
    headers: { Referer: 'https://finance.yahoo.com/' },
  });
  const r = data && data.chart && data.chart.result && data.chart.result[0];
  if (!r) throw new Error(`${ticker}: 빈 응답`);
  const q = (r.indicators.quote || [])[0] || {};
  const offset = (r.meta && r.meta.gmtoffset) || 0;  // 거래소 현지 날짜로 맞춘다
  const rows = [];
  (r.timestamp || []).forEach((ts, i) => {
    const close = q.close && q.close[i];
    if (close == null) return;
    const v = x => (x == null ? close * mult : x * mult);
    rows.push({
      date: new Date((ts + offset) * 1000).toISOString().slice(0, 10),
      open: v(q.open && q.open[i]), high: v(q.high && q.high[i]), low: v(q.low && q.low[i]),
      close: close * mult, volume: (q.volume && q.volume[i]) ?? null,
    });
  });
  return rows;
}

module.exports = { tvQuote, krxVkospi, yahooDaily };
