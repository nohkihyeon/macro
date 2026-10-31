// ─────────────────────────────────────────────────────────────────────────────
// pipeline/insights.js — 위험 신호 · 시장 요약 문장 · 공포·탐욕 지수
//
// 데이터가 없으면 '정상'이 아니라 'na'(확인 불가)로 표시한다.
// ─────────────────────────────────────────────────────────────────────────────
const config = require('./config');
const { signStreak, clamp, round } = require('./analytics');

const T = config.thresholds;

// 억원 단위 숫자 → '1조 6,230억원'
function fmtEok(value, signed = true) {
  const sign = signed ? (value > 0 ? '+' : value < 0 ? '-' : '') : '';
  const v = Math.abs(value);
  if (v >= 10000) {
    const jo = Math.floor(Math.round(v) / 10000), rest = Math.round(v) % 10000;
    return rest ? `${sign}${jo}조 ${rest.toLocaleString('ko-KR')}억원` : `${sign}${jo}조원`;
  }
  return `${sign}${Math.round(v).toLocaleString('ko-KR')}억원`;
}

const fmt = (v, d = 2) => v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
const signedPct = (v, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const signal = (id, label, level, message) => ({ id, label, level, message });

function change20(rows) {
  if (rows.length < 21 || !rows[rows.length - 21].close) return null;
  return (rows[rows.length - 1].close / rows[rows.length - 21].close - 1) * 100;
}

// 백분위 → '최근 200일 중 상위 7%' / '1년 중 하위 12%'
function rankText(pct, days) {
  const period = days ? `최근 ${days}일` : '1년';
  if (pct >= 50) return `${period} 중 상위 ${Math.max(100 - pct, 1).toFixed(0)}%`;
  return `${period} 중 하위 ${Math.max(pct, 1).toFixed(0)}%`;
}

function fxSignal(usdkrw, rows) {
  if (!usdkrw || usdkrw.price == null) return signal('fx', '환율', 'na', '데이터 없음');
  const chg20 = change20(rows);
  const levelHit = usdkrw.price >= T.usdkrw;
  const surge = chg20 != null && chg20 >= 3;
  const level = levelHit && surge ? 'danger' : levelHit || surge ? 'warn' : 'ok';
  const parts = [`원/달러 ${fmt(usdkrw.price)}원`];
  if (chg20 != null) parts.push(`20일 ${signedPct(chg20)}`);
  if (levelHit) parts.push(`${T.usdkrw.toLocaleString('ko-KR')}원 이상`);
  return signal('fx', '환율', level, parts.join(' · '));
}

function volatilitySignal(vix, kospi, vkospi) {
  const rank = { ok: 0, warn: 1, danger: 2 };
  let level = 'ok';
  const raise = next => { if (rank[next] > rank[level]) level = next; };
  const parts = [];
  if (vix && vix.price != null) {
    if (vix.price >= T.vixDanger) raise('danger');
    else if (vix.price >= T.vixWarn) raise('warn');
    let chg = vix.change_percent != null ? ` (${signedPct(vix.change_percent)})` : '';
    if (vix.change_percent != null && vix.change_percent >= 15) { raise('warn'); chg += ' 급등'; }
    parts.push(`VIX ${vix.price.toFixed(2)}${chg}`);
  }
  if (vkospi && vkospi.price != null) {
    if (vkospi.change_percent != null && vkospi.change_percent >= 10) raise('warn');
    parts.push(`VKOSPI ${vkospi.price.toFixed(2)}`);
  }
  if (kospi && kospi.rv20 != null) {
    if (kospi.rv_pct != null && kospi.rv_pct >= 90) raise('warn');
    parts.push(`KOSPI 실현변동성 ${kospi.rv20.toFixed(1)}%${kospi.rv_pct != null ? ` (${rankText(kospi.rv_pct)})` : ''}`);
  }
  if (!parts.length) return signal('volatility', '변동성', 'na', '데이터 없음');
  return signal('volatility', '변동성', level, parts.join(' · '));
}

function creditSignal(credit) {
  if (!credit) return signal('credit', '신용잔고', 'na', '데이터 없음');
  const pct = credit.credit_percentile;
  const level = pct != null && pct >= 98 ? 'danger' : pct != null && pct >= T.creditPct ? 'warn' : 'ok';
  const parts = [`신용잔고 ${fmtEok(credit.credit_loan, false)}`];
  if (credit.credit_to_deposit_pct != null) parts.push(`예탁금 대비 ${credit.credit_to_deposit_pct.toFixed(1)}%`);
  if (pct != null) parts.push(rankText(pct, credit.percentile_days));
  return signal('credit', '신용잔고', level, parts.join(' · '));
}

function foreignSignal(flows) {
  const values = flows.map(r => r.foreign);
  if (!values.length || values[values.length - 1] == null) return signal('foreign', '외국인 수급', 'na', '데이터 없음');
  const streak = signStreak(values);
  const n = T.foreignStreak;
  const total = streak ? values.slice(-Math.abs(streak)).reduce((s, v) => s + (v || 0), 0) : 0;
  const level = streak <= -2 * n ? 'danger' : streak <= -n ? 'warn' : 'ok';
  const side = streak > 0 ? '순매수' : '순매도';
  const message = Math.abs(streak) === 1
    ? `KOSPI 외국인 ${side} 전환 (${fmtEok(total)})`
    : `KOSPI 외국인 ${Math.abs(streak)}일 연속 ${side} (누적 ${fmtEok(total)})`;
  return signal('foreign', '외국인 수급', level, message);
}

function trendSignal(board) {
  if (!board || !board.quote || board.quote.price == null || board.ma.ma20 == null) {
    return signal('trend', 'KOSPI 추세', 'na', '데이터 없음');
  }
  const price = board.quote.price, { ma20, ma60 } = board.ma;
  if (ma60 != null && price < ma60 && ma20 < ma60) {
    return signal('trend', 'KOSPI 추세', 'danger', `60일선(${Math.round(ma60).toLocaleString('ko-KR')}) 아래 · 중기 하락 추세`);
  }
  if (price < ma20) return signal('trend', 'KOSPI 추세', 'warn', `20일선(${Math.round(ma20).toLocaleString('ko-KR')}) 하회`);
  return signal('trend', 'KOSPI 추세', 'ok', `20일선(${Math.round(ma20).toLocaleString('ko-KR')}) 위에서 거래`);
}

function drawdownSignal(board) {
  if (!board || board.drawdown_pct == null) return signal('drawdown', '고점 대비 낙폭', 'na', '데이터 없음');
  const dd = board.drawdown_pct;
  if (dd <= -20) return signal('drawdown', '고점 대비 낙폭', 'danger', `52주 고점 대비 ${dd.toFixed(1)}% · 약세장 구간`);
  if (dd <= -10) return signal('drawdown', '고점 대비 낙폭', 'warn', `52주 고점 대비 ${dd.toFixed(1)}% · 조정 구간`);
  return signal('drawdown', '고점 대비 낙폭', 'ok', `52주 고점 대비 ${dd.toFixed(1)}%`);
}

function breadthSignal(board) {
  const b = board && board.breadth;
  if (!b || b.rising + b.falling + b.upper + b.lower === 0) return signal('breadth', '시장 폭', 'na', '데이터 없음');
  const up = b.rising + b.upper, down = b.falling + b.lower;
  const share = down / (up + down);
  let text = `상승 ${up.toLocaleString('ko-KR')} · 하락 ${down.toLocaleString('ko-KR')} · 보합 ${b.unchanged.toLocaleString('ko-KR')}`;
  if (board.highs != null && board.lows != null) text += ` · 52주 신고가 ${board.highs} / 신저가 ${board.lows}`;
  if (share >= 0.75) return signal('breadth', '시장 폭', 'warn', `${text} · 하락 쏠림`);
  return signal('breadth', '시장 폭', 'ok', `${text} · ${share <= 0.4 ? '상승 우위' : '혼조'}`);
}

function curveSignal(quotes) {
  const kr = quotes['kr-term'], us = quotes['us-term'];
  const parts = [];
  let level = 'ok';
  for (const [q, name] of [[kr, '국고 10-3년'], [us, '미국 10-2년']]) {
    if (!q || q.price == null) continue;
    if (q.price < 0) level = 'warn';
    parts.push(`${name} ${q.price >= 0 ? '+' : ''}${q.price.toFixed(2)}%p${q.price < 0 ? ' (역전)' : ''}`);
  }
  if (!parts.length) return signal('curve', '장단기 금리차', 'na', '데이터 없음');
  if (kr && us && kr.price != null && us.price != null && kr.price < 0 && us.price < 0) level = 'danger';
  return signal('curve', '장단기 금리차', level, parts.join(' · '));
}

function buildSignals({ quotes, boards, credit, kospiFlows, usdkrwRows, vkospi }) {
  const kospi = boards.KOSPI;
  return [
    fxSignal(quotes.usdkrw, usdkrwRows),
    volatilitySignal(quotes.vix, kospi, vkospi),
    foreignSignal(kospiFlows),
    trendSignal(kospi),
    drawdownSignal(kospi),
    breadthSignal(kospi),
    creditSignal(credit),
    curveSignal(quotes),
  ];
}

// ── 시장 요약 문장 ────────────────────────────────────────────────────────────
function idx(q) {
  if (!q || q.price == null || q.change_percent == null) return null;
  return `${fmt(q.price)}(${q.change_percent >= 0 ? '+' : ''}${q.change_percent.toFixed(2)}%)`;
}

function buildSummary({ quotes, boards, score, session, feargreed }) {
  const lines = [];
  const kospi = boards.KOSPI, kosdaq = boards.KOSDAQ;
  const kText = kospi && idx(kospi.quote), qText = kosdaq && idx(kosdaq.quote);
  if (kText) {
    const ending = session.krx === 'open' ? '에서 거래 중입니다' : '로 마감했습니다';
    lines.push(`코스피는 ${kText}${qText ? `, 코스닥은 ${qText}` : ''}${ending}.`);
  }
  if (kospi && kospi.breadth) {
    const b = kospi.breadth;
    const up = b.rising + b.upper, down = b.falling + b.lower;
    if (up + down) {
      const more = down > up ? '하락' : '상승';
      lines.push(`코스피 ${more} 종목이 ${Math.max(up, down).toLocaleString('ko-KR')}개로 ${more === '하락' ? '상승' : '하락'} 종목(${Math.min(up, down).toLocaleString('ko-KR')}개)보다 많습니다.`);
    }
  }
  if (kospi && kospi.flows && kospi.flows.foreign != null) {
    const f = kospi.flows;
    const parts = [['외국인', f.foreign], ['기관', f.institution], ['개인', f.individual]]
      .filter(([, v]) => v != null)
      .map(([name, v]) => `${name} ${fmtEok(v, false)} ${v >= 0 ? '순매수' : '순매도'}`);
    lines.push(`${session.krx === 'open' ? '잠정 수급: ' : '수급: '}${parts.join(', ')}.`);
  }
  const us = [['sox', '필라델피아 반도체'], ['ndx', '나스닥100']]
    .map(([id, name]) => [quotes[id], name])
    .filter(([q]) => q && q.change_percent != null)
    .map(([q, name]) => `${name} ${q.change_percent >= 0 ? '+' : ''}${q.change_percent.toFixed(2)}%`);
  if (us.length) lines.push(`최근 미국장: ${us.join(', ')}.`);
  const fx = quotes.usdkrw;
  if (fx && fx.price != null && fx.change != null) {
    const tone = fx.change > 0 ? '원화 약세' : fx.change < 0 ? '원화 강세' : '보합';
    lines.push(`원/달러 환율은 ${fmt(fx.price)}원(${fx.change >= 0 ? '+' : ''}${fmt(fx.change)}원)으로 ${tone}입니다.`);
  }
  if (score && score.score != null) {
    const rated = score.factors.filter(f => f.score != null);
    const good = rated.filter(f => f.score >= 60).sort((a, b) => b.score - a.score).slice(0, 2).map(f => f.label);
    const bad = rated.filter(f => f.score <= 40).sort((a, b) => a.score - b.score).slice(0, 2).map(f => f.label);
    const detail = [good.length && `우호 요인: ${good.join(', ')}`, bad.length && `부담 요인: ${bad.join(', ')}`].filter(Boolean);
    lines.push(`MacroScore ${Math.round(score.score)}점(${score.label})${detail.length ? ` — ${detail.join(' / ')}` : ''}.`);
  }
  if (feargreed && feargreed.value != null) lines.push(`공포·탐욕 지수는 ${feargreed.value}(${feargreed.label})입니다.`);
  return lines;
}

// ── 공포·탐욕 지수 (0~100, 높을수록 탐욕) ──────────────────────────────────────
// 시장 폭(전 종목) · 52주 신고/신저가 · KOSPI 125일선 이격 · 실현변동성 백분위 · 환율 20일 변화
const FG_LABELS = [[75, '극단적 탐욕'], [55, '탐욕'], [45, '중립'], [25, '공포'], [0, '극단적 공포']];
const fgLabel = v => (FG_LABELS.find(([t]) => v >= t) || FG_LABELS[FG_LABELS.length - 1])[1];

function fearGreed({ boards, kospiRows, usdkrwRows }) {
  const scale = (x, lo, hi) => clamp((x - lo) / (hi - lo), 0, 1) * 100;
  const parts = [];
  const add = (id, label, weight, value, display) => { if (value != null && Number.isFinite(value)) parts.push({ id, label, weight, value: Math.round(value), display }); };

  let up = 0, down = 0, highs = 0, lows = 0, hasHL = false;
  for (const b of Object.values(boards)) {
    if (b.breadth) { up += b.breadth.rising + b.breadth.upper; down += b.breadth.falling + b.breadth.lower; }
    if (b.highs != null && b.lows != null) { highs += b.highs; lows += b.lows; hasHL = true; }
  }
  if (up + down) add('breadth', '시장 폭', 25, scale(up / (up + down), 0.25, 0.75), `상승 비율 ${Math.round(up / (up + down) * 100)}%`);
  if (hasHL && highs + lows) add('highlow', '신고가/신저가', 20, highs / (highs + lows) * 100, `신고가 ${highs} · 신저가 ${lows}`);
  const values = kospiRows.map(r => r.close);
  if (values.length >= 125) {
    const ma = values.slice(-125).reduce((s, v) => s + v, 0) / 125;
    const gap = (values[values.length - 1] / ma - 1) * 100;
    add('momentum', '모멘텀', 25, scale(gap, -10, 10), `125일선 대비 ${signedPct(gap)}`);
  }
  const kospi = boards.KOSPI;
  if (kospi && kospi.rv_pct != null) add('volatility', '변동성', 20, 100 - kospi.rv_pct, `실현변동성 1년 백분위 ${Math.round(kospi.rv_pct)}`);
  const fx = change20(usdkrwRows);
  if (fx != null) add('fx', '환율', 10, 100 - scale(fx, -3, 3), `원/달러 20일 ${signedPct(fx)}`);

  const weight = parts.reduce((s, p) => s + p.weight, 0);
  if (weight < 50) return { value: null, label: '계산 불가', components: parts };
  const value = Math.round(clamp(parts.reduce((s, p) => s + p.value * p.weight, 0) / weight, 1, 99));
  return { value, label: fgLabel(value), components: parts };
}

module.exports = { fmtEok, rankText, buildSignals, buildSummary, fearGreed, change20, round };
