// ─────────────────────────────────────────────────────────────────────────────
// pipeline/score.js — MacroScore: 한국 증시 매크로 환경 종합 점수 (0~100)
//
// 각 팩터를 최근 1년 분포 대비 z-score 로 표준화하고, 한국 증시에 우호적인 방향이
// 높게 나오도록 부호를 맞춘 뒤 정규분포 누적확률(0~100)로 바꿔 가중평균한다.
//  · 수익률/변화량 계열(ret20, diff20, sum20, gap60): 평균 0 기준 표준화 (x / RMS)
//    → 지난 1년이 상승장이었어도 '오르고 있으면' 우호적으로 본다
//  · 수준 계열(level, VIX): 1년 평균·표준편차 기준 표준화
//  · 미국 지표는 같은 날짜 값을 아직 모르므로 평가일 '이전' 값만 쓴다 (look-ahead 방지)
// ─────────────────────────────────────────────────────────────────────────────
const { mean } = require('./analytics');

const WINDOW = 252;
const MIN_WINDOW = 40;
const Z_CAP = 3;

const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

const FACTORS = [
  { id: 'sox', label: '반도체 모멘텀', series: 'sox', transform: 'ret20', sign: +1, weight: 20, lagged: true,
    display: x => `SOX 20일 ${pct(x)}`, why: '미국 반도체 업황은 삼성전자·SK하이닉스를 통해 KOSPI에 선행' },
  { id: 'usdkrw', label: '원/달러 환율', series: 'usdkrw', transform: 'ret20', sign: -1, weight: 20, lagged: false,
    display: x => `20일 ${pct(x)} (${x > 0 ? '원화 약세' : '원화 강세'})`, why: '원화 약세는 외국인 환차손 우려로 매도 압력을 키움' },
  { id: 'foreign', label: '외국인 수급', series: 'FOREIGN', transform: 'sum20', sign: +1, weight: 15, lagged: false,
    display: x => `20일 누적 ${x >= 0 ? '+' : ''}${Math.round(x).toLocaleString('ko-KR')}억원`, why: '외국인 순매수는 KOSPI 방향을 좌우하는 핵심 수급' },
  { id: 'trend', label: 'KOSPI 추세', series: 'kospi', transform: 'gap60', sign: +1, weight: 15, lagged: false,
    display: x => `60일선 대비 ${pct(x)}`, why: '지수가 60일 평균 위에 있으면 중기 상승 추세' },
  { id: 'ndx', label: '미국 기술주', series: 'ndx', transform: 'ret20', sign: +1, weight: 10, lagged: true,
    display: x => `나스닥100 20일 ${pct(x)}`, why: '미국 기술주 흐름은 KOSDAQ 성장주와 동조' },
  { id: 'us10y', label: '미 10년물 금리', series: 'us10y', transform: 'diff20', sign: -1, weight: 10, lagged: true,
    display: x => `20일 ${x >= 0 ? '+' : ''}${Math.round(x * 100)}bp`, why: '금리 상승은 할인율을 높여 주식 밸류에이션에 부담' },
  { id: 'vix', label: '변동성 (VIX)', series: 'vix', transform: 'level', sign: -1, weight: 10, lagged: true,
    display: x => `VIX ${x.toFixed(1)}`, why: '글로벌 공포지수, 높을수록 위험자산 회피' },
];

const LABELS = [
  [70, '위험선호 (Risk-on)', 'risk_on'],
  [55, '우호적', 'risk_on'],
  [45, '중립', 'neutral'],
  [30, '경계', 'risk_off'],
  [0, '위험회피 (Risk-off)', 'risk_off'],
];

function transform(values, kind) {
  return values.map((v, i) => {
    switch (kind) {
      case 'level': return v;
      case 'ret20': return i >= 20 && values[i - 20] ? v / values[i - 20] - 1 : null;
      case 'diff20': return i >= 20 ? v - values[i - 20] : null;
      case 'sum20': return i >= 19 ? values.slice(i - 19, i + 1).reduce((s, x) => s + x, 0) : null;
      case 'gap60': return i >= 59 ? v / mean(values.slice(i - 59, i + 1)) - 1 : null;
      default: throw new Error(kind);
    }
  });
}

