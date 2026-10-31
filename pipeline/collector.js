// ─────────────────────────────────────────────────────────────────────────────
// pipeline/collector.js — 데이터 수집기
//
// 장 상태에 맞춘 주기로 업스트림을 배치 호출해 메모리 스냅샷을 유지한다.
// API 요청은 업스트림을 기다리지 않고 이 스냅샷을 바로 돌려준다.
//
//  · live   : 시세·수급·시장 폭·트리맵·신호·점수 (장중 20초, 장외 1~5분)
//  · series : 일별 히스토리·수급·신용 (1시간, 마지막 날짜 이후만 증분 조회)
//
// 스냅샷은 토픽(quotes·boards·treemap·…)으로 나뉘고, 바뀐 토픽만 SSE 구독자에게 푸시한다.
// quotes·stocks 는 바뀐 종목만, intraday 는 새로 생긴 분봉만 보낸다.
// 접속자도 요청도 없으면 수집을 멈췄다가 다음 요청 때 다시 깨어난다.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const config = require('./config');
const naver = require('./sources/naver');
const others = require('./sources/others');
const A = require('./analytics');
const insights = require('./insights');
const H = require('./market-hours');
const I = require('./instruments');
const { computeScore, computeHistory } = require('./score');
const { analyzeDollar } = require('./dollar');

const MARKETS = ['KOSPI', 'KOSDAQ'];
const BOARD_INDEX = { KOSPI: 'kospi', KOSDAQ: 'kosdaq' };
const CHART_DAYS = 1900;            // 5년 + 여유 — 차트 API 는 1회 호출로 받는다
const MI_PAGES = 5;                 // 60일 × 5 ≈ 1.2년
const MI_SCORE_PAGES = 6;           // 점수·상관 계산용 (≈ 1.4년)
const MI_DEEP_PAGES = 22;           // 5년 차트 요청 시에만 (요청 시 조회 후 12시간 캐시)
const DEEP_IDS = new Set(['usdkrw', 'dxy']);   // 달러 탭 3년 분석용으로 기본 히스토리를 5년 유지
const FLOW_PAGES = 3;               // 200일 × 3 ≈ 2.4년 (주간 수급 보드 104주)
const DEPOSIT_PAGES = 2;
const INCREMENTAL_DAYS = 10;
const TOP_LIMIT = 50;
const MOVER_LIMIT = 10;
const THEME_LIMIT = 15;
const SCORE_HISTORY_DAYS = 120;
const WATCH_LIMIT = 60;
const STOCK_CODE = /^(?=.*\d)[0-9A-Z]{6}$/;   // 숫자 6자리 + 신규 상장 영숫자 코드(0162Z0)
const INTRADAY_IDS = I.INSTRUMENTS.filter(i => i.intraday).map(i => i.id);

const RANGE_DAYS = { '1d': 7, '1w': 7, '1m': 31, '3m': 92, '6m': 183, '1y': 366, '3y': 1096, '5y': 1827 };

// (팩터, 미국장 시차 적용, 금리처럼 bp 차이로 계산)
const CORRELATION_FACTORS = [
  ['sox', true, false], ['ndx', true, false], ['spx', true, false], ['vix', true, false],
  ['us10y', true, true], ['usdkrw', false, false], ['n225', false, false], ['hsi', false, false],
];

// 위젯 id → 일별 수급 필드 (KOSPI)
const FLOW_SERIES = {
  'flow-foreign': ['foreign', '외국인 순매수'], 'flow-inst': ['institution', '기관 순매수'],
  'flow-retail': ['individual', '개인 순매수'], 'flow-pension': ['pension', '연기금 순매수'],
};

// 캐시 키 → 화면에 보일 소스 이름 (stale 배너용)
const SOURCE_LABELS = {
  domestic: '국내 지수', world: '해외 지수', majors: '환율·금리·원자재', mi: '국채 금리',
  integration: '수급·시장 폭', top: '시총 상위', movers: '거래대금 상위', highlow: '52주 신고·신저가',
  industries: '업종 등락', themes: '테마', vki: 'VKOSPI 선물', intraday: '분봉', stocks: '관심종목',
  hist: '히스토리', flows: '수급 히스토리', deposit: '신용잔고', vkospi: 'VKOSPI(KRX)', fxbank: '은행 고시 환율',
};

const LIVE_TOPICS = ['boards', 'treemap', 'movers', 'sectors', 'themes', 'insights', 'dollar'];

const digest = text => crypto.createHash('sha1').update(text).digest('base64');
const round = A.round;

// 깨워질 수 있는 sleep
class Wake {
  constructor() { this._reset(); }
  _reset() { this.promise = new Promise(r => { this.resolve = r; }); }
  set() { this.resolve(); }
  async wait(ms) {
    let timer;
    await Promise.race([this.promise, new Promise(r => { timer = setTimeout(r, ms); })]);
    clearTimeout(timer);
    this._reset();
  }
}

async function runLimited(tasks, limit) {
  const queue = [...tasks];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await queue.shift()();
  }));
}

// 시세가 속한 거래일 (as_of 의 현지 날짜, 직전 거래일 보정 시 그 날짜)
const quoteDay = q => (q && q.day) || null;

class Collector {
  constructor(http, cache) {
    this.http = http;
    this.cache = cache;
    this.state = null;               // 최신 스냅샷 (토픽별 객체)
    this.digests = {};               // 토픽 → digest
    this.quoteDigests = new Map();
    this.stockDigests = new Map();
    this.intradaySent = {};          // id → { date, length }
    this.snapshotJson = null;
    this.snapshotEtag = null;
    this.liveVersion = 0;
    this.seriesVersion = 0;
    this.series = { version: 0, score_history: [], correlation: [] };
    this.liveCheckedAt = 0;
    this.startedAt = Date.now();
    this.failed = new Set();
    this.subscribers = new Set();
    this.lastAccess = Date.now();
    this.wakeLive = new Wake();
    this.wakeSeries = new Wake();
    this.liveWaiters = [];
    this.running = false;
    this.resolvingSectors = null;
  }

