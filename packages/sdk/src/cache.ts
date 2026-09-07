export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface LruCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

/**
 * In-memory LRU with per-entry TTL for read-only contract snapshots.
 */
export class LruCache<T> {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly map = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;

  constructor(options: LruCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 128);
    this.ttlMs = Math.max(0, options.ttlMs ?? 15_000);
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.map.size;
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.map.size };
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (this.ttlMs > 0 && entry.expiresAt <= this.now()) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key: string, value: T, ttlMs = this.ttlMs): T {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    this.evict();
    return value;
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  wrap<R extends T>(key: string, producer: () => Promise<R>, ttlMs?: number): Promise<R> {
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached as R);
    return producer().then((value) => {
      this.set(key, value, ttlMs);
      return value;
    });
  }

  private evict(): void {
    const now = this.now();
    for (const [key, entry] of this.map) {
      if (this.ttlMs > 0 && entry.expiresAt <= now) this.map.delete(key);
    }
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

export function contractStateKey(contractId: string, method: string, args: unknown[] = []): string {
  return `${contractId}:${method}:${JSON.stringify(args)}`;
}
