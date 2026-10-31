const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDollar, rsi, bollinger, verdictFor } = require('../pipeline/dollar');

const series = (fn, n = 900, start = '2023-06-01') => Array.from({ length: n }, (_, i) => {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return { date: d.toISOString().slice(0, 10), close: fn(i) };
});

test('RSI: 계속 오르면 100, 계속 내리면 0 에 가깝다', () => {
  assert.equal(rsi(Array.from({ length: 30 }, (_, i) => 100 + i)), 100);
  assert.ok(rsi(Array.from({ length: 30 }, (_, i) => 100 - i)) < 1);
  assert.equal(rsi([1, 2, 3]), null);
});

test('볼린저: 마지막 값이 밴드 안에서의 위치(%B)', () => {
  const b = bollinger([...Array(19).fill(100), 110]);
  assert.ok(b.upper > b.mid && b.mid > b.lower);
  assert.ok(b.pctB > 0.9);
});

test('판정 구간', () => {
  assert.equal(verdictFor(80)[1], '매수 적기');
  assert.equal(verdictFor(50)[1], '중립');
  assert.equal(verdictFor(10)[1], '매수 자제');
});

test('3년 평균보다 크게 낮으면 BUY 이고 점수가 높다', () => {
  // 3년 동안 1,400 근처 → 최근 1,250 으로 하락
  const usdkrw = series(i => (i < 840 ? 1400 + Math.sin(i / 9) * 15 : 1400 - (i - 840) * 2.5));
  const d = analyzeDollar({ usdkrw, today: usdkrw[usdkrw.length - 1].date });
  assert.equal(d.dollarscope.status, 'BUY');
  assert.ok(d.score >= 60, `점수 ${d.score}`);
  assert.equal(d.tone, 'buy');
  assert.ok(d.components.find(c => c.id === 'avg3y').signal === 'buy');
  assert.ok(d.levels.length >= 6);
  assert.ok(d.summary[0].includes('BUY'));
});

test('3년 평균보다 크게 높으면 WAIT 이고 점수가 낮다', () => {
  const usdkrw = series(i => (i < 840 ? 1300 + Math.sin(i / 9) * 15 : 1300 + (i - 840) * 2.5));
  const d = analyzeDollar({ usdkrw, today: usdkrw[usdkrw.length - 1].date, vix: { price: 30 } });
  assert.equal(d.dollarscope.status, 'WAIT');
  assert.ok(d.score <= 40, `점수 ${d.score}`);
  assert.equal(d.tone, 'wait');
});

test('방향 압력: 외국인 대량 순매도·금리차 확대는 매수 점수를 올린다', () => {
  const usdkrw = series(i => 1350 + Math.sin(i / 7) * 20);
  const today = usdkrw[usdkrw.length - 1].date;
  const base = analyzeDollar({ usdkrw, today });
  const flows = usdkrw.slice(-20).map(r => ({ date: r.date, foreign: -5000 }));
  const us10y = series(i => 4 + i * 0.002, 900), ktb10 = series(() => 3, 900);
  const pressured = analyzeDollar({ usdkrw, today, flows, us10y, ktb10 });
  assert.ok(pressured.groups.direction > 60);
  assert.ok(pressured.score > base.score - 5);
  assert.equal(analyzeDollar({ usdkrw: usdkrw.slice(0, 100), today }), null, '히스토리가 짧으면 계산하지 않는다');
});
