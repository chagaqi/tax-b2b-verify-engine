import { describe, expect, it } from 'vitest';
import { signStandardWebhook, signStripePayload, verifyStandardWebhook, verifyStripeSignature } from '../src/billing/signatures.js';
import { signHs256, verifyHs256 } from '../src/lib/jwt.js';
import { makeApp } from './helpers.js';

const STRIPE = 'whsec_stripe_test';
const POLAR = 'polar_secret_test';
const MONDAY = 'monday_signing_test';

async function stripePost(ctx: Awaited<ReturnType<typeof makeApp>>, event: unknown, secret = STRIPE) {
  const raw = JSON.stringify(event);
  return ctx.request('/v1/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': await signStripePayload(raw, secret), 'content-type': 'application/json' }, body: raw });
}

async function polarPost(ctx: Awaited<ReturnType<typeof makeApp>>, event: unknown, id = 'evt_' + Math.random()) {
  const raw = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  return ctx.request('/v1/webhooks/polar', {
    method: 'POST',
    headers: { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': await signStandardWebhook(raw, id, ts, POLAR), 'content-type': 'application/json' },
    body: raw,
  });
}

describe('signature primitives', () => {
  it('Stripe: accepts any matching v1, rejects stale or forged headers', async () => {
    const header = await signStripePayload('{"a":1}', 'sec', 1_700_000_000);
    expect(await verifyStripeSignature('{"a":1}', `${header},v1=deadbeef`, 'sec', { now: 1_700_000_100_000 })).toBe(true);
    expect(await verifyStripeSignature('{"a":2}', header, 'sec', { now: 1_700_000_100_000 })).toBe(false);
    expect(await verifyStripeSignature('{"a":1}', header, 'sec', { now: 1_700_001_000_000 })).toBe(false);
    expect(await verifyStripeSignature('{"a":1}', 'garbage', 'sec')).toBe(false);
  });

  it('Standard Webhooks: supports whsec_ base64 secrets and multiple signatures', async () => {
    const secret = 'whsec_' + Buffer.from('super-secret-key').toString('base64');
    const sig = await signStandardWebhook('body', 'msg_1', 1_700_000_000, secret);
    expect(await verifyStandardWebhook('body', { id: 'msg_1', timestamp: '1700000000', signature: `v1,bogus ${sig}` }, secret, { now: 1_700_000_000_000 })).toBe(true);
    expect(await verifyStandardWebhook('body', { id: 'msg_2', timestamp: '1700000000', signature: sig }, secret, { now: 1_700_000_000_000 })).toBe(false);
  });

  it('HS256 JWT: verifies, rejects bad signatures, expiry and other algs', async () => {
    const t = await signHs256({ accountId: 42, exp: Math.floor(Date.now() / 1000) + 60 }, 's3cret');
    expect(await verifyHs256(t, 's3cret')).toMatchObject({ accountId: 42 });
    await expect(verifyHs256(t, 'wrong')).rejects.toThrow('Bad signature');
    await expect(verifyHs256(await signHs256({ exp: 1 }, 's3cret'), 's3cret')).rejects.toThrow('expired');
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
    await expect(verifyHs256(none, 's3cret')).rejects.toThrow('Unsupported alg');
  });
});

describe('Stripe billing webhook', () => {
  it('upgrades the tenant on checkout and downgrades on cancellation', async () => {
    const ctx = await makeApp();
    const { tenantId } = await ctx.install();
    const res = await stripePost(ctx, {
      id: 'evt_1', type: 'checkout.session.completed',
      data: { object: { client_reference_id: tenantId, mode: 'subscription', status: 'complete', payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1', metadata: { plan: 'business' } } },
    });
    expect(res.status).toBe(200);
    expect(await ctx.services.tenants.get(tenantId)).toMatchObject({ plan: 'business', billing: { provider: 'stripe', customerId: 'cus_1', subscriptionId: 'sub_1' } });

    await stripePost(ctx, { id: 'evt_2', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled', customer: 'cus_1', metadata: { tenant_id: tenantId } } } });
    expect((await ctx.services.tenants.get(tenantId))?.plan).toBe('free');
  });

  it('links later subscription events to the tenant via the checkout subscription id', async () => {
    const ctx = await makeApp();
    const { tenantId } = await ctx.install();
    // Payment Links only carry client_reference_id on the checkout session, not on the subscription.
    await stripePost(ctx, { id: 'evt_a', type: 'checkout.session.completed', data: { object: { client_reference_id: tenantId, status: 'complete', payment_status: 'paid', customer: 'cus_7', subscription: 'sub_7' } } });
    expect((await ctx.services.tenants.get(tenantId))?.plan).toBe('pro');
    const res = await stripePost(ctx, { id: 'evt_b', type: 'customer.subscription.deleted', data: { object: { id: 'sub_7', status: 'canceled', customer: 'cus_7', metadata: {} } } });
    expect(await res.json()).toMatchObject({ outcome: `tenant ${tenantId} → free` });
    expect(await ctx.services.tenants.get(tenantId)).toMatchObject({ plan: 'free', billing: { customerId: 'cus_7', subscriptionId: 'sub_7', status: 'canceled' } });
    expect(await (await stripePost(ctx, { id: 'evt_c', type: 'customer.subscription.updated', data: { object: { id: 'sub_unknown', status: 'active', metadata: {} } } })).json()).toMatchObject({
      outcome: 'ignored: subscription not linked to a tenant',
    });
  });

  it('maps subscription price lookup keys onto plans', async () => {
    const ctx = await makeApp();
    const { tenantId } = await ctx.install();
    await stripePost(ctx, {
      id: 'evt_3', type: 'customer.subscription.updated',
      data: { object: { id: 'sub_9', status: 'active', current_period_end: 1_800_000_000, metadata: { tenant_id: tenantId }, items: { data: [{ price: { lookup_key: 'pro_monthly' } }] } } },
    });
    expect(await ctx.services.tenants.get(tenantId)).toMatchObject({ plan: 'pro', billing: { status: 'active', currentPeriodEnd: '2027-01-15T08:00:00.000Z' } });
  });

  it('rejects bad signatures and is idempotent per event id', async () => {
    const ctx = await makeApp();
    const { tenantId } = await ctx.install();
    expect((await stripePost(ctx, { id: 'evt_x', type: 'ping' }, 'whsec_wrong')).status).toBe(400);
    const event = { id: 'evt_dup', type: 'checkout.session.completed', data: { object: { client_reference_id: tenantId, status: 'complete', payment_status: 'paid' } } };
    expect(await (await stripePost(ctx, event)).json()).toMatchObject({ received: true, outcome: expect.stringContaining('pro') });
    expect(await (await stripePost(ctx, event)).json()).toEqual({ received: true, duplicate: true });
  });

  it('acknowledges events for unknown tenants without failing', async () => {
    const ctx = await makeApp();
    expect(await (await stripePost(ctx, { id: 'evt_u', type: 'checkout.session.completed', data: { object: {} } })).json()).toMatchObject({ outcome: 'ignored: no tenant reference' });
  });
});

describe('Polar webhook (Standard Webhooks)', () => {
  it('activates and revokes subscriptions', async () => {
    const ctx = await makeApp();
    const { tenantId } = await ctx.install();
    await polarPost(ctx, { type: 'subscription.active', data: { id: 'polar_sub', status: 'active', customer_id: 'pc_1', metadata: { tenant_id: tenantId }, product: { name: 'Tax Verify Pro' } } });
    expect(await ctx.services.tenants.get(tenantId)).toMatchObject({ plan: 'pro', billing: { provider: 'polar', subscriptionId: 'polar_sub' } });
    await polarPost(ctx, { type: 'subscription.canceled', data: { id: 'polar_sub', status: 'active', customer: { external_id: tenantId }, product: { name: 'Tax Verify Pro' } } });
    expect(await ctx.services.tenants.get(tenantId)).toMatchObject({ plan: 'pro', billing: { status: 'canceling' } });
    // Revocation without any tenant reference still resolves through the subscription id.
    await polarPost(ctx, { type: 'subscription.revoked', data: { id: 'polar_sub', status: 'canceled' } });
    expect((await ctx.services.tenants.get(tenantId))?.plan).toBe('free');
  });

  it('rejects forged deliveries', async () => {
    const ctx = await makeApp();
    const res = await ctx.request('/v1/webhooks/polar', {
      method: 'POST',
      headers: { 'webhook-id': 'm', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,AAAA' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});

describe('monday.com lifecycle webhook', () => {
  it('provisions the account and applies subscription changes', async () => {
    const ctx = await makeApp();
    const post = async (type: string, subscription?: Record<string, unknown>) =>
      ctx.request('/v1/webhooks/monday', {
        method: 'POST',
        headers: { authorization: await signHs256({ accountId: 777, exp: Math.floor(Date.now() / 1000) + 60 }, MONDAY) },
        json: { type, data: { account_id: 777, account_name: 'Monday Co', user_email: 'a@b.co', subscription }, timestamp: `${type}-ts` },
      });
    expect((await post('install')).status).toBe(200);
    expect(await ctx.services.tenants.findByExternal('monday', '777')).toMatchObject({ plan: 'free', name: 'Monday Co' });
    await post('app_subscription_created', { plan_id: 'business_annual', is_trial: false, renewal_date: '2027-10-15' });
    expect(await ctx.services.tenants.findByExternal('monday', '777')).toMatchObject({ plan: 'business', billing: { provider: 'monday', status: 'active' } });
    await post('app_subscription_cancelled');
    expect((await ctx.services.tenants.findByExternal('monday', '777'))?.plan).toBe('free');
  });

  it('requires a valid signing-secret JWT', async () => {
    const ctx = await makeApp();
    const res = await ctx.request('/v1/webhooks/monday', { method: 'POST', headers: { authorization: await signHs256({ accountId: 1 }, 'wrong') }, json: { type: 'install', data: { account_id: 1 } } });
    expect(res.status).toBe(401);
  });
});
