// ─── 시드 기반 의사난수 ─────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 일 단위 랜덤워크 시계열 생성 (5년 ≈ 1260 영업일)
// start→end 로 수렴하도록 드리프트를 더하고, 중간에 파동을 섞는다
function genSeries(seed, start, end, vol, n) {
  n = n || 1260;
  const rand = mulberry32(seed);
  const pts = new Array(n);
  let v = start;
  const drift = (end - start) / n;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / (90 + (seed % 60))) * vol * 2.2
      + Math.sin(i / (37 + (seed % 17))) * vol * 0.9;
    v += drift + (rand() - 0.5) * 2 * vol + wave * 0.04;
    if (v < end * 0.12) v = end * 0.12 + rand() * vol;
    pts[i] = v;
  }
  // 마지막 값을 end 근처로 살짝 보정
  const adj = (end - pts[n - 1]) / 60;
  for (let i = n - 60; i < n; i++) pts[i] += adj * (i - (n - 60));
  return pts;
}

// 날짜 라벨 (영업일 기준 과거 n일 → 오늘)
function genDates(n) {
  const out = new Array(n);
  const d = new Date(2026, 5, 11);
  let i = n - 1;
  while (i >= 0) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) { out[i] = new Date(d); i--; }
    d.setDate(d.getDate() - 1);
  }
  return out;
}

const DATES_5Y = genDates(1260);

// ─── 지표 카탈로그 ─────────────────────────────────────────
// kind: line | bars | gauge | sectors
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
  // 환율
  { id: 'usdkrw', cat: 'fx', name: '원/달러 환율',  unit: '원', dec: 1, seed: 31, start: 1305, end: 1362.5, vol: 4.2 },
  { id: 'jpykrw', cat: 'fx', name: '원/100엔 환율', unit: '원', dec: 2, seed: 32, start: 965,  end: 882.4,  vol: 3.4 },
  { id: 'eurkrw', cat: 'fx', name: '원/유로 환율',  unit: '원', dec: 1, seed: 33, start: 1420, end: 1476.8, vol: 4.6 },
  // 원자재
  { id: 'wti',    cat: 'commodity', name: 'WTI 현물', unit: '$', dec: 2, seed: 41, start: 78,   end: 72.40,  vol: 1.1 },
  { id: 'gold',   cat: 'commodity', name: '금 현물',  unit: '$', dec: 2, seed: 42, start: 2050, end: 3248.6, vol: 16 },
  { id: 'copper', cat: 'commodity', name: '구리 선물', unit: '$', dec: 0, seed: 43, start: 8400, end: 9452,  vol: 55 },
  // 수급 (막대)
  { id: 'flow-foreign', cat: 'flow', name: '외국인 순매수', unit: '억원', dec: 0, seed: 51, kind: 'bars', scale: 4200 },
  { id: 'flow-inst',    cat: 'flow', name: '기관 순매수',   unit: '억원', dec: 0, seed: 52, kind: 'bars', scale: 3100 },
  { id: 'flow-retail',  cat: 'flow', name: '개인 순매수',   unit: '억원', dec: 0, seed: 53, kind: 'bars', scale: 3800 },
  // 심리
  { id: 'vkospi',   cat: 'sentiment', name: 'VKOSPI',     unit: '', dec: 2, seed: 61, start: 19, end: 16.42, vol: 0.45 },
  { id: 'feargreed',cat: 'sentiment', name: '공포·탐욕 지수', unit: '', dec: 0, seed: 62, kind: 'gauge', value: 62 },
  // 업종
  { id: 'sectors', cat: 'market', name: '업종별 등락', unit: '%', dec: 2, seed: 71, kind: 'sectors' },
];

const SECTOR_ROWS = [
  { name: '반도체',      chg: +2.41 }, { name: '2차전지',  chg: +1.87 },
  { name: '자동차',      chg: +0.92 }, { name: '바이오',    chg: +0.55 },
  { name: '금융',        chg: +0.31 }, { name: '인터넷·게임', chg: -0.18 },
  { name: '철강·소재',   chg: -0.47 }, { name: '건설',      chg: -0.83 },
  { name: '유통·소비재', chg: -1.12 }, { name: '조선·기계',  chg: +1.34 },
];

// ─── 시계열 캐시 ───────────────────────────────────────────
const seriesCache = {};
function getSeries(ind) {
  if (seriesCache[ind.id]) return seriesCache[ind.id];
  let values;
  if (ind.kind === 'bars') {
    const rand = mulberry32(ind.seed);
    let bias = 0;
    values = new Array(1260);
    for (let i = 0; i < 1260; i++) {
      if (i % 40 === 0) bias = (rand() - 0.5) * 0.8;
      values[i] = Math.round((rand() - 0.5 + bias * 0.5) * 2 * ind.scale);
    }
  } else if (ind.step) {
    // 기준금리: 계단형
    const raw = genSeries(ind.seed, ind.start, ind.end, ind.vol, 1260);
    values = raw.map(v => Math.round(v * 4) / 4);
    // 부드럽게: 50일 구간으로 고정
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

// 기간: key → 영업일 수
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
  const values = all.slice(-p.n);
  const dates = DATES_5Y.slice(-p.n);
  return { values, dates };
}

// ─── 포맷터 ───────────────────────────────────────────────
function fmtNum(v, dec) {
  return v.toLocaleString('ko-KR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtDate(d, periodKey) {
  if (periodKey === '5y' || periodKey === '1y')
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// 현재값 + 전일대비
function getQuote(ind) {
  if (ind.kind === 'gauge') return { value: ind.value, diff: +3, pct: null };
  if (ind.kind === 'sectors') return null;
  const all = getSeries(ind);
  const last = all[all.length - 1];
  const prev = all[all.length - 2];
  const diff = last - prev;
  return { value: last, diff, pct: (diff / prev) * 100 };
}

Object.assign(window, { INDICATORS, SECTOR_ROWS, PERIODS, getSeries, sliceSeries, fmtNum, fmtDate, getQuote, DATES_5Y });
