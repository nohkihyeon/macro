// ─────────────────────────────────────────────────────────────────────────────
// data.js — 지표 카탈로그 · 포맷터 · 실시간 스토어(SSE) · REST 리소스 · 합성 폴백
//
//  · LiveStore: /api/stream(SSE) 로 접속 시 전체 스냅샷, 이후 바뀐 토픽·종목만 받는다.
//    SSE 가 막히면 /api/snapshot 폴링(ETag 304)으로 전환, 탭이 숨겨지면 연결을 끊는다.
//  · useResource: 히스토리 등 무거운 데이터는 REST 로, 서버 series 버전이 바뀔 때만 다시 받는다.
//  · 서버에 아예 연결할 수 없을 때만 합성 시계열(샘플 배지)로 디자인을 유지한다.
// ─────────────────────────────────────────────────────────────────────────────

// ── 시드 기반 의사난수 (샘플 모드 전용) ───────────────────────────────────────
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
// kind: line(기본) | bars | gauge | sectors | treemap | multiline | investors | dual | flowboard
//       | board | breadth | movers | themes | program | curve | score | signals | summary | correlation | watchlist
// span: 2 = 와이드 패널 · intraday: '1일' 분봉 지원 · noHistory: 일별 히스토리 미제공(기준금리)
// seed/start/end/vol: 서버에 연결할 수 없을 때만 쓰는 합성 샘플 파라미터
const INDICATORS = [
  // 시장
  { id: 'kospi',   cat: 'market', name: '코스피',         unit: '', dec: 2, intraday: true, seed: 11, start: 2480, end: 3052.74, vol: 9 },
  { id: 'kosdaq',  cat: 'market', name: '코스닥',         unit: '', dec: 2, intraday: true, seed: 12, start: 845, end: 884.21, vol: 4.5 },
  { id: 'kpi200',  cat: 'market', name: '코스피 200',     unit: '', dec: 2, intraday: true, seed: 14, start: 330, end: 408.35, vol: 1.6 },
  { id: 'k200fut', cat: 'market', name: '코스피200 선물', alias: '선물 최근월물', unit: '', dec: 2, intraday: true, seed: 13, start: 330, end: 408.35, vol: 1.6 },
  { id: 'board-kospi',  cat: 'market', name: '코스피 지수 보드', alias: '52주 이동평균 변동성 낙폭', kind: 'board', market: 'KOSPI' },
  { id: 'board-kosdaq', cat: 'market', name: '코스닥 지수 보드', alias: '52주 이동평균 변동성 낙폭', kind: 'board', market: 'KOSDAQ' },
  { id: 'breadth', cat: 'market', name: '시장 폭 · 신고가/신저가', alias: '상승 하락 종목수 등락', kind: 'breadth' },
  { id: 'sectors', cat: 'market', name: '업종별 등락', unit: '%', dec: 2, kind: 'sectors' },
  { id: 'themes',  cat: 'market', name: '테마 상위', kind: 'themes' },
  { id: 'movers',  cat: 'market', name: '거래대금 상위', alias: '자금 쏠림 종목', kind: 'movers' },
  { id: 'program', cat: 'market', name: '프로그램 매매', alias: '차익 비차익', kind: 'program' },
  { id: 'treemap-kospi',  cat: 'market', name: '코스피 시총 트리맵', kind: 'treemap', market: 'KOSPI', span: 2 },
  { id: 'treemap-kosdaq', cat: 'market', name: '코스닥 시총 트리맵', kind: 'treemap', market: 'KOSDAQ', span: 2 },
  // 글로벌
  { id: 'global', cat: 'global', name: '글로벌 지수 비교', kind: 'multiline', span: 2 },
  { id: 'spx',    cat: 'global', name: 'S&P 500', unit: '', dec: 2, seed: 81, start: 5200, end: 7620, vol: 30 },
  { id: 'ixic',   cat: 'global', name: '나스닥 종합', unit: '', dec: 2, seed: 82, start: 16000, end: 25500, vol: 120 },
  { id: 'ndx',    cat: 'global', name: '나스닥 100', unit: '', dec: 2, seed: 83, start: 18000, end: 28500, vol: 130 },
  { id: 'sox',    cat: 'global', name: '필라델피아 반도체', alias: 'SOX', unit: '', dec: 2, seed: 84, start: 4500, end: 10800, vol: 60 },
  { id: 'dji',    cat: 'global', name: '다우존스', unit: '', dec: 2, seed: 85, start: 39000, end: 52200, vol: 180 },
  { id: 'n225',   cat: 'global', name: '니케이 225', unit: '', dec: 2, seed: 86, start: 38000, end: 63300, vol: 260 },
  { id: 'ssec',   cat: 'global', name: '상해종합', unit: '', dec: 2, seed: 87, start: 3000, end: 3600, vol: 18 },
  { id: 'hsi',    cat: 'global', name: '항셍', unit: '', dec: 2, seed: 88, start: 17000, end: 23300, vol: 150 },
  { id: 'dax',    cat: 'global', name: '독일 DAX', unit: '', dec: 2, seed: 89, start: 18000, end: 25800, vol: 110 },
  { id: 'sensex', cat: 'global', name: '인도 SENSEX', unit: '', dec: 2, seed: 90, start: 72000, end: 74500, vol: 300 },
  // 금리
  { id: 'baserate', cat: 'rates', name: '한국 기준금리', unit: '%', dec: 2, noHistory: true, seed: 21, start: 3.50, end: 2.50, vol: 0.012, step: true },
  { id: 'fedrate',  cat: 'rates', name: '미국 기준금리', unit: '%', dec: 2, noHistory: true, seed: 27, start: 5.5, end: 4.0, vol: 0.01, step: true },
  { id: 'policy-gap', cat: 'rates', name: '한미 기준금리차', unit: '%p', dec: 2, noHistory: true, seed: 28, start: 2, end: 1, vol: 0.01, step: true },
  { id: 'callrate', cat: 'rates', name: '콜금리 (1일)', unit: '%', dec: 3, seed: 22, start: 3.52, end: 2.49, vol: 0.018 },
  { id: 'cd91',     cat: 'rates', name: 'CD 91일', unit: '%', dec: 3, seed: 25, start: 3.40, end: 2.95, vol: 0.015 },
  { id: 'ktb2',     cat: 'rates', name: '국고채 2년', unit: '%', dec: 3, seed: 29, start: 3.3, end: 2.7, vol: 0.02 },
  { id: 'ktb3',     cat: 'rates', name: '국고채 3년', unit: '%', dec: 3, seed: 23, start: 3.42, end: 2.781, vol: 0.022 },
  { id: 'ktb5',     cat: 'rates', name: '국고채 5년', unit: '%', dec: 3, seed: 30, start: 3.5, end: 2.9, vol: 0.022 },
  { id: 'ktb10',    cat: 'rates', name: '국고채 10년', unit: '%', dec: 3, seed: 24, start: 3.55, end: 3.054, vol: 0.024 },
  { id: 'ktb30',    cat: 'rates', name: '국고채 30년', unit: '%', dec: 3, seed: 31, start: 3.4, end: 3.0, vol: 0.022 },
  { id: 'kr-term',  cat: 'rates', name: '국고채 장단기 금리차', alias: '10년 3년 역전', unit: '%p', dec: 3, seed: 32, start: 0.2, end: 0.3, vol: 0.01 },
  { id: 'us2y',     cat: 'rates', name: '미국채 2년', unit: '%', dec: 3, seed: 33, start: 4.8, end: 4.2, vol: 0.03 },
  { id: 'us10y',    cat: 'rates', name: '미국채 10년', unit: '%', dec: 3, seed: 34, start: 4.4, end: 4.6, vol: 0.03 },
  { id: 'us30y',    cat: 'rates', name: '미국채 30년', unit: '%', dec: 3, seed: 35, start: 4.6, end: 4.9, vol: 0.03 },
  { id: 'us-term',  cat: 'rates', name: '미국채 장단기 금리차', alias: '10년 2년 역전', unit: '%p', dec: 3, seed: 36, start: -0.3, end: 0.3, vol: 0.01 },
  { id: 'uskr10y',  cat: 'rates', name: '한미 10년물 금리차', unit: '%p', dec: 3, seed: 37, start: 1.2, end: 0.9, vol: 0.02 },
  { id: 'yield-curve', cat: 'rates', name: '국채 수익률 곡선', alias: '한국 미국 만기', kind: 'curve' },
  // 환율
  { id: 'usdkrw', cat: 'fx', name: '원/달러 환율',  unit: '원', dec: 1, seed: 31, start: 1305, end: 1362.5, vol: 4.2 },
  { id: 'jpykrw', cat: 'fx', name: '원/100엔 환율', unit: '원', dec: 2, seed: 32, start: 965, end: 882.4, vol: 3.4 },
  { id: 'eurkrw', cat: 'fx', name: '원/유로 환율',  unit: '원', dec: 1, seed: 33, start: 1420, end: 1476.8, vol: 4.6 },
  { id: 'cnykrw', cat: 'fx', name: '원/위안 환율',  unit: '원', dec: 2, seed: 34, start: 190, end: 200, vol: 0.6 },
  { id: 'dxy',    cat: 'fx', name: '달러인덱스', unit: '', dec: 2, seed: 35, start: 104, end: 101.9, vol: 0.4 },
  { id: 'usdjpy', cat: 'fx', name: '달러/엔', unit: '엔', dec: 2, seed: 36, start: 150, end: 157.6, vol: 0.6 },
  // 원자재
  { id: 'wti',    cat: 'commodity', name: 'WTI 원유', unit: '$', dec: 2, seed: 41, start: 78, end: 72.40, vol: 1.1 },
  { id: 'brent',  cat: 'commodity', name: '브렌트유', unit: '$', dec: 2, seed: 44, start: 82, end: 76, vol: 1.1 },
  { id: 'natgas', cat: 'commodity', name: '천연가스', unit: '$', dec: 3, seed: 45, start: 2.5, end: 2.9, vol: 0.06 },
  { id: 'gold',   cat: 'commodity', name: '국제 금', alias: '금 현물 선물', unit: '$', dec: 2, seed: 42, start: 2050, end: 3248.6, vol: 16 },
  { id: 'silver', cat: 'commodity', name: '은', unit: '$', dec: 3, seed: 46, start: 24, end: 32, vol: 0.4 },
  { id: 'copper', cat: 'commodity', name: '구리', alias: '구리 선물 Dr. Copper', unit: '$', dec: 3, seed: 43, start: 4.1, end: 4.62, vol: 0.05 },
  { id: 'bdi',    cat: 'commodity', name: 'BDI 건화물선지수', alias: '해운 운임', unit: '', dec: 0, seed: 47, start: 1500, end: 2700, vol: 40 },
  // 달러 (DollarScope 이식 — 원/달러 매수 타이밍)
  { id: 'dollar-verdict', cat: 'dollar', name: '달러 매수 타이밍 종합', alias: 'DollarScope 환전 환율 매수 시점', kind: 'dollar-verdict', span: 2,
    sub: 'DollarScope 원칙(3년 평균 대비) + 11개 지표 종합 · 점수가 높을수록 지금 달러를 사기에 유리' },
  { id: 'dollar-chart', cat: 'dollar', name: '원/달러 3년 추세 · 평균 밴드', alias: 'DollarScope 차트', kind: 'dollar-chart', span: 2,
    sub: '3년 평균선 · ±1σ 밴드 · 200일선 — 평균보다 아래면 DollarScope 기준 BUY' },
  { id: 'dollar-signals', cat: 'dollar', name: '달러 타이밍 지표 체크리스트', kind: 'dollar-signals', sub: '가격 매력도 · 타이밍 · 방향 압력 11개 지표의 신호와 근거' },
  { id: 'dollar-levels', cat: 'dollar', name: '원/달러 참고 가격대', kind: 'dollar-levels', sub: '3년 평균·표준편차·52주 고저·200일선 대비 현재 위치' },
  { id: 'dollar-bank', cat: 'dollar', name: '은행 고시 환율', alias: '환전 현찰 송금 우대', kind: 'dollar-bank', sub: '매매기준율 · 현찰/송금 환율과 우대율별 예상 환율' },
  // 수급
  { id: 'flow-board', cat: 'flow', name: '투자자 수급 종합 보드', kind: 'flowboard', span: 2 },
  { id: 'flow-foreign', cat: 'flow', name: '외국인 순매수', unit: '억원', dec: 0, kind: 'bars', field: 'foreign', seed: 51, scale: 4200 },
  { id: 'flow-inst',    cat: 'flow', name: '기관 순매수',   unit: '억원', dec: 0, kind: 'bars', field: 'institution', seed: 52, scale: 3100 },
  { id: 'flow-retail',  cat: 'flow', name: '개인 순매수',   unit: '억원', dec: 0, kind: 'bars', field: 'individual', seed: 53, scale: 3800 },
  { id: 'flow-pension', cat: 'flow', name: '연기금 순매수', unit: '억원', dec: 0, kind: 'bars', field: 'pension', seed: 54, scale: 1200 },
  { id: 'credit',  cat: 'flow', name: '신용융자 잔고', alias: '빚투 레버리지', unit: '조원', dec: 2, seed: 55, start: 18, end: 28.9, vol: 0.12 },
  { id: 'deposit', cat: 'flow', name: '고객예탁금', unit: '조원', dec: 2, seed: 56, start: 55, end: 88, vol: 0.6 },
  { id: 'flow-cum',      cat: 'flow', name: '투자자별 누적 순매수', kind: 'investors', span: 2 },
  { id: 'foreign-kospi', cat: 'flow', name: '외국인 수급 vs 코스피', kind: 'dual', span: 2 },
  // 심리
  { id: 'vkospi',    cat: 'sentiment', name: '코스피 변동성지수(VKOSPI)', alias: 'V-KOSPI 코스피변동지수 변동성선물', unit: '', dec: 2, seed: 61, start: 19, end: 16.42, vol: 0.45 },
  { id: 'vix',       cat: 'sentiment', name: 'VIX 변동성', unit: '', dec: 2, seed: 63, start: 18, end: 20.7, vol: 0.8 },
  { id: 'feargreed', cat: 'sentiment', name: '공포·탐욕 지수', unit: '', dec: 0, kind: 'gauge', value: 62 },
  // 매크로
  { id: 'macroscore',  cat: 'macro', name: 'MacroScore 종합 점수', alias: '매크로 점수 리스크온 리스크오프', kind: 'score', span: 2 },
  { id: 'signals',     cat: 'macro', name: '위험 신호', kind: 'signals' },
  { id: 'summary',     cat: 'macro', name: '시장 요약', kind: 'summary' },
  { id: 'correlation', cat: 'macro', name: 'KOSPI 상관·베타', alias: '상관관계 민감도', kind: 'correlation' },
  // 관심
  { id: 'watchlist', cat: 'watch', name: '관심종목', alias: '종목 검색', kind: 'watchlist' },
  // 지표추적 (알상무 지표추적자 방식: 이동평균선 + 지지·저항 기준선)
  { id: 'tracker', cat: 'tracker', name: '이동평균선 보드', alias: '지표추적 5일선 20일선 60일선 20주선 돌파 이탈', kind: 'tracker', span: 2,
    sub: '5·20·60일선과 20주선 대비 위치(▲위 ▼아래, 금리는 bp) · 최근 돌파/이탈 · 이번 주 주봉 · 행을 누르면 차트' },
  { id: 'tracker-brief', cat: 'tracker', name: '오늘의 체크포인트', alias: '지표추적 브리핑', kind: 'tracker-brief',
    sub: '최근 이평선 돌파·이탈, 기준선 2% 이내 근접, 주봉 꼬리를 중요도 순으로' },
  { id: 'tracker-chart', cat: 'tracker', name: '이평선 · 기준선 차트', alias: '지표추적 차트', kind: 'tracker-chart', span: 2,
    sub: '종가 + 5·20·60일선 + 20주선(점선) + 내가 정한 지지·저항선' },
  { id: 'tracker-levels', cat: 'tracker', name: '지지·저항 기준선', alias: '지표추적 기준선 알림', kind: 'tracker-levels',
    sub: '가격을 넣어 두면 실시간 시세가 넘나들 때 알림 · 추적 대상 추가/삭제' },
];

