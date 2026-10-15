import type { Context, MiddlewareHandler } from 'hono';
import { verifyHubSpotV3, verifyStripeSignature } from '../billing/signatures.js';
import { ApiError } from '../lib/errors.js';
import { JwtError, verifyHs256, type JwtPayload } from '../lib/jwt.js';
import { timingSafeEqual } from '../lib/crypto.js';
import type { Services } from '../services.js';
import type { AppEnv } from '../types.js';

export function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return m?.[1]?.trim();
}

/** `x-api-key: tbv_live_…` or `Authorization: Bearer tbv_live_…` */
export function requireApiKey(s: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.req.header('x-api-key') ?? bearer(c.req.header('authorization'));
    if (!key) throw new ApiError(401, 'unauthorized', 'Missing API key — send it in the x-api-key header');
    const tenant = await s.tenants.findByApiKey(key);
    if (!tenant) throw new ApiError(401, 'unauthorized', 'Invalid API key');
    c.set('tenant', tenant);
    await next();
  };
}

/** Public URL of the current request (HubSpot signs the URL it called, not our internal one). */
export function publicUrl(s: Services, c: Context): string {
  const u = new URL(c.req.url);
  return `${s.config.publicBaseUrl}${u.pathname}${u.search}`;
}

function requireSecret(v: string | undefined, name: string): string {
  if (!v) throw new ApiError(503, 'internal_error', `${name} is not configured on this deployment`);
  return v;
}

/** Stripe Apps: `fetchStripeSignature()` signs JSON.stringify({ user_id, account_id }). */
export async function verifyStripeApp(s: Services, c: Context, raw: unknown): Promise<{ userId: string; accountId: string }> {
  const secret = requireSecret(s.config.secrets.stripeApp, 'STRIPE_APP_SECRET');
  const body = (raw && typeof raw === 'object' ? raw : {}) as { user_id?: unknown; account_id?: unknown };
  if (typeof body.user_id !== 'string' || typeof body.account_id !== 'string') {
    throw new ApiError(400, 'bad_request', 'user_id and account_id are required');
  }
  const payload = JSON.stringify({ user_id: body.user_id, account_id: body.account_id });
  const ok = await verifyStripeSignature(payload, c.req.header('stripe-signature'), secret, { now: s.now().getTime() });
  if (!ok) throw new ApiError(401, 'unauthorized', 'Invalid Stripe-Signature');
  return { userId: body.user_id, accountId: body.account_id };
}

export async function verifyHubSpotRequest(s: Services, c: Context, rawBody: string): Promise<void> {
  const secret = requireSecret(s.config.secrets.hubspotClientSecret, 'HUBSPOT_CLIENT_SECRET');
  const ok = await verifyHubSpotV3(
    {
      method: c.req.method,
      url: publicUrl(s, c),
      body: rawBody,
      signature: c.req.header('x-hubspot-signature-v3'),
      timestamp: c.req.header('x-hubspot-request-timestamp'),
    },
    secret,
    { now: s.now().getTime() },
  );
  if (!ok) throw new ApiError(401, 'unauthorized', 'Invalid X-HubSpot-Signature-v3');
}

async function verifyJwt(token: string | undefined, secret: string, s: Services): Promise<JwtPayload> {
  if (!token) throw new ApiError(401, 'unauthorized', 'Missing token');
  try {
    return await verifyHs256(token, secret, { now: s.now() });
  } catch (err) {
    throw new ApiError(401, 'unauthorized', err instanceof JwtError ? err.message : 'Invalid token');
  }
}

/** monday.com: client-side `sessionToken` (signed with the app's Client Secret). */
export async function verifyMondaySession(s: Services, c: Context): Promise<{ accountId: string; userId?: string }> {
  const secret = requireSecret(s.config.secrets.mondayClientSecret, 'MONDAY_CLIENT_SECRET');
  const raw = c.req.header('authorization');
  const p = await verifyJwt(bearer(raw) ?? raw, secret, s);
  const dat = (p.dat ?? {}) as Record<string, unknown>;
  const accountId = dat.account_id ?? p.accountId;
  if (accountId === undefined) throw new ApiError(401, 'unauthorized', 'Token has no account');
  const userId = dat.user_id ?? p.userId;
  return { accountId: String(accountId), ...(userId !== undefined ? { userId: String(userId) } : {}) };
}

/** monday.com: server-to-server calls (integration actions, webhooks) signed with the Signing Secret. */
export async function verifyMondaySigned(s: Services, c: Context): Promise<{ accountId?: string; shortLivedToken?: string; payload: JwtPayload }> {
  const secret = requireSecret(s.config.secrets.mondaySigning, 'MONDAY_SIGNING_SECRET');
  const raw = c.req.header('authorization');
  const p = await verifyJwt(bearer(raw) ?? raw, secret, s);
  return {
    payload: p,
    ...(p.accountId !== undefined ? { accountId: String(p.accountId) } : {}),
    ...(typeof p.shortLivedToken === 'string' ? { shortLivedToken: p.shortLivedToken } : {}),
  };
}

/**
 * Pipedrive app extensions: JWT (`token` query param or Bearer header, signed with
 * the JWT secret) or HTTP Basic credentials configured in Developer Hub.
 */
export async function verifyPipedrive(s: Services, c: Context): Promise<{ companyId: string; userId?: string }> {
  const auth = c.req.header('authorization') ?? '';
  const basic = /^Basic\s+(.+)$/i.exec(auth);
  if (basic) {
    const user = requireSecret(s.config.secrets.pipedriveBasicUser, 'PIPEDRIVE_BASIC_USER');
    const pass = requireSecret(s.config.secrets.pipedriveBasicPassword, 'PIPEDRIVE_BASIC_PASSWORD');
    let decoded = '';
    try {
      decoded = atob(basic[1]!);
    } catch {
      throw new ApiError(401, 'unauthorized', 'Malformed Basic credentials');
    }
    if (!timingSafeEqual(decoded, `${user}:${pass}`)) throw new ApiError(401, 'unauthorized', 'Invalid Basic credentials');
    const companyId = c.req.query('companyId');
    if (!companyId) throw new ApiError(400, 'bad_request', 'companyId query parameter is required');
    const userId = c.req.query('userId');
    return { companyId, ...(userId ? { userId } : {}) };
  }
  const secret = requireSecret(s.config.secrets.pipedriveJwtSecret, 'PIPEDRIVE_JWT_SECRET');
  const p = await verifyJwt(bearer(auth) ?? c.req.query('token'), secret, s);
  const companyId = p.companyId ?? p.company_id;
  if (companyId === undefined) throw new ApiError(401, 'unauthorized', 'Token has no companyId');
  const userId = p.userId ?? p.user_id;
  return { companyId: String(companyId), ...(userId !== undefined ? { userId: String(userId) } : {}) };
}
