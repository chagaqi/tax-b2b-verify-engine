import { Hono, type Context } from 'hono';
import { rateLimit } from '../billing/entitlements.js';
import { parseBody } from '../lib/body.js';
import { ApiError } from '../lib/errors.js';
import { runEnrichment, runVerification } from '../operations.js';
import { PLAYGROUND_JS, playgroundHtml } from '../playground/page.js';
import { EnrichCompanySchema, VerifyTaxIdSchema } from '../schemas.js';
import type { Services } from '../services.js';
import type { Tenant } from '../stores/types.js';
import { RULES } from '../taxid/index.js';
import type { AppEnv } from '../types.js';

const PLAYGROUND_TENANT: Tenant = {
  id: 'playground',
  platform: 'playground',
  name: 'Public playground',
  plan: 'free',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export function playgroundRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { requestsPerWindow, windowSeconds, pageViewsPerWindow } = s.config.playground;

  const limit = async (c: Context, scope: string, max: number) => {
    const rl = await rateLimit(s.stores.usage, scope, s.getClientIp(c), max, windowSeconds, s.now().getTime());
    c.header('x-ratelimit-limit', String(rl.limit));
    c.header('x-ratelimit-remaining', String(rl.remaining));
    if (!rl.allowed) {
      throw new ApiError(429, 'rate_limited', `Playground limit reached (${max} per ${Math.round(windowSeconds / 60)} min). Create a free API key via POST /v1/install.`, undefined, {
        'retry-after': String(rl.resetSeconds),
      });
    }
  };

  app.get('/playground', async (c) => {
    await limit(c, 'pg-page', pageViewsPerWindow);
    c.header('content-security-policy', CSP);
    c.header('x-frame-options', 'DENY');
    return c.html(playgroundHtml({ limit: requestsPerWindow, windowSeconds, jurisdictions: RULES.length }));
  });

  app.get('/playground/app.js', (c) => {
    c.header('content-type', 'text/javascript; charset=utf-8');
    c.header('cache-control', 'public, max-age=300');
    return c.body(PLAYGROUND_JS);
  });

  app.post('/v1/playground/verify-tax-id', async (c) => {
    await limit(c, 'pg-api', requestsPerWindow);
    const input = await parseBody(c, VerifyTaxIdSchema);
    return c.json(await runVerification(s, PLAYGROUND_TENANT, { ...input, enrich: false }, { sample: true }));
  });

  app.post('/v1/playground/enrich', async (c) => {
    await limit(c, 'pg-api', requestsPerWindow);
    const input = await parseBody(c, EnrichCompanySchema);
    return c.json(await runEnrichment(s, PLAYGROUND_TENANT, input, { sample: true }));
  });

  return app;
}