const IND_BY_ID = Object.fromEntries(INDICATORS.map(i => [i.id, i]));

const SECTOR_ROWS = [
  { name: '반도체', chg: +2.41 }, { name: '2차전지', chg: +1.87 },
  { name: '자동차', chg: +0.92 }, { name: '바이오', chg: +0.55 },
  { name: '금융', chg: +0.31 }, { name: '인터넷·게임', chg: -0.18 },
  { name: '철강·소재', chg: -0.47 }, { name: '건설', chg: -0.83 },
  { name: '유통·소비재', chg: -1.12 }, { name: '조선·기계', chg: +1.34 },
];

// ── 합성 시계열 (샘플 모드) ───────────────────────────────────────────────────
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
  } else if (ind.seed != null && ind.start != null) {
    values = genSeries(ind.seed, ind.start, ind.end, ind.vol, 1260);
  } else {
    values = null;
  }
  seriesCache[ind.id] = values;
  return values;
}

const PERIODS = [
  { key: '1d', label: '1일', n: 1 },
  { key: '1w', label: '1주', n: 5 },
  { key: '1m', label: '1달', n: 21 },
  { key: '1y', label: '1년', n: 252 },
  { key: '5y', label: '5년', n: 1260 },
];
const periodOf = key => PERIODS.find(p => p.key === key) || PERIODS[3];

