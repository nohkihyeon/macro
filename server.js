// ─────────────────────────────────────────────────────────────────────────────
// server.js — 시그널보드 백엔드 (Express)
//   · Yahoo Finance / 네이버 금융 데이터를 pipeline/* 계층으로 수집해 JSON 제공
//   · 라이브 소스가 없거나 실패하면 프론트가 합성 샘플로 대체 (source 플래그로 구분)
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const path = require('path');
const fs = require('fs');
const S = require('./pipeline/sources');
const C = require('./pipeline/catalog');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// 기간 키 → Yahoo range
const RANGE_MAP = { '1w': '5d', '1m': '1mo', '1y': '1y', '5y': '5y' };
// 기간 키 → 네이버 금리 페이지 수 (페이지당 ~7영업일)
const RATE_PAGES = { '1w': 2, '1m': 5, '1y': 38, '5y': 40 };

// 네이버 금리 캐시 (코드별, 1시간 — 금리는 일 1회 갱신)
const rateCache = {};
async function getRate(code, pages) {
  const k = `${code}`;
  const c = rateCache[k];
  if (c && c.pages >= pages && Date.now() - c.at < 60 * 60 * 1000) return c.data;
  const data = await S.naverRate(code, pages);
  if (data.ok) rateCache[k] = { at: Date.now(), pages, data };
  return data;
}

// 투자자 매매동향 캐시 (네이버 호출 최소화, 5분)
let investorCache = { at: 0, data: null };
async function getInvestors() {
  if (investorCache.data && Date.now() - investorCache.at < 5 * 60 * 1000) return investorCache.data;
  const r = await S.naverInvestors(3);
  investorCache = { at: Date.now(), data: r };
  return r;
}

// 공포·탐욕 지수(0~100, 높을수록 탐욕) — breadth + KOSPI 모멘텀 + VIX 합성
let fgCache = { at: 0, val: null };
async function computeFearGreed() {
  if (fgCache.val != null && Date.now() - fgCache.at < 5 * 60 * 1000) return fgCache.val;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  let breadthN = 0.5, momN = 0.5, volN = 0.5;
  try {
    const mc = await S.naverMarketCap('kospi');
    if (mc.ok) { const b = S.computeBreadth(mc.stocks); if (b.up + b.down) breadthN = b.up / (b.up + b.down); }
  } catch (_) {}
  try {
    const k = await S.yahooChart('^KS11', '1mo', '1d');
    if (k.ok && k.values.length > 1) {
      const pct = (k.values[k.values.length - 1] - k.values[0]) / k.values[0] * 100;
      momN = clamp((pct + 8) / 16, 0, 1);            // -8%..+8% → 0..1
    }
  } catch (_) {}
  try {
    const v = await S.yahooChart('^VIX', '5d', '1d');
    if (v.ok) { const vix = v.values[v.values.length - 1]; volN = clamp((38 - vix) / 28, 0, 1); } // 10..38 → 1..0
  } catch (_) {}
  const val = Math.round(clamp(100 * (0.4 * breadthN + 0.35 * momN + 0.25 * volN), 1, 99));
  fgCache = { at: Date.now(), val };
  return val;
}

// KOSPI 실현변동성: 로그수익률 rolling 표준편차 → 연율화 % (VKOSPI 라인 대용 시계열)
function realizedVol(closes, dates, win = 21) {
  const lr = [];
  for (let i = 1; i < closes.length; i++) lr.push(Math.log(closes[i] / closes[i - 1]));
  const values = [], outDates = [];
  for (let i = win - 1; i < lr.length; i++) {
    const w = lr.slice(i - win + 1, i + 1);
    const m = w.reduce((a, b) => a + b, 0) / win;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) * (b - m), 0) / (win - 1));
    values.push(+(sd * Math.sqrt(252) * 100).toFixed(2));
    outDates.push(dates[i + 1]);                 // 윈도 마지막 수익률의 종가 날짜
  }
  return { values, dates: outDates };
}

// V-KOSPI 선물 현재가 (TradingView 스캐너, 5분 캐시 — 실패 시 null)
let vkiCache = { at: 0, q: null };
async function getVkiQuote(symbol) {
  if (vkiCache.q && Date.now() - vkiCache.at < 5 * 60 * 1000) return vkiCache.q;
  const r = await S.tvScannerQuote(symbol);
  if (r.ok) { vkiCache = { at: Date.now(), q: r.quote }; return r.quote; }
  return vkiCache.q;                              // 만료된 직전 값이라도 재사용 (없으면 null)
}

