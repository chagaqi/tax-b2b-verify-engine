import { describe, expect, it } from 'vitest';
import { StaticResolver } from '../src/enrich/dns.js';
import { CORP_ZONE, VIES_REST, VIES_SOAP, json, makeApp, soapFault, viesError, viesValid } from './helpers.js';

const verifyBody = (taxId: string, extra: Record<string, unknown> = {}) => ({ taxId, ...extra });

describe('public routes', () => {
  it('GET / and /health describe the service', async () => {
    const { request, services } = await makeApp();
    expect(await (await request('/')).json()).toMatchObject({ name: 'tax-b2b-verify-engine', endpoints: { verifyTaxId: 'POST /v1/verify/tax-id' } });
    expect(await (await request('/health')).json()).toMatchObject({ ok: true, viesMode: 'live', signingKey: services.signer.keyId });
  });

  it('GET /v1/countries lists 49 jurisdictions', async () => {
    const { request } = await makeApp();
    const res = await request('/v1/countries');
    expect(res.headers.get('cache-control')).toContain('max-age');
    const body = (await res.json()) as { count: number; jurisdictions: { code: string }[] };
    expect(body.count).toBe(49);
    expect(body.jurisdictions.map((j) => j.code)).toEqual(expect.arrayContaining(['DE', 'XI', 'US', 'IN', 'AE']));
  });

  it('publishes the Ed25519 public key', async () => {
    const { request, services } = await makeApp();
    expect(await (await request('/v1/certificates/public-key')).json()).toMatchObject({ keyId: services.signer.keyId, algorithm: 'Ed25519', jwk: { crv: 'Ed25519' } });
  });

  it('returns JSON 404s and echoes request ids', async () => {
    const { request } = await makeApp();
    const res = await request('/nope', { headers: { 'x-request-id': 'abc-123' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('x-request-id')).toBe('abc-123');
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'No route for GET /nope' } });
  });

  it('answers CORS preflight for the Stripe App iframe', async () => {
    const { request } = await makeApp();
    const res = await request('/v1/integrations/stripe/verify', {
      method: 'OPTIONS',
      headers: { origin: 'https://dashboard.stripe.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'stripe-signature,content-type' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('stripe-signature');
  });
});

describe('install & API keys', () => {
  it('creates a tenant with a one-time API key', async () => {
    const { request } = await makeApp();
    const res = await request('/v1/install', { method: 'POST', json: { name: 'Acme', email: 'ops@acme.example.com' } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { apiKey: string; tenantId: string; plan: { id: string } };
    expect(body.apiKey).toMatch(/^tbv_live_[A-Za-z0-9_-]{32}$/);
    expect(body.plan.id).toBe('free');
  });

  it('rate-limits installs per IP', async () => {
    const { request } = await makeApp({ env: { INSTALLS_PER_HOUR_PER_IP: '2' } });
    for (let i = 0; i < 2; i++) expect((await request('/v1/install', { method: 'POST', json: {} })).status).toBe(201);
    const res = await request('/v1/install', { method: 'POST', json: {} });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('lists install channels including OAuth URLs', async () => {
    const { request } = await makeApp();
    const body = (await (await request('/v1/install')).json()) as { channels: { hubspot: { authorizeUrl: string }; pipedrive: { authorizeUrl: string } } };
    expect(body.channels.hubspot.authorizeUrl).toContain('client_id=hs-client-id');
    expect(body.channels.hubspot.authorizeUrl).toContain(encodeURIComponent('https://verify.test/v1/install/hubspot/callback'));
    expect(body.channels.pipedrive.authorizeUrl).toContain('oauth.pipedrive.com');
  });

  it('rejects missing and wrong keys', async () => {
    const { request } = await makeApp();
    expect((await request('/v1/verify/tax-id', { method: 'POST', json: verifyBody('IE6388047V') })).status).toBe(401);
    const res = await request('/v1/verify/tax-id', { method: 'POST', headers: { 'x-api-key': 'tbv_live_' + 'x'.repeat(32) }, json: verifyBody('IE6388047V') });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'Invalid API key' } });
  });

  it('accepts Bearer keys and rotates them', async () => {
    const { request, install } = await makeApp({ routes: { [VIES_REST]: viesValid() } });
    const { apiKey } = await install();
    expect((await request('/v1/usage', { headers: { authorization: `Bearer ${apiKey}` } })).status).toBe(200);
    const rotated = (await (await request('/v1/keys/rotate', { method: 'POST', headers: { 'x-api-key': apiKey } })).json()) as { apiKey: string };
    expect((await request('/v1/usage', { headers: { 'x-api-key': apiKey } })).status).toBe(401);
    expect((await request('/v1/usage', { headers: { 'x-api-key': rotated.apiKey } })).status).toBe(200);
  });
});

describe('POST /v1/verify/tax-id', () => {
  it('verifies against VIES and returns a flat, mappable response', async () => {
    const { request, install } = await makeApp({ routes: { [VIES_REST]: viesValid() } });
    const { apiKey } = await install();
    const res = await request('/v1/verify/tax-id', { method: 'POST', headers: { 'x-api-key': apiKey }, json: verifyBody('ie 6388047v') });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      verdict: 'registry_verified',
      valid: true,
      confidence: 'high',
      summary: 'IE6388047V is active in EU VIES (GOOGLE IRELAND LIMITED).',
      taxId: { formatted: 'IE6388047V', jurisdiction: 'IE', checksum: 'valid' },
      registry: { source: 'vies', status: 'valid', name: 'GOOGLE IRELAND LIMITED' },
    });
  });

  it('validates the body', async () => {
    const { request, install } = await makeApp();
    const { apiKey } = await install();
    const res = await request('/v1/verify/tax-id', { method: 'POST', headers: { 'x-api-key': apiKey }, json: { taxId: 'X', bogus: true } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { path: string }[] } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.map((d) => d.path)).toEqual(expect.arrayContaining(['taxId']));
    expect((await request('/v1/verify/tax-id', { method: 'POST', headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, body: '{nope' })).status).toBe(400);
  });

  it('returns 422 when the jurisdiction cannot be inferred', async () => {
    const { request, install } = await makeApp();
    const { apiKey } = await install();
    const res = await request('/v1/verify/tax-id', { method: 'POST', headers: { 'x-api-key': apiKey }, json: verifyBody('123456789') });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { details: { reason: 'country_required' } } });
  });

  it('falls back to the checksum when VIES is down', async () => {
    const { request, install } = await makeApp({ routes: { [VIES_REST]: viesError('MS_UNAVAILABLE'), [VIES_SOAP]: soapFault('MS_UNAVAILABLE') } });
    const { apiKey } = await install();
    const body = await (await request('/v1/verify/tax-id', { method: 'POST', headers: { 'x-api-key': apiKey }, json: verifyBody('DE136695976') })).json();
    expect(body).toMatchObject({ verdict: 'checksum_valid', valid: true, fallback: true });
  });

  it('enforces the monthly quota with a 402 and an upgrade link', async () => {
    const { request, install, services } = await makeApp();
    const { apiKey, tenantId } = await install();
    const tenant = (await services.tenants.get(tenantId))!;
    for (let i = 0; i < 100; i++) await services.entitlements.consume(tenant, 'taxVerifications');
    const res = await request('/v1/verify/tax-id', { method: 'POST', headers: { 'x-api-key': apiKey }, json: verifyBody('51824753556', { country: 'AU' }) });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      error: { code: 'quota_exceeded', details: { limit: 100, plan: 'free', upgradeUrl: `https://buy.stripe.com/test_abc?client_reference_id=${tenantId}` } },
    });
  });

  it('does not burn a verification when the certificate quota is already exhausted', async () => {
    const { request, install, services } = await makeApp();
    const { apiKey, tenantId } = await install();
    const tenant = (await services.tenants.get(tenantId))!;
    for (let i = 0; i < 10; i++) await services.entitlements.consume(tenant, 'certificates');
    const res = await request('/v1/verify/tax-id', { method: 'POST', headers: { 'x-api-key': apiKey }, json: verifyBody('51824753556', { country: 'AU', certificate: true }) });
    expect(res.status).toBe(402);
    expect((await services.entitlements.state(tenant, 'taxVerifications')).used).toBe(0);
  });

  it('can enrich the company domain in the same call', async () => {
    const { request, install } = await makeApp({ routes: { [VIES_REST]: viesValid(), 'https://data.iana.org/': () => json({ services: [] }), 'https://rdap.org/': () => new Response('', { status: 404 }) }, dns: new StaticResolver(CORP_ZONE) });
    const { apiKey } = await install();
    const body = (await (await request('/v1/verify/tax-id', { method: 'POST', headers: { 'x-api-key': apiKey }, json: verifyBody('IE6388047V', { email: 'cfo@acme.example.com', enrich: true }) })).json()) as {
      enrichment: { classification: string; email: { address: string } };
    };
    expect(body.enrichment).toMatchObject({ classification: 'corporate', email: { address: 'cfo@acme.example.com' } });
  });
});

