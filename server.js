// ─────────────────────────────────────────────────────────────────────────────
// server.js — 시그널보드 백엔드 (Express)
//
//  · pipeline/collector 가 네이버 배치 API 를 장 상태에 맞춰 수집해 메모리 스냅샷을 유지
//  · API 는 업스트림을 기다리지 않고 스냅샷을 즉시 반환 (ETag → 변경 없으면 304)
//  · /api/stream (SSE) 은 접속 시 전체 스냅샷, 이후 바뀐 토픽·종목만 푸시
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const compression = require('compression');
const { createServer } = require('http');
const path = require('path');
const config = require('./pipeline/config');
const { HttpClient } = require('./pipeline/http');
const { Cache } = require('./pipeline/cache');
const { Collector, RANGE_DAYS, STOCK_CODE } = require('./pipeline/collector');
const I = require('./pipeline/instruments');

const SSE_MAX_BUFFER = 2 * 1024 * 1024;   // 이보다 밀린 느린 구독자는 끊고 재접속시킨다
const KEEPALIVE_MS = 15000;

function createApp(collector) {
  const app = express();
  app.disable('x-powered-by');
  // SSE 는 압축하면 버퍼링돼 실시간성이 깨지므로 제외
  app.use(compression({ filter: (req, res) => !req.path.startsWith('/api/stream') && compression.filter(req, res) }));
  app.use(express.static(path.join(__dirname, 'public')));

  const fail = (res, status, detail) => res.status(status).json({ detail });
  const market = v => (String(v || 'KOSPI').toUpperCase() === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI');
  const range = (v, def = '1y') => (RANGE_DAYS[v] ? v : def);
  const intParam = (v, def, lo, hi) => Math.min(hi, Math.max(lo, parseInt(v, 10) || def));
  const codes = v => [...new Set(String(v || '').split(',').map(s => s.trim()).filter(Boolean))];
  const noCache = res => res.set('Cache-Control', 'no-cache');   // 항상 재검증 → 같으면 304

  // 요청 공통: 접속 기록 + (쉬다 깨어났으면) 첫 스냅샷 대기
  const live = async (req, res, next) => {
    collector.touch();
    await collector.ensureFresh();
    if (!collector.state) return fail(res, 503, '데이터 수집 중입니다. 잠시 후 다시 시도하세요.');
    noCache(res);
    next();
  };

  // ── 실시간 ─────────────────────────────────────────────────────────────────
  // GET /api/snapshot?watch=005930,000660 — 폴링용 전체 스냅샷 (ETag 304)
  app.get('/api/snapshot', live, (req, res) => {
    const watch = codes(req.query.watch).filter(c => STOCK_CODE.test(c)).slice(0, 30);
    const etag = collector.snapshotEtagFor(watch);
    res.set('ETag', etag);
    if (req.get('if-none-match') === etag) return res.status(304).end();
    res.type('application/json').send(JSON.stringify(collector.snapshot(watch)));
  });

  // GET /api/stream?watch=… — Server-Sent Events
  //   event: snapshot (접속 직후 전체) · quotes/stocks (바뀐 종목만) · intraday (새 분봉만)
  //          boards · treemap · movers · sectors · themes · insights · series · meta (매 갱신)
  app.get('/api/stream', (req, res) => {
    const watch = codes(req.query.watch).filter(c => STOCK_CODE.test(c)).slice(0, 30);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const client = {
      watch: new Set(watch),
      send(event, data) {
        if (res.writableLength > SSE_MAX_BUFFER) { res.end(); return; }
        res.write(`event: ${event}\ndata: ${data}\n\n`);
      },
    };
    const snap = collector.snapshot(watch);
    if (snap) client.send('snapshot', JSON.stringify(snap));
    const unsubscribe = collector.subscribe(client);
    const ping = setInterval(() => res.write(': ping\n\n'), KEEPALIVE_MS);
    req.on('close', () => { clearInterval(ping); unsubscribe(); });
  });

  // ── 히스토리·집계 (ETag 304) ───────────────────────────────────────────────
  // GET /api/history/:id?range=1w|1m|3m|6m|1y|3y|5y — 지표 id · 금리차 · 수급(flow-*) · credit · 6자리 종목코드
  app.get('/api/history/:id', live, async (req, res) => {
    try {
      res.json(await collector.history(req.params.id, range(req.query.range)));
    } catch (e) {
      if (e.status === 404) return fail(res, 404, e.message);
      console.warn(`[api] history ${req.params.id} 실패: ${e.message}`);
      fail(res, 503, '데이터 소스에 연결할 수 없습니다.');
    }
  });

  // GET /api/intraday/:id — 국내 지수 1분봉 (마지막 거래일)
  app.get('/api/intraday/:id', live, async (req, res) => {
    try { res.json(await collector.intraday(req.params.id)); } catch (e) { fail(res, e.status || 503, e.message); }
  });

  app.get('/api/flows', live, (req, res) => res.json(collector.dailyFlows(market(req.query.market), intParam(req.query.days, 30, 5, 600))));
  app.get('/api/flows/weekly', live, (req, res) => res.json(collector.weeklyFlows(market(req.query.market), intParam(req.query.weeks, 104, 12, 156))));
  app.get('/api/credit', live, (req, res) => res.json(collector.credit(intParam(req.query.days, 120, 5, 200))));
  app.get('/api/global', live, async (req, res) => res.json(await collector.globalCompare(range(req.query.range))));

  // GET /api/treemap?market=kospi&period=daily|weekly — 시총 상위 → 업종 그룹 (ApexCharts treemap 형식)
  app.get('/api/treemap', live, async (req, res) => {
    const m = market(req.query.market);
    const stocks = collector.state.treemap[m] || [];
    if (!stocks.length) return res.json({ source: 'unavailable', series: [] });
    const weekly = req.query.period === 'weekly' ? await collector.weeklyChanges(m) : null;
    const sectors = new Map();
    for (const s of stocks) {
      const change = weekly && weekly[s.code] != null ? weekly[s.code] : s.change_percent;
      if (!sectors.has(s.sector)) sectors.set(s.sector, []);
      sectors.get(s.sector).push({ x: s.name, y: +(s.market_cap / 10000).toFixed(2), value: change, code: s.code, fillColor: fillColor(change) });
    }
    res.json({
      source: 'live', market: m, period: weekly ? 'weekly' : 'daily',
      series: [...sectors].map(([name, data]) => ({ name, data })),
    });
  });

  // ── 달러 매수 타이밍 (DollarScope 이식) ────────────────────────────────────
  app.get('/api/dollar', live, (req, res) => res.json(collector.state.dollar || { source: 'unavailable' }));
  // DollarScope 호환 형식 (예전 /api/status · /api/history)
  app.get('/api/dollar/status', live, (req, res) => {
    const d = collector.state.dollar;
    if (!d) return fail(res, 503, '환율 히스토리 수집 중입니다.');
    res.json({
      current_price: d.price, average_3yr: d.dollarscope.avg3y, status: d.dollarscope.status,
      diff: d.dollarscope.diff, diff_percent: d.dollarscope.diff_pct,
      last_updated: collector.state.meta.generated_at, source: '네이버 증권', score: d.score, verdict: d.label,
    });
  });
  app.get('/api/dollar/history', live, async (req, res) => {
    const h = await collector.history('usdkrw', range(req.query.range, '3y'));
    res.json(h.rows.map(r => ({ date: r.date, value: r.close })));
  });

  // ── 종목 ───────────────────────────────────────────────────────────────────
  app.get('/api/stocks/quotes', live, async (req, res) => {
    const list = codes(req.query.codes);
    if (!list.length || list.length > 30 || !list.every(c => STOCK_CODE.test(c))) return fail(res, 422, '6자리 종목코드를 1~30개 입력하세요.');
    try { res.json(await collector.stockQuotes(list)); } catch (e) { fail(res, 503, '데이터 소스에 연결할 수 없습니다.'); }
  });

  app.get('/api/stocks/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q || q.length > 30) return fail(res, 422, '검색어를 1~30자로 입력하세요.');
    try { res.json(await collector.search(q)); } catch (e) { fail(res, 503, '데이터 소스에 연결할 수 없습니다.'); }
  });

  // ── 상태 ───────────────────────────────────────────────────────────────────
  app.get('/api/health', (req, res) => { noCache(res); res.json(collector.health()); });

  // ── 예전 API 호환 (스냅샷에서 즉시 응답) ───────────────────────────────────
  // GET /api/series/:id?range= → { source:'live'|'unavailable', kind, values, dates, quote:{value,diff,pct} }
  app.get('/api/series/:id', live, async (req, res) => {
    const id = I.LEGACY_IDS[req.params.id] || req.params.id;
    const s = collector.state;
    if (id === 'feargreed') {
      const fg = s.insights.feargreed;
      return res.json(fg.value != null ? { source: 'live', kind: 'gauge', value: fg.value } : { source: 'unavailable' });
    }
    if (id === 'sectors') {
      return res.json({ source: s.sectors.length ? 'live' : 'unavailable', kind: 'sectors', rows: s.sectors.map(g => ({ name: g.name, chg: g.change })) });
    }
    try {
      const h = await collector.history(id, range(req.query.range));
      if (!h.rows.length) return res.json({ source: 'unavailable', reason: 'no history for this indicator' });
      const values = h.rows.map(r => r.close);
      const q = s.quotes[id];
      const last = values[values.length - 1], prev = values[values.length - 2] ?? last;
      const quote = q && q.price != null
        ? { value: q.price, diff: q.change ?? 0, pct: q.change_percent ?? 0 }
        : { value: last, diff: last - prev, pct: prev ? ((last - prev) / prev) * 100 : 0 };
      res.json({ source: 'live', kind: h.kind === 'bars' ? 'bars' : 'line', values, dates: h.rows.map(r => r.date), quote });
    } catch (e) {
      res.status(e.status === 404 ? 404 : 200).json({ source: 'unavailable', error: e.message });
    }
  });

  // GET /api/quotes?ids=kospi,kosdaq,sp500,nasdaq,usdkrw
  app.get('/api/quotes', live, (req, res) => {
    const out = {};
    for (const id of codes(req.query.ids || 'kospi,kosdaq,sp500,nasdaq')) {
      const q = collector.state.quotes[I.LEGACY_IDS[id] || id];
      out[id] = q && q.price != null
        ? { source: 'live', value: q.price, diff: q.change, pct: q.change_percent, as_of: q.as_of, stale: q.stale }
        : { source: 'unavailable' };
    }
    res.json(out);
  });

  app.get('/api/investors', live, (req, res) => res.json(collector.dailyFlows('KOSPI', 30)));
  app.get('/api/investors/weekly', live, (req, res) => res.json(collector.weeklyFlows('KOSPI', intParam(req.query.weeks, 104, 12, 156))));

  // GET /api/breadth?market=kospi — 전 종목 상승/하락/보합 (+ 상·하한가, 52주 신고·신저가)
  app.get('/api/breadth', live, (req, res) => {
    const b = collector.state.boards[market(req.query.market)];
    if (!b || !b.breadth) return res.json({ source: 'unavailable' });
    const { upper, rising, unchanged, falling, lower } = b.breadth;
    res.json({
      source: 'live', up: upper + rising, down: falling + lower, flat: unchanged,
      total: upper + rising + unchanged + falling + lower, upper, lower, highs: b.highs, lows: b.lows,
    });
  });

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  return app;
}

