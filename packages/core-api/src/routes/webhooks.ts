import { Hono, type Context } from 'hono';
import { verifyMondaySigned } from '../auth/middleware.js';
import { handleMondayEvent, handlePolarEvent, handleStripeEvent } from '../billing/events.js';
import { verifyStandardWebhook, verifyStripeSignature } from '../billing/signatures.js';
import { ApiError } from '../lib/errors.js';
import type { Services } from '../services.js';
import type { AppEnv } from '../types.js';

const IDEMPOTENCY_TTL = 7 * 86_400;

export function webhookRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const parse = (raw: string) => {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new ApiError(400, 'bad_request', 'Webhook body must be JSON');
    }
  };

  /** Process once per event id; duplicates are acknowledged without side effects. */
  const once = async (c: Context, provider: string, eventId: string | undefined, run: () => Promise<string>) => {
    if (eventId && !(await s.stores.cache.setIfAbsent(`wh:${provider}:${eventId}`, 1, IDEMPOTENCY_TTL))) {
      return c.json({ received: true, duplicate: true });
    }
    const outcome = await run();
    s.logger.info('billing webhook', { provider, eventId, outcome });
    return c.json({ received: true, outcome });
  };

  app.post('/v1/webhooks/stripe', async (c) => {
    const secret = s.config.secrets.stripeWebhook;
    if (!secret) throw new ApiError(503, 'internal_error', 'STRIPE_WEBHOOK_SECRET is not configured');
    const raw = await c.req.text();
    if (!(await verifyStripeSignature(raw, c.req.header('stripe-signature'), secret, { now: s.now().getTime() }))) {
      throw new ApiError(400, 'bad_request', 'Invalid Stripe-Signature');
    }
    const event = parse(raw);
    return once(c, 'stripe', event.id as string | undefined, () => handleStripeEvent(s.tenants, event));
  });

  app.post('/v1/webhooks/polar', async (c) => {
    const secret = s.config.secrets.polarWebhook;
    if (!secret) throw new ApiError(503, 'internal_error', 'POLAR_WEBHOOK_SECRET is not configured');
    const raw = await c.req.text();
    const headers = { id: c.req.header('webhook-id'), timestamp: c.req.header('webhook-timestamp'), signature: c.req.header('webhook-signature') };
    if (!(await verifyStandardWebhook(raw, headers, secret, { now: s.now().getTime() }))) {
      throw new ApiError(403, 'forbidden', 'Invalid webhook signature');
    }
    return once(c, 'polar', headers.id, () => handlePolarEvent(s.tenants, parse(raw)));
  });

  app.post('/v1/webhooks/monday', async (c) => {
    // monday's install/billing webhooks carry a JWT signed with the app Signing Secret.
    await verifyMondaySigned(s, c);
    const raw = await c.req.text();
    const event = parse(raw);
    const data = (event.data ?? {}) as Record<string, unknown>;
    const id = `${String(event.type)}:${String(data.account_id)}:${String(event.timestamp ?? '')}`;
    return once(c, 'monday', id, () => handleMondayEvent(s.tenants, event));
  });

  return app;
}
