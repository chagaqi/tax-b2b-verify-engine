import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { TargetError } from './enrich/domain.js';
import { randomToken } from './lib/crypto.js';
import { ApiError } from './lib/errors.js';
import { TaxIdInputError } from './taxid/index.js';
import { hubspotRoutes } from './integrations/hubspot.js';
import { mondayRoutes } from './integrations/monday.js';
import { pipedriveRoutes } from './integrations/pipedrive.js';
import { stripeRoutes } from './integrations/stripe.js';
import { apiRoutes } from './routes/api.js';
import { installRoutes } from './routes/install.js';
import { playgroundRoutes } from './routes/playground.js';
import { publicRoutes } from './routes/public.js';
import { webhookRoutes } from './routes/webhooks.js';
import { createServices, type CoreDeps, type Services } from './services.js';
import type { AppEnv } from './types.js';

export interface CoreApp {
  app: Hono<AppEnv>;
  services: Services;
}

/** Build the runtime-agnostic Hono app. Runtimes add their own static routes on top. */
export function createApp(deps: CoreDeps): CoreApp {
  const s = createServices(deps);
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const id = c.req.header('x-request-id')?.slice(0, 64) || `req_${randomToken(9)}`;
    c.set('requestId', id);
    await next();
    c.header('x-request-id', id);
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
  });

  // API-key auth, no cookies → wildcard CORS is safe and lets the Stripe App iframe call us.
  app.use(
    '/v1/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['content-type', 'x-api-key', 'authorization', 'stripe-signature', 'x-request-id'],
      exposeHeaders: ['x-request-id', 'x-ratelimit-remaining', 'retry-after'],
      maxAge: 600,
    }),
  );
  app.use(
    '/v1/*',
    bodyLimit({
      maxSize: 256 * 1024,
      onError: () => {
        throw new ApiError(413, 'bad_request', 'Request body too large (max 256 KB)');
      },
    }),
  );

  app.route('/', publicRoutes(s));
  app.route('/', apiRoutes(s));
  app.route('/', installRoutes(s));
  app.route('/', webhookRoutes(s));
  app.route('/', playgroundRoutes(s));
  app.route('/', stripeRoutes(s));
  app.route('/', hubspotRoutes(s));
  app.route('/', pipedriveRoutes(s));
  app.route('/', mondayRoutes(s));

  app.notFound((c) => c.json(new ApiError(404, 'not_found', `No route for ${c.req.method} ${new URL(c.req.url).pathname}`).toJSON(), 404));

  app.onError((err, c) => {
    let e: ApiError;
    if (err instanceof ApiError) e = err;
    else if (err instanceof TaxIdInputError) e = new ApiError(422, 'bad_request', err.message, { reason: err.code });
    else if (err instanceof TargetError) e = new ApiError(422, 'bad_request', err.message);
    else {
      s.logger.error('unhandled error', { requestId: c.get('requestId'), error: err.message, stack: err.stack });
      e = new ApiError(500, 'internal_error', 'Internal error', { requestId: c.get('requestId') });
    }
    for (const [k, v] of Object.entries(e.headers ?? {})) c.header(k, v);
    return c.json(e.toJSON(), e.status);
  });

  return { app, services: s };
}
