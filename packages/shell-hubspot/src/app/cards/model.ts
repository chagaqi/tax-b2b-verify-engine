/** Pure helpers for the CRM card (kept free of SDK imports for unit testing). */

export const API_BASE = 'https://verify.taxb2b.app';

/** Company/contact properties the card reads. Custom tax fields vary by portal, so we try several. */
export const TAX_PROPERTIES = ['vat_number', 'vat_id', 'tax_id', 'tax_number', 'company_tax_id'] as const;
export const CARD_PROPERTIES = ['name', 'domain', 'website', 'email', 'country', ...TAX_PROPERTIES, 'tbve_tax_id_status', 'tbve_tax_id_checked_at'];

export type Verdict = 'registry_verified' | 'registry_not_found' | 'checksum_valid' | 'format_valid' | 'invalid';
export type TagVariant = 'success' | 'danger' | 'warning' | 'info' | 'default';

export interface CardResult {
  verdict: Verdict;
  valid: boolean;
  summary: string;
  checkedAt: string;
  fallback: boolean;
  taxId: { formatted: string; countryName: string; schemeName: string };
  registry: { status: string; name?: string; address?: string; consultationNumber?: string };
  certificate?: { pdfUrl: string; verifyUrl: string };
  enrichment?: { domain: string; classification: string; security: { grade: string; score: number }; risk: { level: string; reasons: string[] } };
  writeback?: 'written' | 'skipped' | 'failed';
}

export function firstTaxId(props: Record<string, string | null | undefined>): string {
  for (const k of TAX_PROPERTIES) {
    const v = props[k]?.trim();
    if (v) return v;
  }
  return '';
}

/** Prefer the domain property; fall back to website, then the contact's email. */
export function domainOf(props: Record<string, string | null | undefined>): string | undefined {
  const raw = props.domain || props.website || (props.email?.includes('@') ? props.email.split('@').pop() : '');
  if (!raw) return undefined;
  return raw.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0]!.toLowerCase() || undefined;
}

/** HubSpot objectTypeId → v3 object type name. */
export function objectTypeName(objectTypeId: string): 'companies' | 'contacts' | string {
  return objectTypeId === '0-2' ? 'companies' : objectTypeId === '0-1' ? 'contacts' : objectTypeId;
}

export const VERDICT_TAG: Record<Verdict, { label: string; variant: TagVariant }> = {
  registry_verified: { label: 'Verified in EU VIES', variant: 'success' },
  registry_not_found: { label: 'Not registered', variant: 'danger' },
  checksum_valid: { label: 'Valid check digit', variant: 'info' },
  format_valid: { label: 'Valid format', variant: 'warning' },
  invalid: { label: 'Invalid', variant: 'danger' },
};