  // ── 수명 주기 ──────────────────────────────────────────────────────────────
  start() {
    this.running = true;
    // 디스크에 남은 마지막 데이터로 먼저 스냅샷을 만들어 첫 요청부터 응답한다
    if (this.cache.peek('live:domestic')) {
      this._publishSeries();
      this._publishLive();
    }
    this.loops = [this._loop('live'), this._loop('series')];
  }

  async stop() {
    this.running = false;
    this.wakeLive.set();
    this.wakeSeries.set();
    this.cache.flush();
  }

  isActive() { return this.subscribers.size > 0 || Date.now() - this.lastAccess < config.idleAfter * 1000; }

  // API 요청·접속이 있을 때 호출. 쉬고 있었다면 즉시 갱신을 깨운다
  touch() {
    const wasIdle = !this.isActive();
    this.lastAccess = Date.now();
    if (wasIdle) { this.wakeLive.set(); this.wakeSeries.set(); }
  }

  // 스냅샷이 너무 오래됐으면(쉬다 깨어난 경우) 다음 갱신을 잠깐 기다린다
  async ensureFresh(timeout = 6000) {
    const age = Date.now() - this.liveCheckedAt;
    if (this.state && age < H.refreshInterval() * 2000) return;
    await Promise.race([
      new Promise(r => { this.liveWaiters.push(r); this.wakeLive.set(); }),
      new Promise(r => setTimeout(r, timeout)),
    ]);
  }

  async _loop(kind) {
    const wake = kind === 'live' ? this.wakeLive : this.wakeSeries;
    // 첫 live 수집이 끝난 뒤 히스토리를 받아 시작 시 동시 호출 수를 줄인다
    if (kind === 'series') await new Promise(r => setTimeout(r, 300));
    while (this.running) {
      if (this.isActive() || !this.state) {
        try {
          if (kind === 'live') await this.refreshLive();
          else await this.refreshSeries();
        } catch (e) {
          console.error(`[collector] ${kind} 갱신 실패:`, e);
        }
      }
      await wake.wait(kind === 'live' ? H.refreshInterval() * 1000 : config.refresh.history * 1000);
    }
  }

  // ── 구독 (SSE) ─────────────────────────────────────────────────────────────
  // client: { send(event, data), watch: Set<code> }
  subscribe(client) {
    this.touch();
    this.subscribers.add(client);
    if (client.watch.size && !this._watchCovered(client.watch)) this.wakeLive.set();
    return () => {
      this.subscribers.delete(client);
      this.lastAccess = Date.now();
    };
  }

  watchCodes() {
    const all = new Set();
    for (const c of this.subscribers) for (const code of c.watch) all.add(code);
    return [...all].sort().slice(0, WATCH_LIMIT);
  }

  _watchCovered(watch) {
    const stocks = (this.state && this.state.stocks) || {};
    return [...watch].every(code => stocks[code]);
  }

  _broadcast(events) {
    for (const client of this.subscribers) {
      for (const [event, data] of events) {
        if (event === 'stocks') {
          const mine = {};
          for (const code of client.watch) if (data[code]) mine[code] = data[code];
          if (Object.keys(mine).length) client.send(event, JSON.stringify(mine));
        } else {
          client.send(event, typeof data === 'string' ? data : JSON.stringify(data));
        }
      }
    }
  }

  // ── 조회 ───────────────────────────────────────────────────────────────────
  async _fetchAll(jobs, concurrency) {
    await runLimited(Object.entries(jobs).map(([key, [ttl, fetcher]]) => async () => {
      try {
        const result = await this.cache.get(key, ttl, fetcher, { persist: true });
        if (result.stale) this.failed.add(key); else this.failed.delete(key);
      } catch (e) {
        this.failed.add(key);
        console.warn(`[collector] ${key} 조회 실패 (저장된 값 없음): ${e.message}`);
      }
    }), concurrency);
  }

  async refreshLive() {
    const interval = H.refreshInterval();
    const session = H.krxSession();
    const ttl = Math.max(5, interval - 5);
    const slow = Math.max(ttl, 60);
    const http = this.http;
    const jobs = {
      'live:domestic': [ttl, () => naver.domesticIndices(http, I.DOMESTIC_CODES)],
      'live:world': [ttl, () => naver.worldIndices(http, I.WORLD_CODES)],
      'live:majors': [ttl, () => naver.majors(http)],
      'live:industries': [slow, () => naver.industries(http)],
      'live:themes': [Math.max(ttl, 120), () => naver.themes(http, THEME_LIMIT)],
      'live:vki': [Math.max(ttl, 120), () => others.tvQuote(http, 'KRX:VKI1!')],
      'live:fxbank': [Math.max(ttl, 120), () => naver.fxBankRates(http, 'FX_USDKRW')],
    };
    for (const m of MARKETS) {
      jobs[`live:integration:${m}`] = [ttl, () => naver.indexIntegration(http, m)];
      // 시총 순위에는 ETF 도 섞여 있어 넉넉히 받아 개별 종목만 남긴다
      jobs[`live:top:${m}`] = [slow, async () => (await naver.topMarketCap(http, m, TOP_LIMIT + 20)).filter(s => s.type === 'stock').slice(0, TOP_LIMIT)];
      jobs[`live:movers:${m}`] = [slow, () => naver.topTradingValue(http, m, MOVER_LIMIT)];
      jobs[`live:highlow:${m}`] = [Math.max(ttl, 120), () => naver.highLowCounts(http, m)];
    }
    // majors 에 없는 국채 만기물은 1행씩 (금리는 천천히 움직여 5분 주기)
    for (const inst of I.INSTRUMENTS.filter(i => i.quote === 'mi')) {
      jobs[`live:mi:${inst.id}`] = [300, () => naver.marketindexLatest(http, inst.history.category, inst.code)];
    }
    // 분봉: 장중 1분, 장외에는 마지막 거래일 그대로
    const minuteTtl = session === 'open' || session === 'pre' ? 55 : 1800;
    const today = H.kstDate();
    for (const id of INTRADAY_IDS) {
      const inst = I.BY_ID[id];
      jobs[`live:intraday:${id}`] = [minuteTtl, () => naver.intradayMinutes(http, inst.code, H.addDays(today, -6), today)];
    }
    const watch = this.watchCodes();
    if (watch.length) {
      jobs[`live:stocks:${watch.join(',')}`] = [ttl, () => naver.stockQuotes(http, watch)];
      this.watchKey = `live:stocks:${watch.join(',')}`;
    } else {
      this.watchKey = null;
    }
    await this._fetchAll(jobs, 8);
    this._resolveSectors();
    this._publishLive();
  }

