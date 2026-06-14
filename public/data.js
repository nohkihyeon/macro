// ─────────────────────────────────────────────────────────────────────────────
// data.js — 지표 카탈로그 · 포맷터 · 라이브 페치 + 합성 폴백
//
//  · 위젯은 즉시 합성 시계열로 렌더 → /api/* 라이브 데이터가 오면 교체(LIVE 배지).
//  · 서버가 없거나 라이브 미지원이면 합성 샘플 유지(샘플 배지). 디자인은 항상 보임.
// ─────────────────────────────────────────────────────────────────────────────

// ── 시드 기반 의사난수 (서버 catalog.js 와 동일 알고리즘) ──────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function genSeries(seed, start, end, vol, n) {
  n = n || 1260;
  const rand = mulberry32(seed);
  const pts = new Array(n);
  let v = start;
  const drift = (end - start) / n;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / (90 + (seed % 60))) * vol * 2.2 + Math.sin(i / (37 + (seed % 17))) * vol * 0.9;
    v += drift + (rand() - 0.5) * 2 * vol + wave * 0.04;
    if (v < end * 0.12) v = end * 0.12 + rand() * vol;
    pts[i] = v;
  }
  const adj = (end - pts[n - 1]) / 60;
  for (let i = n - 60; i < n; i++) pts[i] += adj * (i - (n - 60));
  return pts;
}
function genDates(n) {
  const out = new Array(n);
  const d = new Date();
  let i = n - 1;
  while (i >= 0) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) { out[i] = new Date(d); i--; }
    d.setDate(d.getDate() - 1);
  }
  return out;
}
const DATES_5Y = genDates(1260);

// ── 지표 카탈로그 ─────────────────────────────────────────────────────────────
// kind: line | bars | gauge | sectors | treemap | multiline | dual | investors
// span: 위젯 그리드 가로 칸 수(2 = 와이드 패널)
const INDICATORS = [
  // 시장
  { id: 'kospi',   cat: 'market', name: '코스피',        unit: '',  dec: 2, seed: 11, start: 2480, end: 3052.74, vol: 9 },
  { id: 'kosdaq',  cat: 'market', name: '코스닥',        unit: '',  dec: 2, seed: 12, start: 845,  end: 884.21,  vol: 4.5 },
  { id: 'k200fut', cat: 'market', name: '코스피200 선물', unit: '',  dec: 2, seed: 13, start: 330,  end: 408.35,  vol: 1.6 },
  // 금리
  { id: 'baserate', cat: 'rates', name: '기준금리',   unit: '%', dec: 2, seed: 21, start: 3.50, end: 2.50, vol: 0.012, step: true },
  { id: 'callrate', cat: 'rates', name: '콜금리',     unit: '%', dec: 2, seed: 22, start: 3.52, end: 2.49, vol: 0.018 },
  { id: 'ktb3',     cat: 'rates', name: '국고채 3년',  unit: '%', dec: 3, seed: 23, start: 3.42, end: 2.781, vol: 0.022 },
  { id: 'ktb10',    cat: 'rates', name: '국고채 10년', unit: '%', dec: 3, seed: 24, start: 3.55, end: 3.054, vol: 0.024 },
  { id: 'cd91',     cat: 'rates', name: 'CD 91일',    unit: '%', dec: 2, seed: 25, start: 3.40, end: 2.95, vol: 0.015 },
  { id: 'corp3',    cat: 'rates', name: '회사채 3년',  unit: '%', dec: 2, seed: 26, start: 4.10, end: 3.60, vol: 0.02 },
  // 환율
  { id: 'usdkrw', cat: 'fx', name: '원/달러 환율',  unit: '원', dec: 1, seed: 31, start: 1305, end: 1362.5, vol: 4.2 },
  { id: 'jpykrw', cat: 'fx', name: '원/100엔 환율', unit: '원', dec: 2, seed: 32, start: 965,  end: 882.4,  vol: 3.4 },
  { id: 'eurkrw', cat: 'fx', name: '원/유로 환율',  unit: '원', dec: 1, seed: 33, start: 1420, end: 1476.8, vol: 4.6 },
  // 원자재
  { id: 'wti',    cat: 'commodity', name: 'WTI 원유', unit: '$', dec: 2, seed: 41, start: 78,   end: 72.40,  vol: 1.1 },
  { id: 'gold',   cat: 'commodity', name: '금 현물',  unit: '$', dec: 2, seed: 42, start: 2050, end: 3248.6, vol: 16 },
  { id: 'copper', cat: 'commodity', name: '구리 선물', unit: '$', dec: 2, seed: 43, start: 4.1,  end: 4.62,   vol: 0.05 },
  // 수급 (막대)
  { id: 'flow-foreign', cat: 'flow', name: '외국인 순매수', unit: '억원', dec: 0, seed: 51, kind: 'bars', scale: 4200 },
  { id: 'flow-inst',    cat: 'flow', name: '기관 순매수',   unit: '억원', dec: 0, seed: 52, kind: 'bars', scale: 3100 },
  { id: 'flow-retail',  cat: 'flow', name: '개인 순매수',   unit: '억원', dec: 0, seed: 53, kind: 'bars', scale: 3800 },
  // 심리
  // vkospi 라이브: 현재가=V-KOSPI 선물(KRX:VKI1!) · 라인=KOSPI 21일 실현변동성(연율화 %)
  { id: 'vkospi',   cat: 'sentiment', name: '코스피 변동성지수(VKOSPI)', alias: 'V-KOSPI 코스피변동지수 변동성선물', unit: '', dec: 1, seed: 61, start: 19, end: 16.42, vol: 0.45 },
  { id: 'vix',      cat: 'sentiment', name: 'VIX 변동성', unit: '', dec: 2, seed: 63, start: 18, end: 20.7, vol: 0.8 },
  { id: 'feargreed',cat: 'sentiment', name: '공포·탐욕 지수', unit: '', dec: 0, seed: 62, kind: 'gauge', value: 62 },
  // 업종
  { id: 'sectors', cat: 'market', name: '업종별 등락', unit: '%', dec: 2, seed: 71, kind: 'sectors' },

  // ── 와이드 패널 (macro 이식 차트) ──
  { id: 'treemap-kospi',  cat: 'market', name: '코스피 시총 트리맵',  kind: 'treemap', market: 'kospi',  span: 2 },
  { id: 'treemap-kosdaq', cat: 'market', name: '코스닥 시총 트리맵',  kind: 'treemap', market: 'kosdaq', span: 2 },
  { id: 'global',         cat: 'market', name: '글로벌 지수 1년 비교', kind: 'multiline', span: 2 },
  { id: 'flow-cum',       cat: 'flow',   name: '투자자별 누적 순매수', kind: 'investors', span: 2 },
  { id: 'foreign-kospi',  cat: 'flow',   name: '외국인 수급 vs 코스피', kind: 'dual', span: 2 },
  { id: 'flow-board',     cat: 'flow',   name: '투자자 수급 종합 보드', kind: 'flowboard', span: 2 },
];

