import { describe, expect, it } from 'vitest';
import { signHubSpotV3, signStripePayload } from '../src/billing/signatures.js';
import { signHs256 } from '../src/lib/jwt.js';
import { VIES_REST, VIES_SOAP, json, makeApp, viesValid, type Handler } from './helpers.js';

const exp = () => Math.floor(Date.now() / 1000) + 300;

describe('Stripe Dashboard App backend', () => {
  const STRIPE_APP = 'absec_stripe_app_test';
  const signed = async (ctx: Awaited<ReturnType<typeof makeApp>>, body: Record<string, unknown>, secret = STRIPE_APP, path = '/v1/integrations/stripe/verify') =>
    ctx.request(path, {
      method: 'POST',
      headers: { 'stripe-signature': await signStripePayload(JSON.stringify({ user_id: body.user_id, account_id: body.account_id }), secret) },
      json: body,
    });

  it('verifies the customer tax ID and auto-provisions the Stripe account', async () => {
    const ctx = await makeApp({ routes: { [VIES_REST]: viesValid() } });
    const res = await signed(ctx, { user_id: 'usr_1', account_id: 'acct_123', taxId: 'IE6388047V', certificate: true, customerName: 'Google Ireland' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verdict: string; certificate: { pdfUrl: string } };
    expect(body.verdict).toBe('registry_verified');
    expect(body.certificate.pdfUrl).toMatch(/^https:\/\/verify\.test\/v1\/certificates\/tvc_/);
    expect(await ctx.services.tenants.findByExternal('stripe', 'acct_123')).toMatchObject({ platform: 'stripe', plan: 'free' });
  });

  it('rejects requests not signed by Stripe', async () => {
    const ctx = await makeApp();
    expect((await signed(ctx, { user_id: 'usr_1', account_id: 'acct_123', taxId: 'IE6388047V' }, 'absec_wrong')).status).toBe(401);
    expect((await ctx.request('/v1/integrations/stripe/verify', { method: 'POST', json: { user_id: 'u', account_id: 'a' } })).status).toBe(401);
  });

  it('reports plan and usage for the account', async () => {
    const ctx = await makeApp();
    const body = await (await signed(ctx, { user_id: 'u', account_id: 'acct_9' }, STRIPE_APP, '/v1/integrations/stripe/account')).json();
    expect(body).toMatchObject({ plan: { id: 'free' }, usage: { taxVerifications: { used: 0 } }, upgradeUrl: expect.any(String) });
  });
});

describe('HubSpot', () => {
  const SECRET = 'hs-client-secret';
  const post = async (ctx: Awaited<ReturnType<typeof makeApp>>, path: string, body: unknown, opts: { secret?: string; ts?: number } = {}) => {
    const raw = JSON.stringify(body);
    const ts = String(opts.ts ?? Date.now());
    const sig = await signHubSpotV3('POST', `https://verify.test${path}`, raw, ts, opts.secret ?? SECRET);
    return ctx.request(path, { method: 'POST', headers: { 'x-hubspot-signature-v3': sig, 'x-hubspot-request-timestamp': ts, 'content-type': 'application/json' }, body: raw });
  };

  it('CRM card: verifies with a v3-signed hubspot.fetch request', async () => {
    const ctx = await makeApp({ routes: { [VIES_REST]: viesValid() } });
    const res = await post(ctx, '/v1/integrations/hubspot/card?portalId=4455&userId=1&userEmail=a%40b.co', { taxId: 'IE6388047V' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verdict: 'registry_verified', writeback: 'skipped' });
    expect(await ctx.services.tenants.findByExternal('hubspot', '4455')).toBeTruthy();
  });

  it('rejects bad and stale signatures', async () => {
    const ctx = await makeApp();
    expect((await post(ctx, '/v1/integrations/hubspot/card?portalId=1', { taxId: 'IE6388047V' }, { secret: 'nope' })).status).toBe(401);
    expect((await post(ctx, '/v1/integrations/hubspot/card?portalId=1', { taxId: 'IE6388047V' }, { ts: Date.now() - 10 * 60_000 })).status).toBe(401);
  });

  it('workflow action: returns outputFields for property write-back', async () => {
    const ctx = await makeApp({ routes: { [VIES_REST]: viesValid() } });
    const res = await post(ctx, '/v1/integrations/hubspot/workflow-action', {
      callbackId: 'cb_1', origin: { portalId: 4455, actionDefinitionId: 9 }, object: { objectId: 101, objectType: 'COMPANY' },
      inputFields: { tax_id: 'IE6388047V', country: '', generate_certificate: 'true' },
    });
    const body = (await res.json()) as { outputFields: Record<string, string> };
    expect(body.outputFields).toMatchObject({
      verification_status: 'registry_verified', is_valid: 'true', normalized_tax_id: 'IE6388047V', registered_name: 'GOOGLE IRELAND LIMITED',
      country_code: 'IE', hs_execution_state: 'SUCCESS', writeback: 'skipped', certificate_url: expect.stringContaining('/verify'),
    });
  });

  it('workflow action: answers inside the 5 s SLA even when VIES hangs', async () => {
    const hang: Handler = (req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const ctx = await makeApp({ env: { HUBSPOT_SLA_MS: '1500', VIES_TIMEOUT_MS: '30000' }, routes: { [VIES_REST]: hang, [VIES_SOAP]: hang } });
    const started = Date.now();
    const res = await post(ctx, '/v1/integrations/hubspot/workflow-action', { origin: { portalId: 1 }, inputFields: { tax_id: 'DE136695976' } });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2500);
    expect(((await res.json()) as { outputFields: Record<string, string> }).outputFields).toMatchObject({ verification_status: 'checksum_valid', registry_status: 'unavailable', hs_execution_state: 'SUCCESS' });
  });

  it('workflow action: degrades to FAIL_CONTINUE for missing IDs and exhausted quotas', async () => {
    const ctx = await makeApp();
    const missing = (await (await post(ctx, '/v1/integrations/hubspot/workflow-action', { origin: { portalId: 2 }, inputFields: {} })).json()) as { outputFields: Record<string, string> };
    expect(missing.outputFields).toMatchObject({ verification_status: 'missing_tax_id', hs_execution_state: 'FAIL_CONTINUE' });
    const tenant = (await ctx.services.tenants.findByExternal('hubspot', '2'))!;
    for (let i = 0; i < 100; i++) await ctx.services.entitlements.consume(tenant, 'taxVerifications');
    const quota = (await (await post(ctx, '/v1/integrations/hubspot/workflow-action', { origin: { portalId: 2 }, inputFields: { tax_id: '51824753556', country: 'AU' } })).json()) as {
      outputFields: Record<string, string>;
    };
    expect(quota.outputFields).toMatchObject({ verification_status: 'quota_exceeded', hs_execution_state: 'FAIL_CONTINUE' });
  });

  it('OAuth install stores sealed tokens and creates CRM properties; card writes back', async () => {
    const ctx = await makeApp({
      routes: {
        'https://api.hubapi.com/oauth/v1/token': () => json({ access_token: 'at_1', refresh_token: 'rt_1', expires_in: 1800 }),
        'https://api.hubapi.com/oauth/v1/access-tokens/at_1': () => json({ hub_id: 4455, user: 'admin@acme.co', hub_domain: 'acme.co' }),
        'https://api.hubapi.com/crm/v3/properties/': () => json({ status: 'COMPLETE' }, 201),
        'https://api.hubapi.com/crm/v3/objects/companies/101': () => json({ id: '101' }),
        [VIES_REST]: viesValid(),
      },
    });
    const page = await ctx.request('/v1/install/hubspot/callback?code=abc');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Connected HubSpot portal 4455');
    const tenant = (await ctx.services.tenants.findByExternal('hubspot', '4455'))!;
    expect(tenant.integrations?.hubspot?.sealed).toMatch(/^v1\./);
    expect(JSON.stringify(tenant)).not.toContain('at_1');
    expect(await ctx.services.tenants.readTokens(tenant, 'hubspot')).toMatchObject({ accessToken: 'at_1', refreshToken: 'rt_1' });
    expect(ctx.calls.filter((c) => c.url.includes('/crm/v3/properties/')).map((c) => c.url)).toEqual([
      'https://api.hubapi.com/crm/v3/properties/companies/batch/create',
      'https://api.hubapi.com/crm/v3/properties/contacts/batch/create',
    ]);

    const res = await post(ctx, '/v1/integrations/hubspot/card?portalId=4455', { taxId: 'IE6388047V', objectId: 101, objectType: 'company' });
    expect(await res.json()).toMatchObject({ writeback: 'written' });
    const patch = ctx.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.headers.get('authorization')).toBe('Bearer at_1');
    expect(JSON.parse(patch.body).properties).toMatchObject({ tbve_tax_id_status: 'registry_verified', tbve_normalized_tax_id: 'IE6388047V' });
  });
});

