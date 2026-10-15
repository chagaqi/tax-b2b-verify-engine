import { Hono } from 'hono';
import { z } from 'zod';
import { verifyStripeApp } from '../auth/middleware.js';
import { PLANS } from '../billing/plans.js';
import { readJson } from '../lib/body.js';
import { ApiError, zodToApiError } from '../lib/errors.js';
import { runEnrichment, runVerification } from '../operations.js';
import { upgradeUrl, type Services } from '../services.js';
import type { AppEnv } from '../types.js';

/**
 * Backend for the Stripe Dashboard App (`stripe.dashboard.customer.detail`).
 * Every request is signed by `fetchStripeSignature()` inside the UI extension.
 */
const StripeVerifySchema = z.object({
  user_id: z.string(),
  account_id: z.string(),
  taxId: z.string().trim().min(2).max(64).optional(),
  country: z.string().trim().length(2).optional(),
  email: z.string().trim().max(320).optional(),
  domain: z.string().trim().max(253).optional(),
  customerName: z.string().trim().max(200).optional(),
  certificate: z.boolean().default(false),
});

export function stripeRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/v1/integrations/stripe/verify', async (c) => {
    const raw = (await readJson(c)) as Record<string, unknown>;
    const { accountId } = await verifyStripeApp(s, c, raw);
    const parsed = StripeVerifySchema.safeParse(raw);
    if (!parsed.success) throw zodToApiError(parsed.error);
    const b = parsed.data;
    const tenant = await s.tenants.ensurePlatformTenant('stripe', accountId);
    if (b.taxId) {
      return c.json(
        await runVerification(s, tenant, {
          taxId: b.taxId,
          ...(b.country ? { country: b.country.toUpperCase() } : {}),
          liveLookup: true,
          certificate: b.certificate,
          ...(b.customerName ? { companyName: b.customerName } : {}),
          ...(b.domain ? { domain: b.domain } : {}),
          ...(b.email ? { email: b.email } : {}),
          enrich: Boolean(b.domain || b.email),
          fresh: false,
        }),
      );
    }
    if (b.domain || b.email) return c.json({ enrichment: await runEnrichment(s, tenant, { ...(b.email ? { email: b.email } : {}), ...(b.domain ? { domain: b.domain } : {}) }) });
    throw new ApiError(400, 'bad_request', 'The customer has no tax ID, email or domain to verify');
  });

  app.post('/v1/integrations/stripe/account', async (c) => {
    const raw = (await readJson(c)) as Record<string, unknown>;
    const { accountId } = await verifyStripeApp(s, c, raw);
    const tenant = await s.tenants.ensurePlatformTenant('stripe', accountId);
    const up = upgradeUrl(s.config, tenant);
    return c.json({ plan: PLANS[tenant.plan], usage: await s.entitlements.summary(tenant), ...(up && tenant.plan === 'free' ? { upgradeUrl: up } : {}) });
  });

  return app;
}
