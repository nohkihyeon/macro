// ─────────────────────────────────────────────────────────────────────────────
// pipeline/instruments.js — 지표 카탈로그 (지표 ↔ 네이버 소스 매핑)
//
// quote   : 실시간 시세를 어느 배치 응답에서 꺼내는지
//           domestic(국내 지수 polling) | world(해외 지수 polling) | majors(시장지표 일괄)
//           | mi(시장지표 일별 1페이지 — majors 에 없는 국채 만기물)
// history : 일별 히스토리 조회 방법
//           { type:'chart', kind, code }       네이버 차트 API, 1회 호출로 5년
//           { type:'mi', category, code }      네이버 시장지표 API, 60일/페이지
// yahoo   : 네이버 히스토리 실패 시 대체 티커 (mult: 값 보정)
// krImpact: 오르면 한국 증시에 +1 우호 / -1 비우호 / 0 중립
// ─────────────────────────────────────────────────────────────────────────────

const chart = (kind, code) => ({ type: 'chart', kind, code });
const mi = (category, code) => ({ type: 'mi', category, code });

function inst(id, name, group, quote, code, opts = {}) {
  return { id, name, group, quote, code, unit: 'index', dec: 2, history: null, krImpact: 0, note: '', ...opts };
}

const INSTRUMENTS = [
  // ── 한국 ──
  inst('kospi', '코스피', 'kr', 'domestic', 'KOSPI', { history: chart('domestic/index', 'KOSPI'), krImpact: 1, yahoo: '^KS11', intraday: true }),
  inst('kosdaq', '코스닥', 'kr', 'domestic', 'KOSDAQ', { history: chart('domestic/index', 'KOSDAQ'), krImpact: 1, yahoo: '^KQ11', intraday: true }),
  inst('kpi200', '코스피 200', 'kr', 'domestic', 'KPI200', { history: chart('domestic/index', 'KPI200'), krImpact: 1, yahoo: '^KS200', intraday: true }),
  inst('k200fut', '코스피200 선물', 'kr', 'domestic', 'FUT', { history: chart('domestic/index', 'FUT'), krImpact: 1, intraday: true, note: '최근월물' }),

  // ── 글로벌 지수 ──
  inst('spx', 'S&P 500', 'global', 'world', '.INX', { history: chart('foreign/index', '.INX'), krImpact: 1, yahoo: '^GSPC', note: '글로벌 위험선호' }),
  inst('ixic', '나스닥 종합', 'global', 'world', '.IXIC', { history: chart('foreign/index', '.IXIC'), krImpact: 1, yahoo: '^IXIC' }),
  inst('ndx', '나스닥 100', 'global', 'world', '.NDX', { history: chart('foreign/index', '.NDX'), krImpact: 1, yahoo: '^NDX', note: 'KOSDAQ 동조화' }),
  inst('sox', '필라델피아 반도체', 'global', 'world', '.SOX', { history: chart('foreign/index', '.SOX'), krImpact: 1, yahoo: '^SOX', note: 'KOSPI 반도체 선행' }),
  inst('dji', '다우존스', 'global', 'world', '.DJI', { history: chart('foreign/index', '.DJI'), krImpact: 1, yahoo: '^DJI' }),
  inst('n225', '니케이 225', 'global', 'world', '.N225', { history: chart('foreign/index', '.N225'), krImpact: 1, yahoo: '^N225', note: '아시아 수출주' }),
  inst('ssec', '상해종합', 'global', 'world', '.SSEC', { history: chart('foreign/index', '.SSEC'), krImpact: 1, yahoo: '000001.SS', note: '중국 경기' }),
  inst('hsi', '항셍', 'global', 'world', '.HSI', { history: chart('foreign/index', '.HSI'), krImpact: 1, yahoo: '^HSI', note: '중화권 투자심리' }),
  inst('dax', '독일 DAX', 'global', 'world', '.GDAXI', { history: chart('foreign/index', '.GDAXI'), krImpact: 1, yahoo: '^GDAXI' }),
  inst('sensex', '인도 SENSEX', 'global', 'world', '.BSESN', { history: chart('foreign/index', '.BSESN'), krImpact: 1, yahoo: '^BSESN' }),

  // ── 변동성 ──
  inst('vix', 'VIX', 'volatility', 'world', '.VIX', { history: chart('foreign/index', '.VIX'), krImpact: -1, yahoo: '^VIX', note: '미국 공포지수' }),

  // ── 환율 ──
  inst('usdkrw', '원/달러', 'fx', 'majors', 'FX_USDKRW', { unit: 'krw', history: mi('exchange', 'FX_USDKRW'), krImpact: -1, yahoo: 'KRW=X', note: '상승 = 원화 약세, 외국인 자금 이탈 신호' }),
  inst('jpykrw', '원/100엔', 'fx', 'majors', 'FX_JPYKRW', { unit: 'krw', history: mi('exchange', 'FX_JPYKRW'), yahoo: 'JPYKRW=X', yahooMult: 100 }),
  inst('eurkrw', '원/유로', 'fx', 'majors', 'FX_EURKRW', { unit: 'krw', history: mi('exchange', 'FX_EURKRW'), yahoo: 'EURKRW=X' }),
  inst('cnykrw', '원/위안', 'fx', 'majors', 'FX_CNYKRW', { unit: 'krw', history: mi('exchange', 'FX_CNYKRW'), yahoo: 'CNYKRW=X' }),
  inst('dxy', '달러인덱스', 'fx', 'majors', '.DXY', { history: mi('exchange', '.DXY'), krImpact: -1, yahoo: 'DX-Y.NYB', note: '글로벌 달러 강세' }),
  inst('usdjpy', '달러/엔', 'fx', 'majors', 'USDJPY', { unit: 'jpy', history: mi('exchangeWorld', 'USDJPY'), yahoo: 'JPY=X', note: '엔 캐리 트레이드' }),

  // ── 금리 ──
  inst('baserate', '한국 기준금리', 'rates', 'majors', 'KROCRT=ECIX', { unit: 'pct', note: '한국은행 기준금리' }),
  inst('fedrate', '미국 기준금리', 'rates', 'majors', 'USFOMC=ECIX', { unit: 'pct', note: '연방기금금리 상단' }),
  inst('callrate', '콜금리 (1일)', 'rates', 'majors', 'KRCALLBOKK', { unit: 'pct', dec: 3, history: mi('domesticInterest', 'KRCALLBOKK') }),
  inst('cd91', 'CD 91일', 'rates', 'majors', 'KFIA114000', { unit: 'pct', dec: 3, history: mi('domesticInterest', 'KFIA114000') }),
  inst('ktb1', '국고채 1년', 'rates', 'mi', 'KR1YT=RR', { unit: 'pct', dec: 3, history: mi('bond', 'KR1YT=RR') }),
  inst('ktb2', '국고채 2년', 'rates', 'mi', 'KR2YT=RR', { unit: 'pct', dec: 3, history: mi('bond', 'KR2YT=RR') }),
  inst('ktb3', '국고채 3년', 'rates', 'mi', 'KR3YT=RR', { unit: 'pct', dec: 3, history: mi('bond', 'KR3YT=RR') }),
  inst('ktb5', '국고채 5년', 'rates', 'mi', 'KR5YT=RR', { unit: 'pct', dec: 3, history: mi('bond', 'KR5YT=RR') }),
  inst('ktb10', '국고채 10년', 'rates', 'majors', 'KR10YT=RR', { unit: 'pct', dec: 3, history: mi('bond', 'KR10YT=RR') }),
  inst('ktb30', '국고채 30년', 'rates', 'mi', 'KR30YT=RR', { unit: 'pct', dec: 3, history: mi('bond', 'KR30YT=RR') }),
  inst('us2y', '미국채 2년', 'rates', 'mi', 'US2YT=RR', { unit: 'pct', dec: 3, history: mi('bond', 'US2YT=RR'), note: '연준 정책 기대' }),
  inst('us5y', '미국채 5년', 'rates', 'mi', 'US5YT=RR', { unit: 'pct', dec: 3, history: mi('bond', 'US5YT=RR') }),
  inst('us10y', '미국채 10년', 'rates', 'majors', 'US10YT=RR', { unit: 'pct', dec: 3, history: mi('bond', 'US10YT=RR'), krImpact: -1, yahoo: '^TNX', note: '상승 = 성장주 밸류에이션 부담' }),
  inst('us30y', '미국채 30년', 'rates', 'mi', 'US30YT=RR', { unit: 'pct', dec: 3, history: mi('bond', 'US30YT=RR') }),

  // ── 원자재 ──
  inst('wti', 'WTI 원유', 'commodities', 'majors', 'CLcv1', { unit: 'usd', history: mi('energy', 'CLcv1'), yahoo: 'CL=F', note: '물가·정유/화학 업종' }),
  inst('brent', '브렌트유', 'commodities', 'majors', 'LCOcv1', { unit: 'usd', history: mi('energy', 'LCOcv1'), yahoo: 'BZ=F' }),
  inst('natgas', '천연가스', 'commodities', 'majors', 'NGcv1', { unit: 'usd', dec: 3, history: mi('energy', 'NGcv1'), yahoo: 'NG=F' }),
  inst('gold', '국제 금', 'commodities', 'majors', 'GCcv1', { unit: 'usd', history: mi('metals', 'GCcv1'), yahoo: 'GC=F', note: '안전자산 선호' }),
  inst('silver', '은', 'commodities', 'majors', 'SIcv1', { unit: 'usd', dec: 3, history: mi('metals', 'SIcv1'), yahoo: 'SI=F' }),
  inst('copper', '구리', 'commodities', 'majors', 'HGcv1', { unit: 'usd', dec: 3, history: mi('metals', 'HGcv1'), krImpact: 1, yahoo: 'HG=F', note: '경기 선행 (Dr. Copper)' }),
  inst('bdi', 'BDI 건화물선지수', 'commodities', 'majors', '.BADI', { dec: 0, history: mi('transport', '.BADI'), krImpact: 1, note: '글로벌 교역·해운 경기' }),
];