  async refreshSeries() {
    const today = H.kstDate();
    const jobs = {};
    for (const inst of I.INSTRUMENTS.filter(i => i.history)) {
      const key = `series:hist:${inst.id}`;
      // 3년 분석용 지표인데 저장된 히스토리가 얕으면 TTL 과 관계없이 바로 깊게 받는다
      const shallow = DEEP_IDS.has(inst.id) && this.cache.value(key, []).length < 700;
      jobs[key] = [shallow ? 0 : config.refresh.history - 60, this._historyFetcher(inst, today)];
    }
    for (const m of MARKETS) jobs[`series:flows:${m}`] = [config.refresh.history - 60, this._flowsFetcher(m, today)];
    jobs['series:deposit'] = [config.refresh.history - 60, this._depositFetcher(today)];
    if (config.krxApiKey) {
      jobs['series:vkospi'] = [config.refresh.history - 60, () => others.krxVkospi(this.http, config.krxApiKey, today)];
    }
    // 히스토리는 급하지 않으니 동시 호출 수를 낮춰 소스에 부담을 덜 준다
    await this._fetchAll(jobs, 4);
    this._publishSeries();
    // 이동평균·점수·신호가 히스토리에 의존하므로 live 도 다시 만든다
    this._publishLive();
  }

  _needsFull(prev, today, minRows) {
    if (!prev || prev.length < minRows) return true;
    const last = prev[prev.length - 1].date;
    return (new Date(today) - new Date(last)) / 86400000 > INCREMENTAL_DAYS;
  }

  _historyFetcher(inst, today) {
    const key = `series:hist:${inst.id}`;
    const h = inst.history;
    return async () => {
      const prev = this.cache.value(key, []);
      const start = H.addDays(today, -CHART_DAYS);
      const deep = DEEP_IDS.has(inst.id);
      let full = this._needsFull(prev, today, deep ? 700 : 30);
      let rows;
      try {
        if (h.type === 'chart') {
          const since = full ? start : H.addDays(prev[prev.length - 1].date, -7);
          rows = await naver.chartHistory(this.http, h.kind, h.code, since, today);
        } else {
          const pages = full ? (deep ? MI_DEEP_PAGES : I.SCORE_SERIES.includes(inst.id) ? MI_SCORE_PAGES : MI_PAGES) : 1;
          rows = await naver.marketindexHistory(this.http, h.category, h.code, pages);
        }
        if (!rows.length) throw new Error('빈 응답');
      } catch (e) {
        if (!inst.yahoo || !full) throw e;
        console.info(`[collector] ${inst.id} 네이버 히스토리 실패, Yahoo 로 대체: ${e.message}`);
        rows = await others.yahooDaily(this.http, inst.yahoo, H.addDays(today, -800), inst.yahooMult || 1);
        full = true;
      }
      const slim = rows.map(r => (h.type === 'chart'
        ? { date: r.date, open: r.open, high: r.high, low: r.low, close: r.close }
        : { date: r.date, close: r.close }));
      // 증분 조회분은 기존 히스토리에 병합한다 (같은 날짜는 새 값 우선)
      const merged = full && !prev.length ? slim : A.mergeRows(prev, slim);
      return merged.filter(r => r.date >= start);
    };
  }

  _flowsFetcher(market, today) {
    const key = `series:flows:${market}`;
    return async () => {
      const prev = this.cache.value(key, []);
      if (this._needsFull(prev, today, 400)) return naver.investorFlows(this.http, market, FLOW_PAGES);
      const rows = await naver.investorFlows(this.http, market, 1, INCREMENTAL_DAYS);
      return A.mergeRows(prev, rows).slice(-FLOW_PAGES * naver.FLOWS_PAGE_SIZE);
    };
  }

  _depositFetcher(today) {
    return async () => {
      const prev = this.cache.value('series:deposit', []);
      if (this._needsFull(prev, today, 150)) return naver.depositTrend(this.http, DEPOSIT_PAGES);
      const rows = await naver.depositTrend(this.http, 1, INCREMENTAL_DAYS);
      return A.mergeRows(prev, rows).slice(-DEPOSIT_PAGES * naver.DEPOSIT_PAGE_SIZE);
    };
  }

