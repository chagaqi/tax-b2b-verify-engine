import { Hono } from 'hono';
import { ApiError } from '../lib/errors.js';
import { listJurisdictions } from '../taxid/index.js';
import type { Services } from '../services.js';
import type { AppEnv } from '../types.js';
import { CERT_ID_RE, type CertificateVerification } from '../certificates/service.js';
import { verifyPageHtml } from '../playground/verify-page.js';

export const VERSION = '1.0.0';

export function publicRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', (c) =>
    c.json({
      name: 'tax-b2b-verify-engine',
      version: VERSION,
      playground: `${s.config.publicBaseUrl}/playground`,
      endpoints: {
        verifyTaxId: 'POST /v1/verify/tax-id',
        enrichCompany: 'POST /v1/enrich/company',
        certificate: 'GET /v1/certificates/:id',
        certificatePdf: 'GET /v1/certificates/:id.pdf?exp=&sig=',
        verifyCertificate: 'GET /v1/certificates/:id/verify',
        publicKey: 'GET /v1/certificates/public-key',
        countries: 'GET /v1/countries',
        usage: 'GET /v1/usage',
        install: 'GET|POST /v1/install',
      },
    }),
  );

  app.get('/health', (c) =>
    c.json({ ok: true, version: VERSION, viesMode: s.config.viesMode, signingKey: s.signer.keyId, ephemeralKey: s.signer.ephemeral, time: s.now().toISOString() }),
  );

  app.get('/v1/countries', (c) => {
    const jurisdictions = listJurisdictions();
    c.header('cache-control', 'public, max-age=86400');
    return c.json({ count: jurisdictions.length, jurisdictions });
  });

  app.get('/v1/certificates/public-key', (c) => {
    c.header('cache-control', 'public, max-age=3600');
    return c.json({ keyId: s.signer.keyId, algorithm: 'Ed25519', jwk: s.signer.publicJwk(), pem: s.signer.publicPem() });
  });

  app.get('/v1/certificates/:file{tvc_[A-Za-z0-9_\\-]{22}\\.pdf}', async (c) => {
    const id = c.req.param('file').replace(/\.pdf$/, '');
    const link = await s.certificates.checkLink(id, c.req.query('exp'), c.req.query('sig'));
    if (link === 'bad_signature') throw new ApiError(403, 'forbidden', 'Invalid download signature');
    if (link === 'expired') throw new ApiError(403, 'forbidden', 'Download link expired — request a fresh link via GET /v1/certificates/:id');
    const found = await s.certificates.getRecord(id);
    if (!found) throw new ApiError(404, 'not_found', 'Certificate not found or retention period elapsed');
    return c.body(found.pdf as Uint8Array<ArrayBuffer>, 200, {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${id}.pdf"`,
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      'x-certificate-sha256': found.record.pdfSha256,
    });
  });

  app.get('/v1/certificates/:id{tvc_[A-Za-z0-9_\\-]{22}}/verify', async (c) => {
    const id = c.req.param('id');
    const v = CERT_ID_RE.test(id) ? await s.certificates.verify(id) : null;
    const wantsHtml = (c.req.header('accept') ?? '').includes('text/html');
    if (wantsHtml) return c.html(verifyPageHtml(v, id), v ? 200 : 404);
    if (!v) throw new ApiError(404, 'not_found', 'Certificate not found or retention period elapsed');
    return c.json(publicVerification(v));
  });

  return app;
}

/** What anyone holding the QR code may learn — no tenant internals. */
export function publicVerification(v: CertificateVerification) {
  const p = v.payload;
  return {
    id: v.id,
    authentic: v.authentic,
    pdfIntact: v.pdfIntact,
    issuedAt: v.issuedAt,
    issuer: p.issuer,
    keyId: v.keyId,
    payloadSha256: v.payloadSha256,
    pdfSha256: v.pdfSha256,
    sample: p.sample,
    subject: { taxId: p.subject.taxId, countryName: p.subject.countryName, scheme: p.subject.schemeName, companyName: p.subject.companyName },
    result: { verdict: p.result.verdict, summary: p.result.summary, checkedAt: p.result.checkedAt, registry: { source: p.result.registry.source, status: p.result.registry.status, consultationNumber: p.result.registry.consultationNumber } },
  };
}