// ── 1. 단일 시계열 ────────────────────────────────────────────────────────────
// GET /api/series/:id?range=1y  → { source:'live'|'unavailable', kind, values, dates, quote }
app.get('/api/series/:id', async (req, res) => {
  const { id } = req.params;
  const range = req.query.range || '1y';
  const cfg = C.SERIES_SOURCES[id];
  if (!cfg) return res.status(404).json({ source: 'unavailable', error: 'unknown indicator' });

  try {
    if (cfg.src === 'yahoo') {
      const r = await S.yahooChart(cfg.ticker, RANGE_MAP[range] || '1y', '1d');
      if (!r.ok) return res.json({ source: 'unavailable', error: r.error });
      let values = r.values;
      if (cfg.mult) values = values.map(v => v * cfg.mult);
      const last = values[values.length - 1], prev = values[values.length - 2] ?? last;
      return res.json({
        source: 'live', kind: 'line', values, dates: r.dates,
        quote: { value: last, diff: last - prev, pct: prev ? ((last - prev) / prev) * 100 : 0 },
      });
    }

    if (cfg.src === 'naver-rate') {
      const r = await getRate(cfg.code, RATE_PAGES[range] || 16);
      if (!r.ok || !r.values.length) return res.json({ source: 'unavailable', error: r.error });
      const last = r.values[r.values.length - 1], prev = r.values[r.values.length - 2] ?? last;
      return res.json({ source: 'live', kind: 'line', values: r.values, dates: r.dates,
        quote: { value: last, diff: last - prev, pct: prev ? ((last - prev) / prev) * 100 : 0 } });
    }

    if (cfg.src === 'feargreed') {
      const val = await computeFearGreed();
      return res.json({ source: 'live', kind: 'gauge', value: val });
    }

    if (cfg.src === 'kvol') {
      // 라인: KOSPI 실현변동성(rolling 21D, 연율화 %) — 기간별 버퍼를 두고 일봉 수집 후 계산
      const fetchRange = { '1w': '3mo', '1m': '6mo', '1y': '2y', '5y': '5y' }[range] || '2y';
      const k = await S.yahooChart(cfg.ticker, fetchRange, '1d');
      if (!k.ok || k.values.length < cfg.window + 2) return res.json({ source: 'unavailable', error: k.error || 'insufficient closes' });
      const { values, dates } = realizedVol(k.values, k.dates, cfg.window);
      if (!values.length) return res.json({ source: 'unavailable', error: 'vol calc empty' });
      // 현재가: V-KOSPI 선물 라이브 (실패 시 실현변동성 최신값으로 폴백)
      let quote;
      const tv = await getVkiQuote(cfg.tvSymbol);
      if (tv) {
        quote = { value: tv.close, diff: tv.changeAbs != null ? tv.changeAbs : 0, pct: tv.change != null ? tv.change : 0 };
      } else {
        const last = values[values.length - 1], prev = values[values.length - 2] ?? last;
        quote = { value: last, diff: last - prev, pct: prev ? ((last - prev) / prev) * 100 : 0 };
      }
      return res.json({ source: 'live', kind: 'line', values, dates, quote });
    }

    if (cfg.src === 'naver-flow') {
      const r = await getInvestors();
      if (!r.ok || !r.rows || !r.rows.length) return res.json({ source: 'unavailable', error: r.error || 'no investor data' });
      const values = r.rows.map(x => x[cfg.key]);
      const dates = r.rows.map(x => '20' + x.date.replace(/\./g, '-')); // YY.MM.DD → 20YY-MM-DD
      const last = values[values.length - 1], prev = values[values.length - 2] ?? last;
      return res.json({ source: 'live', kind: 'bars', values, dates, quote: { value: last, diff: last - prev, pct: 0 } });
    }

    if (cfg.src === 'sectors') {
      const r = await S.naverMarketCap('kospi');
      if (!r.ok) return res.json({ source: 'unavailable', error: r.error });
      const agg = {};
      r.stocks.forEach(s => {
        const sec = C.SECTOR_MAP[s.code] || '기타';
        if (!agg[sec]) agg[sec] = { sum: 0, n: 0 };
        agg[sec].sum += s.dailyChange; agg[sec].n++;
      });
      const rows = Object.entries(agg).map(([name, v]) => ({ name, chg: +(v.sum / v.n).toFixed(2) }))
        .sort((a, b) => b.chg - a.chg);
      return res.json({ source: 'live', kind: 'sectors', rows });
    }

    // sample (라이브 소스 없음)
    return res.json({ source: 'unavailable', reason: 'no live source for this indicator' });
  } catch (e) {
    res.json({ source: 'unavailable', error: e.message });
  }
});

