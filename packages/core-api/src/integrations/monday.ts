import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { verifyMondaySession, verifyMondaySigned } from '../auth/middleware.js';
import { readJson } from '../lib/body.js';
import { ApiError, zodToApiError } from '../lib/errors.js';
import { runVerification, type VerifyResponse } from '../operations.js';
import type { Services } from '../services.js';
import type { AppEnv } from '../types.js';
import { IntegrationError, MondayClient } from './clients.js';

export const MONDAY_STATUS_LABELS: Record<VerifyResponse['verdict'], string> = {
  registry_verified: 'Verified',
  registry_not_found: 'Not registered',
  checksum_valid: 'Valid checksum',
  format_valid: 'Valid format',
  invalid: 'Invalid',
};

const ItemViewSchema = z.object({
  taxId: z.string().trim().min(2).max(64),
  country: z.string().trim().length(2).optional(),
  domain: z.string().trim().max(253).optional(),
  certificate: z.boolean().default(false),
});

const ActionSchema = z.object({
  payload: z.object({
    inboundFieldValues: z.object({
      boardId: z.union([z.number(), z.string()]),
      itemId: z.union([z.number(), z.string()]),
      taxIdColumnId: z.string(),
      statusColumnId: z.string(),
      countryColumnId: z.string().optional(),
      summaryColumnId: z.string().optional(),
    }),
  }),
});

/** monday shows these fields in the automation's activity log. */
function actionError(c: Context, title: string, description: string, status: 400 | 401 | 402 | 500 = 400) {
  return c.json({ severityCode: 4000, notificationErrorTitle: title, notificationErrorDescription: description, runtimeErrorDescription: description }, status);
}

export function mondayRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const monday = new MondayClient(s.fetch);

  app.post('/v1/integrations/monday/verify', async (c) => {
    const { accountId } = await verifyMondaySession(s, c);
    const parsed = ItemViewSchema.safeParse(await readJson(c));
    if (!parsed.success) throw zodToApiError(parsed.error);
    const b = parsed.data;
    const tenant = await s.tenants.ensurePlatformTenant('monday', accountId);
    return c.json(
      await runVerification(s, tenant, {
        taxId: b.taxId,
        ...(b.country ? { country: b.country.toUpperCase() } : {}),
        liveLookup: true,
        certificate: b.certificate,
        ...(b.domain ? { domain: b.domain } : {}),
        enrich: Boolean(b.domain),
        fresh: false,
      }),
    );
  });

  /** Automation block: "When an item is created, verify {tax ID column} and set {status column}". */
  app.post('/v1/integrations/monday/action', async (c) => {
    const { accountId, shortLivedToken } = await verifyMondaySigned(s, c);
    if (!accountId || !shortLivedToken) throw new ApiError(401, 'unauthorized', 'Integration token is missing accountId/shortLivedToken');
    const parsed = ActionSchema.safeParse(await readJson(c));
    if (!parsed.success) throw zodToApiError(parsed.error);
    const f = parsed.data.payload.inboundFieldValues;
    const boardId = String(f.boardId);
    const itemId = String(f.itemId);
    const tenant = await s.tenants.ensurePlatformTenant('monday', accountId);

    let columns: Record<string, string>;
    try {
      columns = (await monday.readColumns(shortLivedToken, itemId, [f.taxIdColumnId, ...(f.countryColumnId ? [f.countryColumnId] : [])])).values;
    } catch (err) {
      return actionError(c, 'Could not read the item', (err as IntegrationError).message, 500);
    }
    const taxId = (columns[f.taxIdColumnId] ?? '').trim();
    if (!taxId) {
      await monday.writeColumns(shortLivedToken, boardId, itemId, { [f.statusColumnId]: { label: 'Missing tax ID' } }).catch(() => undefined);
      return c.json({});
    }
    const country = f.countryColumnId ? (columns[f.countryColumnId] ?? '').trim() : '';
    let result: VerifyResponse;
    try {
      result = await runVerification(s, tenant, {
        taxId,
        ...(/^[A-Za-z]{2}$/.test(country) ? { country: country.toUpperCase() } : {}),
        liveLookup: true,
        certificate: false,
        enrich: false,
        fresh: false,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) return actionError(c, 'Monthly quota reached', err.message, 402);
      if (err instanceof Error && err.name === 'TaxIdInputError') {
        await monday.writeColumns(shortLivedToken, boardId, itemId, { [f.statusColumnId]: { label: 'Invalid' } }).catch(() => undefined);
        return c.json({});
      }
      throw err;
    }
    const values: Record<string, unknown> = { [f.statusColumnId]: { label: MONDAY_STATUS_LABELS[result.verdict] } };
    if (f.summaryColumnId) values[f.summaryColumnId] = result.summary;
    try {
      await monday.writeColumns(shortLivedToken, boardId, itemId, values);
    } catch (err) {
      return actionError(c, 'Could not update the item', (err as Error).message, 500);
    }
    return c.json({});
  });

  return app;
}
