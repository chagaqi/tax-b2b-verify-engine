import { describe, expect, it } from 'vitest';
import { rateLimit } from '../src/billing/entitlements.js';
import { canonicalJson, fromBase64, seal, toBase64, unseal } from '../src/lib/crypto.js';
import { InMemoryCacheStore, InMemoryDocumentStore, InMemoryTenantStore, InMemoryUsageStore } from '../src/stores/memory.js';
import { createUpstashStores } from '../src/stores/upstash.js';
import type { Tenant } from '../src/stores/types.js';
import { json, mockFetch } from './helpers.js';

const tenant = (over: Partial<Tenant> = {}): Tenant => ({ id: 't1', platform: 'direct', plan: 'free', createdAt: 'x', updatedAt: 'x', ...over });

describe('in-memory stores', () => {
  it('usage counters keep a fixed window', async () => {
    let now = 0;
    const u = new InMemoryUsageStore(() => now);
    expect(await u.increment('k', 1, 10)).toBe(1);
    now = 9_000;
    expect(await u.increment('k', 2, 10)).toBe(3);
    now = 10_500; // original window elapsed even though the key was touched at t=9s
    expect(await u.get('k')).toBe(0);
    expect(await u.increment('k', 1, 10)).toBe(1);
  });

  it('cache expires entries, supports setIfAbsent and evicts beyond capacity', async () => {
    let now = 0;
    const c = new InMemoryCacheStore(() => now, 2);
    await c.set('a', { v: 1 }, 5);
    expect(await c.setIfAbsent('a', { v: 2 }, 5)).toBe(false);
    expect(await c.get('a')).toEqual({ v: 1 });
    now = 6000;
    expect(await c.get('a')).toBeNull();
    expect(await c.setIfAbsent('a', 1, 5)).toBe(true);
    await c.set('b', 2, 5);
    await c.set('c', 3, 5);
    expect(await c.get('a')).toBeNull();
    expect(await c.get('c')).toBe(3);
  });

  it('documents round-trip and expire', async () => {
    let now = 0;
    const d = new InMemoryDocumentStore(() => now);
    await d.put({ id: 'x', contentType: 'application/pdf', bytes: new Uint8Array([1, 2]), metadata: {}, createdAt: 'x' }, 1);
    expect((await d.get('x'))?.bytes).toEqual(new Uint8Array([1, 2]));
    now = 2000;
    expect(await d.get('x')).toBeNull();
  });

  it('tenant indexes follow key rotation and return copies', async () => {
    const s = new InMemoryTenantStore();
    await s.put(tenant({ apiKeyHash: 'h1', externalAccountId: 'acct', platform: 'stripe' }));
    expect((await s.findByApiKeyHash('h1'))?.id).toBe('t1');
    await s.put(tenant({ apiKeyHash: 'h2', externalAccountId: 'acct', platform: 'stripe' }));
    expect(await s.findByApiKeyHash('h1')).toBeNull();
    expect((await s.findByExternal('stripe', 'acct'))?.apiKeyHash).toBe('h2');
    const copy = (await s.get('t1'))!;
    copy.plan = 'business';
    expect((await s.get('t1'))?.plan).toBe('free');
  });

  it('rateLimit resets with each window', async () => {
    const u = new InMemoryUsageStore(() => 0);
    const at = (ms: number) => rateLimit(u, 'pg', '1.2.3.4', 2, 60, ms);
    expect((await at(1_000)).allowed).toBe(true);
    expect((await at(2_000)).remaining).toBe(0);
    expect(await at(3_000)).toMatchObject({ allowed: false, resetSeconds: 57 });
    expect((await at(61_000)).allowed).toBe(true);
  });
});

