// ─────────────────────────────────────────────────────────────────────────────
// pipeline/cache.js — 캐시 레이어
//
//  · TTL: TTL 안에서는 같은 데이터를 다시 받지 않는다
//  · Single-flight: 같은 키를 동시에 요청해도 업스트림 호출은 1번
//  · Stale-while-revalidate: 만료된 값을 즉시 돌려주고 뒤에서 갱신 (swr: true)
//  · Last-known-good: 업스트림이 실패하면 마지막 정상값을 stale 표시와 함께 반환
//    (실패했다고 가짜 값을 만들어내지 않는다)
//  · 디스크 영속화: 키마다 cache/<키>.json — 재시작해도 히스토리·마지막 정상값을 다시 받지 않음
//    (쓰기는 모아서 2초 뒤 한 번에, 임시 파일 → rename 으로 원자적 교체)
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const FLUSH_DELAY = 2000;

class Cache {
  constructor({ dir = null } = {}) {
    this.dir = dir;
    this.mem = new Map();          // key → { value, fetchedAt }
    this.inflight = new Map();     // key → Promise
    this.dirty = new Set();
    this.timer = null;
    this.stats = { hits: 0, misses: 0, coalesced: 0, stale_served: 0, errors: 0 };
    if (dir) this._load();
  }

  _file(key) { return path.join(this.dir, `${encodeURIComponent(key)}.json`); }

  _load() {
    let files = [];
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'));
    } catch (_) { return; }
    let n = 0;
    for (const f of files) {
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        // 이전 버전 캐시(investors-daily.json 등)는 형식이 달라 건너뛴다
        if (!saved || typeof saved.key !== 'string' || !('value' in saved)) continue;
        this.mem.set(saved.key, { value: saved.value, fetchedAt: saved.fetchedAt || 0 });
        n++;
      } catch (_) { /* 손상된 파일은 무시하고 다시 받는다 */ }
    }
    if (n) console.log(`[cache] 저장된 캐시 ${n}건 로드`);
  }

  // 만료 여부와 관계없이 현재 값 (업스트림 호출 없음)
  peek(key) { return this.mem.get(key); }

  value(key, def) {
    const e = this.mem.get(key);
    return e ? e.value : def;
  }

  set(key, value, { persist = false } = {}) {
    const entry = { value, fetchedAt: Date.now() };
    this.mem.set(key, entry);
    if (persist && this.dir) {
      this.dirty.add(key);
      if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_DELAY);
    }
    return entry;
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dir) return;
    for (const key of this.dirty) {
      const entry = this.mem.get(key);
      if (!entry) continue;
      const file = this._file(key);
      try {
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ key, fetchedAt: entry.fetchedAt, value: entry.value }));
        fs.renameSync(`${file}.tmp`, file);
      } catch (e) {
        console.warn(`[cache] ${key} 저장 실패: ${e.message}`); // 디스크 실패는 치명적이지 않음
      }
    }
    this.dirty.clear();
  }

  // ttl: 초. 반환 { value, fetchedAt, stale, error }
  async get(key, ttl, fetcher, { persist = false, swr = false } = {}) {
    const entry = this.mem.get(key);
    if (entry && Date.now() - entry.fetchedAt < ttl * 1000) {
      this.stats.hits++;
      return { value: entry.value, fetchedAt: entry.fetchedAt, stale: false };
    }
    if (entry && swr) {
      this._refresh(key, fetcher, persist).catch(() => {}); // 뒤에서 갱신, 실패는 다음 요청 때 다시
      this.stats.stale_served++;
      return { value: entry.value, fetchedAt: entry.fetchedAt, stale: true };
    }
    try {
      const value = await this._refresh(key, fetcher, persist);
      return { value, fetchedAt: this.mem.get(key).fetchedAt, stale: false };
    } catch (e) {
      this.stats.errors++;
      if (!entry) throw e;
      this.stats.stale_served++;
      return { value: entry.value, fetchedAt: entry.fetchedAt, stale: true, error: e.message };
    }
  }

  _refresh(key, fetcher, persist) {
    const running = this.inflight.get(key);
    if (running) {
      this.stats.coalesced++;
      return running;
    }
    this.stats.misses++;
    const p = (async () => {
      const value = await fetcher();
      this.set(key, value, { persist });
      return value;
    })();
    this.inflight.set(key, p);
    const done = () => { if (this.inflight.get(key) === p) this.inflight.delete(key); };
    p.then(done, done);
    return p;
  }
}

module.exports = { Cache };
