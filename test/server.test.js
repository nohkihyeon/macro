// 수집기 + Express 앱 통합 테스트 (업스트림은 fixtures)
const test = require('node:test');
const assert = require('node:assert/strict');
const { HttpClient } = require('../pipeline/http');
const { Cache } = require('../pipeline/cache');
const { Collector } = require('../pipeline/collector');
const { createApp } = require('../server');
const { fixtureFetch } = require('./helpers');

async function setup() {
  const fetch = fixtureFetch();
  const http = new HttpClient({ fetch, retries: 0 });
  const collector = new Collector(http, new Cache());
  await collector.refreshLive();
  await collector.refreshSeries();
  const server = createApp(collector).listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { collector, server, base, fetch };
}

test('수집기 → API 통합', async t => {
  const { collector, server, base } = await setup();
  t.after(() => server.close());

  await t.test('스냅샷: 토픽 전체 + ETag 로 304', async () => {
    const res = await fetch(`${base}/api/snapshot`);
    assert.equal(res.status, 200);
    const s = await res.json();
    for (const key of ['meta', 'quotes', 'boards', 'treemap', 'movers', 'sectors', 'themes', 'insights', 'intraday', 'series']) {
      assert.ok(key in s, `${key} 없음`);
    }
    assert.equal(s.quotes.kospi.source, 'naver');
    assert.ok(s.quotes['kr-term'].price != null, '금리차 계산');
    assert.ok(s.boards.KOSPI.breadth.falling > 0);
    assert.ok(s.insights.signals.length >= 7);
    assert.ok(s.intraday.kospi.points.length > 0);
    const again = await fetch(`${base}/api/snapshot`, { headers: { 'If-None-Match': res.headers.get('etag') } });
    assert.equal(again.status, 304);
  });

  await t.test('SSE: 접속하면 snapshot 이벤트부터 받는다', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream?watch=005930`, { signal: ctrl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('event: snapshot')) text += new TextDecoder().decode((await reader.read()).value);
    assert.ok(text.startsWith('retry: 3000'));
    assert.equal(collector.subscribers.size, 1);
    assert.deepEqual(collector.watchCodes(), ['005930']);
    ctrl.abort();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(collector.subscribers.size, 0);
  });

  await t.test('히스토리: 지표 · 금리차 · 수급 · 종목 · 미지원', async () => {
    // 픽스처가 고정된 날짜라 1m 은 시간이 지나면 비어 간다 → 1y 로 본다
    const kospi = await (await fetch(`${base}/api/history/kospi?range=1y`)).json();
    assert.equal(kospi.kind, 'line');
    assert.ok(kospi.rows.length > 15);
    const flow = await (await fetch(`${base}/api/history/flow-foreign?range=1m`)).json();
    assert.equal(flow.kind, 'bars');
    const stock = await (await fetch(`${base}/api/history/005930?range=1m`)).json();
    assert.equal(stock.kind, 'candle');
    assert.ok(stock.rows[0].open != null);
    const spread = await (await fetch(`${base}/api/history/kr-term?range=1m`)).json();
    assert.ok(spread.rows.length > 0);
    assert.equal((await fetch(`${base}/api/history/nope`)).status, 404);
  });

  await t.test('지표추적: 지표 · 종목 · 미지원 · 잘못된 입력', async () => {
    const res = await (await fetch(`${base}/api/tracker?ids=kospi,005930,nope,btc`)).json();
    assert.equal(res.items.length, 4);
    const [kospi, stock, nope, btc] = res.items;
    assert.equal(btc.id, 'btc');
    assert.ok(btc.error || btc.ma, 'Yahoo 지표: 실패해도 항목은 돌려준다');
    assert.equal(kospi.id, 'kospi');
    assert.ok(kospi.ma.ma5 && typeof kospi.ma.ma5.above === 'boolean');
    assert.ok(kospi.week && kospi.week.shape);
    assert.ok(kospi.series.length > 0);
    assert.equal(stock.kind, 'candle');
    assert.ok(stock.price != null);
    assert.ok(nope.error);
    assert.equal((await fetch(`${base}/api/tracker`)).status, 422);
    assert.equal((await fetch(`${base}/api/tracker?ids=a/b`)).status, 422);
  });

  await t.test('예전 API 호환', async () => {
    const q = await (await fetch(`${base}/api/quotes?ids=kospi,sp500,nasdaq`)).json();
    assert.equal(q.kospi.source, 'live');
    assert.equal(q.sp500.source, 'live');
    const s = await (await fetch(`${base}/api/series/usdkrw?range=1m`)).json();
    assert.equal(s.source, 'live');
    assert.equal(s.values.length, s.dates.length);
    const tm = await (await fetch(`${base}/api/treemap?market=kospi`)).json();
    assert.equal(tm.source, 'live');
    assert.ok(tm.series[0].data[0].fillColor);
    const w = await (await fetch(`${base}/api/investors/weekly?weeks=12`)).json();
    assert.equal(w.source, 'live');
    assert.ok(['buy', 'sell'].includes(w.streak.direction));
    const br = await (await fetch(`${base}/api/breadth?market=kospi`)).json();
    assert.ok(br.total > 500);
  });

  await t.test('입력 검증', async () => {
    assert.equal((await fetch(`${base}/api/stocks/quotes?codes=abc`)).status, 422);
    assert.equal((await fetch(`${base}/api/stocks/quotes?codes=0162Z0`)).status, 200, '영숫자 코드 허용');
    assert.equal((await fetch(`${base}/api/stocks/search?q=`)).status, 422);
  });
});

test('발행: 바뀐 종목만 quotes 로 푸시, 변화 없으면 meta 만', async () => {
  const fetch = fixtureFetch();
  const collector = new Collector(new HttpClient({ fetch, retries: 0 }), new Cache());
  await collector.refreshLive();
  const events = [];
  collector.subscribers.add({ watch: new Set(), send: (e, d) => events.push([e, JSON.parse(d)]) });

  collector._publishLive();
  assert.deepEqual(events.map(e => e[0]), ['meta'], '변화 없음');

  events.length = 0;
  const domestic = collector.cache.value('live:domestic');
  collector.cache.set('live:domestic', { ...domestic, KOSPI: { ...domestic.KOSPI, price: domestic.KOSPI.price + 10 } });
  collector._publishLive();
  const quotes = events.find(e => e[0] === 'quotes');
  assert.deepEqual(Object.keys(quotes[1]), ['kospi']);
  assert.ok(events.some(e => e[0] === 'boards'));
});