const BY_ID = Object.fromEntries(INSTRUMENTS.map(i => [i.id, i]));
const DOMESTIC_CODES = INSTRUMENTS.filter(i => i.quote === 'domestic').map(i => i.code);
const WORLD_CODES = INSTRUMENTS.filter(i => i.quote === 'world').map(i => i.code);

// 두 지표의 차이로 계산하는 금리차 (A − B, %p)
const SPREADS = {
  'uskr10y': { name: '한미 10년물 금리차', a: 'us10y', b: 'ktb10', note: '미국채 10년 − 국고채 10년' },
  'policy-gap': { name: '한미 기준금리차', a: 'fedrate', b: 'baserate', note: '미국 − 한국 기준금리' },
  'kr-term': { name: '국고채 장단기 금리차', a: 'ktb10', b: 'ktb3', note: '10년 − 3년, 음수 = 역전' },
  'us-term': { name: '미국채 장단기 금리차', a: 'us10y', b: 'us2y', note: '10년 − 2년, 음수 = 역전' },
};

// 수익률 곡선 (만기 라벨, 지표 id)
const YIELD_CURVE = {
  kr: [['1년', 'ktb1'], ['2년', 'ktb2'], ['3년', 'ktb3'], ['5년', 'ktb5'], ['10년', 'ktb10'], ['30년', 'ktb30']],
  us: [['2년', 'us2y'], ['5년', 'us5y'], ['10년', 'us10y'], ['30년', 'us30y']],
};

