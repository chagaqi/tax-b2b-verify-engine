import { EU_VAT_CODES, GSTIN_RE, RULES, RULES_BY_CODE, clean, type ChecksumStatus, type TaxIdRule } from './rules.js';

export { RULES, RULES_BY_CODE, type TaxIdRule, type ChecksumStatus } from './rules.js';

export interface TaxIdValidation {
  input: string;
  /** Jurisdiction key (ISO alpha-2, or XI for Northern Ireland). */
  jurisdiction: string;
  country: string;
  countryName: string;
  scheme: string;
  schemeName: string;
  /** Compact national number without prefix or separators. */
  normalized: string;
  /** Canonical display form (e.g. `EL094259216`, `04-3341285`). */
  formatted: string;
  syntaxValid: boolean;
  checksum: ChecksumStatus;
  algorithm: string;
  /** `syntaxValid && checksum !== 'invalid'` */
  valid: boolean;
  viesEligible: boolean;
  reason?: string;
  details?: Record<string, string>;
}

export class TaxIdInputError extends Error {
  constructor(
    message: string,
    readonly code: 'unknown_country' | 'country_required' | 'empty',
  ) {
    super(message);
    this.name = 'TaxIdInputError';
  }
}

const COUNTRY_ALIASES: Record<string, string> = { EL: 'GR', UK: 'GB' };

/**
 * Pick the rule for an input. An explicit country wins; otherwise the
 * jurisdiction is inferred from a VAT prefix (`DE…`, `EL…`, `XI…`, `CHE…`,
 * `NO…MVA`) or from the unmistakable GSTIN shape.
 */
export function resolveRule(cleaned: string, country?: string | null): TaxIdRule {
  if (country) {
    const c = country.trim().toUpperCase();
    // A Northern Ireland number keeps its XI prefix even when the caller says GB.
    if ((c === 'GB' || c === 'UK' || c === 'XI') && cleaned.startsWith('XI')) return RULES_BY_CODE.get('XI')!;
    const rule = RULES_BY_CODE.get(COUNTRY_ALIASES[c] ?? c);
    if (!rule) throw new TaxIdInputError(`Unsupported country "${country}"`, 'unknown_country');
    return rule;
  }
  if (cleaned.startsWith('CHE')) return RULES_BY_CODE.get('CH')!;
  if (/^NO\d{9}(MVA)?$/.test(cleaned)) return RULES_BY_CODE.get('NO')!;
  if (GSTIN_RE.test(cleaned)) return RULES_BY_CODE.get('IN')!;
  const two = cleaned.slice(0, 2);
  if (two === 'EL' || (two === 'GR' && /^GR\d{8,9}$/.test(cleaned))) return RULES_BY_CODE.get('GR')!;
  if (two === 'XI') return RULES_BY_CODE.get('XI')!;
  if (two === 'GB') return RULES_BY_CODE.get('GB')!;
  if (EU_VAT_CODES.has(two) && /^[A-Z]{2}[0-9A-Z+*]/.test(cleaned)) return RULES_BY_CODE.get(two)!;
  throw new TaxIdInputError(
    'Cannot infer the jurisdiction from this number — pass `country` (ISO 3166-1 alpha-2).',
    'country_required',
  );
}

export function validateTaxId(input: string, country?: string | null): TaxIdValidation {
  const cleaned = clean(input ?? '');
  if (!cleaned) throw new TaxIdInputError('Tax ID is empty', 'empty');
  const rule = resolveRule(cleaned, country);
  const normalized = rule.compact(cleaned);
  const res = rule.check(normalized);
  const syntaxValid = res.syntax;
  const valid = syntaxValid && res.checksum !== 'invalid';
  const formatted = valid && rule.format ? rule.format(normalized) : `${rule.prefix}${normalized}`;
  return {
    input,
    jurisdiction: rule.code,
    country: rule.country,
    countryName: rule.countryName,
    scheme: rule.scheme,
    schemeName: rule.schemeName,
    normalized,
    formatted,
    syntaxValid,
    checksum: res.checksum,
    algorithm: rule.algorithm,
    valid,
    viesEligible: rule.vies,
    ...(res.reason ? { reason: res.reason } : {}),
    ...(res.details ? { details: res.details } : {}),
  };
}

export interface JurisdictionInfo {
  code: string;
  country: string;
  countryName: string;
  scheme: string;
  schemeName: string;
  algorithm: string;
  vies: boolean;
  example: string;
}

export function listJurisdictions(): JurisdictionInfo[] {
  return RULES.map(({ code, country, countryName, scheme, schemeName, algorithm, vies, example }) => ({
    code, country, countryName, scheme, schemeName, algorithm, vies, example,
  }));
}
