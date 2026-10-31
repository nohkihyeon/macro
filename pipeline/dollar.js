// ─────────────────────────────────────────────────────────────────────────────
// pipeline/dollar.js — 원/달러 매수 타이밍 분석 (DollarScope 이식 + 확장)
//
// DollarScope 원칙: 현재 환율 < 3년 평균 → BUY, 그 외 → WAIT
// 여기에 지표 11개를 더해 '지금 달러를 사기에 얼마나 유리한가'를 0~100 으로 점수화한다.
//  · 가격 매력도(50): 3년 평균 대비 · 3년 분포 백분위 · 200일선 · 원화 상대가치(달러인덱스 대비)
//  · 타이밍(25): 볼린저 %B · RSI(14) · 20일 모멘텀 · VIX(공포 국면의 급등 추격 회피)
//  · 방향 압력(25): 한미 금리차 3개월 변화 · 외국인 순매수 20일 · 달러인덱스 20일
//    (원화 약세 압력이 클수록 '오르기 전에 사는' 쪽이 유리 → 점수 ↑)
// 점수가 높을수록 매수에 유리. 데이터가 없는 지표는 빼고 나머지 가중치로 계산한다.
// ─────────────────────────────────────────────────────────────────────────────
const A = require('./analytics');
const { cdf } = require('./score');
const { addDays } = require('./market-hours');

