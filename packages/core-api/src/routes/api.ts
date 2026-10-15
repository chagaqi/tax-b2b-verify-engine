import { Hono } from 'hono';
import { requireApiKey } from '../auth/middleware.js';
import { PLANS } from '../billing/plans.js';
import { parseBody } from '../lib/body.js';
import { ApiError } from '../lib/errors.js';
import { assertCertificateOwner, runEnrichment, runVerification } from '../operations.js';
import { EnrichCompanySchema, VerifyTaxIdSchema } from '../schemas.js';
import { upgradeUrl, type Services } from '../services.js';
import type { AppEnv } from '../types.js';

export function apiRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const auth = requireApiKey(s);

  app.post('/v1/verify/tax-id', auth, async (c) => {
    const input = await parseBody(c, VerifyTaxIdSchema);
    return c.json(await runVerification(s, c.get('tenant'), input));
  });

  app.post('/v1/enrich/company', auth, async (c) => {
    const input = await parseBody(c, EnrichCompanySchema);
    return c.json(await runEnrichment(s, c.get('tenant'), input));
  });

  app.get('/v1/certificates/:id{tvc_[A-Za-z0-9_\\-]{22}}', auth, async (c) => {
    const id = c.req.param('id');
    const found = await s.certificates.getRecord(id);
    if (!found) throw new ApiError(404, 'not_found', 'Certificate not found');
    assertCertificateOwner(found.record.tenantId, c.get('tenant'));
    const link = await s.certificates.signedPdfUrl(id);
    return c.json({
      id,
      issuedAt: found.record.payload.issuedAt,
      pdfUrl: link.url,
      pdfUrlExpiresAt: link.expiresAt,
      verifyUrl: found.record.payload.verifyUrl,
      payloadSha256: found.record.payloadSha256,
      pdfSha256: found.record.pdfSha256,
      keyId: found.record.keyId,
      signature: found.record.signature,
      payload: found.record.payload,
    });
  });

  app.get('/v1/usage', auth, async (c) => {
    const tenant = c.get('tenant');
    const up = upgradeUrl(s.config, tenant);
    return c.json({
      tenantId: tenant.id,
      plan: PLANS[tenant.plan],
      usage: await s.entitlements.summary(tenant),
      ...(tenant.billing ? { billing: tenant.billing } : {}),
      ...(up && tenant.plan === 'free' ? { upgradeUrl: up } : {}),
    });
  });

  app.post('/v1/keys/rotate', auth, async (c) => {
    const { tenant, apiKey } = await s.tenants.rotateKey(c.get('tenant'));
    return c.json({ tenantId: tenant.id, apiKey, note: 'The previous key stopped working immediately. Store this key now — it is not shown again.' });
  });

  return app;
}