describe('Upstash REST stores', () => {
  const upstash = () => {
    const kv = new Map<string, string>();
    const exec = (cmd: (string | number)[]): unknown => {
      const [op, key, ...rest] = cmd.map(String);
      switch (op) {
        case 'GET':
          return kv.get(key!) ?? null;
        case 'SET': {
          if (rest.includes('NX') && kv.has(key!)) return null;
          kv.set(key!, rest[0]!);
          return 'OK';
        }
        case 'DEL':
          return kv.delete(key!) ? 1 : 0;
        case 'INCRBY': {
          const v = Number(kv.get(key!) ?? 0) + Number(rest[0]);
          kv.set(key!, String(v));
          return v;
        }
        case 'EXPIRE':
          return 1;
        default:
          throw new Error(op);
      }
    };
    const mf = mockFetch({
      'https://redis.test/pipeline': async (req) => json((await req.json() as (string | number)[][]).map((c) => ({ result: exec(c) }))),
      'https://redis.test': async (req) => {
        expect(req.headers.get('authorization')).toBe('Bearer tok');
        return json({ result: exec(await req.json()) });
      },
    });
    return { stores: createUpstashStores('https://redis.test/', 'tok', mf.fetch), kv, calls: mf.calls };
  };

  it('usage uses INCRBY + EXPIRE NX in one pipeline', async () => {
    const { stores, calls } = upstash();
    expect(await stores.usage.increment('q', 2, 60)).toBe(2);
    expect(await stores.usage.increment('q', 1, 60)).toBe(3);
    expect(await stores.usage.get('q')).toBe(3);
    expect(JSON.parse(calls[0]!.body)).toEqual([['INCRBY', 'tbve:usage:q', 2], ['EXPIRE', 'tbve:usage:q', 60, 'NX']]);
  });

  it('documents are stored base64 with a TTL', async () => {
    const { stores, calls } = upstash();
    await stores.documents.put({ id: 'd', contentType: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70]), metadata: { a: 1 }, createdAt: 'x' }, 3600);
    expect(JSON.parse(calls[0]!.body).slice(-2)).toEqual(['EX', 3600]);
    expect(Buffer.from((await stores.documents.get('d'))!.bytes).toString()).toBe('%PDF');
    await stores.documents.delete('d');
    expect(await stores.documents.get('d')).toBeNull();
  });

  it('cache setIfAbsent maps to SET NX', async () => {
    const { stores } = upstash();
    expect(await stores.cache.setIfAbsent('evt', 1, 60)).toBe(true);
    expect(await stores.cache.setIfAbsent('evt', 1, 60)).toBe(false);
    await stores.cache.set('j', { a: [1] }, 60);
    expect(await stores.cache.get('j')).toEqual({ a: [1] });
  });

  it('tenants maintain api-key and external indexes', async () => {
    const { stores, kv } = upstash();
    await stores.tenants.put(tenant({ apiKeyHash: 'k1', externalAccountId: '42', platform: 'hubspot' }));
    await stores.tenants.put(tenant({ apiKeyHash: 'k2', externalAccountId: '42', platform: 'hubspot' }));
    expect(kv.has('tbve:apikey:k1')).toBe(false);
    expect((await stores.tenants.findByApiKeyHash('k2'))?.id).toBe('t1');
    expect((await stores.tenants.findByExternal('hubspot', '42'))?.id).toBe('t1');
    await stores.tenants.setAlias('stripe:sub:sub_1', 't1');
    expect((await stores.tenants.findByAlias('stripe:sub:sub_1'))?.id).toBe('t1');
    expect(await stores.tenants.findByAlias('stripe:sub:nope')).toBeNull();
  });

  it('surfaces Upstash errors', async () => {
    const mf = mockFetch({ 'https://redis.test': () => json({ error: 'WRONGPASS' }, 401) });
    await expect(createUpstashStores('https://redis.test', 'bad', mf.fetch).cache.get('x')).rejects.toThrow('WRONGPASS');
  });
});

describe('crypto helpers', () => {
  it('canonical JSON sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[{"y":2,"z":1}]},"b":1}');
  });

  it('base64 round-trips binary and base64url input', () => {
    const bytes = new Uint8Array([0, 251, 255, 62, 63]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(fromBase64(Buffer.from(bytes).toString('base64url'))).toEqual(bytes);
  });

  it('seal/unseal is authenticated encryption', async () => {
    const sealed = await seal('secret-a', '{"accessToken":"x"}');
    expect(await unseal('secret-a', sealed)).toBe('{"accessToken":"x"}');
    await expect(unseal('secret-b', sealed)).rejects.toThrow();
    expect(await seal('secret-a', 'same')).not.toBe(await seal('secret-a', 'same'));
  });
});