// ── 2. 배치 현재가 (상단 KPI · 위젯 헤더용) ───────────────────────────────────
// GET /api/quotes?ids=kospi,kosdaq,sp500,nasdaq,usdkrw
const KPI_TICKERS = {
  kospi: '^KS11', kosdaq: '^KQ11', sp500: '^GSPC', nasdaq: '^IXIC',
  usdkrw: 'KRW=X', nikkei: '^N225',
};
app.get('/api/quotes', async (req, res) => {
  const ids = (req.query.ids || 'kospi,kosdaq,sp500,nasdaq').split(',').map(s => s.trim()).filter(Boolean);
  const out = {};
  await Promise.all(ids.map(async id => {
    const ticker = KPI_TICKERS[id] || (C.SERIES_SOURCES[id] && C.SERIES_SOURCES[id].ticker);
    if (!ticker) { out[id] = { source: 'unavailable' }; return; }
    const r = await S.yahooChart(ticker, '5d', '1d');
    if (!r.ok || r.values.length < 2) { out[id] = { source: 'unavailable', error: r.error }; return; }
    const v = r.values, last = v[v.length - 1], prev = v[v.length - 2];
    out[id] = { source: 'live', value: last, diff: last - prev, pct: ((last - prev) / prev) * 100 };
  }));
  res.json(out);
});

// ── 3. 트리맵 (네이버 시총 상위 → 업종 그룹 트리맵) ───────────────────────────
// GET /api/treemap?market=kospi&period=daily|weekly
app.get('/api/treemap', async (req, res) => {
  const { market = 'kospi', period = 'daily' } = req.query;
  const suffix = market === 'kosdaq' ? '.KQ' : '.KS';
  const r = await S.naverMarketCap(market);
  if (!r.ok) return res.status(200).json({ source: 'unavailable', error: r.error, series: [] });

  let weekly = {};
  if (period === 'weekly') {
    const symbols = r.stocks.map(s => `${s.code}${suffix}`);
    const sp = await S.yahooSparkWeekly(symbols);
    weekly = sp.changes || {};
  }

  const sectors = {};
  r.stocks.forEach(s => {
    const sec = C.SECTOR_MAP[s.code] || '기타 업종';
    if (!sectors[sec]) sectors[sec] = [];
    const change = period === 'weekly' && weekly[s.code] !== undefined ? weekly[s.code] : s.dailyChange;
    sectors[sec].push({ x: s.name, y: s.marketCapCho, value: change, fillColor: C.getFillColor(change) });
  });
  const series = Object.entries(sectors).map(([name, data]) => ({ name, data }));
  res.json({ source: 'live', series });
});

// ── 4. 글로벌 지수 1년 정규화 비교 ────────────────────────────────────────────
// GET /api/global?range=1y → { source, dates, series:[{name,data}] }
const GLOBAL_TICKERS = {
  'KOSPI': '^KS11', 'KOSDAQ': '^KQ11', '코스피200': '^KS200',
  'S&P 500': '^GSPC', 'NASDAQ': '^IXIC', '다우': '^DJI',
  'Nikkei 225': '^N225', '항셍': '^HSI', '독일 DAX': '^GDAXI', '인도 SENSEX': '^BSESN',
};
app.get('/api/global', async (req, res) => {
  const range = RANGE_MAP[req.query.range] || '1y';
  const entries = Object.entries(GLOBAL_TICKERS);
  const results = await Promise.all(entries.map(async ([name, t]) => {
    const r = await S.yahooChart(t, range, '1d');
    if (!r.ok || r.values.length < 2) return null;
    const init = r.values[0];
    return { name, dates: r.dates, data: r.values.map(p => ((p - init) / init) * 100) };
  }));
  const live = results.filter(Boolean);
  if (!live.length) return res.json({ source: 'unavailable', series: [] });
  // 가장 긴 날짜축 채택
  const dates = live.reduce((a, b) => (b.dates.length > a.length ? b.dates : a), []);
  const series = live.map(s => ({ name: s.name, data: s.data })).sort((a, b) => (b.data[b.data.length - 1]) - (a.data[a.data.length - 1]));
  res.json({ source: 'live', dates, series });
});

