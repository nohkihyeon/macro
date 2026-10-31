// ─────────────────────────────────────────────────────────────────────────────
// pipeline/market-hours.js — 장 운영 시간 판단 (KST 기준)
//
// 서버(Render)는 UTC 로 돌기 때문에 모든 판단을 Intl 시간대 변환으로 한다.
// 휴장일 목록은 갱신 주기 결정에만 쓰고, 화면에 보이는 장 상태는
// 실제 시세 데이터(체결 시각/marketStatus)로 collector 가 한 번 더 보정한다.
// ─────────────────────────────────────────────────────────────────────────────
const config = require('./config');

const KST = 'Asia/Seoul';
const NEW_YORK = 'America/New_York';

// KRX 휴장일 (주말 제외, 연말 폐장일 포함)
const KRX_HOLIDAYS = new Set([
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02',
  '2026-05-01', '2026-05-05', '2026-05-25', '2026-06-03', '2026-08-17',
  '2026-09-24', '2026-09-25', '2026-10-05', '2026-10-09', '2026-12-25', '2026-12-31',
  '2027-01-01', '2027-02-05', '2027-02-08', '2027-03-01', '2027-05-05', '2027-05-13',
  '2027-08-16', '2027-09-14', '2027-09-15', '2027-09-16', '2027-10-04', '2027-10-11',
  '2027-12-27', '2027-12-31',
]);

const hm = (h, m) => h * 60 + m;
const KRX = { preopen: hm(8, 30), open: hm(9, 0), close: hm(15, 30), afterEnd: hm(18, 0), settled: hm(16, 30) };
const US = { pre: hm(4, 0), open: hm(9, 30), close: hm(16, 0), afterEnd: hm(20, 0) };

const KRX_LABELS = { pre: '장전', open: '장중', after: '장마감', closed: '장마감', holiday: '휴장' };
const US_LABELS = { pre: '프리마켓', open: '장중', after: '애프터마켓', closed: '장마감' };

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = {};

// 특정 시간대의 달력 값 { ymd:'YYYY-MM-DD', wd:0~6, minutes, hh, mm, ss }
function zoned(date, timeZone) {
  const f = formatters[timeZone] || (formatters[timeZone] = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }));
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  const hh = Number(p.hour), mm = Number(p.minute);
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    wd: WEEKDAYS[p.weekday],
    hh, mm, ss: Number(p.second),
    minutes: hh * 60 + mm,
  };
}

const kst = (date = new Date()) => zoned(date, KST);
const kstDate = (date = new Date()) => kst(date).ymd;

function weekdayOf(ymd) { return new Date(`${ymd}T00:00:00Z`).getUTCDay(); }

function isKrxTradingDay(ymd) {
  const wd = weekdayOf(ymd);
  return wd >= 1 && wd <= 5 && !KRX_HOLIDAYS.has(ymd);
}

// 'YYYY-MM-DD' 에 n일 더하기
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 오늘 포함 가장 최근 거래일
function lastTradingDay(ymd = kstDate()) {
  let d = ymd;
  for (let i = 0; i < 15 && !isKrxTradingDay(d); i++) d = addDays(d, -1);
  return d;
}

// pre | open | after | closed | holiday
function krxSession(now = new Date()) {
  const t = kst(now);
  if (!isKrxTradingDay(t.ymd)) return 'holiday';
  if (t.minutes >= KRX.preopen && t.minutes < KRX.open) return 'pre';
  if (t.minutes >= KRX.open && t.minutes < KRX.close) return 'open';
  if (t.minutes >= KRX.close && t.minutes < KRX.afterEnd) return 'after';
  return 'closed';
}

// pre | open | after | closed (미국 공휴일은 시세 데이터로 보정)
function usSession(now = new Date()) {
  const t = zoned(now, NEW_YORK);
  if (t.wd === 0 || t.wd === 6) return 'closed';
  if (t.minutes >= US.pre && t.minutes < US.open) return 'pre';
  if (t.minutes >= US.open && t.minutes < US.close) return 'open';
  if (t.minutes >= US.close && t.minutes < US.afterEnd) return 'after';
  return 'closed';
}

// 지금 시세가 얼마나 자주 바뀌는지에 맞춘 백그라운드 갱신 주기(초)
function refreshInterval(now = new Date()) {
  const kr = krxSession(now);
  const t = kst(now);
  if (kr === 'pre' || kr === 'open') return config.refresh.krOpen;
  if (kr === 'after' && t.minutes < KRX.settled) return config.refresh.active;
  if (['pre', 'open', 'after'].includes(usSession(now))) return config.refresh.active;
  // 평일 낮에는 환율 고시가 계속 바뀐다
  if (kr !== 'holiday' && t.minutes >= hm(8, 0) && t.minutes < KRX.afterEnd) return config.refresh.active;
  return config.refresh.closed;
}

// KST 기준 ISO 문자열 (2026-10-30T22:10:13+09:00)
function kstIso(date = new Date()) {
  const t = kst(date);
  const pad = n => String(n).padStart(2, '0');
  return `${t.ymd}T${pad(t.hh)}:${pad(t.mm)}:${pad(t.ss)}+09:00`;
}

module.exports = {
  KST, NEW_YORK, KRX_HOLIDAYS, KRX_LABELS, US_LABELS, KRX,
  zoned, kst, kstDate, kstIso, addDays, isKrxTradingDay, lastTradingDay,
  krxSession, usSession, refreshInterval,
};
