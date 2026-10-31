// ─────────────────────────────────────────────────────────────────────────────
// pipeline/analytics.js — 파생 지표 계산 (이동평균, 실현변동성, 백분위, 상관관계 등)
//
// 히스토리 행 형식: { date:'YYYY-MM-DD', close:number, ... } 날짜 오름차순
// ─────────────────────────────────────────────────────────────────────────────

const TRADING_DAYS = 252;

const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;

function std(xs, ddof = 1) {
  if (xs.length <= ddof) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - ddof));
}

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// 히스토리 끝에 실시간 값을 붙인다 (같은 날짜면 교체, 더 과거면 무시)
function mergePoint(rows, day, close) {
  if (close == null || !day) return rows;
  const last = rows[rows.length - 1];
  if (last && last.date === day) return [...rows.slice(0, -1), { ...last, close }];
  if (last && last.date > day) return rows;
  return [...rows, { date: day, close }];
}

// 날짜 기준 병합 (새 값 우선)
function mergeRows(old, fresh) {
  const byDate = new Map(old.map(r => [r.date, r]));
  for (const r of fresh) byDate.set(r.date, r);
  return [...byDate.keys()].sort().map(d => byDate.get(d));
}

const closes = rows => rows.map(r => r.close).filter(v => v != null);

function sma(values, n) {
  return values.length < n ? null : mean(values.slice(-n));
}

function movingAverages(values, periods = [5, 20, 60, 120]) {
  return Object.fromEntries(periods.map(p => [`ma${p}`, round(sma(values, p))]));
}

function logReturns(values) {
  const out = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0 && values[i] > 0) out.push(Math.log(values[i] / values[i - 1]));
  }
  return out;
}

// n일 실현변동성 (연율화 %) 시계열 — 결과 i 번째는 values[i + n] 종가 시점
function realizedVolSeries(values, n = 20) {
  const rets = logReturns(values);
  const out = [];
  for (let i = n; i <= rets.length; i++) out.push(std(rets.slice(i - n, i)) * Math.sqrt(TRADING_DAYS) * 100);
  return out;
}

// 날짜를 붙인 실현변동성 (VKOSPI 위젯의 라인)
function realizedVolRows(rows, n = 21) {
  const vals = rows.map(r => r.close);
  const vol = realizedVolSeries(vals, n);
  return vol.map((v, i) => ({ date: rows[i + n].date, close: round(v, 2) }));
}

// sample 중 x 이하인 비율 (0~100)
function percentileRank(x, sample) {
  if (x == null || !sample.length) return null;
  const below = sample.filter(v => v <= x).length;
  return round((below / sample.length) * 100, 1);
}

function rangePosition(price, low, high) {
  if (price == null || low == null || high == null || high <= low) return null;
  return clamp((price - low) / (high - low), 0, 1);
}

function drawdownPct(price, high) {
  if (price == null || !high) return null;
  return (price / high - 1) * 100;
}

// 끝에서부터 같은 부호가 몇 번 연속인지 (순매도 연속이면 음수)
function signStreak(values) {
  let streak = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v == null || v === 0) break;
    if (streak === 0 || (v > 0) === (streak > 0)) streak += v > 0 ? 1 : -1;
    else break;
  }
  return streak;
}

// 각 a 날짜에 대해 그 날짜 이하의 마지막 b 값을 짝짓는다 (미국 지표처럼 시차가 있는 시계열용)
function asofJoin(aRows, bRows, fn) {
  const out = [];
  let j = -1;
  for (const a of aRows) {
    while (j + 1 < bRows.length && bRows[j + 1].date <= a.date) j++;
    if (j >= 0) out.push({ date: a.date, close: fn(a.close, bRows[j].close) });
  }
  return out;
}

// (날짜, 전일 대비 변화). 금리는 bp 차이, 나머지는 % 수익률
function dailyChanges(rows, asDiff) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].close, b = rows[i].close;
    if (asDiff) out.push([rows[i].date, (b - a) * 100]);
    else if (a) out.push([rows[i].date, (b / a - 1) * 100]);
  }
  return out;
}

// 정렬된 배열에서 x 보다 작은(strict) / 이하(!strict) 마지막 인덱스
function lastIndexBefore(sorted, x, strict) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? sorted[mid] < x : sorted[mid] <= x) lo = mid + 1; else hi = mid;
  }
  return lo - 1;
}

// KOSPI 일간 수익률과 팩터 변화의 상관계수·베타
// lagged 면 KOSPI d일에 대해 d일 '이전' 마지막 팩터 변화(전날 밤 미국장)를 짝짓는다.
function leadLag(baseRows, factorRows, { lagged, asDiff, window = 60 }) {
  const base = dailyChanges(baseRows, false);
  const factor = dailyChanges(factorRows, asDiff);
  if (base.length < 20 || factor.length < 20) return null;
  const fDates = factor.map(f => f[0]);
  let pairs = [];
  for (const [d, k] of base) {
    const idx = lastIndexBefore(fDates, d, lagged);
    if (idx < 0 || (!lagged && fDates[idx] !== d)) continue;
    pairs.push([k, factor[idx][1]]);
  }
  pairs = pairs.slice(-window);
  if (pairs.length < 20) return null;
  const ks = pairs.map(p => p[0]), fs = pairs.map(p => p[1]);
  const mk = mean(ks), mf = mean(fs);
  let cov = 0, vk = 0, vf = 0;
  for (let i = 0; i < pairs.length; i++) {
    cov += (ks[i] - mk) * (fs[i] - mf);
    vk += (ks[i] - mk) ** 2;
    vf += (fs[i] - mf) ** 2;
  }
  if (!vk || !vf) return null;
  const beta = cov / vf;
  const lastChange = factor[factor.length - 1][1];
  return {
    correlation: round(cov / Math.sqrt(vk * vf), 3),
    beta: round(beta, 4),
    last_change: round(lastChange, 2),
    implied_move: round(beta * lastChange, 2),
    window: pairs.length,
  };
}

// ISO 주(월요일 시작) 키
function mondayOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

module.exports = {
  TRADING_DAYS, mean, std, round, clamp, mergePoint, mergeRows, closes, sma, movingAverages,
  logReturns, realizedVolSeries, realizedVolRows, percentileRank, rangePosition, drawdownPct,
  signStreak, asofJoin, dailyChanges, leadLag, mondayOf,
};