describe('certificates over HTTP', () => {
  async function issued() {
    const ctx = await makeApp({ routes: { [VIES_REST]: viesValid() } });
    const { apiKey } = await ctx.install();
    const body = (await (await ctx.request('/v1/verify/tax-id', { method: 'POST', headers: { 'x-api-key': apiKey }, json: verifyBody('IE6388047V', { certificate: true }) })).json()) as {
      certificate: { id: string; pdfUrl: string; verifyUrl: string; pdfSha256: string };
    };
    return { ...ctx, apiKey, cert: body.certificate };
  }

  it('downloads the PDF through the signed link', async () => {
    const { request, cert } = await issued();
    const u = new URL(cert.pdfUrl);
    const res = await request(u.pathname + u.search);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-certificate-sha256')).toBe(cert.pdfSha256);
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses tampered or unsigned links', async () => {
    const { request, cert } = await issued();
    const u = new URL(cert.pdfUrl);
    u.searchParams.set('sig', 'A'.repeat(32));
    expect((await request(u.pathname + u.search)).status).toBe(403);
    expect((await request(u.pathname)).status).toBe(403);
  });

  it('exposes public verification as JSON and HTML', async () => {
    const { request, cert } = await issued();
    const path = new URL(cert.verifyUrl).pathname;
    expect(await (await request(path)).json()).toMatchObject({ id: cert.id, authentic: true, pdfIntact: true, subject: { taxId: 'IE6388047V' }, result: { verdict: 'registry_verified' } });
    const html = await (await request(path, { headers: { accept: 'text/html' } })).text();
    expect(html).toContain('Authentic — signature valid');
    expect((await request('/v1/certificates/tvc_AAAAAAAAAAAAAAAAAAAAAA/verify')).status).toBe(404);
  });

  it('lets only the owning tenant fetch certificate metadata', async () => {
    const { request, cert, apiKey, install } = await issued();
    const own = await request(`/v1/certificates/${cert.id}`, { headers: { 'x-api-key': apiKey } });
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ id: cert.id, payload: { subject: { taxId: 'IE6388047V' } } });
    const other = await install('Intruder');
    expect((await request(`/v1/certificates/${cert.id}`, { headers: { 'x-api-key': other.apiKey } })).status).toBe(404);
  });
});

