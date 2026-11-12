// 지표추적: 이동평균선 위치 · 돌파 시점 · 주봉 · 꼬리 판정
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../pipeline/tracker');

// 2025-01-06(월)부터 평일만 n일
function days(n) {
  const out = [];
  const d = new Date('2025-01-06T00:00:00Z');
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const rowsOf = values => days(values.length).map((date, i) => ({ date, close: values[i] }));

test('maSeries: 단순 이동평균, 앞쪽은 null', () => {
  assert.deepEqual(T.maSeries([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('linePosition: 위/아래 · 이격 · 마지막 교차 시점', () => {
  // 10까지 오르다 꺾여 내려감 → 3일선 아래로 이탈
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 8, 6];
  const pos = T.linePosition(values, T.maSeries(values, 3));
  assert.equal(pos.above, false);
  assert.equal(pos.cross.dir, 'down');
  assert.equal(pos.cross.ago, 1);       // 8 일 때 이미 (10+9+8)/3=9 아래
  assert.ok(pos.dist_pct < 0);
});

test('linePosition: 교차가 없으면 cross=null, 데이터 부족이면 null', () => {
  const up = [1, 2, 3, 4, 5, 6];
  assert.equal(T.linePosition(up, T.maSeries(up, 3)).cross, null);
  assert.equal(T.linePosition([1, 2], T.maSeries([1, 2], 3)), null);
});

test('toWeekly: 월요일 기준으로 묶고 OHLC 가 없으면 종가로 고저', () => {
  const w = T.toWeekly(rowsOf([10, 12, 9, 11, 10, 20]));
  assert.equal(w.length, 2);
  assert.deepEqual(w[0], { week: '2025-01-06', open: 10, high: 12, low: 9, close: 10, days: 5 });
  assert.equal(w[1].close, 20);
});

test('candleShape: 윗꼬리 · 아랫꼬리 · 장대 양봉', () => {
  assert.equal(T.candleShape({ week: 'w', open: 100, high: 120, low: 99, close: 102 }).shape, 'upper_wick');
  assert.equal(T.candleShape({ week: 'w', open: 100, high: 101, low: 80, close: 99 }).shape, 'lower_wick');
  assert.equal(T.candleShape({ week: 'w', open: 100, high: 111, low: 99, close: 110 }).shape, 'long_up');
  assert.equal(T.candleShape({ week: 'w', open: 100, high: 100, low: 100, close: 100 }).shape, 'flat');
});

test('analyze: 상승 추세면 정배열 · 모든 선 위 · 20주선 계산', () => {
  const values = Array.from({ length: 160 }, (_, i) => 100 + i);
  const t = T.analyze(rowsOf(values));
  assert.equal(t.alignment, 'bull');
  assert.equal(t.above_count, 4);
  assert.equal(t.line_count, 4);
  assert.ok(t.ma.ma20w.value > 0);
  assert.equal(t.ma.ma5.value, 257);
  assert.equal(t.ohlc, false);
  assert.equal(t.series.length, 130);
  assert.ok(t.series[t.series.length - 1].ma20w != null);
});

test('volumeProfile: 거래량이 몰린 가격대가 최다 구간(poc)', () => {
  // 100~110 에서 거래량 1000, 110~120 에서 100 → 매물대 최다는 아래쪽
  const rows = days(20).map((date, i) => (i < 15
    ? { date, open: 105, high: 110, low: 100, close: 105, volume: 1000 }
    : { date, open: 115, high: 120, low: 110, close: 115, volume: 100 }));
  const p = T.volumeProfile(rows, 20, 4);
  assert.equal(p.bins.length, 4);
  assert.ok(p.poc.hi <= 110.0001);
  assert.equal(p.poc.share, 1);
  const pct = p.bins.reduce((s, b) => s + b.pct, 0);
  assert.ok(Math.abs(pct - 100) < 0.5);
});

test('volumeProfile: 거래량이 없으면 null, analyze 도 profile=null', () => {
  assert.equal(T.volumeProfile(rowsOf([1, 2, 3, 4, 5, 6, 7, 8]), 8), null);
  assert.equal(T.analyze(rowsOf([1, 2, 3, 4, 5, 6])).profile, null);
});

test('analyze: 거래량이 있으면 1달·3달·6달 매물대를 돌려준다', () => {
  const rows = days(160).map((date, i) => ({ date, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 500 }));
  const t = T.analyze(rows);
  assert.ok(t.profile['3m'].bins.length > 0);
  assert.ok(t.profile['1m'].poc.lo >= t.profile['3m'].bins[0].lo);
});

test('analyze: 데이터가 짧으면 긴 선은 null, 2개 미만이면 null', () => {
  const t = T.analyze(rowsOf([1, 2, 3, 4, 5, 6]));
  assert.ok(t.ma.ma5);
  assert.equal(t.ma.ma20, null);
  assert.equal(t.ma.ma20w, null);
  assert.equal(t.alignment, null);
  assert.equal(T.analyze(rowsOf([1])), null);
});