// 한국식 등락 색상 (예전 /api/treemap 호환 — 새 화면은 브라우저에서 색을 정한다)
function fillColor(v) {
  if (v > 3) return '#b91c1c';
  if (v > 0) return '#ef4444';
  if (v < -3) return '#1d4ed8';
  if (v < 0) return '#3b82f6';
  return '#64748b';
}

// 포트를 잡는다. PORT 를 직접 지정하지 않았는데 다른 프로그램이 쓰고 있으면 다음 포트로 넘어간다.
// (app.listen 은 Express 5 에서 실패도 콜백으로 넘겨, 예전엔 실패해도 '시작!' 이 찍히고 남의 화면이 열렸다)
function listen(app, port, explicit, tries = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.once('error', err => {
      if (err.code === 'EADDRINUSE' && !explicit && tries < 10) {
        console.warn(`⚠️  ${port} 포트를 다른 프로그램이 쓰고 있어 ${port + 1} 포트로 시도합니다.`);
        resolve(listen(app, port + 1, explicit, tries + 1));
      } else {
        reject(err);
      }
    });
    server.once('listening', () => resolve(server));
    server.listen(port);
  });
}

async function main() {
  const http = new HttpClient();
  const cache = new Cache({ dir: config.cacheDir });
  const collector = new Collector(http, cache);
  const app = createApp(collector);

  let server;
  try {
    server = await listen(app, config.port, !!process.env.PORT);
  } catch (e) {
    console.error(e.code === 'EADDRINUSE'
      ? `❌ ${config.port} 포트를 이미 다른 프로그램이 쓰고 있습니다. 그 프로그램을 끄거나 다른 포트로 실행하세요 (예: PORT=3100 npm start).`
      : `❌ 서버를 시작하지 못했습니다: ${e.message}`);
    process.exit(1);
  }
  collector.start();

  const url = `http://localhost:${server.address().port}`;
  console.log('===============================================');
  console.log('📊 시그널보드 대시보드 서버 시작!');
  console.log(`👉 접속 주소: ${url}`);
  console.log(`   실시간 스트림: ${url}/api/stream · 상태: ${url}/api/health`);
  console.log('===============================================');
  // 브라우저 자동 오픈 (로컬 전용 — NO_OPEN=1 또는 Render 등 호스팅 환경에선 생략)
  if (process.env.NO_OPEN !== '1' && !process.env.RENDER && !process.argv.includes('--no-open')) {
    const { exec } = require('child_process');
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(cmd, () => {}); // 실패는 무시 (헤드리스 등)
  }

  // 종료 시 디스크 캐시를 기록하고 SSE 연결까지 정리
  const shutdown = async () => {
    await collector.stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createApp };
