const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Cache } = require('../pipeline/cache');
const { HttpClient, HttpError, SourceUnavailable } = require('../pipeline/http');
const H = require('../pipeline/market-hours');
const { response } = require('./helpers');

// ── 캐시 ──────────────────────────────────────────────────────────────────────
test('cache: TTL 안에서는 다시 받지 않는다', async () => {
  const c = new Cache();
  let n = 0;
  const fetcher = async () => ++n;
  assert.equal((await c.get('k', 60, fetcher)).value, 1);
  assert.equal((await c.get('k', 60, fetcher)).value, 1);
  assert.equal(n, 1);
  assert.equal(c.stats.hits, 1);
});

test('cache: single-flight — 동시 요청은 업스트림 1번', async () => {
  const c = new Cache();
  let n = 0;
  const fetcher = () => new Promise(r => setTimeout(() => r(++n), 20));
  const results = await Promise.all([c.get('k', 60, fetcher), c.get('k', 60, fetcher), c.get('k', 60, fetcher)]);
  assert.deepEqual(results.map(r => r.value), [1, 1, 1]);
  assert.equal(c.stats.coalesced, 2);
});

test('cache: 실패하면 마지막 정상값을 stale 로, 값이 없으면 throw', async () => {
  const c = new Cache();
  await c.get('k', 0, async () => 'good');
  const r = await c.get('k', 0, async () => { throw new Error('down'); });
  assert.equal(r.value, 'good');
  assert.equal(r.stale, true);
  assert.equal(r.error, 'down');
  await assert.rejects(c.get('none', 0, async () => { throw new Error('down'); }), /down/);
});

test('cache: SWR 은 만료값을 즉시 주고 뒤에서 갱신', async () => {
  const c = new Cache();
  await c.get('k', 0, async () => 'old');
  const r = await c.get('k', 0, async () => 'new', { swr: true });
  assert.equal(r.value, 'old');
  assert.equal(r.stale, true);
  await new Promise(res => setTimeout(res, 5));
  assert.equal(c.value('k'), 'new');
});

test('cache: 디스크에 저장했다가 재시작 시 다시 읽는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cache-'));
  const a = new Cache({ dir });
  await a.get('series:hist:kospi', 60, async () => [{ date: '2026-10-30', close: 1 }], { persist: true });
  a.flush();
  const b = new Cache({ dir });
  assert.deepEqual(b.value('series:hist:kospi'), [{ date: '2026-10-30', close: 1 }]);
  assert.equal((await b.get('series:hist:kospi', 60, async () => 'refetched')).value[0].close, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── HTTP 클라이언트 ───────────────────────────────────────────────────────────
test('http: 503 은 재시도 후 성공', async () => {
  let n = 0;
  const http = new HttpClient({ retries: 2, backoff: () => 1, fetch: async () => (++n < 3 ? response(503, '') : response(200, '{"ok":1}')) });
  assert.deepEqual(await http.getJson('https://example.com/a'), { ok: 1 });
  assert.equal(n, 3);
});

test('http: 연속 실패하면 브레이커가 열려 호출을 건너뛴다', async () => {
  let n = 0;
  const http = new HttpClient({ retries: 0, breakerThreshold: 2, breakerCooldown: 60, fetch: async () => { n++; return response(500, ''); } });
  await assert.rejects(http.getJson('https://example.com/a'), HttpError);
  await assert.rejects(http.getJson('https://example.com/a'), HttpError);
  await assert.rejects(http.getJson('https://example.com/a'), SourceUnavailable);
  assert.equal(n, 2);
  assert.equal(http.snapshot()[0].breaker_open, true);
});

test('http: 404 는 재시도하지 않고 브레이커에도 반영하지 않는다', async () => {
  let n = 0;
  const http = new HttpClient({ retries: 2, breakerThreshold: 1, fetch: async () => { n++; return response(404, ''); } });
  await assert.rejects(http.getJson('https://example.com/a'), HttpError);
  await assert.rejects(http.getJson('https://example.com/a'), HttpError);
  assert.equal(n, 2);
  assert.equal(http.breakerOpen('example.com'), false);
});

// ── 장 운영 시간 (KST) ────────────────────────────────────────────────────────
const at = iso => new Date(iso);

test('market-hours: 한국 장 세션', () => {
  assert.equal(H.krxSession(at('2026-10-30T08:45:00+09:00')), 'pre');
  assert.equal(H.krxSession(at('2026-10-30T10:00:00+09:00')), 'open');
  assert.equal(H.krxSession(at('2026-10-30T15:40:00+09:00')), 'after');
  assert.equal(H.krxSession(at('2026-10-30T22:00:00+09:00')), 'closed');
  assert.equal(H.krxSession(at('2026-10-31T10:00:00+09:00')), 'holiday', '토요일');
  assert.equal(H.krxSession(at('2026-10-09T10:00:00+09:00')), 'holiday', '한글날');
});

test('market-hours: 미국 세션은 서머타임을 따른다', () => {
  // 2026-10-30 은 EDT (UTC-4): 09:30 ET = 22:30 KST
  assert.equal(H.usSession(at('2026-10-30T22:40:00+09:00')), 'open');
  assert.equal(H.usSession(at('2026-10-30T22:20:00+09:00')), 'pre');
  // 2026-12-01 은 EST (UTC-5): 09:30 ET = 23:30 KST
  assert.equal(H.usSession(at('2026-12-01T23:00:00+09:00')), 'pre');
  assert.equal(H.usSession(at('2026-12-01T23:40:00+09:00')), 'open');
});

test('market-hours: 갱신 주기와 거래일 계산', () => {
  assert.equal(H.refreshInterval(at('2026-10-30T10:00:00+09:00')), 20);
  assert.equal(H.refreshInterval(at('2026-10-30T23:00:00+09:00')), 60, '미국 장중');
  assert.equal(H.refreshInterval(at('2026-11-01T03:00:00+09:00')), 300, '일요일 새벽');
  assert.equal(H.lastTradingDay('2026-10-31'), '2026-10-30');
  assert.equal(H.lastTradingDay('2026-10-09'), '2026-10-08');
  assert.equal(H.kstIso(at('2026-10-30T13:35:26Z')), '2026-10-30T22:35:26+09:00');
});
