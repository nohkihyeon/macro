// ─────────────────────────────────────────────────────────────────────────────
// pipeline/config.js — 설정 (환경 변수 / .env 로 덮어쓰기)
//
// 로컬은 macro/.env, Render 는 대시보드 Environment 에 같은 키로 등록한다.
// 모든 값에 기본값이 있어 아무것도 설정하지 않아도 동작한다.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 의존성 없이 KEY=VALUE 형식만 읽는다 (이미 설정된 환경 변수가 우선)
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

function num(key, def) {
  const raw = process.env[key];
  const v = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(v) ? v : def;
}

module.exports = {
  root: ROOT,
  port: num('PORT', 3000),

  // 백그라운드 갱신 주기(초) — 장 상태에 따라 자동 선택 (market-hours.js)
  refresh: {
    krOpen: num('REFRESH_KR_OPEN', 20),   // 한국 장중·장전
    active: num('REFRESH_ACTIVE', 60),    // 한국 장외지만 미국장·환율이 움직이는 시간
    closed: num('REFRESH_CLOSED', 300),   // 휴장·심야
    history: num('REFRESH_HISTORY', 3600),// 일별 히스토리·수급·신용
  },
  // 마지막 접속/요청 후 이 시간(초)이 지나면 업스트림 수집을 멈춘다
  idleAfter: num('IDLE_AFTER', 300),

  // 업스트림 호출
  http: {
    timeout: num('HTTP_TIMEOUT', 8000),   // ms
    retries: num('HTTP_RETRIES', 2),
    breakerThreshold: num('BREAKER_THRESHOLD', 3),
    breakerCooldown: num('BREAKER_COOLDOWN', 60), // 초
  },

  // 마지막 정상값·히스토리 저장 위치 (재시작해도 다시 받지 않음)
  cacheDir: process.env.CACHE_DIR || path.join(ROOT, 'cache'),

  // 위험 신호 임계값
  thresholds: {
    usdkrw: num('USDKRW_WARNING', 1400),
    vixWarn: num('VIX_WARNING', 25),
    vixDanger: num('VIX_DANGER', 35),
    creditPct: num('CREDIT_PERCENTILE_WARNING', 90),
    foreignStreak: num('FOREIGN_SELL_STREAK_WARNING', 5),
  },

  // 선택: KRX OpenAPI 인증키 — 설정하면 VKOSPI 지수(일별) 사용 (https://openapi.krx.co.kr)
  krxApiKey: process.env.KRX_API_KEY || '',
};
