// ─────────────────────────────────────────────────────────────────────────────
// pipeline/http.js — 업스트림 HTTP 클라이언트
//
//  · Node 내장 fetch(undici) — 호스트별 연결을 keep-alive 로 재사용
//  · 일시 오류(429/5xx/타임아웃/네트워크)는 지수 백오프 + 지터로 재시도
//  · 호스트별 서킷 브레이커: 연속 실패하면 잠시 호출 자체를 건너뛰어 IP 차단을 막는다
//  · 소스별 호출/실패 통계를 /api/health 에 노출
// ─────────────────────────────────────────────────────────────────────────────
const config = require('./config');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

// 서킷 브레이커가 열려 있어 호출하지 않음
class SourceUnavailable extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function shortError(e) {
  if (e instanceof HttpError) return e.message;
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return '타임아웃';
  const cause = e && e.cause && (e.cause.code || e.cause.message);
  return `${(e && e.name) || 'Error'}: ${(cause || (e && e.message) || e)}`.slice(0, 200);
}

function isRetryable(e) {
  if (e instanceof HttpError) return RETRY_STATUS.has(e.status);
  if (e instanceof SyntaxError) return false;          // 깨진 JSON 은 다시 받아도 같다
  return true;                                         // 네트워크 오류·타임아웃
}

class HttpClient {
  constructor(opts = {}) {
    this.timeout = opts.timeout ?? config.http.timeout;
    this.retries = opts.retries ?? config.http.retries;
    this.threshold = opts.breakerThreshold ?? config.http.breakerThreshold;
    this.cooldown = (opts.breakerCooldown ?? config.http.breakerCooldown) * 1000;
    this.fetch = opts.fetch || globalThis.fetch;
    this.backoff = opts.backoff ?? (attempt => Math.min(4000, 500 * 2 ** attempt) + Math.random() * 300);
    this.health = new Map();
  }

  source(name) {
    if (!this.health.has(name)) {
      this.health.set(name, {
        name, calls: 0, failures: 0, consecutiveFailures: 0,
        lastSuccess: null, lastError: null, lastErrorMessage: null, openUntil: 0,
      });
    }
    return this.health.get(name);
  }

  breakerOpen(name) { return Date.now() < this.source(name).openUntil; }

  recordSuccess(name) {
    const h = this.source(name);
    h.calls++;
    h.consecutiveFailures = 0;
    h.lastSuccess = Date.now();
  }

  recordFailure(name, e, trip = true) {
    const h = this.source(name);
    h.calls++;
    h.failures++;
    h.lastError = Date.now();
    h.lastErrorMessage = shortError(e);
    if (!trip) return;
    h.consecutiveFailures++;
    if (h.consecutiveFailures >= this.threshold) h.openUntil = Date.now() + this.cooldown;
  }

  async getJson(url, { params, headers } = {}) {
    const full = params ? `${url}?${new URLSearchParams(params)}` : url;
    const name = new URL(full).hostname;
    const h = this.source(name);
    if (this.breakerOpen(name)) {
      throw new SourceUnavailable(`${name}: 연속 실패로 ${Math.ceil((h.openUntil - Date.now()) / 1000)}초간 호출 중단`);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.fetch(full, {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://m.stock.naver.com/',
            ...headers,
          },
          signal: AbortSignal.timeout(this.timeout),
        });
        if (!res.ok) throw new HttpError(res.status, full);
        const data = JSON.parse(await res.text());
        this.recordSuccess(name);
        return data;
      } catch (e) {
        const retryable = isRetryable(e);
        if (retryable && attempt < this.retries) {
          await sleep(this.backoff(attempt));
          continue;
        }
        // 400/404 같은 요청 오류는 소스 장애가 아니므로 브레이커에 반영하지 않는다
        this.recordFailure(name, e, retryable || e instanceof SyntaxError);
        throw e;
      }
    }
  }

  snapshot() {
    return [...this.health.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(h => ({
        name: h.name,
        ok: h.consecutiveFailures === 0 && Date.now() >= h.openUntil,
        calls: h.calls,
        failures: h.failures,
        last_success: h.lastSuccess ? new Date(h.lastSuccess).toISOString() : null,
        last_error: h.lastError ? new Date(h.lastError).toISOString() : null,
        last_error_message: h.lastErrorMessage,
        breaker_open: Date.now() < h.openUntil,
      }));
  }
}

module.exports = { HttpClient, HttpError, SourceUnavailable, USER_AGENT, shortError };
