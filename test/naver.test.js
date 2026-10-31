const test = require('node:test');
const assert = require('node:assert/strict');
const { HttpClient } = require('../pipeline/http');
const naver = require('../pipeline/sources/naver');
const others = require('../pipeline/sources/others');
const { fixtureFetch } = require('./helpers');

const client = () => new HttpClient({ fetch: fixtureFetch(), retries: 0 });

test('num: 콤마·부호·빈 값', () => {
  assert.equal(naver.num('1,334.20'), 1334.2);
  assert.equal(naver.num('+6,217'), 6217);
  assert.equal(naver.num('-16,149'), -16149);
  assert.equal(naver.num('-'), null);
  assert.equal(naver.num('N/A'), null);
  assert.equal(naver.num(''), null);
  assert.equal(naver.num(null), null);
});

test('signed: 등락 방향으로 부호 보정', () => {
  assert.equal(naver.signed(5.2, { name: 'FALLING' }), -5.2);
  assert.equal(naver.signed(-5.2, { name: 'RISING' }), 5.2);
  assert.equal(naver.signed(3, { name: 'UNCHANGED' }), 3);
  assert.equal(naver.ymd('20261030'), '2026-10-30');
  assert.equal(naver.ymd('2026-10-30T09:12:37-04:00'), '2026-10-30');
});

test('국내 지수 polling 배치: 4종을 코드로 꺼낸다', async () => {
  const q = await naver.domesticIndices(client(), ['KOSPI', 'KOSDAQ', 'KPI200', 'FUT']);
  assert.deepEqual(Object.keys(q).sort(), ['FUT', 'KOSDAQ', 'KOSPI', 'KPI200']);
  assert.equal(typeof q.KOSPI.price, 'number');
  assert.equal(q.KOSPI.name, '코스피');
  assert.ok(q.KOSPI.as_of.startsWith('2026-'));
});

test('해외 지수 polling: reutersCode 로 매핑', async () => {
  const q = await naver.worldIndices(client(), ['.INX', '.VIX']);
  assert.ok(q['.INX'] && q['.INX'].price > 0);
  assert.ok(q['.VIX'].name.includes('VIX'));
  assert.ok(q['.N225'].delayed >= 0);
});

test('majors: 환율·금리·원자재·기준금리를 한 번에', async () => {
  const m = await naver.majors(client());
  for (const code of ['FX_USDKRW', 'US10YT=RR', 'KR10YT=RR', 'CLcv1', 'GCcv1', 'KROCRT=ECIX', 'USFOMC=ECIX', 'KRCALLBOKK', '.BADI']) {
    assert.ok(m[code], `${code} 없음`);
    assert.equal(typeof m[code].price, 'number', code);
  }
});

test('marketindex: 최신 1행 시세와 날짜 오름차순 히스토리', async () => {
  const http = client();
  const latest = await naver.marketindexLatest(http, 'exchange', 'FX_USDKRW');
  assert.ok(latest.price > 1000);
  const rows = await naver.marketindexHistory(http, 'exchange', 'FX_USDKRW', 2);
  assert.equal(rows.length, 60, '같은 날짜는 한 번만');
  assert.ok(rows[0].date < rows[rows.length - 1].date);
});

test('지수 종합: 수급(잠정)·프로그램·전 종목 등락수·52주 고저', async () => {
  const d = await naver.indexIntegration(client(), 'KOSPI');
  assert.ok(d.high_52w > d.low_52w);
  assert.match(d.flows.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof d.flows.foreign, 'number');
  assert.equal(typeof d.program.total, 'number');
  const b = d.breadth;
  assert.ok(b.rising + b.falling + b.unchanged > 500, '전 종목 기준');
});

test('순위: 시총 상위 · 거래대금 상위(ETF 제외) · 신고가 수', async () => {
  const http = client();
  const top = await naver.topMarketCap(http, 'KOSPI', 6);
  assert.equal(top[0].code, '005930');
  assert.ok(top[0].market_cap > 0);
  const movers = await naver.topTradingValue(http, 'KOSPI', 5);
  assert.ok(movers.every(s => s.type === 'stock'));
  const hl = await naver.highLowCounts(http, 'KOSPI');
  assert.ok(hl.highs > 0 && hl.lows > 0);
});

test('업종·테마·종목 업종 코드', async () => {
  const http = client();
  const g = await naver.industries(http);
  assert.ok(g.length > 0 && typeof g[0].change === 'number' && g[0].name);
  const t = await naver.themes(http, 5);
  assert.ok(t.length > 0);
  assert.equal(await naver.stockIndustry(http, '005930'), 278);
});

test('차트: 일봉 OHLC 와 마지막 거래일 분봉', async () => {
  const http = client();
  const rows = await naver.chartHistory(http, 'domestic/index', 'KOSPI', '2025-09-01', '2026-10-30');
  assert.ok(rows.length > 250);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].date < r.date));
  const m = await naver.intradayMinutes(http, 'KOSPI', '2026-10-24', '2026-10-30');
  assert.equal(m.date, '2026-10-30', '여러 날이 섞여도 마지막 날만');
  assert.ok(m.points.every(p => /^\d{4}$/.test(p.t)));
});

test('투자자별 수급: 외국인 = 외국인 + 기타외국인, 기관계 = 금융투자~연기금 (억원)', async () => {
  const rows = await naver.investorFlows(client(), 'KOSPI', 1, 40);
  assert.equal(rows.length, 40);
  const raw = require('./fixtures/flows_kospi.json').content[0];
  const amt = Object.fromEntries(raw.netAmounts.map(a => [a.investorGubun, Number(a.diffValue)]));
  const last = rows.find(r => r.date === naver.ymd(raw.bizdate));
  assert.equal(last.foreign, +((amt['9000'] + amt['9001']) / 1e8).toFixed(1));
  const inst = ['1000', '2000', '3000', '3100', '4000', '5000', '6000'].reduce((s, k) => s + amt[k], 0);
  assert.equal(last.institution, +(inst / 1e8).toFixed(1));
  assert.equal(last.pension, +(amt['6000'] / 1e8).toFixed(1));
});

test('신용잔고·고객예탁금 · 자동완성 · TradingView', async () => {
  const http = client();
  const dep = await naver.depositTrend(http, 1, 30);
  assert.ok(dep.length > 0 && dep[0].credit_loan > 0);
  const found = await naver.searchStocks(http, '삼성');
  assert.ok(found.some(s => s.code === '005930'));
  const vki = await others.tvQuote(http, 'KRX:VKI1!');
  assert.ok(vki.price > 0);
  assert.equal(vki.delayed, 20);
});
