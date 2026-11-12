// ─────────────────────────────────────────────────────────────────────────────
// pipeline/tracker.js — 지표추적 (이동평균선 위치 · 돌파/이탈 · 20주선 · 주봉 꼬리)
//
// 일별 히스토리 하나로 한 종목/지표의 '선 위치'를 계산한다.
//  · 일봉 5 · 20 · 60일선: 현재가가 위/아래인지, 이격, 마지막으로 선을 넘은 게 며칠 전인지
//  · 주봉 20주선: 월요일 기준 주봉으로 묶어 같은 계산 (이번 주는 진행 중인 주봉)
//  · 이번 주 주봉 모양: 윗꼬리·아랫꼬리 비율 (종가만 있는 지표는 일별 종가로 만든 근사 주봉)
//  · 배열: 5 > 20 > 60 정배열 / 역배열 / 혼조
// 지지·저항 기준선은 사용자가 정하는 값이라 브라우저에서 계산한다.
// ─────────────────────────────────────────────────────────────────────────────
const A = require('./analytics');

const DAILY_PERIODS = [5, 20, 60];
const WEEKLY_PERIOD = 20;
const SERIES_TAIL = 130;     // 차트용으로 돌려줄 최근 거래일 수
const WICK_ALERT = 0.5;      // 꼬리가 주봉 전체 범위의 절반 이상이면 의미 있는 꼬리로 본다

// 이동평균 시계열 (앞쪽 n-1 개는 null)
function maSeries(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// 마지막 값 기준 선 위치 + 마지막으로 선을 넘은 시점 (ago = 몇 봉 전, 0 = 오늘/이번 주)
function linePosition(values, ma) {
  const last = values.length - 1;
  if (last < 0 || ma[last] == null) return null;
  const above = values[last] >= ma[last];
  let ago = null;
  for (let i = last; i > 0; i--) {
    if (ma[i - 1] == null) break;
    if ((values[i] >= ma[i]) !== (values[i - 1] >= ma[i - 1])) { ago = last - i; break; }
  }
  const value = ma[last];
  return {
    value: A.round(value, 4),
    above,
    diff: A.round(values[last] - value, 4),
    dist_pct: value ? A.round(((values[last] - value) / Math.abs(value)) * 100, 2) : null,
    cross: ago == null ? null : { dir: above ? 'up' : 'down', ago },
  };
}

// 일봉 → 주봉 (월요일 키). OHLC 가 없으면 종가로 고저를 만든다
function toWeekly(rows) {
  const weeks = [];
  for (const r of rows) {
    if (r.close == null) continue;
    const week = A.mondayOf(r.date);
    const hi = r.high != null ? r.high : r.close;
    const lo = r.low != null ? r.low : r.close;
    const cur = weeks[weeks.length - 1];
    if (!cur || cur.week !== week) {
      weeks.push({ week, open: r.open != null ? r.open : r.close, high: hi, low: lo, close: r.close, days: 1 });
    } else {
      cur.high = Math.max(cur.high, hi);
      cur.low = Math.min(cur.low, lo);
      cur.close = r.close;
      cur.days += 1;
    }
  }
  return weeks;
}

// 주봉 모양: 몸통·꼬리 비율과 한 줄 해석
function candleShape(bar) {
  if (!bar) return null;
  const range = bar.high - bar.low;
  const top = Math.max(bar.open, bar.close), bottom = Math.min(bar.open, bar.close);
  const upper = range > 0 ? (bar.high - top) / range : 0;
  const lower = range > 0 ? (bottom - bar.low) / range : 0;
  const body = range > 0 ? (top - bottom) / range : 0;
  let shape = 'flat', label = '보합권';
  if (range > 0) {
    if (upper >= WICK_ALERT) { shape = 'upper_wick'; label = '윗꼬리 (위에서 매도 압력)'; }
    else if (lower >= WICK_ALERT) { shape = 'lower_wick'; label = '아랫꼬리 (아래에서 매수 유입)'; }
    else if (body >= 0.6) { shape = bar.close >= bar.open ? 'long_up' : 'long_down'; label = bar.close >= bar.open ? '장대 양봉' : '장대 음봉'; }
    else { shape = bar.close >= bar.open ? 'up' : 'down'; label = bar.close >= bar.open ? '양봉' : '음봉'; }
  }
  return {
    week: bar.week, open: bar.open, high: bar.high, low: bar.low, close: bar.close, days: bar.days,
    upper_wick: A.round(upper, 2), lower_wick: A.round(lower, 2), body: A.round(body, 2), shape, label,
  };
}

function alignment(ma) {
  const [a, b, c] = DAILY_PERIODS.map(p => ma[`ma${p}`] && ma[`ma${p}`].value);
  if (a == null || b == null || c == null) return null;
  if (a > b && b > c) return 'bull';
  if (a < b && b < c) return 'bear';
  return 'mixed';
}

// rows: [{date, close, (open, high, low)}] 오래된 순
function analyze(rows) {
  const clean = (rows || []).filter(r => r && r.date && Number.isFinite(r.close));
  if (clean.length < 2) return null;
  const closes = clean.map(r => r.close);
  const last = clean[clean.length - 1];
  const prev = clean[clean.length - 2];
  const ohlc = clean.slice(-30).every(r => r.high != null && r.low != null && r.open != null);

  const daily = {}, maCols = {};
  for (const p of DAILY_PERIODS) {
    maCols[p] = maSeries(closes, p);
    daily[`ma${p}`] = linePosition(closes, maCols[p]);
  }

  const weeks = toWeekly(clean);
  const wCloses = weeks.map(w => w.close);
  const wMa = maSeries(wCloses, WEEKLY_PERIOD);
  const ma20w = linePosition(wCloses, wMa);
  const weekMaByKey = new Map(weeks.map((w, i) => [w.week, wMa[i]]));

  const lines = [daily.ma5, daily.ma20, daily.ma60, ma20w].filter(Boolean);
  const tail = clean.slice(-SERIES_TAIL);
  const offset = clean.length - tail.length;
  return {
    date: last.date,
    price: last.close,
    change: A.round(last.close - prev.close, 4),
    change_pct: prev.close ? A.round(((last.close - prev.close) / Math.abs(prev.close)) * 100, 2) : null,
    ohlc,
    ma: { ...daily, ma20w },
    alignment: alignment(daily),
    above_count: lines.filter(l => l.above).length,
    line_count: lines.length,
    week: candleShape(weeks[weeks.length - 1]),
    prev_week: candleShape(weeks[weeks.length - 2]),
    series: tail.map((r, i) => ({
      date: r.date, close: r.close,
      ma5: A.round(maCols[5][offset + i], 4), ma20: A.round(maCols[20][offset + i], 4), ma60: A.round(maCols[60][offset + i], 4),
      ma20w: A.round(weekMaByKey.get(A.mondayOf(r.date)), 4),
    })),
  };
}

module.exports = { analyze, maSeries, linePosition, toWeekly, candleShape, DAILY_PERIODS, WEEKLY_PERIOD, WICK_ALERT };