function sliceSeries(ind, periodKey) {
  const all = getSeries(ind);
  if (!all) return null;
  const n = Math.max(5, periodOf(periodKey).n);
  return { values: all.slice(-n), dates: DATES_5Y.slice(-n) };
}

function getQuote(ind) {
  if (ind.kind === 'gauge') return { value: ind.value, diff: +3, pct: null };
  const all = getSeries(ind);
  if (!all) return null;
  const last = all[all.length - 1], prev = all[all.length - 2];
  return { value: last, diff: last - prev, pct: (last - prev) / prev * 100 };
}

// ── 포맷터 ────────────────────────────────────────────────────────────────────
function fmtNum(v, dec) {
  if (v == null || isNaN(v)) return '–';
  return v.toLocaleString('ko-KR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
// 날짜 축/툴팁 — 'YYYY-MM-DD' · Date · 분봉 'HHMM'
function fmtDate(d, periodKey) {
  if (typeof d === 'string' && /^\d{4}$/.test(d)) return `${d.slice(0, 2)}:${d.slice(2)}`;
  const dt = d instanceof Date ? d : new Date(typeof d === 'string' && d.length === 10 ? `${d}T00:00:00` : d);
  if (isNaN(dt)) return String(d);
  if (periodKey === '5y' || periodKey === '1y')
    return `${dt.getFullYear()}.${String(dt.getMonth() + 1).padStart(2, '0')}.${String(dt.getDate()).padStart(2, '0')}`;
  return `${dt.getMonth() + 1}월 ${dt.getDate()}일`;
}
// 억원 → '1조 6,230억' (signed: 부호 표시)
function fmtEok(v, signed) {
  if (v == null || isNaN(v)) return '–';
  const sign = signed ? (v > 0 ? '+' : v < 0 ? '-' : '') : (v < 0 ? '-' : '');
  const a = Math.abs(Math.round(v));
  if (a >= 10000) {
    const jo = Math.floor(a / 10000), rest = a % 10000;
    return `${sign}${jo.toLocaleString('ko-KR')}조${rest ? ` ${rest.toLocaleString('ko-KR')}억` : ''}`;
  }
  return `${sign}${a.toLocaleString('ko-KR')}억`;
}
const fmtPct = (v, d = 2) => (v == null || isNaN(v) ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
// 시세 기준 시각: 오늘이면 HH:MM, 아니면 MM.DD (HH:MM)
function fmtAsOf(asOf) {
  if (!asOf) return '';
  const s = String(asOf);
  const md = `${s.slice(5, 7)}.${s.slice(8, 10)}`;
  if (s.length <= 10) return md;
  const hm = s.slice(11, 16);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  return s.slice(0, 10) === today ? hm : `${md} ${hm}`;
}

// ── REST ──────────────────────────────────────────────────────────────────────
async function fetchJSON(url, opts) {
  const res = await fetch(url, { cache: 'no-cache', ...opts });   // 매번 ETag 로 재검증 (같으면 304)
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const body = await res.json(); if (body && body.detail) detail = body.detail; } catch (_) {}
    throw new Error(detail);
  }
  return res.json();
}

// ── 실시간 스토어 ─────────────────────────────────────────────────────────────
const LiveStore = (() => {
  const TOPICS = ['meta', 'boards', 'treemap', 'movers', 'sectors', 'themes', 'insights', 'dollar', 'series'];
  const EVENTS = ['snapshot', 'quotes', 'stocks', 'intraday', ...TOPICS];
  const FIRST_DATA_TIMEOUT = 3000;
  const SSE_MAX_FAILURES = 3;
  const empty = () => ({ meta: null, quotes: {}, boards: {}, treemap: {}, movers: {}, sectors: [], themes: [], insights: null, dollar: null, intraday: {}, stocks: {}, series: null });

  let state = empty();
  // conn: connecting | live | polling | reconnecting | offline | paused · sample: 서버 미연결 (합성 데이터)
  const info = { conn: 'connecting', everConnected: false, sample: false, lastMessageAt: 0, receivedAt: 0 };
  let infoSnap = { ...info };
  const listeners = new Set();
  let es = null, pollTimer = null, firstTimer = null, watchTimer = null;
  let mode = typeof EventSource === 'undefined' ? 'poll' : 'sse';
  let failures = 0, pollFailures = 0, sseBlocked = false, sseJustFailed = false;
  let paused = false, started = false, lastEtag = null, scheduled = false;
  let background = false;   // 켜진 알림이 있으면 탭이 숨겨져도 연결을 유지
  let watch = [];

  function emit() {
    infoSnap = { ...info };
    if (scheduled) return;
    scheduled = true;
    // 한 번에 몰려오는 이벤트(스냅샷 직후 등)는 한 프레임에 모아 렌더
    (window.requestAnimationFrame || setTimeout)(() => { scheduled = false; listeners.forEach(fn => fn()); });
  }
  function setConn(conn) { if (info.conn !== conn) { info.conn = conn; emit(); } }

  function apply(event, data) {
    info.lastMessageAt = Date.now();
    if (!info.everConnected || info.sample) { info.everConnected = true; info.sample = false; }
    if (event === 'snapshot') {
      state = { ...empty(), ...data };
      info.receivedAt = Date.now();
    } else if (event === 'quotes' || event === 'stocks') {
      state = { ...state, [event]: { ...state[event], ...data } };
    } else if (event === 'intraday') {
      const next = { ...state.intraday };
      for (const [id, p] of Object.entries(data)) {
        const cur = next[id];
        if (p.from > 0 && cur && cur.date === p.date && p.from <= cur.points.length) {
          next[id] = { date: p.date, points: cur.points.slice(0, p.from).concat(p.points) };
        } else {
          next[id] = { date: p.date, points: p.points };
          if (p.from > 0) refresh();   // 이어 붙일 기준이 어긋나면 전체를 다시 받는다
        }
      }
      state = { ...state, intraday: next };
    } else if (TOPICS.includes(event)) {
      state = { ...state, [event]: data };
      if (event === 'meta') info.receivedAt = Date.now();
    }
    emit();
  }

  const query = () => (watch.length ? `?watch=${watch.join(',')}` : '');

  function stop() {
    if (es) { es.close(); es = null; }
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  const sleeping = () => paused || (document.hidden && !background);

  function connect() {
    stop();
    if (sleeping()) return;
    if (mode === 'poll') { poll(); return; }
    if (info.conn !== 'live') setConn(info.everConnected ? 'reconnecting' : 'connecting');
    es = new EventSource(`/api/stream${query()}`);
    for (const ev of EVENTS) {
      es.addEventListener(ev, e => {
        failures = 0;
        if (info.conn !== 'live') setConn('live');
        try { apply(ev, JSON.parse(e.data)); } catch (err) { console.warn('[live] 이벤트 파싱 실패', ev, err); }
      });
    }
    es.onerror = () => {
      failures++;
      setConn(info.everConnected ? 'reconnecting' : 'connecting');
      if (failures >= SSE_MAX_FAILURES) {
        // 프록시 등으로 SSE 가 막혔거나 서버가 내려감 → 폴링이 판별한다
        failures = 0;
        mode = 'poll';
        sseJustFailed = true;
        connect();
      }
    };
  }

  async function poll() {
    clearTimeout(pollTimer);
    if (sleeping()) return;
    let ok = false;
    try {
      await loadSnapshot();
      ok = true;
    } catch (_) {
      ok = false;
    }
    if (ok) {
      if (sseJustFailed) { sseBlocked = true; sseJustFailed = false; }      // 서버는 되는데 SSE 만 안 됨
      else if (!sseBlocked && pollFailures > 0 && typeof EventSource !== 'undefined') {
        pollFailures = 0;                                                     // 서버 복구 → SSE 재시도
        mode = 'sse';
        connect();
        return;
      }
      pollFailures = 0;
      setConn('polling');
    } else {
      sseJustFailed = false;
      pollFailures++;
      setConn(info.everConnected ? 'offline' : 'connecting');
      if (!info.everConnected && pollFailures >= 1) goSample();
    }
    const seconds = ok ? ((state.meta && state.meta.session.refresh_seconds) || 60) : Math.min(60, 5 * 2 ** Math.min(pollFailures - 1, 4));
    pollTimer = setTimeout(poll, seconds * 1000);
  }

  async function loadSnapshot() {
    const res = await fetch(`/api/snapshot${query()}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const etag = res.headers.get('ETag');
    if (etag && etag === lastEtag && info.everConnected) { info.lastMessageAt = Date.now(); info.receivedAt = Date.now(); emit(); return; }
    const data = await res.json();
    lastEtag = etag;
    apply('snapshot', data);
  }

  function goSample() {
    if (info.everConnected || info.sample) return;
    info.sample = true;
    setConn('offline');
    emit();
  }

  function onVisibility() {
    if (document.hidden) { if (!background) stop(); return; }
    failures = 0;
    connect();
  }

  function start() {
    if (started) return;
    started = true;
    connect();
    // SSE 첫 메시지가 늦으면 REST 로 먼저 채우고, 그것도 안 되면 샘플 모드
    firstTimer = setTimeout(() => {
      if (info.everConnected) return;
      loadSnapshot().catch(() => goSample());
    }, FIRST_DATA_TIMEOUT);
    document.addEventListener('visibilitychange', onVisibility);
  }

  // 관심종목이 바뀌면 SSE 를 새 목록으로 다시 연다 (서버가 모든 접속자의 종목을 1회 호출로 묶어 조회)
  function setWatch(codes) {
    const next = [...new Set(codes)].sort();
    if (next.join(',') === watch.join(',')) return;
    watch = next;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => { if (started && mode === 'sse') connect(); else if (started) poll(); }, 400);
  }

  function setBackground(on) {
    background = on;
    if (on && started && !paused && !es && !pollTimer) connect();
  }

  function setPaused(on) {
    paused = on;
    if (on) { stop(); setConn('paused'); } else { failures = 0; connect(); }
  }

  // 수동 새로고침: 스냅샷을 다시 받고 REST 리소스 캐시를 비운다
  function refresh() {
    bustResources();
    return loadSnapshot().catch(() => {});
  }

  return {
    start, setWatch, setPaused, setBackground, refresh,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getState: () => state,
    getInfo: () => infoSnap,
    isPaused: () => paused,
  };
})();

// 스토어 구독 훅 — selector 는 기존 객체 참조나 원시값을 돌려줘야 한다
function useLive(selector) {
  return React.useSyncExternalStore(LiveStore.subscribe, () => selector(LiveStore.getState(), LiveStore.getInfo()));
}

// ── REST 리소스 (여러 위젯이 같은 URL 을 공유, key 가 바뀔 때만 다시 받음) ─────
const resources = new Map();   // url → { key, data, error, promise }
let resourceEpoch = 0;
function bustResources() { resourceEpoch++; }

const RETRY_AFTER = 10000;   // 실패한 URL 은 이 시간 동안 다시 요청하지 않는다 (렌더마다 재요청 방지)
function loadResource(url, key) {
  const k = `${key}|${resourceEpoch}`;
  const cur = resources.get(url);
  if (cur && cur.key === k && (cur.data || cur.promise || (cur.error && Date.now() - cur.failedAt < RETRY_AFTER))) return cur;
  const entry = { key: k, data: cur ? cur.data : null, error: null, promise: null, failedAt: 0 };
  entry.promise = fetchJSON(url)
    .then(data => { entry.data = data; entry.error = null; return data; })
    .catch(err => { entry.error = err; entry.failedAt = Date.now(); throw err; })
    .finally(() => { entry.promise = null; });
  entry.promise.catch(() => {});   // 구독한 위젯이 없어져도 unhandled rejection 이 나지 않게
  resources.set(url, entry);
  return entry;
}

function useResource(url, key) {
  const [, force] = React.useReducer(x => x + 1, 0);
  const entry = url ? loadResource(url, key) : null;
  React.useEffect(() => {
    if (!entry || !entry.promise) return;
    let alive = true;
    entry.promise.then(() => alive && force(), () => alive && force());
    return () => { alive = false; };
  }, [entry, entry && entry.promise]);
  if (!entry) return { data: null, loading: false, error: null };
  return { data: entry.data, loading: !!entry.promise && !entry.data, error: entry.error };
}

// N초마다 바뀌는 값 (분 단위로 다시 계산해야 하는 집계용)
function useTick(seconds) {
  const [tick, setTick] = React.useState(() => Math.floor(Date.now() / (seconds * 1000)));
  React.useEffect(() => {
    const iv = setInterval(() => setTick(Math.floor(Date.now() / (seconds * 1000))), 1000);
    return () => clearInterval(iv);
  }, [seconds]);
  return tick;
}

// ── 실시간 병합 ───────────────────────────────────────────────────────────────
// 일별 히스토리 끝에 실시간 시세를 붙인다 (같은 거래일이면 교체)
function mergeLiveRows(rows, q) {
  if (!rows || !rows.length || !q || q.price == null || !q.day) return rows;
  const last = rows[rows.length - 1];
  if (q.day === last.date) return last.close === q.price ? rows : [...rows.slice(0, -1), { ...last, close: q.price }];
  if (q.day > last.date) return [...rows, { date: q.day, close: q.price }];
  return rows;
}

// 분봉 + 장중 실시간 시세 (진행 중인 분은 교체, 새 분은 추가)
function intradayData(d, q) {
  if (!d || !d.points.length) return null;
  let pts = d.points;
  if (q && q.price != null && q.market_status === 'OPEN' && q.as_of && q.as_of.slice(0, 10) === d.date) {
    const t = q.as_of.slice(11, 13) + q.as_of.slice(14, 16);
    const last = pts[pts.length - 1];
    if (t > last[0]) pts = [...pts, [t, q.price]];
    else if (t === last[0] && last[1] !== q.price) pts = [...pts.slice(0, -1), [t, q.price]];
  }
  return { values: pts.map(p => p[1]), dates: pts.map(p => p[0]), date: d.date };
}

// ── 로컬 설정 (관심종목 · 알림) ───────────────────────────────────────────────
function loadLocal(key, def) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? def : v; } catch (_) { return def; }
}
function saveLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* 사파리 사생활 보호 모드 등 */ }
}

function downloadCsv(filename, header, rows) {
  const esc = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const text = '﻿' + [header, ...rows].map(r => r.map(esc).join(',')).join('\n');   // 엑셀 한글 깨짐 방지 BOM
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

Object.assign(window, {
  INDICATORS, IND_BY_ID, SECTOR_ROWS, PERIODS, DATES_5Y, periodOf, mulberry32, genSeries,
  getSeries, sliceSeries, getQuote, fmtNum, fmtDate, fmtEok, fmtPct, fmtAsOf, fetchJSON,
  LiveStore, useLive, useResource, useTick, bustResources, mergeLiveRows, intradayData,
  loadLocal, saveLocal, downloadCsv,
});
