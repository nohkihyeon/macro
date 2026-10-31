// ─────────────────────────────────────────────────────────────────────────────
// pipeline/check.js — 데이터 소스 점검 CLI
//
//   node pipeline/check.js          # 모든 외부 소스 점검 + 표 출력
//   node pipeline/check.js --json   # JSON 으로 출력 (CI/모니터링용)
//
// server.js 를 띄우지 않고도 "어떤 지표가 라이브로 들어오는지" 한눈에 확인한다.
// ─────────────────────────────────────────────────────────────────────────────
const config = require('./config');
const { HttpClient, shortError } = require('./http');
const naver = require('./sources/naver');
const others = require('./sources/others');
const H = require('./market-hours');
const I = require('./instruments');

const PAD = (s, n) => String(s).padEnd(n);
const COL = { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', dim: '\x1b[90m', rst: '\x1b[0m' };
const tag = (state, txt) => `${COL[state] || ''}${txt}${COL.rst}`;

async function run() {
  const asJson = process.argv.includes('--json');
  const http = new HttpClient({ retries: 1 });
  const today = H.kstDate();
  const checks = [];

  // optional: 실패해도 대시보드 동작에는 지장 없는 보조 소스 → WARN
  async function check(group, name, fn, { optional = false } = {}) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      checks.push({ group, name, ok: true, ms: Date.now() - t0, detail });
    } catch (e) {
      checks.push({ group, name, ok: false, warn: optional, ms: Date.now() - t0, detail: shortError(e) });
    }
  }
  const coverage = (codes, got) => {
    const missing = codes.filter(c => !got[c] || got[c].price == null);
    if (missing.length === codes.length) throw new Error('응답에 지표 없음');
    return `${codes.length - missing.length}/${codes.length}${missing.length ? ` (누락: ${missing.join(', ')})` : ''}`;
  };

  await check('실시간 배치', `국내 지수 ${I.DOMESTIC_CODES.length}종`, async () => coverage(I.DOMESTIC_CODES, await naver.domesticIndices(http, I.DOMESTIC_CODES)));
  await check('실시간 배치', `해외 지수 ${I.WORLD_CODES.length}종`, async () => coverage(I.WORLD_CODES, await naver.worldIndices(http, I.WORLD_CODES)));
  const majorCodes = I.INSTRUMENTS.filter(i => i.quote === 'majors').map(i => i.code);
  await check('실시간 배치', `시장지표 ${majorCodes.length}종`, async () => coverage(majorCodes, await naver.majors(http)));
  for (const inst of I.INSTRUMENTS.filter(i => i.quote === 'mi')) {
    await check('국채 만기물', inst.name, async () => {
      const q = await naver.marketindexLatest(http, inst.history.category, inst.code);
      return `${q.price}% (${String(q.as_of).slice(0, 16)})`;
    });
  }

  for (const m of ['KOSPI', 'KOSDAQ']) {
    await check('시장 내부', `${m} 수급·시장 폭`, async () => {
      const d = await naver.indexIntegration(http, m);
      if (!d.breadth) throw new Error('등락 종목수 없음');
      const f = d.flows ? `외국인 ${d.flows.foreign}억` : '수급 없음';
      return `상승 ${d.breadth.rising + d.breadth.upper} · 하락 ${d.breadth.falling + d.breadth.lower} · ${f} · 52주 ${d.low_52w}~${d.high_52w}`;
    });
    await check('시장 내부', `${m} 시총 상위`, async () => {
      const s = await naver.topMarketCap(http, m, 50);
      if (!s.length) throw new Error('종목 없음');
      return `${s.length}종목, 1위=${s[0].name}`;
    });
    await check('시장 내부', `${m} 거래대금·신고저`, async () => {
      const [top, hl] = await Promise.all([naver.topTradingValue(http, m, 5), naver.highLowCounts(http, m)]);
      return `1위=${top[0] && top[0].name} · 신고가 ${hl.highs} / 신저가 ${hl.lows}`;
    });
  }
  await check('시장 내부', '업종 등락', async () => {
    const g = await naver.industries(http);
    if (!g.length) throw new Error('업종 없음');
    return `${g.length}개 업종, 최고=${g[0].name} ${g[0].change}%`;
  });
  await check('시장 내부', '테마 등락', async () => `${(await naver.themes(http, 5)).length}개 (상위 5)`);
  await check('시장 내부', '종목 업종 매핑', async () => `삼성전자 업종코드 ${await naver.stockIndustry(http, '005930')}`);

  await check('히스토리', '차트 API (코스피 1년)', async () => {
    const rows = await naver.chartHistory(http, 'domestic/index', 'KOSPI', H.addDays(today, -366), today);
    return `${rows.length}일, 최근 ${rows[rows.length - 1].date} ${rows[rows.length - 1].close}`;
  });
  await check('히스토리', '차트 API (S&P 500 1년)', async () => `${(await naver.chartHistory(http, 'foreign/index', '.INX', H.addDays(today, -366), today)).length}일`);
  await check('히스토리', '분봉 (코스피)', async () => {
    const d = await naver.intradayMinutes(http, 'KOSPI', H.addDays(today, -6), today);
    if (!d) throw new Error('분봉 없음');
    return `${d.date} ${d.points.length}개`;
  });
  await check('히스토리', '시장지표 (원/달러 60일)', async () => `${(await naver.marketindexHistory(http, 'exchange', 'FX_USDKRW', 1)).length}일`);
  await check('히스토리', '투자자별 수급 (10일)', async () => {
    const rows = await naver.investorFlows(http, 'KOSPI', 1, 10);
    const last = rows[rows.length - 1];
    return `${rows.length}일, 최근 ${last.date} 외국인 ${last.foreign}억`;
  });
  await check('히스토리', '신용잔고·예탁금', async () => {
    const rows = await naver.depositTrend(http, 1, 10);
    return `${rows.length}일, 최근 ${rows[rows.length - 1].date}`;
  });
  await check('종목', '자동완성 검색', async () => `"삼성" → ${(await naver.searchStocks(http, '삼성')).length}건`);
  await check('종목', '종목 시세 배치', async () => `${Object.keys(await naver.stockQuotes(http, ['005930', '000660'])).length}/2`);

  await check('보조 소스', 'TradingView V-KOSPI 선물', async () => {
    const q = await others.tvQuote(http, 'KRX:VKI1!');
    return `${q.price} (${q.change_percent >= 0 ? '+' : ''}${q.change_percent.toFixed(2)}%, ${q.delayed}분 지연)`;
  }, { optional: true });
  await check('보조 소스', 'Yahoo (히스토리 대체용)', async () => `${(await others.yahooDaily(http, '^KS11', H.addDays(today, -10))).length}일`, { optional: true });
  if (config.krxApiKey) {
    await check('보조 소스', 'KRX OpenAPI VKOSPI', async () => {
      const v = await others.krxVkospi(http, config.krxApiKey, today);
      if (!v) throw new Error('데이터 없음');
      return `${v.price} (${v.date})`;
    }, { optional: true });
  }

  if (asJson) { console.log(JSON.stringify(checks, null, 2)); return; }

  console.log('\n  📡 시그널보드 데이터 소스 점검\n');
  let group = '';
  for (const c of checks) {
    if (c.group !== group) { group = c.group; console.log(`  ${COL.dim}── ${group} ──${COL.rst}`); }
    const state = c.ok ? tag('ok', '[ OK ]') : c.warn ? tag('warn', '[WARN]') : tag('fail', '[FAIL]');
    console.log(`    ${state}  ${PAD(c.name, 26)} ${COL.dim}${PAD(`${c.ms}ms`, 7)} ${c.detail}${COL.rst}`);
  }
  const okN = checks.filter(c => c.ok).length, warnN = checks.filter(c => c.warn).length;
  const failN = checks.length - okN - warnN;
  console.log(`\n  요약: ${tag('ok', `${okN} OK`)} · ${tag('warn', `${warnN} WARN`)} · ${tag('fail', `${failN} FAIL`)}  (총 ${checks.length})`);
  console.log(`  ${COL.dim}지표 ${I.INSTRUMENTS.length}종 + 금리차 ${Object.keys(I.SPREADS).length}종 + VKOSPI · 장 상태: KRX ${H.KRX_LABELS[H.krxSession()]} / 미국 ${H.US_LABELS[H.usSession()]} · 갱신 주기 ${H.refreshInterval()}초${COL.rst}\n`);
  if (failN) process.exitCode = 1;
}

run().catch(e => { console.error('check failed:', e); process.exit(1); });
