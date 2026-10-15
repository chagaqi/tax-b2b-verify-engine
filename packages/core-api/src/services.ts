import type { Context } from 'hono';
import { EntitlementService } from './billing/entitlements.js';
import { CertificateService } from './certificates/service.js';
import type { CertificateSigner } from './certificates/signer.js';
import type { AppConfig } from './config.js';
import { DohResolver, type DnsResolver } from './enrich/dns.js';
import { RdapClient } from './enrich/rdap.js';
import { EnrichmentService } from './enrich/service.js';
import { TenantService } from './auth/tenants.js';
import type { FetchLike } from './lib/http.js';
import type { Stores, Tenant } from './stores/types.js';
import { TaxVerificationService } from './verify/service.js';
import { ViesClient } from './vies/client.js';

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (msg, f) => console.log(JSON.stringify({ level: 'info', msg, ...f })),
  warn: (msg, f) => console.warn(JSON.stringify({ level: 'warn', msg, ...f })),
  error: (msg, f) => console.error(JSON.stringify({ level: 'error', msg, ...f })),
};

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface CoreDeps {
  config: AppConfig;
  stores: Stores;
  signer: CertificateSigner;
  /** Outbound fetch for VIES, RDAP, DoH, websites and OAuth (injectable for tests). */
  fetch?: FetchLike;
  /** Fetch for company websites; should pin connections to the SSRF-checked address. */
  siteFetch?: FetchLike;
  dns?: DnsResolver;
  /** Override the VIES client; `null` forces offline checksum mode. */
  vies?: ViesClient | null;
  now?: () => Date;
  /** Runtime-specific client IP lookup (the gateway passes the socket address). */
  getClientIp?: (c: Context) => string | undefined;
  logger?: Logger;
}

export interface Services {
  config: AppConfig;
  stores: Stores;
  fetch: FetchLike;
  now: () => Date;
  logger: Logger;
  tenants: TenantService;
  entitlements: EntitlementService;
  verifier: TaxVerificationService;
  enricher: EnrichmentService;
  certificates: CertificateService;
  signer: CertificateSigner;
  getClientIp: (c: Context) => string;
}

export function upgradeUrl(config: AppConfig, tenant: Tenant): string | undefined {
  const base = config.upgradeUrls.stripe ?? config.upgradeUrls.polar;
  if (!base) return undefined;
  const u = new URL(base);
  u.searchParams.set(config.upgradeUrls.stripe ? 'client_reference_id' : 'reference_id', tenant.id);
  return u.toString();
}

export function createServices(deps: CoreDeps): Services {
  const { config, stores } = deps;
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => new Date());
  const vies =
    deps.vies !== undefined
      ? deps.vies
      : config.viesMode === 'offline'
        ? null
        : new ViesClient({ fetch: fetchImpl, timeoutMs: config.viesTimeoutMs, requesterVat: config.viesRequesterVat });
  const dns = deps.dns ?? new DohResolver(fetchImpl);

  const getClientIp = (c: Context): string => {
    if (config.trustProxy === 'cloudflare') {
      const cf = c.req.header('cf-connecting-ip');
      if (cf) return cf.trim();
    } else if (typeof config.trustProxy === 'number') {
      // Each trusted proxy appends the address it saw; anything further left is client-supplied.
      const hops = (c.req.header('x-forwarded-for') ?? '').split(',').map((h) => h.trim()).filter(Boolean);
      const ip = hops[hops.length - config.trustProxy];
      if (ip) return ip;
    }
    return deps.getClientIp?.(c) ?? 'unknown';
  };

  return {
    config,
    stores,
    fetch: fetchImpl,
    now,
    logger: deps.logger ?? consoleLogger,
    signer: deps.signer,
    getClientIp,
    tenants: new TenantService(stores.tenants, config.appSecret, now),
    entitlements: new EntitlementService(stores.usage, { now, upgradeUrl: (t) => upgradeUrl(config, t) }),
    verifier: new TaxVerificationService({ vies, cache: stores.cache, now }),
    enricher: new EnrichmentService({ dns, fetch: fetchImpl, ...(deps.siteFetch ? { siteFetch: deps.siteFetch } : {}), rdap: new RdapClient(fetchImpl), cache: stores.cache, now }),
    certificates: new CertificateService({
      signer: deps.signer,
      documents: stores.documents,
      appSecret: config.appSecret,
      publicBaseUrl: config.publicBaseUrl,
      now,
      retentionSeconds: config.certificateRetentionDays * 86_400,
      linkTtlSeconds: config.certificateLinkTtlSeconds,
    }),
  };
}
