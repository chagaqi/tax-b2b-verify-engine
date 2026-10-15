import { Hono } from 'hono';
import { z } from 'zod';
import { verifyPipedrive } from '../auth/middleware.js';
import { readJson } from '../lib/body.js';
import { zodToApiError } from '../lib/errors.js';
import { runVerification, type VerifyResponse } from '../operations.js';
import type { Services } from '../services.js';
import type { Tenant } from '../stores/types.js';
import type { AppEnv } from '../types.js';
import { PipedriveClient, freshTokens } from './clients.js';

/** Pipedrive JSON-panel label colours keyed by verdict. */
const STATUS: Record<VerifyResponse['verdict'], { label: string; color: 'green' | 'red' | 'yellow' | 'blue' | 'gray' }> = {
  registry_verified: { label: 'Verified (VIES)', color: 'green' },
  registry_not_found: { label: 'Not registered', color: 'red' },
  checksum_valid: { label: 'Valid checksum', color: 'blue' },
  format_valid: { label: 'Valid format', color: 'yellow' },
  invalid: { label: 'Invalid', color: 'red' },
};

const RESULT_TTL = 24 * 3600;

export function pipedrivePanelRow(id: string, r: VerifyResponse | null, hint?: string): Record<string, unknown> {
  if (!r) {
    return { id, header: 'Tax ID not verified', status: { label: 'Not checked', color: 'gray' }, summary: hint ?? 'Use “Verify tax ID” to run a check.' };
  }
  return {
    id,
    header: r.taxId.formatted,
    status: STATUS[r.verdict],
    summary: r.summary,
    country: `${r.taxId.countryName} (${r.taxId.jurisdiction})`,
    registered_name: r.registry.name ?? '',
    registered_address: r.registry.address ?? '',
    checked_at: r.checkedAt.slice(0, 10),
    ...(r.certificate ? { certificate: { url: r.certificate.pdfUrl, label: 'Audit certificate (PDF)' } } : {}),
  };
}

const ModalSchema = z.object({
  taxId: z.string().trim().min(2).max(64),
  country: z.string().trim().length(2).optional(),
  domain: z.string().trim().max(253).optional(),
  certificate: z.boolean().default(false),
  resource: z.enum(['organization', 'deal']).optional(),
  selectedId: z.union([z.string(), z.number()]).optional(),
});

const cacheKey = (tenant: Tenant, resource: string, id: string) => `pd:${tenant.id}:${resource}:${id}`;

export function pipedriveRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/v1/integrations/pipedrive/panel', async (c) => {
    const { companyId } = await verifyPipedrive(s, c);
    const tenant = await s.tenants.ensurePlatformTenant('pipedrive', companyId);
    const resource = c.req.query('resource') === 'deal' ? 'deal' : 'organization';
    const id = (c.req.query('selectedIds') ?? c.req.query('id') ?? '').split(',')[0]!.trim();
    if (!id) return c.json({ data: [pipedrivePanelRow('0', null, 'No record selected')] });

    const cached = await s.stores.cache.get<VerifyResponse>(cacheKey(tenant, resource, id));
    if (cached) return c.json({ data: [pipedrivePanelRow(id, cached)] });

    const { pipedriveClientId, pipedriveClientSecret } = s.config.secrets;
    if (!pipedriveClientId || !pipedriveClientSecret || !tenant.integrations?.pipedrive) {
      return c.json({ data: [pipedrivePanelRow(id, null)] });
    }
    const client = new PipedriveClient(s.fetch, pipedriveClientId, pipedriveClientSecret);
    try {
      const tokens = await freshTokens(s, tenant, 'pipedrive', (rt) => client.refresh(rt));
      const profile = tokens ? await client.organizationTaxProfile(tokens, resource, id) : null;
      if (!profile?.taxId) return c.json({ data: [pipedrivePanelRow(id, null, 'No tax/VAT field found on the organization.')] });
      const result = await runVerification(s, tenant, {
        taxId: profile.taxId,
        liveLookup: true,
        certificate: false,
        ...(profile.name ? { companyName: profile.name } : {}),
        enrich: false,
        fresh: false,
      });
      await s.stores.cache.set(cacheKey(tenant, resource, id), result, RESULT_TTL);
      return c.json({ data: [pipedrivePanelRow(id, result)] });
    } catch (err) {
      s.logger.warn('pipedrive panel lookup failed', { tenantId: tenant.id, error: (err as Error).message });
      return c.json({ data: [pipedrivePanelRow(id, null, (err as Error).name === 'TaxIdInputError' ? (err as Error).message : 'Could not read the organization from Pipedrive.')] });
    }
  });

  app.post('/v1/integrations/pipedrive/verify', async (c) => {
    const { companyId } = await verifyPipedrive(s, c);
    const tenant = await s.tenants.ensurePlatformTenant('pipedrive', companyId);
    const parsed = ModalSchema.safeParse(await readJson(c));
    if (!parsed.success) throw zodToApiError(parsed.error);
    const b = parsed.data;
    const result = await runVerification(s, tenant, {
      taxId: b.taxId,
      ...(b.country ? { country: b.country.toUpperCase() } : {}),
      liveLookup: true,
      certificate: b.certificate,
      ...(b.domain ? { domain: b.domain } : {}),
      enrich: Boolean(b.domain),
      fresh: true,
    });
    if (b.selectedId !== undefined) await s.stores.cache.set(cacheKey(tenant, b.resource ?? 'organization', String(b.selectedId)), result, RESULT_TTL);
    return c.json(result);
  });

  return app;
}