  // 트리맵 종목의 네이버 업종을 한 번만 조회해 디스크에 보관 (새로 들어온 종목만)
  _resolveSectors() {
    if (this.resolvingSectors) return;
    const map = this.cache.value('sectors:map', {});
    const monthAgo = Date.now() - 30 * 86400000;
    const codes = MARKETS.flatMap(m => this.cache.value(`live:top:${m}`, []).map(s => s.code))
      .filter(code => !map[code] || map[code].at < monthAgo)
      .slice(0, 30);
    if (!codes.length) return;
    this.resolvingSectors = (async () => {
      const found = {};
      await runLimited(codes.map(code => async () => {
        try { found[code] = { no: await naver.stockIndustry(this.http, code), at: Date.now() }; } catch (_) { /* 다음 주기에 다시 */ }
      }), 4);
      if (Object.keys(found).length) {
        this.cache.set('sectors:map', { ...this.cache.value('sectors:map', {}), ...found }, { persist: true });
        this._publishLive();
      }
    })().finally(() => { this.resolvingSectors = null; });
  }

  // ── 스냅샷 조립 ────────────────────────────────────────────────────────────
  _history(id) { return this.cache.value(`series:hist:${id}`, []); }

  _makeQuote(inst, raw, stale) {
    const base = {
      id: inst.id, name: inst.name, group: inst.group, unit: inst.unit, dec: inst.dec,
      kr_impact: inst.krImpact, note: inst.note || null,
    };
    if (!raw || raw.price == null) return { ...base, price: null, stale: true, source: 'none' };
    let { change, change_percent: pct } = raw;
    let day = raw.as_of ? String(raw.as_of).slice(0, 10) : null;
    let prevSession = false;
    // 미국 지수 프리마켓: 네이버가 등락 0 으로 주므로 직전 거래일 등락으로 보정
    if (raw.market_status === 'PREOPEN' && !change) {
      const rows = this._history(inst.id);
      const last = rows[rows.length - 1], prev = rows[rows.length - 2];
      if (last && prev && Math.abs(last.close - raw.price) <= Math.abs(raw.price) * 1e-6) {
        change = last.close - prev.close;
        pct = prev.close ? (change / prev.close) * 100 : null;
        day = last.date;
        prevSession = true;
      }
    }
    return {
      ...base,
      price: raw.price, change: round(change, 4), change_percent: round(pct, 2),
      open: raw.open ?? null, high: raw.high ?? null, low: raw.low ?? null,
      as_of: raw.as_of, day, market_status: raw.market_status, delayed: raw.delayed || 0,
      stale, source: 'naver', prev_session: prevSession,
    };
  }

  _spreadQuote(id, spec, a, b) {
    const base = { id, name: spec.name, group: 'rates', unit: 'pct', dec: 2, note: spec.note, source: 'calc', kr_impact: 0 };
    if (!a || !b || a.price == null || b.price == null) return { ...base, price: null, stale: true };
    const asOf = [a.as_of, b.as_of].filter(Boolean).sort().pop() || null;
    return {
      ...base,
      price: round(a.price - b.price, 4),
      change: a.change != null && b.change != null ? round(a.change - b.change, 4) : null,
      change_percent: null, as_of: asOf, day: [a.day, b.day].filter(Boolean).sort().pop() || null,
      stale: !!(a.stale || b.stale),
    };
  }

  _vkospiQuote() {
    const base = { id: 'vkospi', name: 'VKOSPI', group: 'volatility', unit: 'index', dec: 2, kr_impact: -1 };
    const krx = this.cache.value('series:vkospi');
    if (krx && krx.price != null) {
      return {
        ...base, price: krx.price, change: krx.change, change_percent: krx.change_percent,
        as_of: `${krx.date}T15:30:00+09:00`, day: krx.date, stale: this.failed.has('series:vkospi'),
        source: 'krx', note: '코스피200 변동성지수 (KRX OpenAPI, 일별)', delayed: 0,
      };
    }
    const tv = this.cache.peek('live:vki');
    if (!tv) return { ...base, price: null, stale: true, source: 'none', note: 'V-KOSPI 선물' };
    return {
      ...base, price: tv.value.price, change: round(tv.value.change, 2), change_percent: round(tv.value.change_percent, 2),
      as_of: H.kstIso(new Date(tv.fetchedAt)), day: H.kstDate(new Date(tv.fetchedAt)),
      stale: this.failed.has('live:vki'), source: 'tradingview', delayed: tv.value.delayed || 20,
      note: 'V-KOSPI 선물 최근월물 (TradingView, 20분 지연) · 라인 = KOSPI 21일 실현변동성',
    };
  }

  _board(market, quote, integ, history, hl) {
    const rows = A.mergePoint(history, quoteDay(quote), quote.price);
    const values = A.closes(rows);
    const vol = A.realizedVolSeries(values.slice(-(252 + 21)));
    const rv = vol.length ? vol[vol.length - 1] : null;
    let high = integ ? integ.high_52w : null, low = integ ? integ.low_52w : null;
    if ((high == null || low == null) && values.length) {
      high = Math.max(...values.slice(-252));
      low = Math.min(...values.slice(-252));
    }
    return {
      id: market, quote_id: quote.id,
      quote: { price: quote.price, change: quote.change, change_percent: quote.change_percent },
      high_52w: high, low_52w: low,
      range_position: round(A.rangePosition(quote.price, low, high), 3),
      drawdown_pct: round(A.drawdownPct(quote.price, high)),
      ma: A.movingAverages(values),
      rv20: round(rv, 1),
      rv_pct: rv != null ? A.percentileRank(rv, vol.slice(-252)) : null,
      breadth: integ ? integ.breadth : null,
      flows: integ ? integ.flows : null,
      program: integ ? integ.program : null,
      trading_value: integ ? integ.trading_value : null,
      highs: hl ? hl.highs : null,
      lows: hl ? hl.lows : null,
    };
  }

