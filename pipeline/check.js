// ─────────────────────────────────────────────────────────────────────────────
// pipeline/check.js — 데이터 수집 파이프라인 점검 CLI
//
//   node pipeline/check.js          # 모든 외부 소스 점검 + 표 출력
//   node pipeline/check.js --json   # JSON 으로 출력 (CI/모니터링용)
//
// server.js 를 띄우지 않고도 "어떤 지표가 라이브로 들어오는지" 한눈에 확인한다.
// ─────────────────────────────────────────────────────────────────────────────
const S = require('./sources');
const C = require('./catalog');

const PAD = (s, n) => String(s).padEnd(n);
const COL = { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', dim: '\x1b[90m', rst: '\x1b[0m' };
const tag = (state, txt) => `${COL[state] || ''}${txt}${COL.rst}`;

async function run() {
  const asJson = process.argv.includes('--json');
  const checks = [];

  // 1. Yahoo — 대표 티커 묶음
  const yTickers = [['KOSPI', '^KS11'], ['KOSDAQ', '^KQ11'], ['S&P500', '^GSPC'], ['NASDAQ', '^IXIC'],
                    ['USD/KRW', 'KRW=X'], ['WTI', 'CL=F'], ['GOLD', 'GC=F'], ['COPPER', 'HG=F']];
  for (const [name, t] of yTickers) {
    const r = await S.yahooChart(t, '5d', '1d');
    checks.push({ group: 'Yahoo', name, ok: r.ok, detail: r.ok ? `last=${r.values[r.values.length - 1].toFixed(2)}` : r.error });
  }

  // 2. 네이버 트리맵
  for (const m of ['kospi', 'kosdaq']) {
    const r = await S.naverMarketCap(m);
    checks.push({ group: '네이버 트리맵', name: m.toUpperCase(), ok: r.ok, detail: r.ok ? `${r.stocks.length}종목, 대표=${r.stocks[0].name}` : r.error });
  }

  // 2b. 네이버 marketindex 국내금리
  for (const [name, code] of [['콜금리', 'IRR_CALL'], ['국고채3년', 'IRR_GOVT03Y'], ['CD91', 'IRR_CD91'], ['회사채3년', 'IRR_CORP03Y']]) {
    const r = await S.naverRate(code, 2);
    checks.push({ group: '네이버 금리', name, ok: r.ok, detail: r.ok ? `${r.values.length}일, 최근=${r.values[r.values.length - 1]}%` : r.error });
  }

  // 3. 네이버 투자자 매매동향
  const inv = await S.naverInvestors(2);
  checks.push({ group: '네이버 수급', name: '투자자별 일자', ok: inv.ok && !inv.empty,
    warn: inv.ok && inv.empty,
    detail: !inv.ok ? inv.error : inv.empty ? '응답은 받았으나 데이터 행 없음 → 합성 샘플로 대체' : `${inv.rows.length}일, 최근=${inv.rows[inv.rows.length - 1].date}` });

  // 4. 글로벌 비교 티커 커버리지
  const gl = await S.yahooChart('^N225', '1y', '1d');
  checks.push({ group: 'Yahoo', name: 'Nikkei(글로벌비교)', ok: gl.ok, detail: gl.ok ? `${gl.values.length}일` : gl.error });

  // 5. 합성 폴백 정상 동작
  const samp = C.sampleSeries('baserate', 252);
  checks.push({ group: '합성 폴백', name: 'genSeries', ok: samp.values.length === 252, detail: `${samp.values.length}포인트 생성` });

  if (asJson) { console.log(JSON.stringify(checks, null, 2)); return; }

  // 표 출력
  console.log('\n  📡 시그널보드 데이터 파이프라인 점검\n');
  let group = '';
  for (const c of checks) {
    if (c.group !== group) { group = c.group; console.log(`  ${COL.dim}── ${group} ──${COL.rst}`); }
    const state = c.ok ? tag('ok', '[ OK ]  ') : c.warn ? tag('warn', '[WARN]') : tag('fail', '[FAIL]');
    console.log(`    ${state}  ${PAD(c.name, 20)} ${COL.dim}${c.detail}${COL.rst}`);
  }
  const okN = checks.filter(c => c.ok).length, warnN = checks.filter(c => c.warn).length;
  console.log(`\n  요약: ${tag('ok', okN + ' OK')} · ${tag('warn', warnN + ' WARN')} · ${tag('fail', (checks.length - okN - warnN) + ' FAIL')}  (총 ${checks.length})\n`);

  // 라이브 vs 샘플 지표 매핑 요약
  const live = [], sample = [];
  for (const [id, cfg] of Object.entries(C.SERIES_SOURCES)) {
    (cfg.src === 'sample' ? sample : live).push(id);
  }
  console.log(`  ${COL.dim}라이브 소스 지표(${live.length}): ${live.join(', ')}${COL.rst}`);
  console.log(`  ${COL.dim}합성 샘플 지표(${sample.length}): ${sample.join(', ')}${COL.rst}\n`);
}

run().catch(e => { console.error('check failed:', e); process.exit(1); });
