import { Hono, type Context } from 'hono';
import { rateLimit } from '../billing/entitlements.js';
import { PLANS } from '../billing/plans.js';
import { parseBody } from '../lib/body.js';
import { ApiError } from '../lib/errors.js';
import { HUBSPOT_SCOPES, HubSpotClient, PipedriveClient } from '../integrations/clients.js';
import { InstallSchema } from '../schemas.js';
import type { Services } from '../services.js';
import type { AppEnv } from '../types.js';
import { resultPageHtml } from '../playground/verify-page.js';

export function installRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const base = s.config.publicBaseUrl;
  const sec = s.config.secrets;

  app.get('/v1/install', (c) => {
    const hubspot = sec.hubspotClientId
      ? `https://app.hubspot.com/oauth/authorize?${new URLSearchParams({ client_id: sec.hubspotClientId, redirect_uri: `${base}/v1/install/hubspot/callback`, scope: HUBSPOT_SCOPES.join(' ') })}`
      : undefined;
    const pipedrive = sec.pipedriveClientId
      ? `https://oauth.pipedrive.com/oauth/authorize?${new URLSearchParams({ client_id: sec.pipedriveClientId, redirect_uri: `${base}/v1/install/pipedrive/callback` })}`
      : undefined;
    return c.json({
      plans: Object.values(PLANS),
      channels: {
        direct: { method: 'POST', url: `${base}/v1/install`, body: { name: 'Acme Ltd', email: 'ops@acme.example' } },
        makecom: { method: 'POST', url: `${base}/v1/install`, body: { platform: 'makecom' }, note: 'Paste the returned API key into the Make.com connection.' },
        stripe: { marketplace: 'https://marketplace.stripe.com', note: 'Zero-config: the first signed request from a Stripe account provisions it.' },
        hubspot: { authorizeUrl: hubspot ?? null, callback: `${base}/v1/install/hubspot/callback` },
        pipedrive: { authorizeUrl: pipedrive ?? null, callback: `${base}/v1/install/pipedrive/callback` },
        monday: { marketplace: 'https://monday.com/marketplace', note: 'Provisioned from the signed install webhook / first session token.' },
      },
    });
  });

  app.post('/v1/install', async (c) => {
    const ip = s.getClientIp(c);
    const rl = await rateLimit(s.stores.usage, 'install', ip, s.config.installsPerHourPerIp, 3600, s.now().getTime());
    if (!rl.allowed) throw new ApiError(429, 'rate_limited', 'Too many installs from this IP — try again later', undefined, { 'retry-after': String(rl.resetSeconds) });
    const input = await parseBody(c, InstallSchema);
    const { tenant, apiKey } = await s.tenants.createWithKey({
      platform: input.platform,
      ...(input.name ? { name: input.name } : {}),
      ...(input.email ? { email: input.email } : {}),
    });
    s.logger.info('tenant installed', { tenantId: tenant.id, platform: tenant.platform });
    return c.json(
      {
        tenantId: tenant.id,
        apiKey,
        plan: PLANS[tenant.plan],
        note: 'Store this API key now — it is not shown again. Send it as the x-api-key header.',
        try: `curl -X POST ${base}/v1/verify/tax-id -H 'x-api-key: ${apiKey}' -H 'content-type: application/json' -d '{"taxId":"IE6388047V"}'`,
      },
      201,
    );
  });

  const oauthDone = (c: Context, title: string, body: string, ok = true) => c.html(resultPageHtml(title, body, ok), ok ? 200 : 400);

  app.get('/v1/install/hubspot/callback', async (c) => {
    const code = c.req.query('code');
    if (!code) return oauthDone(c, 'HubSpot install failed', 'Missing authorization code.', false);
    if (!sec.hubspotClientId || !sec.hubspotClientSecret) throw new ApiError(503, 'internal_error', 'HubSpot OAuth is not configured');
    const client = new HubSpotClient(s.fetch, sec.hubspotClientId, sec.hubspotClientSecret);
    try {
      const tokens = await client.exchangeCode(code, `${base}/v1/install/hubspot/callback`);
      const info = await client.tokenInfo(tokens.accessToken);
      const tenant = await s.tenants.ensurePlatformTenant('hubspot', info.hubId, { ...(info.hubDomain ? { name: info.hubDomain } : {}), ...(info.user ? { email: info.user } : {}) });
      await s.tenants.storeTokens(tenant, 'hubspot', tokens);
      await client.ensureProperties(tokens.accessToken).catch((err: Error) => s.logger.warn('hubspot property setup failed', { error: err.message }));
      return oauthDone(c, 'Tax ID Verify is installed', `Connected HubSpot portal ${info.hubId}. Add the "Verify tax ID" action to any company or contact workflow.`);
    } catch (err) {
      s.logger.error('hubspot oauth failed', { error: (err as Error).message });
      return oauthDone(c, 'HubSpot install failed', 'We could not complete the OAuth handshake. Please retry the install.', false);
    }
  });

  app.get('/v1/install/pipedrive/callback', async (c) => {
    const code = c.req.query('code');
    if (!code) return oauthDone(c, 'Pipedrive install failed', 'Missing authorization code.', false);
    if (!sec.pipedriveClientId || !sec.pipedriveClientSecret) throw new ApiError(503, 'internal_error', 'Pipedrive OAuth is not configured');
    const client = new PipedriveClient(s.fetch, sec.pipedriveClientId, sec.pipedriveClientSecret);
    try {
      const tokens = await client.exchangeCode(code, `${base}/v1/install/pipedrive/callback`);
      const me = await client.me(tokens);
      const tenant = await s.tenants.ensurePlatformTenant('pipedrive', String(me.company_id), {
        ...(me.company_name ? { name: me.company_name } : {}),
        ...(me.email ? { email: me.email } : {}),
      });
      await s.tenants.storeTokens(tenant, 'pipedrive', tokens);
      return oauthDone(c, 'Tax ID Verify is installed', `Connected Pipedrive company ${me.company_id}. Open any organization or deal to see the verification panel.`);
    } catch (err) {
      s.logger.error('pipedrive oauth failed', { error: (err as Error).message });
      return oauthDone(c, 'Pipedrive install failed', 'We could not complete the OAuth handshake. Please retry the install.', false);
    }
  });

  return app;
}
