import { describe, expect, it } from 'vitest';
import { signStripePayload } from '../src/billing/signatures.js';
import { isPrivateIp, parseIpv6 } from '../src/enrich/domain.js';
import { fetchWithTimeout, readTextLimited } from '../src/lib/http.js';
import { signHs256, verifyHs256 } from '../src/lib/jwt.js';
import { loadConfig } from '../src/config.js';
import { createMemoryStores } from '../src/stores/memory.js';
import { ViesClient } from '../src/vies/client.js';
import { TEST_ENV, VIES_REST, VIES_SOAP, makeApp, mockFetch, soapFault, viesError, viesValid } from './helpers.js';

/** Regression tests for the security/correctness review findings. */

describe('quota enforcement under concurrency', () => {
  it('300 parallel reservations against a limit of 100 admit exactly 100', async () => {
    const { services, install } = await makeApp();
    const { tenantId } = await install();
    const tenant = (await services.tenants.get(tenantId))!;
    const results = await Promise.allSettled(Array.from({ length: 300 }, () => services.entitlements.consume(tenant, 'enrichments')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(100);
    expect((await services.entitlements.state(tenant, 'enrichments')).used).toBe(100);
  });

  it('does not charge for malformed input or failed work', async () => {
    const { request, install, services } = await makeApp({ routes: { [VIES_REST]: viesValid() } });
    const { apiKey, tenantId } = await install();
    expect((await request('/v1/verify/tax-id', { method: 'POST', headers: { 'x-api-key': apiKey }, json: { taxId: '123456789' } })).status).toBe(422);
    expect((await request('/v1/enrich/company', { method: 'POST', headers: { 'x-api-key': apiKey }, json: { domain: 'localhost' } })).status).toBe(422);
    const usage = await services.entitlements.summary((await services.tenants.get(tenantId))!);
    expect([usage.taxVerifications.used, usage.enrichments.used]).toEqual([0, 0]);
  });
});

describe('SSRF address classification', () => {
  it.each([
    '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', 'fec0::1', '0:0:0:0:0:0:0:1', '::ffff:10.0.0.1', '[::1]', '::',
    'fe80::1%eth0', 'ff02::1', '2001:db8::1', 'not-an-ip', '256.1.1.1',
  ])('%s is blocked', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '::ffff:808:808', '2606:4700:4700::1111', '2a00:1450:4001:82a::200e'])('%s is public', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  it('parses IPv6 forms to bytes', () => {
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 1, 2, 3, 4]);
    expect(parseIpv6('1::2::3')).toBeNull();
    expect(parseIpv6('1:2:3:4:5:6:7:8:9')).toBeNull();
  });
});

describe('VIES service errors are never "not registered"', () => {
  it.each(['IP_BLOCKED', 'VAT_BLOCKED', 'SOMETHING_NEW'])('%s → unavailable → checksum fallback', async (code) => {
    const { fetch } = mockFetch({ [VIES_REST]: viesError(code), [VIES_SOAP]: soapFault(code) });
    expect((await new ViesClient({ fetch }).check('DE', '136695976')).status).toBe('unavailable');
  });
});