  _creditSummary(rows) {
    if (!rows.length) return null;
    const last = rows[rows.length - 1];
    const credits = rows.map(r => r.credit_loan);
    const c5 = credits.length >= 6 && credits[credits.length - 6] ? (credits[credits.length - 1] / credits[credits.length - 6] - 1) * 100 : null;
    return {
      date: last.date, customer_deposit: last.customer_deposit, credit_loan: last.credit_loan,
      credit_change_5d_pct: round(c5),
      credit_to_deposit_pct: last.customer_deposit ? round((last.credit_loan / last.customer_deposit) * 100, 1) : null,
      credit_percentile: credits.length >= 20 ? A.percentileRank(credits[credits.length - 1], credits) : null,
      percentile_days: credits.length,
      stale: this.failed.has('series:deposit'),
    };
  }

  _session(now, kospi) {
    let kr = H.krxSession(now);
    const t = H.kst(now);
    const tradedToday = !!(kospi && kospi.day === t.ymd);
    // 휴장일 목록에 없는 임시 휴장 / 목록과 다른 실제 개장을 시세 데이터로 보정
    if ((kr === 'open' || kr === 'after') && kospi && kospi.price != null && !tradedToday && t.minutes > 9 * 60 + 10) kr = 'holiday';
    else if (kr === 'holiday' && tradedToday && kospi.market_status === 'OPEN') kr = 'open';
    const us = H.usSession(now);
    return {
      now: H.kstIso(now), krx: kr, krx_label: H.KRX_LABELS[kr], us, us_label: H.US_LABELS[us],
      refresh_seconds: H.refreshInterval(now),
    };
  }

  // 일별 확정 수급 + 오늘 잠정 수급
  _flowsWithToday(market) {
    const rows = this.cache.value(`series:flows:${market}`, []);
    const integ = this.cache.value(`live:integration:${market}`);
    const today = integ && integ.flows;
    if (!today || today.foreign == null) return rows;
    const last = rows[rows.length - 1];
    const merged = last && last.date === today.date ? { ...last, ...today } : { pension: null, ...today };
    return A.mergeRows(rows, [merged]);
  }

  _scoreSeries(quotes, kospiFlows) {
    const out = {};
    for (const id of I.SCORE_SERIES) {
      let rows = this._history(id);
      const q = quotes && quotes[id];
      if (q) rows = A.mergePoint(rows, quoteDay(q), q.price);
      out[id] = rows.map(r => [r.date, r.close]);
    }
    out.FOREIGN = kospiFlows.filter(r => r.foreign != null).map(r => [r.date, r.foreign]);
    return out;
  }

  _sectorName(code, names) {
    const entry = this.cache.value('sectors:map', {})[code];
    return (entry && entry.no != null && names.get(entry.no)) || '기타';
  }

  _buildLive() {
    const now = new Date();
    const v = (key, def) => this.cache.value(key, def);
    const sources = { domestic: 'live:domestic', world: 'live:world', majors: 'live:majors' };

    const quotes = {};
    for (const inst of I.INSTRUMENTS) {
      if (inst.quote === 'mi') {
        quotes[inst.id] = this._makeQuote(inst, v(`live:mi:${inst.id}`), this.failed.has(`live:mi:${inst.id}`));
      } else {
        const key = sources[inst.quote];
        quotes[inst.id] = this._makeQuote(inst, v(key, {})[inst.code], this.failed.has(key));
      }
    }
    for (const [id, spec] of Object.entries(I.SPREADS)) quotes[id] = this._spreadQuote(id, spec, quotes[spec.a], quotes[spec.b]);
    quotes.vkospi = this._vkospiQuote();

    const boards = {};
    for (const m of MARKETS) {
      boards[m] = this._board(m, quotes[BOARD_INDEX[m]], v(`live:integration:${m}`), this._history(BOARD_INDEX[m]), v(`live:highlow:${m}`));
    }

    const names = new Map(v('live:industries', []).map(g => [g.no, g.name]));
    const treemap = {}, movers = {};
    for (const m of MARKETS) {
      treemap[m] = v(`live:top:${m}`, []).map(s => ({
        code: s.code, name: s.name, price: s.price, change_percent: s.change_percent,
        market_cap: s.market_cap, trading_value: s.trading_value, sector: this._sectorName(s.code, names),
      }));
      movers[m] = v(`live:movers:${m}`, []).map(s => ({
        code: s.code, name: s.name, price: s.price, change_percent: s.change_percent,
        trading_value: s.trading_value, market_cap: s.market_cap,
      }));
    }
    const sectors = [...v('live:industries', [])].sort((a, b) => b.change - a.change);
    const themes = v('live:themes', []).slice(0, THEME_LIMIT);

    const kospiFlows = this._flowsWithToday('KOSPI');
    const usdkrw = quotes.usdkrw;
    const usdkrwRows = A.mergePoint(this._history('usdkrw'), quoteDay(usdkrw), usdkrw.price);
    const kospiRows = A.mergePoint(this._history('kospi'), quoteDay(quotes.kospi), quotes.kospi.price);
    const credit = this._creditSummary(v('series:deposit', []));
    const score = computeScore(this._scoreSeries(quotes, kospiFlows));
    const session = this._session(now, quotes.kospi);
    const feargreed = insights.fearGreed({ boards, kospiRows, usdkrwRows });
    const insightTopic = {
      score, feargreed, credit,
      signals: insights.buildSignals({ quotes, boards, credit, kospiFlows, usdkrwRows, vkospi: quotes.vkospi }),
      summary: insights.buildSummary({ quotes, boards, score, session, feargreed }),
    };

    const live = id => A.mergePoint(this._history(id), quoteDay(quotes[id]), quotes[id].price);
    const dollar = analyzeDollar({
      usdkrw: usdkrwRows, dxy: live('dxy'), us10y: live('us10y'), ktb10: live('ktb10'),
      flows: kospiFlows, vix: quotes.vix, bank: v('live:fxbank'), today: H.kstDate(now),
    });

    const intraday = {};
    for (const id of INTRADAY_IDS) {
      const d = v(`live:intraday:${id}`);
      if (d) intraday[id] = { date: d.date, points: d.points.map(p => [p.t, p.v]) };
    }

    const stocks = {};
    if (this.watchKey) {
      for (const [code, q] of Object.entries(v(this.watchKey, {}))) {
        stocks[code] = {
          code, name: q.name, price: q.price, change: q.change, change_percent: q.change_percent,
          market_cap: q.market_cap, trading_value: q.trading_value, as_of: q.as_of, market_status: q.market_status,
        };
      }
    }
    // 관심종목 목록이 바뀌어도 이전에 받은 종목은 유지 (다음 갱신까지 공백 방지)
    const prevStocks = (this.state && this.state.stocks) || {};
    for (const code of this.watchCodes()) if (!stocks[code] && prevStocks[code]) stocks[code] = prevStocks[code];

    const staleSources = [...new Set([...this.failed].map(k => SOURCE_LABELS[k.split(':')[1]] || k))].sort();
    return {
      meta: {
        generated_at: H.kstIso(now), session, stale_sources: staleSources,
        live_version: this.liveVersion, series_version: this.seriesVersion,
      },
      quotes, boards, treemap, movers, sectors, themes, insights: insightTopic, dollar, intraday, stocks,
    };
  }

