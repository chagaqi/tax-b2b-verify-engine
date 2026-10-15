import type { Context } from 'hono';
import {
  CertificateSigner,
  consoleLogger,
  createApp,
  createMemoryStores,
  createUpstashStores,
  loadConfig,
  type CoreApp,
  type DnsResolver,
  type FetchLike,
  type Logger,
  type Stores,
} from '@tbve/core-api';
import type { ShellAssets } from './assets.js';

export interface GatewayOptions {
  env: Record<string, string | undefined>;
  assets: ShellAssets;
  fetch?: FetchLike;
  siteFetch?: FetchLike;
  dns?: DnsResolver;
  stores?: Stores;
  logger?: Logger;
  getClientIp?: (c: Context) => string | undefined;
}

export interface Gateway extends CoreApp {
  storage: 'upstash' | 'memory';
}

const SDK_ORIGIN = 'https://cdn.jsdelivr.net';

/** CSP for shell pages that platforms embed in their own iframes. */
function embedCsp(frameAncestors: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' ${SDK_ORIGIN}`,
    "style-src 'unsafe-inline'",
    "connect-src 'self' https://api.monday.com",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');
}

export async function createGateway(o: GatewayOptions): Promise<Gateway> {
  const config = loadConfig(o.env);
  const logger = o.logger ?? consoleLogger;

  const upstashUrl = o.env.UPSTASH_REDIS_REST_URL?.trim();
  const upstashToken = o.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  const storage = o.stores ? 'memory' : upstashUrl && upstashToken ? 'upstash' : 'memory';
  const stores = o.stores ?? (storage === 'upstash' ? createUpstashStores(upstashUrl!, upstashToken!, o.fetch) : createMemoryStores());
  if (storage === 'memory' && config.environment === 'production') {
    logger.warn('Using in-memory storage: tenants, quotas and certificates are lost on restart. Set UPSTASH_REDIS_REST_URL/TOKEN.');
  }

  const pkcs8 = o.env.CERT_SIGNING_KEY?.trim();
  if (!pkcs8 && config.environment === 'production') {
    throw new Error('CERT_SIGNING_KEY is required in production (generate one with `node dist/server.mjs --generate-signing-key`)');
  }
  const signer = pkcs8 ? await CertificateSigner.fromPkcs8(pkcs8) : await CertificateSigner.ephemeral();
  if (!pkcs8) logger.warn('No CERT_SIGNING_KEY set: using an ephemeral Ed25519 key — certificates stop verifying after a restart.');

  const core = createApp({
    config,
    stores,
    signer,
    logger,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.siteFetch ? { siteFetch: o.siteFetch } : {}),
    ...(o.dns ? { dns: o.dns } : {}),
    ...(o.getClientIp ? { getClientIp: o.getClientIp } : {}),
  });

  const page = (body: string, type: string, csp?: string) => (c: Context) => {
    c.header('content-type', type);
    c.header('cache-control', 'public, max-age=300');
    if (csp) c.header('content-security-policy', csp);
    return c.body(body);
  };
  const pipedriveCsp = embedCsp('https://*.pipedrive.com');
  const mondayCsp = embedCsp('https://*.monday.com');
  core.app.get('/apps/pipedrive/modal', page(o.assets.pipedriveModalHtml, 'text/html; charset=utf-8', pipedriveCsp));
  core.app.get('/apps/pipedrive/modal.js', page(o.assets.pipedriveModalJs, 'text/javascript; charset=utf-8'));
  core.app.get('/apps/monday/item-view', page(o.assets.mondayItemViewHtml, 'text/html; charset=utf-8', mondayCsp));
  core.app.get('/apps/monday/item-view.js', page(o.assets.mondayItemViewJs, 'text/javascript; charset=utf-8'));

  return { ...core, storage };
}