function zScore(x, window, kind) {
  if (window.length < MIN_WINDOW) return null;
  let z;
  if (kind === 'level') {
    const m = mean(window);
    const sd = Math.sqrt(mean(window.map(w => (w - m) ** 2)));
    z = sd ? (x - m) / sd : 0;
  } else {
    const rms = Math.sqrt(mean(window.map(w => w * w)));
    z = rms ? x / rms : 0;
  }
  return Math.max(-Z_CAP, Math.min(Z_CAP, z));
}

// Abramowitz & Stegun 7.1.26 (최대 오차 1.5e-7)
function erf(x) {
  const s = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}
const cdf = z => 0.5 * (1 + erf(z / Math.SQRT2));

// 팩터별 변환 시계열을 한 번만 계산해 두고 날짜별로 조회
function prepare(series) {
  return FACTORS.map(spec => {
    const rows = series[spec.series] || [];
    return { spec, dates: rows.map(r => r[0]), values: transform(rows.map(r => r[1]), spec.transform) };
  });
}

function lastIndex(dates, day, strict) {
  let lo = 0, hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? dates[mid] < day : dates[mid] <= day) lo = mid + 1; else hi = mid;
  }
  return lo - 1;
}

function factorAt(p, day) {
  if (!p.dates.length) return null;
  const idx = day == null ? p.dates.length - 1 : lastIndex(p.dates, day, p.spec.lagged);
  if (idx < 0 || p.values[idx] == null) return null;
  const window = p.values.slice(Math.max(0, idx - WINDOW + 1), idx + 1).filter(v => v != null);
  return { raw: p.values[idx], window, asOf: p.dates[idx] };
}

function evaluate(prepared, day) {
  let total = 0, weightSum = 0;
  const factors = prepared.map(p => {
    const { spec } = p;
    const found = factorAt(p, day);
    let z = null, score = null;
    if (found) {
      z = zScore(found.raw, found.window, spec.transform);
      if (z != null) {
        score = +(cdf(spec.sign * z) * 100).toFixed(1);
        total += score * spec.weight;
        weightSum += spec.weight;
      }
    }
    return {
      id: spec.id, label: spec.label, weight: spec.weight,
      raw: found ? found.raw : null,
      display: found ? spec.display(found.raw) : '데이터 없음',
      z: z == null ? null : +z.toFixed(2),
      score, description: spec.why, as_of: found ? found.asOf : null,
    };
  });
  const weights = FACTORS.reduce((s, f) => s + f.weight, 0);
  return { composite: weightSum ? +(total / weightSum).toFixed(1) : null, coverage: weightSum / weights, factors };
}

function labelFor(score) {
  if (score == null) return ['계산 불가', 'unknown'];
  for (const [threshold, label, tone] of LABELS) if (score >= threshold) return [label, tone];
  return [LABELS[LABELS.length - 1][1], LABELS[LABELS.length - 1][2]];
}

// series: { kospi:[[date, close]...], FOREIGN:[[date, 억원]...], ... }
function computeScore(series) {
  const { composite, coverage, factors } = evaluate(prepare(series), null);
  // 팩터 절반 이상이 비면 점수가 한쪽으로 쏠리므로 내지 않는다
  const score = coverage < 0.5 ? null : composite;
  const [label, tone] = labelFor(score);
  return { score, label, tone, coverage: +coverage.toFixed(2), factors };
}

// 과거 각 날짜에 그날 알 수 있었던 데이터만으로 계산한 점수
function computeHistory(series, days) {
  const prepared = prepare(series);
  const out = [];
  for (const day of days) {
    const { composite, coverage } = evaluate(prepared, day);
    if (composite != null && coverage >= 0.5) out.push({ date: day, score: composite });
  }
  return out;
}

module.exports = { FACTORS, computeScore, computeHistory, labelFor, erf, cdf, transform, zScore };