describe('usage & enrichment', () => {
  it('reports plan, usage and an upgrade link', async () => {
    const { request, install } = await makeApp({ routes: { [VIES_REST]: viesValid() } });
    const { apiKey } = await install();
    await request('/v1/verify/tax-id', { method: 'POST', headers: { 'x-api-key': apiKey }, json: verifyBody('IE6388047V') });
    expect(await (await request('/v1/usage', { headers: { 'x-api-key': apiKey } })).json()).toMatchObject({
      plan: { id: 'free' },
      usage: { taxVerifications: { used: 1, limit: 100, remaining: 99 }, certificates: { used: 0 } },
      upgradeUrl: expect.stringContaining('client_reference_id='),
    });
  });

  it('POST /v1/enrich/company classifies and meters', async () => {
    const { request, install } = await makeApp({ dns: new StaticResolver({ 'mailinator.com': { MX: ['10 mail.mailinator.com.'] } }) });
    const { apiKey } = await install();
    const res = await request('/v1/enrich/company', { method: 'POST', headers: { 'x-api-key': apiKey }, json: { email: 'temp@mailinator.com' } });
    expect(await res.json()).toMatchObject({ classification: 'disposable', email: { isDisposable: true, deliverability: 'unlikely' } });
    expect(await (await request('/v1/usage', { headers: { 'x-api-key': apiKey } })).json()).toMatchObject({ usage: { enrichments: { used: 1 } } });
  });

  it('rejects enrichment without a target and private hosts', async () => {
    const { request, install } = await makeApp();
    const { apiKey } = await install();
    expect((await request('/v1/enrich/company', { method: 'POST', headers: { 'x-api-key': apiKey }, json: {} })).status).toBe(400);
    expect((await request('/v1/enrich/company', { method: 'POST', headers: { 'x-api-key': apiKey }, json: { domain: 'localhost' } })).status).toBe(422);
  });

  it('caps request bodies', async () => {
    const { request, install } = await makeApp();
    const { apiKey } = await install();
    const res = await request('/v1/verify/tax-id', { method: 'POST', headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ taxId: 'x'.repeat(300_000) }) });
    expect(res.status).toBe(413);
  });
});