// ── 5. 투자자별 누적 순매수 + 외국인 vs KOSPI ─────────────────────────────────
// GET /api/investors → { source, dates, individual[], foreigner[], institution[], pension[], foreignerCum[], kospi[] }
app.get('/api/investors', async (req, res) => {
  const r = await getInvestors();
  if (!r.ok || !r.rows || !r.rows.length) return res.json({ source: 'unavailable', error: (r.error || 'empty (네이버 일자별 매매동향 비어있음)') });

  const rows = r.rows;
  const dates = rows.map(x => x.date);
  const cum = key => { let s = 0; return rows.map(x => +(s += x[key] / 10000).toFixed(2)); }; // 억원→조원 누적
  const individual = cum('individual'), foreigner = cum('foreigner'),
        institution = cum('institution'), pension = cum('pension');

  // 외국인 vs KOSPI: 같은 날짜축의 KOSPI 종가
  let kospi = [];
  const kr = await S.yahooChart('^KS11', '3mo', '1d');
  if (kr.ok) {
    const map = Object.fromEntries(kr.dates.map((d, i) => [d.slice(2).replace(/-/g, '.'), kr.values[i]]));
    kospi = dates.map(d => map[d] != null ? +map[d].toFixed(2) : null);
  }
  res.json({ source: 'live', dates, individual, foreigner, institution, pension, foreignerCum: foreigner, kospi });
});