describe('Pipedrive', () => {
  const jwt = (companyId = 900) => signHs256({ companyId, userId: 5, exp: exp() }, 'pd-jwt-secret');

  it('panel shows a "not checked" row before any verification', async () => {
    const ctx = await makeApp();
    const res = await ctx.request(`/v1/integrations/pipedrive/panel?resource=organization&selectedIds=12&token=${await jwt()}`);
    expect(await res.json()).toEqual({ data: [{ id: '12', header: 'Tax ID not verified', status: { label: 'Not checked', color: 'gray' }, summary: 'Use “Verify tax ID” to run a check.' }] });
  });

  it('modal verification is remembered by the panel', async () => {
    const ctx = await makeApp({ routes: { [VIES_REST]: viesValid() } });
    const token = await jwt();
    const v = await ctx.request('/v1/integrations/pipedrive/verify', { method: 'POST', headers: { authorization: `Bearer ${token}` }, json: { taxId: 'IE6388047V', selectedId: 12, resource: 'organization', certificate: true } });
    expect(v.status).toBe(200);
    const panel = (await (await ctx.request(`/v1/integrations/pipedrive/panel?resource=organization&selectedIds=12&token=${token}`)).json()) as { data: Record<string, unknown>[] };
    expect(panel.data[0]).toMatchObject({ id: '12', header: 'IE6388047V', status: { label: 'Verified (VIES)', color: 'green' }, registered_name: 'GOOGLE IRELAND LIMITED', certificate: { label: 'Audit certificate (PDF)' } });
  });

  it('accepts Basic auth with companyId, rejects bad credentials and JWTs', async () => {
    const ctx = await makeApp();
    const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;
    expect((await ctx.request('/v1/integrations/pipedrive/panel?companyId=900&selectedIds=1', { headers: { authorization: basic('pd-user', 'pd-pass') } })).status).toBe(200);
    expect((await ctx.request('/v1/integrations/pipedrive/panel?companyId=900&selectedIds=1', { headers: { authorization: basic('pd-user', 'nope') } })).status).toBe(401);
    expect((await ctx.request(`/v1/integrations/pipedrive/panel?token=${await signHs256({ companyId: 1 }, 'other')}`)).status).toBe(401);
  });

  it('with OAuth tokens, reads the organization tax field and verifies automatically', async () => {
    const ctx = await makeApp({
      routes: {
        'https://oauth.pipedrive.com/oauth/token': () => json({ access_token: 'pd_at', refresh_token: 'pd_rt', expires_in: 3600, api_domain: 'https://acme.pipedrive.com' }),
        'https://acme.pipedrive.com/api/v1/users/me': () => json({ data: { id: 5, company_id: 900, company_name: 'Acme CRM' } }),
        'https://acme.pipedrive.com/api/v1/deals/77': () => json({ data: { org_id: { value: 12 } } }),
        'https://acme.pipedrive.com/api/v1/organizations/12': () => json({ data: { name: 'Google Ireland', abc123hash: 'IE 6388047V' } }),
        'https://acme.pipedrive.com/api/v1/organizationFields': () => json({ data: [{ key: 'name', name: 'Name' }, { key: 'abc123hash', name: 'VAT number' }] }),
        [VIES_REST]: viesValid(),
      },
    });
    const install = await ctx.request('/v1/install/pipedrive/callback?code=xyz');
    expect(await install.text()).toContain('Connected Pipedrive company 900');
    const panel = (await (await ctx.request(`/v1/integrations/pipedrive/panel?resource=deal&selectedIds=77&token=${await jwt()}`)).json()) as { data: Record<string, unknown>[] };
    expect(panel.data[0]).toMatchObject({ header: 'IE6388047V', status: { color: 'green' } });
    const tokenCall = ctx.calls.find((c) => c.url === 'https://oauth.pipedrive.com/oauth/token')!;
    expect(tokenCall.headers.get('authorization')).toBe(`Basic ${btoa('pd-client-id:pd-client-secret')}`);
  });
});

