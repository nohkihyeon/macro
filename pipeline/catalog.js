// ─────────────────────────────────────────────────────────────────────────────
// pipeline/catalog.js — 지표 카탈로그 · 소스 매핑 · 합성(샘플) 시계열
//
// "지표 → 어떤 소스에서 가져오나" 매핑과, 라이브 소스가 없는 지표용
// 결정론적 합성 시계열 생성기를 함께 보관한다. server.js 가 이 매핑을 보고
// /api/series/:id 응답을 만든다.
// ─────────────────────────────────────────────────────────────────────────────

// 업종 매핑 (네이버 시총 상위 종목 → 업종). 트리맵 그룹핑 + 업종 등락 집계에 사용.
const SECTOR_MAP = {
  '005930': '반도체/전자', '005935': '반도체/전자', '000660': '반도체/전자',
  '402340': 'IT/지주사', '009150': '반도체/전자', '373220': '2차전지/배터리',
  '051910': '화학/배터리', '006400': '2차전지/배터리', '005380': '자동차/운송',
  '000270': '자동차/운송', '012330': '자동차/부품', '207940': '바이오/제약',
  '068270': '바이오/제약', '005490': '철강/소재', '000220': '바이오/제약',
  '003550': 'IT/지주사', '012450': '자동차/부품', '035420': '인터넷/서비스',
  '035720': '인터넷/서비스', '055560': '금융/은행', '055550': '금융/은행',
  '086790': '금융/은행', '035760': '금융/은행', '032830': '금융/보험',
  '000810': '금융/보험', '028260': '상사/유통', '017670': '통신/유틸리티',
  '030200': '통신/유틸리티', '015760': '통신/유틸리티', '009540': '조선/중공업',
  '010140': '조선/중공업', '042660': '조선/중공업',
  '247540': '2차전지/배터리', '086520': '2차전지/배터리', '391250': '화학/소재',
  '196170': '바이오/제약', '145020': '바이오/제약', '028300': '바이오/제약',
  '214150': '의료/미용기기', '068760': '바이오/제약', '035900': '엔터/콘텐츠',
  '036270': '엔터/콘텐츠', '253450': 'IT서비스/게임',
};

// 한국식 등락 색상 (상승=빨강, 하락=파랑)
function getFillColor(v) {
  if (v > 3) return '#b91c1c';
  if (v > 0) return '#ef4444';
  if (v < -3) return '#1d4ed8';
  if (v < 0) return '#3b82f6';
  return '#64748b';
}

// ── 단일 시계열 지표 → 소스 매핑 ──────────────────────────────────────────────
// kind: line | bars | gauge
// src:  yahoo(티커) | naver-flow(투자자 순매수) | sectors | sample
// mult: yahoo 값 보정(예: 원/100엔)
const SERIES_SOURCES = {
  // 시장지수 (Yahoo 라이브)
  kospi:   { kind: 'line', src: 'yahoo', ticker: '^KS11' },
  kosdaq:  { kind: 'line', src: 'yahoo', ticker: '^KQ11' },
  k200fut: { kind: 'line', src: 'yahoo', ticker: '^KS200' },
  // 환율 (Yahoo 라이브)
  usdkrw:  { kind: 'line', src: 'yahoo', ticker: 'KRW=X' },
  jpykrw:  { kind: 'line', src: 'yahoo', ticker: 'JPYKRW=X', mult: 100 }, // 원/100엔
  eurkrw:  { kind: 'line', src: 'yahoo', ticker: 'EURKRW=X' },
  // 원자재 (Yahoo 라이브)
  wti:     { kind: 'line', src: 'yahoo', ticker: 'CL=F' },
  gold:    { kind: 'line', src: 'yahoo', ticker: 'GC=F' },
  copper:  { kind: 'line', src: 'yahoo', ticker: 'HG=F' },
  // 금리 (네이버 marketindex 국내금리 라이브 / 일부는 무료 소스 없어 합성)
  baserate: { kind: 'line', src: 'sample' },                       // 기준금리: 무료 시계열 없음
  callrate: { kind: 'line', src: 'naver-rate', code: 'IRR_CALL' },  // 콜금리
  ktb3:     { kind: 'line', src: 'naver-rate', code: 'IRR_GOVT03Y' },// 국고채 3년
  ktb10:    { kind: 'line', src: 'sample' },                       // 국고채 10년: 네이버 미제공
  cd91:     { kind: 'line', src: 'naver-rate', code: 'IRR_CD91' },   // CD 91일
  corp3:    { kind: 'line', src: 'naver-rate', code: 'IRR_CORP03Y' },// 회사채(AA-) 3년
  // 수급 막대 (네이버 투자자 매매동향, 비면 합성)
  'flow-foreign': { kind: 'bars', src: 'naver-flow', key: 'foreigner' },
  'flow-inst':    { kind: 'bars', src: 'naver-flow', key: 'institution' },
  'flow-retail':  { kind: 'bars', src: 'naver-flow', key: 'individual' },
  // 심리
  // VKOSPI: 지수 원시계열은 KRX 로그인 벽 뒤라 무료 미제공 (야후/네이버/WSJ 미보유 — 2026.06 전수 확인).
  //   → 라인 = KOSPI 21일 실현변동성(연율화 %, 야후 일봉 계산) · 현재가 = V-KOSPI 선물 KRX:VKI1! (TradingView 스캐너, 20분지연)
  vkospi:    { kind: 'line', src: 'kvol', ticker: '^KS11', tvSymbol: 'KRX:VKI1!', window: 21 },
  vix:       { kind: 'line', src: 'yahoo', ticker: '^VIX' },         // VIX (글로벌 변동성)
  feargreed: { kind: 'gauge', src: 'feargreed' },                   // 계산: breadth+모멘텀+VIX
  // 업종 등락 (네이버 트리맵 집계 → 라이브)
  sectors:   { kind: 'sectors', src: 'sectors' },
};