  // ── 발행 ───────────────────────────────────────────────────────────────────
  _publishLive() {
    const state = this._buildLive();
    const events = [];

    const changed = {};
    for (const [id, q] of Object.entries(state.quotes)) {
      const d = digest(JSON.stringify(q));
      if (this.quoteDigests.get(id) !== d) { this.quoteDigests.set(id, d); changed[id] = q; }
    }
    if (Object.keys(changed).length) events.push(['quotes', changed]);

    for (const topic of LIVE_TOPICS) {
      const json = JSON.stringify(state[topic]);
      const d = digest(json);
      if (this.digests[topic] !== d) { this.digests[topic] = d; events.push([topic, json]); }
    }

    // 분봉: 같은 날이면 마지막 점(진행 중인 분)부터 이어 붙일 부분만
    const patch = {};
    for (const [id, d] of Object.entries(state.intraday)) {
      const sent = this.intradaySent[id];
      const key = digest(JSON.stringify(d.points[d.points.length - 1] || null) + d.points.length + d.date);
      if (sent && sent.key === key) continue;
      const from = sent && sent.date === d.date && sent.length <= d.points.length ? Math.max(0, sent.length - 1) : 0;
      patch[id] = { date: d.date, from, points: d.points.slice(from) };
      this.intradaySent[id] = { date: d.date, length: d.points.length, key };
    }
    if (Object.keys(patch).length) events.push(['intraday', patch]);

    const stockPatch = {};
    for (const [code, q] of Object.entries(state.stocks)) {
      const d = digest(JSON.stringify(q));
      if (this.stockDigests.get(code) !== d) { this.stockDigests.set(code, d); stockPatch[code] = q; }
    }
    if (Object.keys(stockPatch).length) events.push(['stocks', stockPatch]);

    if (events.length) this.liveVersion++;
    state.meta.live_version = this.liveVersion;
    state.meta.series_version = this.seriesVersion;
    this.state = state;
    this.liveCheckedAt = Date.now();
    this.snapshotJson = null;      // 다음 /api/snapshot 요청 때 다시 직렬화

    events.push(['meta', state.meta]);
    this._broadcast(events);
    const waiters = this.liveWaiters;
    this.liveWaiters = [];
    waiters.forEach(r => r());
  }

  _publishSeries() {
    const kospi = this._history('kospi');
    const days = kospi.map(r => r.date).slice(-SCORE_HISTORY_DAYS);
    const flows = this.cache.value('series:flows:KOSPI', []);
    const next = {
      score_history: computeHistory(this._scoreSeries(null, flows), days),
      correlation: CORRELATION_FACTORS.map(([id, lagged, asDiff]) => {
        const r = kospi.length ? A.leadLag(kospi, this._history(id), { lagged, asDiff }) : null;
        return { id, name: I.BY_ID[id].name, lagged, window: r ? r.window : 0, ...(r || {}) };
      }),
      last_dates: Object.fromEntries(I.INSTRUMENTS.filter(i => i.history).map(i => {
        const rows = this._history(i.id);
        return [i.id, rows.length ? rows[rows.length - 1].date : null];
      })),
    };
    const d = digest(JSON.stringify(next));
    if (d === this.digests.series) return;
    this.digests.series = d;
    this.seriesVersion++;
    this.series = { version: this.seriesVersion, ...next };
    this.snapshotJson = null;
    this._broadcast([['series', this.series]]);
  }

  // SSE 접속 직후 / 폴링용 전체 스냅샷
  snapshot(watch) {
    const s = this.state;
    if (!s) return null;
    const stocks = {};
    for (const code of watch || []) if (s.stocks[code]) stocks[code] = s.stocks[code];
    return { ...s, stocks, series: this.series };
  }

  snapshotEtagFor(watch) {
    const parts = [this.liveVersion, this.seriesVersion, (watch || []).join(',')];
    return `W/"${digest(parts.join('|')).slice(0, 16)}"`;
  }

