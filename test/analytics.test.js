const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../pipeline/analytics');
const { computeScore, computeHistory, labelFor, cdf, transform } = require('../pipeline/score');
const insights = require('../pipeline/insights');

const rows = (values, start = '2026-01-01') => values.map((close, i) => {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return { date: d.toISOString().slice(0, 10), close };
});

test('mergePoint: 같은 날짜는 교체, 새 날짜는 추가, 과거는 무시', () => {
  const r = rows([1, 2, 3]);
  assert.equal(A.mergePoint(r, r[2].date, 9).at(-1).close, 9);
  assert.equal(A.mergePoint(r, '2026-01-10', 9).length, 4);
  assert.equal(A.mergePoint(r, '2025-12-01', 9), r);
  assert.equal(A.mergePoint(r, null, 9), r);
});

test('mergeRows: 날짜 기준 병합, 새 값 우선', () => {
  const merged = A.mergeRows(rows([1, 2, 3]), [{ date: '2026-01-03', close: 30 }, { date: '2026-01-05', close: 5 }]);
  assert.deepEqual(merged.map(r => r.close), [1, 2, 30, 5]);
});

test('signStreak: 끝에서부터 같은 부호 연속', () => {
  assert.equal(A.signStreak([1, -2, -3, -4]), -3);
  assert.equal(A.signStreak([-1, 2, 3]), 2);
  assert.equal(A.signStreak([1, 0]), 0);
  assert.equal(A.signStreak([]), 0);
});

test('실현변동성: 일정 수익률이면 0, 날짜는 윈도 마지막 종가', () => {
  const flat = rows(Array.from({ length: 30 }, (_, i) => 100 * 1.01 ** i));
  const vol = A.realizedVolRows(flat, 21);
  assert.equal(vol.length, 30 - 21);
  assert.ok(vol.every(v => v.close < 1e-6));
  assert.equal(vol[0].date, flat[21].date);
});

test('percentileRank · rangePosition · drawdown', () => {
  assert.equal(A.percentileRank(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 50);
  assert.equal(A.rangePosition(150, 100, 200), 0.5);
  assert.equal(A.rangePosition(250, 100, 200), 1);
  assert.ok(Math.abs(A.drawdownPct(80, 100) + 20) < 1e-9);
});

test('asofJoin: 각 날짜에 그 이전 마지막 값을 짝짓는다', () => {
  const a = [{ date: '2026-01-02', close: 5 }, { date: '2026-01-05', close: 6 }];
  const b = [{ date: '2026-01-01', close: 1 }, { date: '2026-01-04', close: 2 }];
  assert.deepEqual(A.asofJoin(a, b, (x, y) => x - y), [{ date: '2026-01-02', close: 4 }, { date: '2026-01-05', close: 4 }]);
});

test('leadLag: 완전 비례 시계열은 상관 1, 베타 = 비율', () => {
  const f = [100];
  for (let i = 1; i < 80; i++) f.push(f[i - 1] * (1 + Math.sin(i) / 100));
  const k = [100];
  for (let i = 1; i < 80; i++) k.push(k[i - 1] * (1 + (f[i] / f[i - 1] - 1) * 2));
  const r = A.leadLag(rows(k), rows(f), { lagged: false, asDiff: false });
  assert.ok(r.correlation > 0.999);
  assert.ok(Math.abs(r.beta - 2) < 0.01);
  assert.equal(r.window, 60);
});

test('mondayOf: ISO 주 월요일', () => {
  assert.equal(A.mondayOf('2026-10-30'), '2026-10-26');
  assert.equal(A.mondayOf('2026-10-26'), '2026-10-26');
  assert.equal(A.mondayOf('2026-11-01'), '2026-10-26');
});

test('score: cdf·변환·라벨', () => {
  assert.ok(Math.abs(cdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(cdf(1.96) - 0.975) < 1e-3);
  assert.deepEqual(transform([1, 2, 3], 'level'), [1, 2, 3]);
  assert.equal(transform(Array(25).fill(1), 'sum20')[24], 20);
  assert.deepEqual(labelFor(72), ['위험선호 (Risk-on)', 'risk_on']);
  assert.deepEqual(labelFor(40), ['경계', 'risk_off']);
  assert.deepEqual(labelFor(null), ['계산 불가', 'unknown']);
});

test('MacroScore: 팩터 절반 미만이면 점수를 내지 않는다', () => {
  const series = { kospi: rows(Array.from({ length: 300 }, (_, i) => 100 + i)).map(r => [r.date, r.close]) };
  const s = computeScore(series);
  assert.equal(s.score, null);
  assert.ok(s.coverage < 0.5);
  assert.equal(s.factors.find(f => f.id === 'trend').score > 50, true, '상승 추세는 우호적');
});

test('MacroScore: 모든 팩터가 있으면 0~100 점수와 히스토리', () => {
  const make = (fn, n = 320) => rows(Array.from({ length: n }, (_, i) => fn(i))).map(r => [r.date, r.close]);
  const series = {
    kospi: make(i => 2500 + i * 3 + Math.sin(i / 5) * 20), sox: make(i => 4000 + i * 5 + Math.cos(i / 7) * 50),
    ndx: make(i => 15000 + i * 10 + Math.sin(i / 3) * 80), vix: make(i => 18 + Math.sin(i / 9) * 4),
    usdkrw: make(i => 1300 + Math.sin(i / 11) * 30), us10y: make(i => 4 + Math.sin(i / 13) * 0.3),
    FOREIGN: make(i => Math.sin(i / 4) * 3000),
  };
  const s = computeScore(series);
  assert.ok(s.score > 0 && s.score < 100);
  assert.equal(s.coverage, 1);
  const days = series.kospi.slice(-30).map(r => r[0]);
  const h = computeHistory(series, days);
  assert.equal(h.length, 30);
});

test('insights: 억원 포맷 · 공포탐욕 · 신호는 데이터 없으면 na', () => {
  assert.equal(insights.fmtEok(16230), '+1조 6,230억원');
  assert.equal(insights.fmtEok(-5000), '-5,000억원');
  assert.equal(insights.fmtEok(20000, false), '2조원');
  const signals = insights.buildSignals({ quotes: {}, boards: {}, credit: null, kospiFlows: [], usdkrwRows: [], vkospi: null });
  assert.ok(signals.every(s => s.level === 'na'));
  const fg = insights.fearGreed({ boards: {}, kospiRows: [], usdkrwRows: [] });
  assert.equal(fg.value, null);
  const board = { breadth: { upper: 0, rising: 800, unchanged: 50, falling: 100, lower: 0 }, highs: 90, lows: 10, rv_pct: 20 };
  const up = insights.fearGreed({ boards: { KOSPI: board }, kospiRows: rows(Array.from({ length: 130 }, (_, i) => 100 + i)), usdkrwRows: [] });
  assert.ok(up.value >= 75, `탐욕 쪽이어야 함: ${up.value}`);
  assert.equal(up.label, '극단적 탐욕');
});