// 글로벌 지수 비교 (정규화 멀티라인) — 표시 이름
const GLOBAL_COMPARE = [
  ['kospi', 'KOSPI'], ['kosdaq', 'KOSDAQ'], ['kpi200', '코스피200'], ['spx', 'S&P 500'], ['ixic', 'NASDAQ'],
  ['dji', '다우'], ['n225', 'Nikkei 225'], ['hsi', '항셍'], ['dax', '독일 DAX'], ['sensex', '인도 SENSEX'],
];

const GROUP_ORDER = {
  kr: ['kospi', 'kosdaq', 'kpi200', 'k200fut'],
  global: ['spx', 'ixic', 'ndx', 'sox', 'dji', 'n225', 'ssec', 'hsi', 'dax', 'sensex'],
  volatility: ['vix', 'vkospi'],
  fx: ['usdkrw', 'dxy', 'usdjpy', 'jpykrw', 'eurkrw', 'cnykrw'],
  rates: ['baserate', 'fedrate', 'policy-gap', 'callrate', 'cd91', 'ktb3', 'ktb10', 'kr-term', 'us2y', 'us10y', 'us-term', 'uskr10y'],
  commodities: ['wti', 'brent', 'natgas', 'gold', 'silver', 'copper', 'bdi'],
};

// 스코어·상관 계산에 1년 이상 히스토리가 필요한 지표 (marketindex 는 6페이지)
const SCORE_SERIES = ['kospi', 'sox', 'ndx', 'vix', 'usdkrw', 'us10y'];

// 지표추적 전용: 네이버에 없어 Yahoo 일봉으로만 받는 지표 (실시간 시세 없음, 15분 캐시)
const YAHOO_EXTRA = {
  btc: { name: '비트코인', ticker: 'BTC-USD', unit: 'usd', dec: 0 },
  eth: { name: '이더리움', ticker: 'ETH-USD', unit: 'usd', dec: 0 },
  usdidr: { name: '달러/루피아', ticker: 'IDR=X', unit: 'idr', dec: 0 },
  orcl: { name: '오라클', ticker: 'ORCL', unit: 'usd', dec: 2 },
  nvda: { name: '엔비디아', ticker: 'NVDA', unit: 'usd', dec: 2 },
  softbank: { name: '소프트뱅크그룹', ticker: '9984.T', unit: 'jpy', dec: 0 },
};

// 예전 API(/api/quotes, /api/series) id 호환
const LEGACY_IDS = { sp500: 'spx', nasdaq: 'ixic', nikkei: 'n225' };

module.exports = {
  INSTRUMENTS, BY_ID, DOMESTIC_CODES, WORLD_CODES, SPREADS, YIELD_CURVE, GLOBAL_COMPARE,
  GROUP_ORDER, SCORE_SERIES, LEGACY_IDS, YAHOO_EXTRA,
};