  // ── 요청 시 조회 (캐시 경유) ────────────────────────────────────────────────
  // 반환 { id, name, kind:'line'|'bars'|'candle', unit, rows:[{date, close, ...}], source, stale }
  async history(id, range = '1y') {
    const days = RANGE_DAYS[range] || 366;
    const today = H.kstDate();
    const cutoff = H.addDays(today, -days);
    const cut = rows => rows.filter(r => r.date >= cutoff);
    const quotes = (this.state && this.state.quotes) || {};
    const live = (rows, q) => (q ? A.mergePoint(rows, quoteDay(q), q.price) : rows);

    if (STOCK_CODE.test(id)) return this._stockHistory(id, range, today, cutoff);

    if (FLOW_SERIES[id]) {
      const [field, name] = FLOW_SERIES[id];
      const rows = this._flowsWithToday('KOSPI').filter(r => r[field] != null).map(r => ({ date: r.date, close: r[field] }));
      return { id, name, kind: 'bars', unit: '억원', rows: cut(rows), source: 'naver', stale: this.failed.has('series:flows:KOSPI') };
    }
    if (id === 'credit' || id === 'deposit') {
      const field = id === 'credit' ? 'credit_loan' : 'customer_deposit';
      const rows = this.cache.value('series:deposit', []).map(r => ({ date: r.date, close: round(r[field] / 10000, 2) }));
      return { id, name: id === 'credit' ? '신용융자 잔고' : '고객예탁금', kind: 'line', unit: '조원', rows: cut(rows), source: 'naver', stale: this.failed.has('series:deposit') };
    }
    if (id === 'vkospi') {
      const base = live(this._history('kospi'), quotes.kospi);
      const fromIdx = Math.max(0, base.findIndex(r => r.date >= cutoff) - 22);
      const rows = A.realizedVolRows(base.slice(fromIdx), 21);
      return { id, name: 'KOSPI 21일 실현변동성', kind: 'line', unit: '%', rows: cut(rows), source: 'calc', stale: false };
    }
    if (I.SPREADS[id]) {
      const spec = I.SPREADS[id];
      const a = await this._deepHistory(spec.a, range), b = await this._deepHistory(spec.b, range);
      const rows = A.asofJoin(live(a, quotes[spec.a]), live(b, quotes[spec.b]), (x, y) => round(x - y, 4));
      return { id, name: spec.name, kind: 'line', unit: '%p', rows: cut(rows), source: 'calc', stale: false };
    }
    const inst = I.BY_ID[id];
    if (!inst) throw Object.assign(new Error(`지원하지 않는 지표: ${id}`), { status: 404 });
    if (!inst.history) return { id, name: inst.name, kind: 'line', unit: inst.unit, rows: [], source: 'none', stale: false };
    const rows = live(await this._deepHistory(id, range), quotes[id]);
    return {
      id, name: inst.name, kind: 'line', unit: inst.unit, rows: cut(rows), source: 'naver',
      stale: this.failed.has(`series:hist:${id}`),
    };
  }

  // 5년 범위의 시장지표는 기본 히스토리(1.2년)보다 깊게 한 번 더 받아 12시간 보관
  async _deepHistory(id, range) {
    const inst = I.BY_ID[id];
    const base = this._history(id);
    if (!inst || !inst.history || inst.history.type !== 'mi' || !['3y', '5y'].includes(range)) return base;
    const { category, code } = inst.history;
    try {
      const deep = await this.cache.get(`deep:${id}`, 12 * 3600,
        () => naver.marketindexHistory(this.http, category, code, MI_DEEP_PAGES), { persist: true, swr: true });
      return A.mergeRows(deep.value, base);
    } catch (_) {
      return base;
    }
  }

  async _stockHistory(code, range, today, cutoff) {
    const session = H.krxSession();
    const ttl = session === 'open' || session === 'pre' ? 60 : 900;
    const days = Math.max(RANGE_DAYS[range] || 183, 31);
    const timeframe = days > 1100 ? 'week' : 'day';
    const result = await this.cache.get(`stock:${code}:${range}`, ttl,
      () => naver.chartHistory(this.http, 'domestic/item', code, H.addDays(today, -days), today, timeframe), { swr: true });
    const stocks = (this.state && this.state.stocks) || {};
    const name = (stocks[code] && stocks[code].name) || this._stockName(code) || code;
    return {
      id: code, name, kind: 'candle', unit: 'krw', rows: result.value.filter(r => r.date >= cutoff),
      source: 'naver', stale: result.stale,
    };
  }

  _stockName(code) {
    for (const m of MARKETS) {
      for (const key of [`live:top:${m}`, `live:movers:${m}`]) {
        const hit = this.cache.value(key, []).find(s => s.code === code);
        if (hit) return hit.name;
      }
    }
    return null;
  }

  async intraday(id) {
    const d = this.state && this.state.intraday[id];
    if (!d) throw Object.assign(new Error(`분봉 미지원: ${id}`), { status: 404 });
    return { id, ...d };
  }

  // 투자자별 주간 순매수 집계 + 지수 주간 종가 + 외국인 연속 매매 주 수 (조원)
  weeklyFlows(market = 'KOSPI', weeks = 104) {
    const rows = this._flowsWithToday(market);
    if (rows.length < 30) return { source: 'unavailable', error: 'insufficient investor history' };
    const keys = ['individual', 'foreign', 'institution', 'pension'];
    const buckets = new Map();
    for (const r of rows) {
      const mon = A.mondayOf(r.date);
      let b = buckets.get(mon);
      if (!b) { b = { end: r.date, individual: 0, foreign: 0, institution: 0, pension: 0 }; buckets.set(mon, b); }
      if (r.date > b.end) b.end = r.date;
      for (const k of keys) b[k] += r[k] || 0;
    }
    const mons = [...buckets.keys()].sort().slice(-weeks);
    const wk = mons.map(k => buckets.get(k));
    const legacy = { individual: 'individual', foreign: 'foreigner', institution: 'institution', pension: 'pension' };
    const net = {}, cum = {};
    for (const k of keys) {
      let s = 0;
      net[legacy[k]] = wk.map(b => +(b[k] / 10000).toFixed(3));
      cum[legacy[k]] = wk.map(b => +((s += b[k]) / 10000).toFixed(3));
    }
    const index = BOARD_INDEX[market];
    const q = this.state && this.state.quotes[index];
    const closeByMon = new Map();
    for (const r of A.mergePoint(this._history(index), quoteDay(q), q && q.price)) closeByMon.set(A.mondayOf(r.date), r.close);
    const streak = A.signStreak(net.foreigner);
    return {
      source: 'live', freq: 'weekly', market, weeks: mons.length, dates: wk.map(b => b.end), net, cum,
      kospi: mons.map(k => (closeByMon.has(k) ? round(closeByMon.get(k)) : null)),
      streak: { weeks: Math.abs(streak), direction: streak < 0 ? 'sell' : 'buy' },
      provisional: H.krxSession() === 'open' && !!(this.cache.value(`live:integration:${market}`) || {}).flows,
    };
  }

