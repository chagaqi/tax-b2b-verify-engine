/** Pure helpers shared by the view and its tests (no SDK imports). */

export type Verdict = 'registry_verified' | 'registry_not_found' | 'checksum_valid' | 'format_valid' | 'invalid';
export type BadgeTone = 'positive' | 'negative' | 'warning' | 'info' | 'neutral';

export interface StripeTaxId {
  id: string;
  type: string;
  value: string;
  country?: string | null;
}

export interface StripeCustomer {
  id: string;
  name?: string | null;
  email?: string | null;
  address?: { country?: string | null } | null;
  tax_ids?: { data: StripeTaxId[] } | null;
  metadata?: Record<string, string>;
}

/** Stripe `tax_id.type` → ISO country for schemes whose value carries no prefix. */
const TYPE_COUNTRY: Record<string, string> = {
  gb_vat: 'GB', us_ein: 'US', ca_bn: 'CA', ca_gst_hst: 'CA', au_abn: 'AU', au_arn: 'AU', in_gst: 'IN', ch_vat: 'CH',
  ch_uid: 'CH', no_vat: 'NO', nz_gst: 'NZ', br_cnpj: 'BR', mx_rfc: 'MX', jp_cn: 'JP', jp_trn: 'JP', sg_uen: 'SG',
  sg_gst: 'SG', za_vat: 'ZA', kr_brn: 'KR', ru_inn: 'RU', tr_tin: 'TR', ar_cuit: 'AR', cl_tin: 'CL', co_nit: 'CO',
  sa_vat: 'SA', ae_trn: 'AE',
};

/** Build the verify request for a Stripe tax ID object. EU VAT values carry their own prefix. */
export function toVerifyRequest(taxId: StripeTaxId): { taxId: string; country?: string } {
  if (taxId.type === 'eu_vat' || taxId.type === 'eu_oss_vat') return { taxId: taxId.value };
  const country = TYPE_COUNTRY[taxId.type] ?? taxId.country ?? undefined;
  return country ? { taxId: taxId.value, country } : { taxId: taxId.value };
}

export function domainFromEmail(email?: string | null): string | undefined {
  const at = email?.lastIndexOf('@') ?? -1;
  return at > 0 ? email!.slice(at + 1).toLowerCase() : undefined;
}

export function verdictTone(v: Verdict): BadgeTone {
  switch (v) {
    case 'registry_verified':
      return 'positive';
    case 'checksum_valid':
      return 'info';
    case 'format_valid':
      return 'warning';
    default:
      return 'negative';
  }
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  registry_verified: 'Verified in VIES',
  registry_not_found: 'Not registered',
  checksum_valid: 'Valid check digit',
  format_valid: 'Valid format',
  invalid: 'Invalid',
};

export interface VerifyResult {
  verdict: Verdict;
  valid: boolean;
  summary: string;
  checkedAt: string;
  fallback: boolean;
  taxId: { formatted: string; countryName: string; schemeName: string };
  registry: { status: string; name?: string; address?: string; consultationNumber?: string };
  certificate?: { id: string; pdfUrl: string; verifyUrl: string };
  enrichment?: { domain: string; classification: string; security: { grade: string; score: number }; risk: { level: string } };
}

/** Domain-only checks (no tax ID on the customer) return just `{ enrichment }`. */
export type StripeVerifyResponse = VerifyResult | { enrichment: NonNullable<VerifyResult['enrichment']> };

export function hasVerdict(r: StripeVerifyResponse): r is VerifyResult {
  return 'verdict' in r;
}

/** Customer metadata written by "Save to customer" (Stripe caps values at 500 chars). */
export function metadataFor(r: VerifyResult): Record<string, string> {
  const md: Record<string, string> = {
    tbve_tax_status: r.verdict,
    tbve_tax_id: r.taxId.formatted,
    tbve_checked_at: r.checkedAt,
  };
  if (r.registry.name) md.tbve_registered_name = r.registry.name.slice(0, 500);
  if (r.certificate) md.tbve_certificate = r.certificate.verifyUrl;
  if (r.enrichment) md.tbve_domain_risk = `${r.enrichment.risk.level} (${r.enrichment.security.grade})`;
  return md;
}

/** Stripe's API expects form-encoded `metadata[key]=value`. */
export function metadataForm(md: Record<string, string>): string {
  return Object.entries(md)
    .map(([k, v]) => `${encodeURIComponent(`metadata[${k}]`)}=${encodeURIComponent(v)}`)
    .join('&');
}
