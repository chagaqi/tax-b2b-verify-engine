import { validateTaxId, type TaxIdValidation } from '../taxid/index.js';
import type { ICacheStore } from '../stores/types.js';
import type { ViesClient, ViesResult } from '../vies/client.js';

/**
 * Overall outcome, ordered from strongest to weakest evidence:
 *  - `registry_verified`   VIES confirms the number is active.
 *  - `registry_not_found`  Checksum passes but VIES says the number is not active.
 *  - `checksum_valid`      Structure + check digit pass; no registry consulted/available.
 *  - `format_valid`        Structure passes; this scheme has no public check digit.
 *  - `invalid`             Structure or check digit fails.
 */
export type Verdict = 'registry_verified' | 'registry_not_found' | 'checksum_valid' | 'format_valid' | 'invalid';

export type RegistrySource = 'vies' | 'vies_cache' | 'none';
export type RegistryStatus = 'valid' | 'invalid' | 'unavailable' | 'skipped' | 'not_supported';

export interface RegistryResult {
  source: RegistrySource;
  status: RegistryStatus;
  name?: string;
  address?: string;
  requestDate?: string;
  consultationNumber?: string;
  errorCode?: string;
  transport?: 'rest' | 'soap';
  latencyMs?: number;
}

export interface VerificationResult {
  verdict: Verdict;
  /** True when a registry lookup was wanted but we degraded to checksum-only. */
  fallback: boolean;
  fallbackReason?: string;
  confidence: 'high' | 'medium' | 'low' | 'none';
  validation: TaxIdValidation;
  registry: RegistryResult;
  checkedAt: string;
}

export interface VerifyOptions {
  /** Query VIES for EU/XI numbers (default true). */
  liveLookup?: boolean;
  /** Hard time budget for the registry call, e.g. to honour a 5 s workflow SLA. */
  budgetMs?: number;
  /** Bypass the registry cache. */
  fresh?: boolean;
}

export interface TaxVerificationServiceOptions {
  vies: ViesClient | null;
  cache: ICacheStore;
  now?: () => Date;
  validTtlSeconds?: number;
  invalidTtlSeconds?: number;
}

export class TaxVerificationService {
  private readonly now: () => Date;
  private readonly validTtl: number;
  private readonly invalidTtl: number;

  constructor(private readonly opts: TaxVerificationServiceOptions) {
    this.now = opts.now ?? (() => new Date());
    this.validTtl = opts.validTtlSeconds ?? 24 * 3600;
    this.invalidTtl = opts.invalidTtlSeconds ?? 6 * 3600;
  }

  /** Throws `TaxIdInputError` when the jurisdiction cannot be determined. */
  async verify(taxId: string, country?: string | null, options: VerifyOptions = {}): Promise<VerificationResult> {
    const validation = validateTaxId(taxId, country);
    const checkedAt = this.now().toISOString();
    const wantLive = options.liveLookup !== false;

    if (!validation.valid) {
      return {
        verdict: 'invalid',
        fallback: false,
        confidence: 'high',
        validation,
        registry: { source: 'none', status: validation.viesEligible ? 'skipped' : 'not_supported' },
        checkedAt,
      };
    }

    const offlineVerdict: Verdict = validation.checksum === 'valid' ? 'checksum_valid' : 'format_valid';
    const offlineConfidence = validation.checksum === 'valid' ? 'medium' : 'low';

    if (!validation.viesEligible) {
      return { verdict: offlineVerdict, fallback: false, confidence: offlineConfidence, validation, registry: { source: 'none', status: 'not_supported' }, checkedAt };
    }
    if (!wantLive) {
      return { verdict: offlineVerdict, fallback: false, confidence: offlineConfidence, validation, registry: { source: 'none', status: 'skipped' }, checkedAt };
    }
    if (!this.opts.vies) {
      return {
        verdict: offlineVerdict,
        fallback: true,
        fallbackReason: 'Registry lookups are disabled on this deployment (VIES_MODE=offline)',
        confidence: offlineConfidence,
        validation,
        registry: { source: 'none', status: 'unavailable', errorCode: 'OFFLINE_MODE' },
        checkedAt,
      };
    }

    const viesCountry = validation.formatted.slice(0, 2);
    const viesNumber = validation.normalized;
    const cacheKey = `vies:${viesCountry}${viesNumber}`;

    if (!options.fresh) {
      const cached = await this.opts.cache.get<ViesResult>(cacheKey).catch(() => null);
      if (cached) return this.fromRegistry(validation, cached, 'vies_cache', checkedAt);
    }

    const res = await this.opts.vies.check(viesCountry, viesNumber, options.budgetMs);
    if (res.status !== 'unavailable') {
      await this.opts.cache.set(cacheKey, res, res.status === 'valid' ? this.validTtl : this.invalidTtl).catch(() => undefined);
    }
    return this.fromRegistry(validation, res, 'vies', checkedAt);
  }

  private fromRegistry(validation: TaxIdValidation, res: ViesResult, source: RegistrySource, checkedAt: string): VerificationResult {
    const registry: RegistryResult = {
      source,
      status: res.status,
      ...(res.name ? { name: res.name } : {}),
      ...(res.address ? { address: res.address } : {}),
      ...(res.requestDate ? { requestDate: res.requestDate } : {}),
      ...(res.consultationNumber ? { consultationNumber: res.consultationNumber } : {}),
      ...(res.errorCode ? { errorCode: res.errorCode } : {}),
      transport: res.transport,
      latencyMs: source === 'vies' ? res.latencyMs : 0,
    };
    if (res.status === 'valid') return { verdict: 'registry_verified', fallback: false, confidence: 'high', validation, registry, checkedAt };
    if (res.status === 'invalid') return { verdict: 'registry_not_found', fallback: false, confidence: 'high', validation, registry, checkedAt };
    return {
      verdict: validation.checksum === 'valid' ? 'checksum_valid' : 'format_valid',
      fallback: true,
      fallbackReason: `VIES unavailable (${res.errorCode ?? 'unknown'}); result is based on the offline checksum`,
      confidence: 'medium',
      validation,
      registry,
      checkedAt,
    };
  }
}

/** One-line human summary, used by CRM write-backs and the certificate. */
export function summarize(r: VerificationResult): string {
  const id = r.validation.formatted;
  switch (r.verdict) {
    case 'registry_verified':
      return `${id} is active in EU VIES${r.registry.name ? ` (${r.registry.name})` : ''}.`;
    case 'registry_not_found':
      return `${id} passes its checksum but is NOT active in EU VIES.`;
    case 'checksum_valid':
      return `${id} has a valid ${r.validation.schemeName} structure and check digit${r.fallback ? ' (registry unavailable — offline fallback)' : ''}.`;
    case 'format_valid':
      return `${id} has a valid ${r.validation.schemeName} structure (no public check digit for this scheme).`;
    default:
      return `${r.validation.input} is not a valid ${r.validation.schemeName}: ${r.validation.reason ?? 'check failed'}.`;
  }
}