  // 투자자별 최근 N일 누적 순매수 (조원) + 지수 종가 — 예전 /api/investors 형식
  dailyFlows(market = 'KOSPI', days = 30) {
    const rows = this._flowsWithToday(market).slice(-days);
    if (!rows.length) return { source: 'unavailable', error: 'no investor data' };
    const cum = key => { let s = 0; return rows.map(r => +((s += (r[key] || 0)) / 10000).toFixed(2)); };
    const index = BOARD_INDEX[market];
    const q = this.state && this.state.quotes[index];
    const closeByDate = new Map(A.mergePoint(this._history(index), quoteDay(q), q && q.price).map(r => [r.date, r.close]));
    const foreigner = cum('foreign');
    return {
      source: 'live', market, dates: rows.map(r => r.date),
      individual: cum('individual'), foreigner, institution: cum('institution'), pension: cum('pension'),
      foreignerCum: foreigner,
      kospi: rows.map(r => (closeByDate.has(r.date) ? round(closeByDate.get(r.date)) : null)),
      net: rows.map(r => ({ date: r.date, individual: r.individual, foreign: r.foreign, institution: r.institution, pension: r.pension })),
    };
  }

  credit(days = 120) {
    const rows = this.cache.value('series:deposit', []);
    return { summary: this._creditSummary(rows), history: rows.slice(-days) };
  }

  // 글로벌 지수 정규화 비교 — 날짜를 합집합으로 맞추고 휴장일은 직전 값으로 채운다
  async globalCompare(range = '1y') {
    const days = RANGE_DAYS[range] || 366;
    const cutoff = H.addDays(H.kstDate(), -days);
    const quotes = (this.state && this.state.quotes) || {};
    const lines = I.GLOBAL_COMPARE.map(([id, name]) => {
      const q = quotes[id];
      const rows = A.mergePoint(this._history(id), quoteDay(q), q && q.price).filter(r => r.date >= cutoff);
      return { id, name, rows };
    }).filter(l => l.rows.length > 1);
    if (!lines.length) return { source: 'unavailable', series: [] };
    const dates = [...new Set(lines.flatMap(l => l.rows.map(r => r.date)))].sort();
    const series = lines.map(l => {
      const byDate = new Map(l.rows.map(r => [r.date, r.close]));
      const base = l.rows[0].close;
      let last = null;
      const data = dates.map(d => {
        if (byDate.has(d)) last = byDate.get(d);
        return last == null ? null : +((last / base - 1) * 100).toFixed(2);
      });
      return { id: l.id, name: l.name, data };
    }).sort((a, b) => b.data[b.data.length - 1] - a.data[a.data.length - 1]);
    return { source: 'live', range, dates, series };
  }

  // 트리맵 주간 모드: 실시간가 ÷ 5거래일 전 종가 (기준가는 하루 한 번만 받는다)
  async weeklyChanges(market) {
    const stocks = (this.state && this.state.treemap[market]) || [];
    const refDay = H.lastTradingDay();
    const key = `weekbase:${market}`;
    const cached = this.cache.value(key);
    const base = cached && cached.day === refDay ? { ...cached.closes } : {};
    const missing = stocks.map(s => s.code).filter(code => base[code] == null);
    if (missing.length) {
      await runLimited(missing.map(code => async () => {
        try {
          const rows = await naver.chartHistory(this.http, 'domestic/item', code, H.addDays(refDay, -21), refDay);
          const before = rows.filter(r => r.date < refDay);
          if (before.length >= 5) base[code] = before[before.length - 5].close;
        } catch (_) { /* 이 종목만 일간 등락으로 표시 */ }
      }), 4);
      this.cache.set(key, { day: refDay, closes: base }, { persist: true });
    }
    const out = {};
    for (const s of stocks) if (base[s.code] && s.price != null) out[s.code] = round((s.price / base[s.code] - 1) * 100, 2);
    return out;
  }

  async stockQuotes(codes) {
    const session = H.krxSession();
    const ttl = session === 'open' || session === 'pre' ? 10 : 120;
    const result = await this.cache.get(`stocks:${[...codes].sort().join(',')}`, ttl, () => naver.stockQuotes(this.http, codes));
    return codes.map(code => result.value[code]).filter(Boolean);
  }

  async search(query) {
    const result = await this.cache.get(`search:${query}`, 3600, () => naver.searchStocks(this.http, query));
    return result.value;
  }

  health() {
    const sources = this.http.snapshot();
    const status = !this.state ? 'starting' : this.failed.size || sources.some(s => !s.ok) ? 'degraded' : 'ok';
    return {
      status,
      uptime_seconds: Math.round((Date.now() - this.startedAt) / 1000),
      live_version: this.liveVersion,
      series_version: this.seriesVersion,
      live_age_seconds: this.liveCheckedAt ? Math.round((Date.now() - this.liveCheckedAt) / 1000) : null,
      refresh_seconds: H.refreshInterval(),
      subscribers: this.subscribers.size,
      idle: !this.isActive(),
      failed: [...this.failed].sort(),
      cache: { ...this.cache.stats },
      sources,
      at: new Date().toISOString(),
    };
  }
}

module.exports = { Collector, RANGE_DAYS, FLOW_SERIES, MARKETS, STOCK_CODE };