const clamp100 = v => Math.max(0, Math.min(100, v));
const r2 = v => A.round(v, 2);
const pctStr = (v, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const won = v => `${v.toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}원`;

// Wilder RSI
function rsi(values, n = 14) {
  if (values.length <= n) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / n, al = loss / n;
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function bollinger(values, n = 20, k = 2) {
  if (values.length < n) return null;
  const w = values.slice(-n);
  const mid = A.mean(w), sd = A.std(w, 0);
  const upper = mid + k * sd, lower = mid - k * sd;
  const last = values[values.length - 1];
  return { mid, upper, lower, pctB: upper > lower ? (last - lower) / (upper - lower) : 0.5 };
}

const VERDICTS = [
  [70, '매수 적기', 'buy', '여러 지표가 달러가 싼 구간을 가리켜요. 분할 매수 비중을 높여볼 만한 구간입니다.'],
  [55, '분할 매수', 'buy', '평균보다 유리한 편이에요. 한 번에 사기보다 나눠서 사기 좋은 구간입니다.'],
  [45, '중립', 'neutral', '싸지도 비싸지도 않아요. 필요한 만큼만 분할로 접근하는 구간입니다.'],
  [30, '관망', 'wait', '평균보다 비싼 편이에요. 급하지 않다면 기다리거나 소액만 분할하는 구간입니다.'],
  [0, '매수 자제', 'wait', '달러가 비싼 구간이에요. 급등 추격은 피하고 가격이 내려오길 기다리는 구간입니다.'],
];
const verdictFor = score => VERDICTS.find(([t]) => score >= t) || VERDICTS[VERDICTS.length - 1];

function component(group, id, label, weight, score, display, why) {
  if (score == null || !Number.isFinite(score)) return null;
  const s = Math.round(clamp100(score));
  return { group, id, label, weight, score: s, signal: s >= 60 ? 'buy' : s <= 40 ? 'wait' : 'neutral', display, why };
}

// rows: 오래된 → 최신, 실시간 시세를 이미 마지막 점으로 붙인 상태
function analyzeDollar({ usdkrw, dxy = [], us10y = [], ktb10 = [], flows = [], vix = null, bank = null, today }) {
  if (!usdkrw || usdkrw.length < 260) return null;
  const last = usdkrw[usdkrw.length - 1];
  const price = last.close;
  const cutoff3y = addDays(today || last.date, -1096);
  const rows3y = usdkrw.filter(r => r.date >= cutoff3y);
  const v3 = rows3y.map(r => r.close);
  const all = usdkrw.map(r => r.close);
  const avg3y = A.mean(v3), std3y = A.std(v3, 0);
  // 히스토리가 3년보다 짧으면(수집 초기 등) 실제 기간으로 표기
  const years = v3.length / 252;
  const win = years >= 2.8 ? '3년' : `${years.toFixed(1)}년`;
  const z = std3y ? (price - avg3y) / std3y : 0;
  const pct3y = A.percentileRank(price, v3);
  const ma200 = A.sma(all, 200), ma60 = A.sma(all, 60), ma20 = A.sma(all, 20);
  const bb = bollinger(all, 20, 2);
  const rsi14 = rsi(all.slice(-250), 14);
  const chg20 = all.length > 21 ? (price / all[all.length - 21] - 1) * 100 : null;
  const year = all.slice(-252);
  const high52 = Math.max(...year), low52 = Math.min(...year);
  const vol = A.realizedVolSeries(all.slice(-61), 20);
  const rv20 = vol.length ? vol[vol.length - 1] : null;

  const comps = [];
  const push = c => c && comps.push(c);

  // ── 가격 매력도 ──
  push(component('valuation', 'avg3y', `${win} 평균 대비 (DollarScope 원칙)`, 20, cdf(-z) * 100,
    `${win} 평균 ${won(avg3y)} 대비 ${pctStr((price / avg3y - 1) * 100)} · ${price < avg3y ? 'BUY' : 'WAIT'}`,
    '장기 평균보다 낮을 때 사면 평균 매입 단가를 낮출 수 있어요 (DollarScope 기본 규칙).'));
  push(component('valuation', 'pct3y', `${win} 분포 위치`, 10, 100 - pct3y,
    `${win} 중 ${pct3y >= 50 ? `상위 ${Math.max(1, Math.round(100 - pct3y))}%` : `하위 ${Math.max(1, Math.round(pct3y))}%`} 수준`,
    '최근 3년 동안의 환율 중 지금이 얼마나 낮은 쪽에 있는지예요.'));
  if (ma200) {
    const gap = (price / ma200 - 1) * 100;
    push(component('valuation', 'ma200', '200일 이동평균 대비', 10, 50 - gap * 10,
      `200일선 ${won(ma200)} 대비 ${pctStr(gap)}`, '장기 추세선 아래에 있으면 상대적으로 싼 구간이에요.'));
  }
  // 원화 상대가치: 원/달러 ÷ 달러인덱스 — 높을수록 '달러 강세보다 원화 고유 약세'가 큰 상태
  if (dxy.length > 260) {
    const ratio = A.asofJoin(rows3y, dxy, (k, d) => (d ? k / d : null)).filter(r => r.close != null);
    if (ratio.length > 200) {
      const cur = ratio[ratio.length - 1].close;
      const p = A.percentileRank(cur, ratio.map(r => r.close));
      push(component('valuation', 'krwrel', '원화 상대가치 (달러인덱스 대비)', 10, 100 - p,
        `원/달러 ÷ 달러인덱스 비율 ${win} 중 ${p >= 50 ? `상위 ${Math.max(1, Math.round(100 - p))}%` : `하위 ${Math.max(1, Math.round(p))}%`}`,
        '글로벌 달러보다 원화가 유독 약하면(비율 높음) 되돌림 여지가 있어 서두를 필요가 적어요.'));
    }
  }

  // ── 타이밍 ──
  if (bb) {
    push(component('timing', 'bollinger', '볼린저 밴드 위치 (20일)', 8, (1 - bb.pctB) * 100,
      `%B ${Math.round(bb.pctB * 100)} · 하단 ${won(bb.lower)} / 상단 ${won(bb.upper)}`,
      '밴드 하단 근처는 단기적으로 눌린 자리, 상단 돌파는 단기 과열이에요.'));
  }
  if (rsi14 != null) {
    push(component('timing', 'rsi', 'RSI (14일)', 7, 100 - rsi14,
      `RSI ${rsi14.toFixed(0)}${rsi14 <= 30 ? ' · 과매도' : rsi14 >= 70 ? ' · 과매수' : ''}`,
      '30 이하면 달러가 단기 과매도(매수 유리), 70 이상이면 과매수(추격 주의)예요.'));
  }
  if (chg20 != null) {
    push(component('timing', 'momentum', '20일 모멘텀', 5, 50 - chg20 * (50 / 3),
      `20일 ${pctStr(chg20)}`, '최근 급등했다면 숨 고르기를 기다리는 편이 유리해요.'));
  }
  if (vix && vix.price != null) {
    push(component('timing', 'vix', '위험회피 강도 (VIX)', 5, 100 - (vix.price - 12) * 4,
      `VIX ${vix.price.toFixed(1)}${vix.price >= 25 ? ' · 공포 국면' : ''}`,
      '공포 국면엔 달러가 순간적으로 치솟았다가 되돌아오는 경우가 많아 추격 매수를 피하는 게 좋아요.'));
  }

  // ── 방향 압력 (원화 약세 압력 ↑ → 지금 사는 쪽이 유리) ──
  if (us10y.length > 70 && ktb10.length > 70) {
    const sp = A.asofJoin(us10y, ktb10, (u, k) => u - k);
    if (sp.length > 64) {
      const now = sp[sp.length - 1].close, before = sp[sp.length - 64].close;
      const d = now - before;
      push(component('direction', 'spread', '한미 금리차 추세 (3개월)', 10, 50 + d * 100,
        `미 10년 − 국고 10년 ${now >= 0 ? '+' : ''}${now.toFixed(2)}%p (3개월 ${d >= 0 ? '+' : ''}${d.toFixed(2)}%p)`,
        '금리차가 벌어지면 달러 쪽으로 자금이 쏠려 환율 상승 압력이 커져요.'));
    }
  }
  const f20 = flows.slice(-20).map(r => r.foreign).filter(v => v != null);
  if (f20.length >= 10) {
    const sum = f20.reduce((s, v) => s + v, 0);
    push(component('direction', 'foreign', '외국인 주식 수급 (20일)', 10, 50 - (sum / 50000) * 50,
      `KOSPI 외국인 20일 ${sum >= 0 ? '+' : ''}${Math.round(sum).toLocaleString('ko-KR')}억원`,
      '외국인이 주식을 팔면 달러 수요가 늘어 원화 약세(환율 상승) 압력이 생겨요.'));
  }
  if (dxy.length > 21) {
    const dv = dxy[dxy.length - 1].close / dxy[dxy.length - 21].close - 1;
    push(component('direction', 'dxy', '글로벌 달러 강세 (달러인덱스 20일)', 5, 50 + dv * 100 * (50 / 3),
      `달러인덱스 ${dxy[dxy.length - 1].close.toFixed(2)} (20일 ${pctStr(dv * 100)})`,
      '글로벌 달러가 강해지는 국면이면 원/달러도 따라 오르기 쉬워요.'));
  }

  const weight = comps.reduce((s, c) => s + c.weight, 0);
  const score = weight ? Math.round(comps.reduce((s, c) => s + c.score * c.weight, 0) / weight) : null;
  const [, label, tone, advice] = verdictFor(score ?? 50);
  const group = g => {
    const cs = comps.filter(c => c.group === g);
    const w = cs.reduce((s, c) => s + c.weight, 0);
    return w ? Math.round(cs.reduce((s, c) => s + c.score * c.weight, 0) / w) : null;
  };

  const levels = [
    [`${win} 평균 +1σ`, avg3y + std3y], ['52주 최고', high52], ['볼린저 상단', bb && bb.upper],
    ['200일선', ma200], [`${win} 평균`, avg3y], ['볼린저 하단', bb && bb.lower],
    [`${win} 평균 −1σ`, avg3y - std3y], ['52주 최저', low52], [`${win} 평균 −2σ`, avg3y - 2 * std3y],
  ].filter(([, p]) => p != null)
    .map(([lbl, p]) => ({ label: lbl, price: r2(p), diff_pct: r2((p / price - 1) * 100) }))
    .sort((a, b) => b.price - a.price);

  const summary = [];
  summary.push(`원/달러 ${won(price)}은 ${win} 평균(${won(avg3y)})보다 ${Math.abs((price / avg3y - 1) * 100).toFixed(1)}% ${price < avg3y ? '낮아 DollarScope 기준 BUY' : '높아 DollarScope 기준 WAIT'} 구간이에요.`);
  summary.push(`최근 ${win} 중 ${pct3y >= 50 ? `상위 ${Math.max(1, Math.round(100 - pct3y))}%` : `하위 ${Math.max(1, Math.round(pct3y))}%`} 수준이고, 52주 범위는 ${won(low52)} ~ ${won(high52)}예요.`);
  if (rsi14 != null && bb) {
    const t = rsi14 <= 30 || bb.pctB <= 0.1 ? '단기 과매도로 눌린 자리' : rsi14 >= 70 || bb.pctB >= 0.9 ? '단기 과열 구간' : '단기적으로는 중립';
    summary.push(`RSI ${rsi14.toFixed(0)} · 볼린저 %B ${Math.round(bb.pctB * 100)}로 ${t}이에요.`);
  }
  const dir = comps.filter(c => c.group === 'direction');
  if (dir.length) {
    const up = dir.filter(c => c.score >= 60).map(c => c.label.replace(/ \(.*\)/, ''));
    const down = dir.filter(c => c.score <= 40).map(c => c.label.replace(/ \(.*\)/, ''));
    if (up.length) summary.push(`환율 상승 압력: ${up.join(', ')} — 너무 오래 기다리면 더 비싸질 수 있어요.`);
    if (down.length) summary.push(`환율 하락 압력: ${down.join(', ')} — 서두르지 않아도 되는 요인이에요.`);
  }
  if (rv20 != null && rv20 >= 10) summary.push(`최근 변동성(연 ${rv20.toFixed(1)}%)이 높아 한 번에 사기보다 날짜를 나눠 사는 게 안전해요.`);

  return {
    price: r2(price), date: last.date, score, label, tone, advice,
    groups: { valuation: group('valuation'), timing: group('timing'), direction: group('direction') },
    coverage: +(weight / 100).toFixed(2),
    dollarscope: { status: price < avg3y ? 'BUY' : 'WAIT', avg3y: r2(avg3y), diff: r2(price - avg3y), diff_pct: r2((price / avg3y - 1) * 100) },
    stats: {
      avg3y: r2(avg3y), std3y: r2(std3y), z3y: r2(z), pct3y, ma20: r2(ma20), ma60: r2(ma60), ma200: r2(ma200),
      high52w: r2(high52), low52w: r2(low52), rsi14: r2(rsi14), chg20: r2(chg20), rv20: r2(rv20), window: win,
      bb: bb ? { upper: r2(bb.upper), mid: r2(bb.mid), lower: r2(bb.lower), pctB: r2(bb.pctB) } : null,
      days3y: v3.length,
    },
    components: comps, levels, summary,
    bank: bank ? { ...bank, cash_spread_pct: bank.cash_buy && bank.base ? r2((bank.cash_buy / bank.base - 1) * 100) : null, send_spread_pct: bank.send && bank.base ? r2((bank.send / bank.base - 1) * 100) : null } : null,
  };
}

module.exports = { analyzeDollar, rsi, bollinger, verdictFor };
