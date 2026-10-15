import type { IssuedCertificate } from './certificates/service.js';
import type { EnrichmentResult } from './enrich/service.js';
import type { VerifyTaxIdInput } from './schemas.js';
import type { Services } from './services.js';
import type { Tenant } from './stores/types.js';
import { summarize, type VerificationResult } from './verify/service.js';
import { ApiError } from './lib/errors.js';
import { validateTaxId } from './taxid/index.js';
import type { Metric } from './billing/plans.js';

export interface VerifyResponse {
  verdict: VerificationResult['verdict'];
  /** True for registry_verified, checksum_valid and format_valid. */
  valid: boolean;
  summary: string;
  confidence: VerificationResult['confidence'];
  fallback: boolean;
  fallbackReason?: string;
  checkedAt: string;
  taxId: VerificationResult['validation'];
  registry: VerificationResult['registry'];
  certificate?: IssuedCertificate;
  enrichment?: EnrichmentResult;
}

export function toResponse(v: VerificationResult, extra: { certificate?: IssuedCertificate; enrichment?: EnrichmentResult } = {}): VerifyResponse {
  return {
    verdict: v.verdict,
    valid: v.verdict === 'registry_verified' || v.verdict === 'checksum_valid' || v.verdict === 'format_valid',
    summary: summarize(v),
    confidence: v.confidence,
    fallback: v.fallback,
    ...(v.fallbackReason ? { fallbackReason: v.fallbackReason } : {}),
    checkedAt: v.checkedAt,
    taxId: v.validation,
    registry: v.registry,
    ...(extra.certificate ? { certificate: extra.certificate } : {}),
    ...(extra.enrichment ? { enrichment: extra.enrichment } : {}),
  };
}

export interface RunOptions {
  /** Registry time budget (HubSpot SLA). */
  budgetMs?: number;
  /** Playground: watermark the certificate and skip quotas. */
  sample?: boolean;
}

/**
 * The single verification pipeline behind every channel (REST, Stripe,
 * HubSpot, Pipedrive, monday.com, Make): quota → checksum → VIES →
 * optional enrichment → optional signed certificate.
 */
export async function runVerification(s: Services, tenant: Tenant, input: VerifyTaxIdInput, opts: RunOptions = {}): Promise<VerifyResponse> {
  const metered = !opts.sample;
  const wantsEnrichment = input.enrich && Boolean(input.domain || input.email);

  // Reject malformed input (422) before anything is charged.
  validateTaxId(input.taxId, input.country);

  // Reserve every unit up front (atomically); release the ones whose work does not happen.
  const reserved: Metric[] = [];
  const release = async (m: Metric) => {
    const i = reserved.indexOf(m);
    if (i < 0) return;
    reserved.splice(i, 1);
    await s.entitlements.refund(tenant, m).catch(() => undefined);
  };
  if (metered) {
    try {
      for (const m of ['taxVerifications', ...(input.certificate ? ['certificates'] : []), ...(wantsEnrichment ? ['enrichments'] : [])] as Metric[]) {
        await s.entitlements.consume(tenant, m);
        reserved.push(m);
      }
    } catch (err) {
      for (const m of [...reserved]) await release(m);
      throw err;
    }
  }

  try {
    const verifyPromise = s.verifier.verify(input.taxId, input.country, {
      liveLookup: input.liveLookup,
      fresh: input.fresh,
      ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}),
    });
    const enrichPromise = wantsEnrichment
      ? s.enricher.enrich({ email: input.email, domain: input.domain }).catch(async (err: Error) => {
          s.logger.warn('enrichment failed', { error: err.message });
          await release('enrichments');
          return undefined;
        })
      : Promise.resolve(undefined);
    const [verification, enrichment] = await Promise.all([verifyPromise, enrichPromise]);

    let certificate: IssuedCertificate | undefined;
    if (input.certificate) {
      certificate = await s.certificates.issue({
        verification,
        tenantId: tenant.id,
        ...(tenant.name ? { tenantName: tenant.name } : {}),
        ...(input.companyName ? { companyName: input.companyName } : {}),
        ...(input.domain ? { domain: input.domain } : {}),
        ...(enrichment ? { enrichment } : {}),
        sample: Boolean(opts.sample),
      });
    }
    return toResponse(verification, {
      ...(certificate ? { certificate } : {}),
      ...(enrichment ? { enrichment } : {}),
    });
  } catch (err) {
    for (const m of [...reserved]) await release(m);
    throw err;
  }
}

export async function runEnrichment(
  s: Services,
  tenant: Tenant,
  input: { email?: string; domain?: string; include?: { rdap: boolean; metadata: boolean } },
  opts: { sample?: boolean } = {},
): Promise<EnrichmentResult> {
  if (opts.sample) return s.enricher.enrich({ email: input.email, domain: input.domain }, input.include ?? {});
  await s.entitlements.consume(tenant, 'enrichments');
  try {
    return await s.enricher.enrich({ email: input.email, domain: input.domain }, input.include ?? {});
  } catch (err) {
    await s.entitlements.refund(tenant, 'enrichments').catch(() => undefined);
    throw err;
  }
}

export function assertCertificateOwner(ownerTenantId: string, tenant: Tenant): void {
  if (ownerTenantId !== tenant.id) throw new ApiError(404, 'not_found', 'Certificate not found');
}
