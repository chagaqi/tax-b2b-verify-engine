import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { verifyHubSpotRequest } from '../auth/middleware.js';
import { background } from '../lib/background.js';
import { ApiError, zodToApiError } from '../lib/errors.js';
import { runVerification, type VerifyResponse } from '../operations.js';
import type { Services } from '../services.js';
import type { Tenant } from '../stores/types.js';
import type { AppEnv } from '../types.js';
import { HubSpotClient, freshTokens } from './clients.js';

/**
 * HubSpot CRM card (`hubspot.fetch`) + custom workflow action.
 * The action must answer inside HubSpot's callback timeout, so the registry
 * lookup gets a hard budget and degrades to the offline checksum.
 */

const CardSchema = z.object({
  taxId: z.string().trim().min(2).max(64),
  country: z.string().trim().length(2).optional(),
  domain: z.string().trim().max(253).optional(),
  companyName: z.string().trim().max(200).optional(),
  certificate: z.boolean().default(false),
  objectId: z.union([z.string(), z.number()]).optional(),
  objectType: z.string().optional(),
});

const ActionSchema = z.object({
  callbackId: z.string().optional(),
  origin: z.object({ portalId: z.union([z.number(), z.string()]) }).passthrough(),
  object: z.object({ objectId: z.union([z.number(), z.string()]), objectType: z.string() }).passthrough().optional(),
  inputFields: z.record(z.string(), z.unknown()).default({}),
});

export function hubspotOutputFields(r: VerifyResponse): Record<string, string> {
  return {
    verification_status: r.verdict,
    is_valid: String(r.valid),
    summary: r.summary,
    normalized_tax_id: r.taxId.formatted,
    country_code: r.taxId.country,
    registered_name: r.registry.name ?? '',
    registered_address: r.registry.address ?? '',
    registry_status: r.registry.status,
    checked_at: r.checkedAt,
    certificate_url: r.certificate?.verifyUrl ?? '',
  };
}

async function readSigned(s: Services, c: Context): Promise<unknown> {
  const raw = await c.req.text();
  await verifyHubSpotRequest(s, c, raw);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new ApiError(400, 'bad_request', 'Body must be JSON');
  }
}

function hubspotClient(s: Services): HubSpotClient | null {
  const { hubspotClientId, hubspotClientSecret } = s.config.secrets;
  return hubspotClientId && hubspotClientSecret ? new HubSpotClient(s.fetch, hubspotClientId, hubspotClientSecret) : null;
}

/** Best-effort property write-back using the portal's OAuth tokens. */
async function writeBack(s: Services, tenant: Tenant, objectType: string, objectId: string, r: VerifyResponse): Promise<'written' | 'skipped' | 'failed'> {
  const client = hubspotClient(s);
  if (!client) return 'skipped';
  try {
    const tokens = await freshTokens(s, tenant, 'hubspot', (rt) => client.refresh(rt));
    if (!tokens) return 'skipped';
    await client.updateObject(tokens.accessToken, objectType, objectId, {
      tbve_tax_id_status: r.verdict,
      tbve_tax_id_checked_at: String(Date.parse(r.checkedAt)),
      tbve_registered_name: r.registry.name ?? '',
      tbve_normalized_tax_id: r.taxId.formatted,
      ...(r.certificate ? { tbve_certificate_url: r.certificate.verifyUrl } : {}),
    });
    return 'written';
  } catch (err) {
    s.logger.warn('hubspot write-back failed', { tenantId: tenant.id, error: (err as Error).message });
    return 'failed';
  }
}

export function hubspotRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/v1/integrations/hubspot/card', async (c) => {
    const body = await readSigned(s, c);
    const portalId = c.req.query('portalId');
    if (!portalId) throw new ApiError(400, 'bad_request', 'portalId query parameter is required');
    const parsed = CardSchema.safeParse(body);
    if (!parsed.success) throw zodToApiError(parsed.error);
    const b = parsed.data;
    const tenant = await s.tenants.ensurePlatformTenant('hubspot', portalId);
    const result = await runVerification(s, tenant, {
      taxId: b.taxId,
      ...(b.country ? { country: b.country.toUpperCase() } : {}),
      liveLookup: true,
      certificate: b.certificate,
      ...(b.companyName ? { companyName: b.companyName } : {}),
      ...(b.domain ? { domain: b.domain } : {}),
      enrich: Boolean(b.domain),
      fresh: false,
    });
    const writeback = b.objectId && b.objectType ? await writeBack(s, tenant, b.objectType, String(b.objectId), result) : 'skipped';
    return c.json({ ...result, writeback });
  });

  app.post('/v1/integrations/hubspot/workflow-action', async (c) => {
    const started = s.now().getTime();
    const body = await readSigned(s, c);
    const parsed = ActionSchema.safeParse(body);
    if (!parsed.success) throw zodToApiError(parsed.error);
    const { origin, object, inputFields } = parsed.data;
    const tenant = await s.tenants.ensurePlatformTenant('hubspot', String(origin.portalId));
    const str = (k: string) => (typeof inputFields[k] === 'string' ? (inputFields[k] as string).trim() : '');
    const taxId = str('tax_id');
    if (!taxId) {
      return c.json({ outputFields: { verification_status: 'missing_tax_id', is_valid: 'false', summary: 'No tax ID on the record', hs_execution_state: 'FAIL_CONTINUE' } });
    }
    const country = str('country');
    try {
      const result = await runVerification(
        s,
        tenant,
        {
          taxId,
          ...(/^[A-Za-z]{2}$/.test(country) ? { country: country.toUpperCase() } : {}),
          liveLookup: true,
          certificate: ['true', 'yes', '1'].includes(str('generate_certificate').toLowerCase()),
          enrich: false,
          fresh: false,
        },
        { budgetMs: Math.max(500, s.config.hubspotSlaMs - (s.now().getTime() - started) - 400) },
      );
      // Write-back runs after the response so it never eats into the SLA.
      let writeback = 'skipped';
      if (object && tenant.integrations?.hubspot) {
        background(c, writeBack(s, tenant, object.objectType, String(object.objectId), result));
        writeback = 'queued';
      }
      return c.json({ outputFields: { ...hubspotOutputFields(result), writeback, hs_execution_state: 'SUCCESS' } });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 402 || err.status === 400)) {
        return c.json({ outputFields: { verification_status: err.code, is_valid: 'false', summary: err.message, hs_execution_state: 'FAIL_CONTINUE' } });
      }
      if (err instanceof Error && err.name === 'TaxIdInputError') {
        return c.json({ outputFields: { verification_status: 'invalid', is_valid: 'false', summary: err.message, hs_execution_state: 'FAIL_CONTINUE' } });
      }
      throw err;
    }
  });

  return app;
}