// ── 합성 시계열 파라미터 (라이브 미지원 지표의 "보기 좋은" 샘플) ─────────────
const SAMPLE_PARAMS = {
  kospi:   { start: 2480, end: 3052.74, vol: 9 },
  kosdaq:  { start: 845, end: 884.21, vol: 4.5 },
  k200fut: { start: 330, end: 408.35, vol: 1.6 },
  baserate: { start: 3.50, end: 2.50, vol: 0.012, step: true },
  callrate: { start: 3.52, end: 2.49, vol: 0.018 },
  ktb3:     { start: 3.42, end: 2.781, vol: 0.022 },
  ktb10:    { start: 3.55, end: 3.054, vol: 0.024 },
  cd91:     { start: 3.40, end: 2.95, vol: 0.015 },
  corp3:    { start: 4.10, end: 3.60, vol: 0.02 },
  vix:      { start: 18, end: 20.7, vol: 0.8 },
  usdkrw:  { start: 1305, end: 1362.5, vol: 4.2 },
  jpykrw:  { start: 965, end: 882.4, vol: 3.4 },
  eurkrw:  { start: 1420, end: 1476.8, vol: 4.6 },
  wti:     { start: 78, end: 72.40, vol: 1.1 },
  gold:    { start: 2050, end: 3248.6, vol: 16 },
  copper:  { start: 8400, end: 9452, vol: 55 },
  vkospi:  { start: 19, end: 16.42, vol: 0.45 },
  feargreed: { value: 62 },
  'flow-foreign': { scale: 4200 },
  'flow-inst':    { scale: 3100 },
  'flow-retail':  { scale: 3800 },
};

// 시드 PRNG (mulberry32) — 동일 시드 → 동일 시계열 (결정론적)
function seedOf(id) { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0; return h >>> 0; }
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genSeries(seed, start, end, vol, n) {
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

// 과거 n 영업일 날짜 (today 기준)
function genDates(n, today) {
  const out = new Array(n);
  const d = today ? new Date(today) : new Date();
  let i = n - 1;
  while (i >= 0) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) { out[i] = new Date(d).toISOString().slice(0, 10); i--; }
    d.setDate(d.getDate() - 1);
  }
  return out;
}

// 합성 시계열 생성 (line/bars/gauge). n = 영업일 수.
function sampleSeries(id, n = 252) {
  const cfg = SERIES_SOURCES[id] || {};
  const p = SAMPLE_PARAMS[id] || { start: 100, end: 120, vol: 2 };
  const seed = seedOf(id);
  const dates = genDates(n);
  if (cfg.kind === 'gauge') {
    return { kind: 'gauge', value: p.value != null ? p.value : 50, dates: [], values: [] };
  }
  if (cfg.kind === 'bars') {
    const rand = mulberry32(seed);
    let bias = 0; const values = new Array(n);
    for (let i = 0; i < n; i++) {
      if (i % 40 === 0) bias = (rand() - 0.5) * 0.8;
      values[i] = Math.round((rand() - 0.5 + bias * 0.5) * 2 * (p.scale || 3000));
    }
    return { kind: 'bars', values, dates };
  }
  let values = genSeries(seed, p.start, p.end, p.vol, n);
  if (p.step) {
    values = values.map(v => Math.round(v * 4) / 4);
    for (let i = 0; i < n; i += 50) {
      const lv = values[Math.min(i + 25, n - 1)];
      for (let j = i; j < Math.min(i + 50, n); j++) values[j] = lv;
    }
  }
  return { kind: 'line', values, dates };
}

module.exports = {
  SECTOR_MAP, SERIES_SOURCES, SAMPLE_PARAMS, getFillColor,
  sampleSeries, genSeries, genDates, seedOf,
};
