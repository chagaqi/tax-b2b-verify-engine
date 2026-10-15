export interface AppConfig {
  environment: 'production' | 'development' | 'test';
  publicBaseUrl: string;
  /** HMAC key for signed links, API-key hashing and token sealing. */
  appSecret: string;
  viesMode: 'live' | 'offline';
  viesTimeoutMs: number;
  viesRequesterVat?: string;
  /** Trust X-Forwarded-For / CF-Connecting-IP for client IPs. */
  trustProxy: boolean;
  /** HubSpot workflow-action SLA budget (HubSpot times out callbacks at 5 s). */
  hubspotSlaMs: number;
  certificateRetentionDays: number;
  certificateLinkTtlSeconds: number;
  playground: { requestsPerWindow: number; windowSeconds: number; pageViewsPerWindow: number };
  installsPerHourPerIp: number;
  secrets: {
    stripeWebhook?: string;
    polarWebhook?: string;
    mondaySigning?: string;
    stripeApp?: string;
    hubspotClientId?: string;
    hubspotClientSecret?: string;
    pipedriveClientId?: string;
    pipedriveClientSecret?: string;
    pipedriveJwtSecret?: string;
    pipedriveBasicUser?: string;
    pipedriveBasicPassword?: string;
    mondayClientSecret?: string;
  };
  upgradeUrls: { stripe?: string; polar?: string };
}

type Env = Record<string, string | undefined>;

const int = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};
const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export function loadConfig(env: Env): AppConfig {
  const environment = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const appSecret = opt(env.APP_SECRET);
  if (!appSecret && environment === 'production') throw new Error('APP_SECRET is required in production');
  if (appSecret && appSecret.length < 32 && environment === 'production') throw new Error('APP_SECRET must be at least 32 characters');
  const port = int(env.PORT, 8787);
  return {
    environment,
    publicBaseUrl: (opt(env.PUBLIC_BASE_URL) ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    appSecret: appSecret ?? 'dev-only-insecure-secret-change-me-0000000000',
    viesMode: env.VIES_MODE === 'offline' ? 'offline' : 'live',
    viesTimeoutMs: int(env.VIES_TIMEOUT_MS, 6000),
    viesRequesterVat: opt(env.VIES_REQUESTER_VAT),
    trustProxy: env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1',
    hubspotSlaMs: int(env.HUBSPOT_SLA_MS, 4200),
    certificateRetentionDays: int(env.CERTIFICATE_RETENTION_DAYS, 90),
    certificateLinkTtlSeconds: int(env.CERTIFICATE_LINK_TTL_SECONDS, 7 * 86_400),
    playground: {
      requestsPerWindow: int(env.PLAYGROUND_LIMIT, 20),
      windowSeconds: int(env.PLAYGROUND_WINDOW_SECONDS, 3600),
      pageViewsPerWindow: int(env.PLAYGROUND_PAGE_LIMIT, 120),
    },
    installsPerHourPerIp: int(env.INSTALLS_PER_HOUR_PER_IP, 10),
    secrets: {
      stripeWebhook: opt(env.STRIPE_WEBHOOK_SECRET),
      polarWebhook: opt(env.POLAR_WEBHOOK_SECRET),
      mondaySigning: opt(env.MONDAY_SIGNING_SECRET),
      stripeApp: opt(env.STRIPE_APP_SECRET),
      hubspotClientId: opt(env.HUBSPOT_CLIENT_ID),
      hubspotClientSecret: opt(env.HUBSPOT_CLIENT_SECRET),
      pipedriveClientId: opt(env.PIPEDRIVE_CLIENT_ID),
      pipedriveClientSecret: opt(env.PIPEDRIVE_CLIENT_SECRET),
      pipedriveJwtSecret: opt(env.PIPEDRIVE_JWT_SECRET),
      pipedriveBasicUser: opt(env.PIPEDRIVE_BASIC_USER),
      pipedriveBasicPassword: opt(env.PIPEDRIVE_BASIC_PASSWORD),
      mondayClientSecret: opt(env.MONDAY_CLIENT_SECRET),
    },
    upgradeUrls: { stripe: opt(env.UPGRADE_URL_STRIPE), polar: opt(env.UPGRADE_URL_POLAR) },
  };
}