describe('response bodies share the request deadline', () => {
  it('aborts a server that trickles its body', async () => {
    const trickle = () =>
      new Response(
        new ReadableStream({
          async pull(c) {
            await new Promise((r) => setTimeout(r, 100));
            c.enqueue(new TextEncoder().encode('x'));
          },
        }),
      );
    const started = Date.now();
    const res = await fetchWithTimeout(mockFetch({ 'https://slow.test/': trickle }).fetch, 'https://slow.test/', {}, 300);
    await expect(readTextLimited(res, 1_000_000)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('leaves complete bodies untouched', async () => {
    const res = await fetchWithTimeout(mockFetch({ 'https://ok.test/': () => new Response('hello', { status: 201, headers: { 'x-a': '1' } }) }).fetch, 'https://ok.test/', {}, 300);
    expect([res.status, res.headers.get('x-a'), await res.text()]).toEqual([201, '1', 'hello']);
  });
});

describe('webhook retries after a failure are processed', () => {
  it('releases the idempotency key when the handler throws', async () => {
    const stores = createMemoryStores();
    const ctx = await makeApp({ stores });
    const { tenantId } = await ctx.install();
    const realPut = stores.tenants.put.bind(stores.tenants);
    let fail = true;
    stores.tenants.put = async (t) => {
      if (fail && t.plan === 'pro') throw new Error('transient storage error');
      return realPut(t);
    };
    const raw = JSON.stringify({ id: 'evt_retry', type: 'checkout.session.completed', data: { object: { client_reference_id: tenantId, status: 'complete', payment_status: 'paid' } } });
    const post = async () => ctx.request('/v1/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': await signStripePayload(raw, 'whsec_stripe_test') }, body: raw });
    expect((await post()).status).toBe(500);
    fail = false;
    expect(await (await post()).json()).toMatchObject({ received: true, outcome: expect.stringContaining('→ pro') });
  });
});

describe('client IP behind proxies', () => {
  const ipOf = async (env: Record<string, string>, headers: Record<string, string>) => {
    const { services } = await makeApp({ env });
    return services.getClientIp({ req: { header: (n: string) => headers[n.toLowerCase()] } } as never);
  };

  it('uses the rightmost trusted hop, never the client-supplied left side', async () => {
    expect(await ipOf({ TRUST_PROXY: 'true' }, { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' })).toBe('203.0.113.9');
    expect(await ipOf({ TRUST_PROXY: '2' }, { 'x-forwarded-for': 'spoof, 198.51.100.4, 10.0.0.2' })).toBe('198.51.100.4');
    expect(await ipOf({ TRUST_PROXY: 'cloudflare' }, { 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': 'spoof' })).toBe('192.0.2.1');
    expect(await ipOf({ TRUST_PROXY: 'false' }, { 'x-forwarded-for': 'spoof', 'cf-connecting-ip': 'spoof' })).toBe('203.0.113.7');
    expect(() => loadConfig({ ...TEST_ENV, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
  });
});

describe('tenant races', () => {
  it('concurrent first requests from one marketplace account converge on one tenant', async () => {
    const { services } = await makeApp();
    const tenants = await Promise.all(Array.from({ length: 10 }, () => services.tenants.ensurePlatformTenant('stripe', 'acct_race')));
    expect(new Set(tenants.map((t) => t.id)).size).toBe(1);
  });

  it('token refresh does not overwrite a concurrent plan upgrade', async () => {
    const { services } = await makeApp();
    const stale = await services.tenants.ensurePlatformTenant('hubspot', '77');
    await services.tenants.update(stale.id, (t) => ({ ...t, plan: 'business' }));
    await services.tenants.storeTokens(stale, 'hubspot', { accessToken: 'a' }); // stale snapshot says free
    expect((await services.tenants.get(stale.id))?.plan).toBe('business');
  });
});

describe('tokens, signatures and request shapes', () => {
  const now = () => Math.floor(Date.now() / 1000);

  it('JWTs need exp, or an iat within the max age', async () => {
    await expect(verifyHs256(await signHs256({ a: 1 }, 's'), 's')).rejects.toThrow('no exp or iat');
    await expect(verifyHs256(await signHs256({ iat: now() - 60 }, 's'), 's')).resolves.toMatchObject({});
    await expect(verifyHs256(await signHs256({ iat: now() - 3600 }, 's'), 's')).rejects.toThrow('expired');
  });

  it('monday webhooks must match the signed account', async () => {
    const ctx = await makeApp();
    const auth = await signHs256({ accountId: 1, exp: now() + 60 }, 'monday_signing_test');
    const res = await ctx.request('/v1/webhooks/monday', { method: 'POST', headers: { authorization: auth }, json: { type: 'app_subscription_created', data: { account_id: 2, subscription: { plan_id: 'business' } } } });
    expect(res.status).toBe(403);
    expect(await ctx.services.tenants.findByExternal('monday', '2')).toBeNull();
  });

  it('Stripe App endpoint answers 400 (not 500) for non-object bodies', async () => {
    const ctx = await makeApp();
    const res = await ctx.request('/v1/integrations/stripe/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
    expect(res.status).toBe(400);
  });

  it('a Business subscription event that precedes checkout still yields Business', async () => {
    const ctx = await makeApp();
    const { tenantId } = await ctx.install();
    const post = async (event: unknown) => {
      const raw = JSON.stringify(event);
      return ctx.request('/v1/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': await signStripePayload(raw, 'whsec_stripe_test') }, body: raw });
    };
    await post({ id: 'e1', type: 'customer.subscription.created', data: { object: { id: 'sub_b', status: 'active', metadata: {}, items: { data: [{ price: { lookup_key: 'business_monthly' } }] } } } });
    await post({ id: 'e2', type: 'checkout.session.completed', data: { object: { client_reference_id: tenantId, status: 'complete', payment_status: 'paid', subscription: 'sub_b' } } });
    expect((await ctx.services.tenants.get(tenantId))?.plan).toBe('business');
  });

  it('production requires PUBLIC_BASE_URL', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40) })).toThrow('PUBLIC_BASE_URL');
  });
});