const IND_BY_ID = Object.fromEntries(INDICATORS.map(i => [i.id, i]));

const SECTOR_ROWS = [
  { name: '반도체', chg: +2.41 }, { name: '2차전지', chg: +1.87 },
  { name: '자동차', chg: +0.92 }, { name: '바이오', chg: +0.55 },
  { name: '금융', chg: +0.31 }, { name: '인터넷·게임', chg: -0.18 },
  { name: '철강·소재', chg: -0.47 }, { name: '건설', chg: -0.83 },
  { name: '유통·소비재', chg: -1.12 }, { name: '조선·기계', chg: +1.34 },
];

// ── 합성 시계열 캐시 ──────────────────────────────────────────────────────────
const seriesCache = {};
function getSeries(ind) {
  if (seriesCache[ind.id]) return seriesCache[ind.id];
  let values;
  if (ind.kind === 'bars') {
    const rand = mulberry32(ind.seed);
    let bias = 0; values = new Array(1260);
    for (let i = 0; i < 1260; i++) {
      if (i % 40 === 0) bias = (rand() - 0.5) * 0.8;
      values[i] = Math.round((rand() - 0.5 + bias * 0.5) * 2 * ind.scale);
    }
  } else if (ind.step) {
    const raw = genSeries(ind.seed, ind.start, ind.end, ind.vol, 1260);
    values = raw.map(v => Math.round(v * 4) / 4);
    for (let i = 0; i < 1260; i += 50) {
      const lv = values[Math.min(i + 25, 1259)];
      for (let j = i; j < Math.min(i + 50, 1260); j++) values[j] = lv;
    }
  } else if (ind.kind === 'gauge' || ind.kind === 'sectors') {
    values = null;
  } else {
    values = genSeries(ind.seed, ind.start, ind.end, ind.vol, 1260);
  }
  seriesCache[ind.id] = values;
  return values;
}

const PERIODS = [
  { key: '1w', label: '1주', n: 5 },
  { key: '1m', label: '1달', n: 21 },
  { key: '1y', label: '1년', n: 252 },
  { key: '5y', label: '5년', n: 1260 },
];

function sliceSeries(ind, periodKey) {
  const all = getSeries(ind);
  if (!all) return null;
  const p = PERIODS.find(p => p.key === periodKey) || PERIODS[2];
  return { values: all.slice(-p.n), dates: DATES_5Y.slice(-p.n) };
}

// ── 포맷터 ────────────────────────────────────────────────────────────────────
function fmtNum(v, dec) {
  if (v == null || isNaN(v)) return '–';
  return v.toLocaleString('ko-KR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtDate(d, periodKey) {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt)) return String(d);
  if (periodKey === '5y' || periodKey === '1y')
    return `${dt.getFullYear()}.${String(dt.getMonth() + 1).padStart(2, '0')}.${String(dt.getDate()).padStart(2, '0')}`;
  return `${dt.getMonth() + 1}월 ${dt.getDate()}일`;
}

function getQuote(ind) {
  if (ind.kind === 'gauge') return { value: ind.value, diff: +3, pct: null };
  if (ind.kind === 'sectors') return null;
  const all = getSeries(ind);
  if (!all) return null;
  const last = all[all.length - 1], prev = all[all.length - 2];
  return { value: last, diff: last - prev, pct: (last - prev) / prev * 100 };
}

// ── 라이브 페치 헬퍼 ──────────────────────────────────────────────────────────
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
// 단일 시계열: 라이브면 {values,dates,quote,source:'live'}, 아니면 null
async function fetchSeries(id, periodKey) {
  try {
    const d = await fetchJSON(`/api/series/${id}?range=${periodKey}`);
    if (d && d.source === 'live') return d;
  } catch (_) {}
  return null;
}

Object.assign(window, {
  INDICATORS, IND_BY_ID, SECTOR_ROWS, PERIODS, DATES_5Y,
  getSeries, sliceSeries, fmtNum, fmtDate, getQuote, fetchJSON, fetchSeries,
});
