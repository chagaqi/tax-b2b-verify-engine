import type { ICacheStore, IDocumentStore, ITenantStore, IUsageStore, Platform, StoredDocument, Stores, Tenant } from './types.js';

type Clock = () => number;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** Insertion-ordered map with TTL and a hard entry cap (oldest evicted first). */
class TtlMap<T> {
  private readonly map = new Map<string, Entry<T>>();
  constructor(
    private readonly maxEntries: number,
    private readonly now: Clock,
  ) {}

  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T, ttlSeconds: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}

export class InMemoryUsageStore implements IUsageStore {
  /** value = { count, windowEnd } so the window keeps its original end (Redis INCRBY + EXPIRE NX). */
  private readonly counters: TtlMap<{ count: number; windowEnd: number }>;
  constructor(
    private readonly now: Clock = Date.now,
    maxEntries = 100_000,
  ) {
    this.counters = new TtlMap(maxEntries, now);
  }

  async increment(key: string, by: number, windowSeconds: number): Promise<number> {
    const current = this.counters.get(key);
    if (!current) {
      this.counters.set(key, { count: by, windowEnd: this.now() + windowSeconds * 1000 }, windowSeconds);
      return by;
    }
    const remaining = Math.max(1, Math.ceil((current.windowEnd - this.now()) / 1000));
    this.counters.set(key, { count: current.count + by, windowEnd: current.windowEnd }, remaining);
    return current.count + by;
  }

  async get(key: string): Promise<number> {
    return this.counters.get(key)?.count ?? 0;
  }
}

export class InMemoryDocumentStore implements IDocumentStore {
  private readonly docs: TtlMap<StoredDocument>;
  constructor(now: Clock = Date.now, maxEntries = 2_000) {
    this.docs = new TtlMap(maxEntries, now);
  }
  async put(doc: StoredDocument, ttlSeconds: number): Promise<void> {
    this.docs.set(doc.id, doc, ttlSeconds);
  }
  async get(id: string): Promise<StoredDocument | null> {
    return this.docs.get(id) ?? null;
  }
  async delete(id: string): Promise<void> {
    this.docs.delete(id);
  }
}

export class InMemoryCacheStore implements ICacheStore {
  private readonly entries: TtlMap<string>;
  constructor(now: Clock = Date.now, maxEntries = 50_000) {
    this.entries = new TtlMap(maxEntries, now);
  }
  async get<T>(key: string): Promise<T | null> {
    const v = this.entries.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.entries.set(key, JSON.stringify(value), ttlSeconds);
  }
  async setIfAbsent<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
    if (this.entries.get(key) !== undefined) return false;
    this.entries.set(key, JSON.stringify(value), ttlSeconds);
    return true;
  }
}

export class InMemoryTenantStore implements ITenantStore {
  private readonly tenants = new Map<string, Tenant>();
  private readonly byKey = new Map<string, string>();
  private readonly byExternal = new Map<string, string>();
  private readonly aliases = new Map<string, string>();

  async get(id: string): Promise<Tenant | null> {
    const t = this.tenants.get(id);
    return t ? structuredClone(t) : null;
  }

  async put(tenant: Tenant): Promise<void> {
    const prev = this.tenants.get(tenant.id);
    if (prev?.apiKeyHash && prev.apiKeyHash !== tenant.apiKeyHash) this.byKey.delete(prev.apiKeyHash);
    this.tenants.set(tenant.id, structuredClone(tenant));
    if (tenant.apiKeyHash) this.byKey.set(tenant.apiKeyHash, tenant.id);
    if (tenant.externalAccountId) this.byExternal.set(`${tenant.platform}:${tenant.externalAccountId}`, tenant.id);
  }

  async findByApiKeyHash(hash: string): Promise<Tenant | null> {
    const id = this.byKey.get(hash);
    return id ? this.get(id) : null;
  }

  async findByExternal(platform: Platform, accountId: string): Promise<Tenant | null> {
    const id = this.byExternal.get(`${platform}:${accountId}`);
    return id ? this.get(id) : null;
  }

  async setAlias(alias: string, tenantId: string): Promise<void> {
    this.aliases.set(alias, tenantId);
  }

  async findByAlias(alias: string): Promise<Tenant | null> {
    const id = this.aliases.get(alias);
    return id ? this.get(id) : null;
  }
}

export function createMemoryStores(now: Clock = Date.now): Stores {
  return {
    usage: new InMemoryUsageStore(now),
    documents: new InMemoryDocumentStore(now),
    cache: new InMemoryCacheStore(now),
    tenants: new InMemoryTenantStore(),
  };
}