describe('monday.com', () => {
  it('Item View: verifies with the client sessionToken', async () => {
    const ctx = await makeApp({ routes: { [VIES_REST]: viesValid() } });
    const token = await signHs256({ dat: { account_id: 31337, user_id: 9 }, exp: exp() }, 'monday_client_test');
    const res = await ctx.request('/v1/integrations/monday/verify', { method: 'POST', headers: { authorization: token }, json: { taxId: 'IE6388047V' } });
    expect(await res.json()).toMatchObject({ verdict: 'registry_verified' });
    expect(await ctx.services.tenants.findByExternal('monday', '31337')).toBeTruthy();
    expect((await ctx.request('/v1/integrations/monday/verify', { method: 'POST', headers: { authorization: 'x.y.z' }, json: { taxId: 'IE6388047V' } })).status).toBe(401);
  });

  it('automation action: reads the tax ID column and writes status + summary back', async () => {
    const gql: { query: string; variables: Record<string, unknown> }[] = [];
    const ctx = await makeApp({
      routes: {
        'https://api.monday.com/v2': async (req) => {
          const body = (await req.json()) as { query: string; variables: Record<string, unknown> };
          gql.push(body);
          expect(req.headers.get('authorization')).toBe('slt_abc');
          if (body.query.startsWith('query')) return json({ data: { items: [{ name: 'Google', column_values: [{ id: 'text_tax', text: 'IE6388047V' }, { id: 'country', text: '' }] }] } });
          return json({ data: { change_multiple_column_values: { id: '555' } } });
        },
        [VIES_REST]: viesValid(),
      },
    });
    const auth = await signHs256({ accountId: 31337, userId: 9, shortLivedToken: 'slt_abc', exp: exp() }, 'monday_signing_test');
    const res = await ctx.request('/v1/integrations/monday/action', {
      method: 'POST',
      headers: { authorization: auth },
      json: { payload: { inboundFieldValues: { boardId: 1, itemId: 555, taxIdColumnId: 'text_tax', statusColumnId: 'status', countryColumnId: 'country', summaryColumnId: 'notes' } } },
    });
    expect(res.status).toBe(200);
    expect(gql[0]!.variables).toEqual({ ids: ['555'], cols: ['text_tax', 'country'] });
    expect(JSON.parse(gql[1]!.variables.vals as string)).toEqual({ status: { label: 'Verified' }, notes: 'IE6388047V is active in EU VIES (GOOGLE IRELAND LIMITED).' });
    expect(gql[1]!.query).toContain('create_labels_if_missing: true');
  });

  it('automation action: reports quota errors in monday’s error format', async () => {
    const ctx = await makeApp({
      routes: { 'https://api.monday.com/v2': () => json({ data: { items: [{ name: 'X', column_values: [{ id: 'tax', text: '51824753556' }, { id: 'cc', text: 'AU' }] }] } }) },
    });
    const tenant = await ctx.services.tenants.ensurePlatformTenant('monday', '1');
    for (let i = 0; i < 100; i++) await ctx.services.entitlements.consume(tenant, 'taxVerifications');
    const res = await ctx.request('/v1/integrations/monday/action', {
      method: 'POST',
      headers: { authorization: await signHs256({ accountId: 1, shortLivedToken: 't', exp: exp() }, 'monday_signing_test') },
      json: { payload: { inboundFieldValues: { boardId: 1, itemId: 2, taxIdColumnId: 'tax', statusColumnId: 's', countryColumnId: 'cc' } } },
    });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ severityCode: 4000, notificationErrorTitle: 'Monthly quota reached' });
  });
});