// ── 5b. 주간 수급 보드 — 투자자별 주간 순매수 집계 + 외국인 연속 매도/매수 주 수 ──
// 일별 매매동향을 길게(최대 3년) 모아 ISO 주(월~일) 단위로 합산한다.
// 일별 히스토리는 디스크 캐시(cache/investors-daily.json) + 증분 갱신으로 유지해
// 서버 재시작 시 전체 재수집을 피한다.
const HIST_FILE = path.join(__dirname, 'cache', 'investors-daily.json');
const HIST_MAX_ROWS = 800;                       // 일별 보관 상한 (~3년)
let invHist = { rows: [], checkedAt: 0 };        // rows: 과거→현재, date='YY.MM.DD'
try { invHist.rows = (JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')).rows) || []; } catch (_) {}

function saveHist() {
  try {
    fs.mkdirSync(path.dirname(HIST_FILE), { recursive: true });
    fs.writeFileSync(HIST_FILE, JSON.stringify({ savedAt: new Date().toISOString(), rows: invHist.rows }));
  } catch (_) { /* 디스크 실패는 치명적이지 않음 (메모리 캐시로 동작) */ }
}

// minDays 이상의 일별 히스토리를 보장. 캐시가 신선하면 그대로, 아니면 최신 페이지부터
// 캐시 최신일과 겹칠 때까지(콜드 스타트면 minDays 채울 때까지) 6페이지씩 병렬 수집.
let histInflight = null;
async function getInvestorHistory(minDays) {
  const fresh = Date.now() - invHist.checkedAt < 10 * 60 * 1000;
  if (invHist.rows.length >= minDays && fresh) return invHist.rows;
  if (histInflight) return histInflight;          // 동시 요청은 한 번의 수집을 공유
  histInflight = (async () => {
    const byDate = new Map(invHist.rows.map(r => [r.date, r]));
    const newestCached = invHist.rows.length ? invHist.rows[invHist.rows.length - 1].date : '';
    const maxPages = Math.ceil((minDays * 1.05) / 10) + 3;
    outer:
    for (let base = 1; base <= maxPages; base += 6) {
      const group = [];
      for (let p = base; p < base + 6 && p <= maxPages; p++) group.push(p);
      const results = await Promise.all(group.map(p => S.naverInvestorPage(p)));
      let reachedCache = false, anyRows = false;
      for (const r of results) {
        if (!r.ok || !r.rows.length) continue;
        anyRows = true;
        r.rows.forEach(row => byDate.set(row.date, row));
        if (newestCached && r.rows[r.rows.length - 1].date <= newestCached) reachedCache = true;
      }
      if (!anyRows) break outer;                  // 전 페이지 실패/빈 응답 → 네트워크 문제로 보고 중단
      if (byDate.size >= minDays && (reachedCache || !newestCached)) break outer;
    }
    invHist.rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-HIST_MAX_ROWS);
    invHist.checkedAt = Date.now();
    saveHist();
    return invHist.rows;
  })();
  try { return await histInflight; } finally { histInflight = null; }
}

const INVESTOR_KEYS = ['individual', 'foreigner', 'institution', 'pension'];
const toIso = yy => '20' + yy.replace(/\./g, '-');                    // 'YY.MM.DD' → 'YYYY-MM-DD'
function mondayOf(iso) {                                              // ISO 주의 월요일 (주간 버킷 키)
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}

// GET /api/investors/weekly?weeks=104
// → { source, freq:'weekly', dates(주 마지막 거래일), net{...}, cum{...}(조원), kospi[], streak:{weeks,direction} }
const weeklyRespCache = {};                      // weeks → { at, body } (5분)
app.get('/api/investors/weekly', async (req, res) => {
  const weeks = Math.min(156, Math.max(12, parseInt(req.query.weeks, 10) || 104));
  const rc = weeklyRespCache[weeks];
  if (rc && Date.now() - rc.at < 5 * 60 * 1000) return res.json(rc.body);
  try {
    const rows = await getInvestorHistory(Math.ceil(weeks * 5.05) + 10);
    if (!rows || rows.length < 30) return res.json({ source: 'unavailable', error: 'insufficient investor history' });

    // ISO 주 단위 합산 (억원)
    const buckets = new Map();                                        // monday → {end, 4개 주체 합}
    rows.forEach(r => {
      const iso = toIso(r.date), mon = mondayOf(iso);
      let b = buckets.get(mon);
      if (!b) { b = { end: iso, individual: 0, foreigner: 0, institution: 0, pension: 0 }; buckets.set(mon, b); }
      if (iso > b.end) b.end = iso;
      INVESTOR_KEYS.forEach(k => { b[k] += r[k]; });
    });
    const keys = [...buckets.keys()].sort().slice(-weeks);
    const wk = keys.map(k => buckets.get(k));
    const dates = wk.map(b => b.end);
    const net = {}, cum = {};
    INVESTOR_KEYS.forEach(k => {
      net[k] = wk.map(b => +(b[k] / 10000).toFixed(3));               // 억원 → 조원
      let s = 0;
      cum[k] = wk.map(b => +((s += b[k]) / 10000).toFixed(3));
    });

    // KOSPI 주간 종가: 야후 일봉을 같은 주 버킷의 마지막 종가로 축약 (거래주만 존재 → 정렬 보장)
    let kospi = keys.map(() => null);
    const yr = await S.yahooChart('^KS11', '5y', '1d');
    if (yr.ok) {
      const closeByMon = new Map();
      yr.dates.forEach((d, i) => closeByMon.set(mondayOf(d), yr.values[i]));
      kospi = keys.map(k => closeByMon.has(k) ? +closeByMon.get(k).toFixed(2) : null);
    }

    // 외국인 연속 순매도/순매수 주 수 (최신 주부터 같은 부호 연속)
    const f = net.foreigner;
    const dir = f[f.length - 1] < 0 ? -1 : 1;
    let streak = 0;
    for (let i = f.length - 1; i >= 0; i--) {
      if ((dir < 0 && f[i] < 0) || (dir > 0 && f[i] > 0)) streak++; else break;
    }
    const body = { source: 'live', freq: 'weekly', weeks: keys.length, dates, net, cum, kospi,
      streak: { weeks: streak, direction: dir < 0 ? 'sell' : 'buy' } };
    weeklyRespCache[weeks] = { at: Date.now(), body };
    res.json(body);
  } catch (e) {
    res.json({ source: 'unavailable', error: e.message });
  }
});

// ── 6. 시장 폭 (Breadth) ──────────────────────────────────────────────────────
app.get('/api/breadth', async (req, res) => {
  const market = req.query.market || 'kospi';
  const r = await S.naverMarketCap(market);
  if (!r.ok) return res.json({ source: 'unavailable', error: r.error });
  res.json({ source: 'live', ...S.computeBreadth(r.stocks) });
});

// ── 7. 헬스체크 (파이프라인 소스 상태 요약) ───────────────────────────────────
app.get('/api/health', async (req, res) => {
  const [y, n, inv] = await Promise.all([
    S.yahooChart('^KS11', '5d', '1d'),
    S.naverMarketCap('kospi'),
    getInvestors(),
  ]);
  res.json({
    yahoo: y.ok ? 'ok' : 'fail',
    naverTreemap: n.ok ? `ok (${n.stocks.length})` : 'fail',
    naverInvestors: inv.ok ? (inv.empty ? 'empty' : `ok (${inv.rows.length})`) : 'fail',
    at: new Date().toISOString(),
  });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('===============================================');
  console.log('📊 시그널보드 대시보드 서버 시작!');
  console.log(`👉 접속 주소: ${url}`);
  console.log('===============================================');
  // 브라우저 자동 오픈 (로컬 전용 — NO_OPEN=1 또는 Render 등 호스팅 환경에선 생략)
  if (process.env.NO_OPEN !== '1' && !process.env.RENDER) {
    const { exec } = require('child_process');
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(cmd, () => {}); // 실패는 무시 (헤드리스 등)
  }
});
