import { config, log } from "./config.js";

/**
 * 書き換え済みレスポンスのインメモリ LRU キャッシュ。
 *
 * Spotify の Web Player は初回ロードで 5〜15MB 程度の JS/CSS を読む。
 * それらはファイル名にハッシュが入った不変アセットなので、
 * 一度書き換えた結果を保持しておくと 2 回目以降が劇的に速くなる。
 *
 * - 保存するのは「書き換えたテキスト本文」だけ（音声・画像はストリーム素通し）
 * - 上流の Cache-Control に従う（no-store / private で max-age 無しなら保存しない）
 * - Set-Cookie を含むレスポンスは保存しない（利用者間で混ざると事故るため）
 * - 総バイト数の上限を超えたら古いものから追い出す
 */
export class ResponseCache {
  #maxBytes;
  #maxEntries;
  #bytes = 0;
  #map = new Map(); // key -> { size, expiresAt, entry }
  #hits = 0;
  #misses = 0;

  constructor(maxBytes = config.cacheMaxBytes, maxEntries = config.cacheMaxEntries) {
    this.#maxBytes = maxBytes;
    this.#maxEntries = maxEntries;
    this.enabled = maxBytes > 0;
  }

  get size() {
    return this.#map.size;
  }

  get bytes() {
    return this.#bytes;
  }

  get stats() {
    return {
      enabled: this.enabled,
      entries: this.#map.size,
      bytes: this.#bytes,
      maxBytes: this.#maxBytes,
      hits: this.#hits,
      misses: this.#misses,
      hitRate: this.#hits + this.#misses === 0 ? null : +(this.#hits / (this.#hits + this.#misses)).toFixed(3),
    };
  }

  get(key) {
    if (!this.enabled) return undefined;
    const rec = this.#map.get(key);
    if (!rec) {
      this.#misses++;
      return undefined;
    }
    if (rec.expiresAt && rec.expiresAt < Date.now()) {
      this.#evictKey(key);
      this.#misses++;
      return undefined;
    }
    // LRU: 触れたものを末尾へ
    this.#map.delete(key);
    this.#map.set(key, rec);
    this.#hits++;
    return rec.entry;
  }

  set(key, entry, { size, maxAgeSec } = {}) {
    if (!this.enabled || !entry || !size || size > this.#maxBytes) return false;

    this.#evictKey(key);
    while (this.#bytes + size > this.#maxBytes && this.#map.size > 0) {
      const oldest = this.#map.keys().next().value;
      this.#evictKey(oldest);
    }
    while (this.#map.size >= this.#maxEntries) {
      const oldest = this.#map.keys().next().value;
      this.#evictKey(oldest);
    }

    const expiresAt = maxAgeSec ? Date.now() + Math.min(maxAgeSec, config.cacheMaxTtlSec) * 1000 : 0;
    this.#map.set(key, { size, expiresAt, entry });
    this.#bytes += size;
    log.debug(`cache SET ${key} (${size}B, ttl=${expiresAt ? Math.round((expiresAt - Date.now()) / 1000) + "s" : "session"})`);
    return true;
  }

  #evictKey(key) {
    const rec = this.#map.get(key);
    if (!rec) return;
    this.#map.delete(key);
    this.#bytes -= rec.size;
  }

  clear() {
    this.#map.clear();
    this.#bytes = 0;
  }
}

/**
 * 上流の Cache-Control から、キャッシュしてよいかと max-age を判定する。
 * @returns {{ cacheable: boolean, maxAgeSec: number }}
 */
export function parseCacheability(cacheControl, status, hasSetCookie) {
  if (status !== 200) return { cacheable: false, maxAgeSec: 0 };
  if (hasSetCookie) return { cacheable: false, maxAgeSec: 0 };

  const cc = String(cacheControl || "").toLowerCase();
  if (!cc) return { cacheable: false, maxAgeSec: 0 };
  if (cc.includes("no-store") || cc.includes("no-cache") || cc.includes("must-revalidate")) {
    return { cacheable: false, maxAgeSec: 0 };
  }
  // private でも max-age/immutable があれば保存してよい（プロセス内で完結するため）
  const immutable = cc.includes("immutable");
  const m = /max-age\s*=\s*(\d+)/.exec(cc);
  const sMaxAge = /s-maxage\s*=\s*(\d+)/.exec(cc);
  const maxAgeSec = Math.max(m ? Number(m[1]) : 0, sMaxAge ? Number(sMaxAge[1]) : 0);

  if (immutable && !maxAgeSec) return { cacheable: true, maxAgeSec: config.cacheMaxTtlSec };
  if (maxAgeSec > 0) return { cacheable: true, maxAgeSec };
  return { cacheable: false, maxAgeSec: 0 };
}
