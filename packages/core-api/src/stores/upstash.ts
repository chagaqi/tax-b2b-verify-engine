import { fromBase64, toBase64 } from '../lib/crypto.js';
import type { FetchLike } from '../lib/http.js';
import type { ICacheStore, IDocumentStore, ITenantStore, IUsageStore, Platform, StoredDocument, Stores, Tenant } from './types.js';

type Command = (string | number)[];

export class UpstashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstashError';
  }
}

/** Minimal Upstash Redis REST client (https://upstash.com/docs/redis/features/restapi). */
export class UpstashClient {
  private readonly url: string;
  constructor(
    url: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly prefix = 'tbve:',
  ) {
    this.url = url.replace(/\/+$/, '');
  }

  key(k: string): string {
    return this.prefix + k;
  }

  async exec<T = unknown>(cmd: Command): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
    if (!res.ok || body.error) throw new UpstashError(body.error ?? `Upstash HTTP ${res.status}`);
    return body.result as T;
  }

  async pipeline<T extends unknown[] = unknown[]>(cmds: Command[]): Promise<T> {
    const res = await this.fetchImpl(`${this.url}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(cmds),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string }[] | null;
    if (!res.ok || !Array.isArray(body)) throw new UpstashError(`Upstash pipeline HTTP ${res.status}`);
    const failed = body.find((r) => r.error);
    if (failed) throw new UpstashError(failed.error!);
    return body.map((r) => r.result) as T;
  }
}

export class UpstashUsageStore implements IUsageStore {
  constructor(private readonly redis: UpstashClient) {}
  async increment(key: string, by: number, windowSeconds: number): Promise<number> {
    const k = this.redis.key(`usage:${key}`);
    const [total] = await this.redis.pipeline<[number, number]>([
      ['INCRBY', k, by],
      ['EXPIRE', k, windowSeconds, 'NX'],
    ]);
    return Number(total);
  }
  async get(key: string): Promise<number> {
    const v = await this.redis.exec<string | null>(['GET', this.redis.key(`usage:${key}`)]);
    return v ? Number(v) : 0;
  }
}

export class UpstashDocumentStore implements IDocumentStore {
  constructor(private readonly redis: UpstashClient) {}
  async put(doc: StoredDocument, ttlSeconds: number): Promise<void> {
    const record = { ...doc, bytes: toBase64(doc.bytes) };
    await this.redis.exec(['SET', this.redis.key(`doc:${doc.id}`), JSON.stringify(record), 'EX', ttlSeconds]);
  }
  async get(id: string): Promise<StoredDocument | null> {
    const raw = await this.redis.exec<string | null>(['GET', this.redis.key(`doc:${id}`)]);
    if (!raw) return null;
    const rec = JSON.parse(raw) as Omit<StoredDocument, 'bytes'> & { bytes: string };
    return { ...rec, bytes: fromBase64(rec.bytes) };
  }
  async delete(id: string): Promise<void> {
    await this.redis.exec(['DEL', this.redis.key(`doc:${id}`)]);
  }
}

export class UpstashCacheStore implements ICacheStore {
  constructor(private readonly redis: UpstashClient) {}
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.exec<string | null>(['GET', this.redis.key(`cache:${key}`)]);
    return raw ? (JSON.parse(raw) as T) : null;
  }
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.redis.exec(['SET', this.redis.key(`cache:${key}`), JSON.stringify(value), 'EX', ttlSeconds]);
  }
  async setIfAbsent<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
    const r = await this.redis.exec<string | null>(['SET', this.redis.key(`cache:${key}`), JSON.stringify(value), 'EX', ttlSeconds, 'NX']);
    return r === 'OK';
  }
  async delete(key: string): Promise<void> {
    await this.redis.exec(['DEL', this.redis.key(`cache:${key}`)]);
  }
}

export class UpstashTenantStore implements ITenantStore {
  constructor(private readonly redis: UpstashClient) {}

  async get(id: string): Promise<Tenant | null> {
    const raw = await this.redis.exec<string | null>(['GET', this.redis.key(`tenant:${id}`)]);
    return raw ? (JSON.parse(raw) as Tenant) : null;
  }

  async put(tenant: Tenant): Promise<void> {
    const prev = await this.get(tenant.id);
    const cmds: Command[] = [['SET', this.redis.key(`tenant:${tenant.id}`), JSON.stringify(tenant)]];
    if (prev?.apiKeyHash && prev.apiKeyHash !== tenant.apiKeyHash) cmds.push(['DEL', this.redis.key(`apikey:${prev.apiKeyHash}`)]);
    if (tenant.apiKeyHash) cmds.push(['SET', this.redis.key(`apikey:${tenant.apiKeyHash}`), tenant.id]);
    if (tenant.externalAccountId) {
      cmds.push(['SET', this.redis.key(`ext:${tenant.platform}:${tenant.externalAccountId}`), tenant.id, 'NX']);
    }
    await this.redis.pipeline(cmds);
  }

  async findByApiKeyHash(hash: string): Promise<Tenant | null> {
    const id = await this.redis.exec<string | null>(['GET', this.redis.key(`apikey:${hash}`)]);
    return id ? this.get(id) : null;
  }

  async findByExternal(platform: Platform, accountId: string): Promise<Tenant | null> {
    const id = await this.redis.exec<string | null>(['GET', this.redis.key(`ext:${platform}:${accountId}`)]);
    return id ? this.get(id) : null;
  }

  async setAlias(alias: string, tenantId: string): Promise<void> {
    await this.redis.exec(['SET', this.redis.key(`alias:${alias}`), tenantId]);
  }

  async findByAlias(alias: string): Promise<Tenant | null> {
    const id = await this.redis.exec<string | null>(['GET', this.redis.key(`alias:${alias}`)]);
    return id ? this.get(id) : null;
  }
}

export function createUpstashStores(url: string, token: string, fetchImpl: FetchLike = fetch): Stores {
  const redis = new UpstashClient(url, token, fetchImpl);
  return {
    usage: new UpstashUsageStore(redis),
    documents: new UpstashDocumentStore(redis),
    cache: new UpstashCacheStore(redis),
    tenants: new UpstashTenantStore(redis),
  };
}
