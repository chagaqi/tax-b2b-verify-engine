import { describe, expect, it } from 'vitest';
import { domainFromEmail, hasVerdict, metadataFor, metadataForm, toVerifyRequest, verdictTone, type VerifyResult } from '../src/lib/model';

describe('Stripe tax ID mapping', () => {
  it.each([
    [{ id: 'txi_1', type: 'eu_vat', value: 'DE136695976', country: 'DE' }, { taxId: 'DE136695976' }],
    [{ id: 'txi_2', type: 'gb_vat', value: 'GB980780684', country: 'GB' }, { taxId: 'GB980780684', country: 'GB' }],
    [{ id: 'txi_3', type: 'us_ein', value: '04-3341285', country: 'US' }, { taxId: '04-3341285', country: 'US' }],
    [{ id: 'txi_4', type: 'au_abn', value: '51824753556' }, { taxId: '51824753556', country: 'AU' }],
    [{ id: 'txi_5', type: 'in_gst', value: '27AAPFU0939F1ZV' }, { taxId: '27AAPFU0939F1ZV', country: 'IN' }],
    [{ id: 'txi_6', type: 'unknown_type', value: 'X1', country: 'FR' }, { taxId: 'X1', country: 'FR' }],
    [{ id: 'txi_7', type: 'unknown_type', value: 'X1', country: null }, { taxId: 'X1' }],
  ])('%j → %j', (input, out) => {
    expect(toVerifyRequest(input)).toEqual(out);
  });

  it('extracts the email domain', () => {
    expect(domainFromEmail('Jane@Acme.CO.uk')).toBe('acme.co.uk');
    expect(domainFromEmail(null)).toBeUndefined();
    expect(domainFromEmail('nope')).toBeUndefined();
  });

  it('maps verdicts to Stripe badge tones', () => {
    expect(verdictTone('registry_verified')).toBe('positive');
    expect(verdictTone('checksum_valid')).toBe('info');
    expect(verdictTone('format_valid')).toBe('warning');
    expect(verdictTone('registry_not_found')).toBe('negative');
  });

  it('builds form-encoded customer metadata', () => {
    const r = {
      verdict: 'registry_verified', valid: true, summary: 's', checkedAt: '2026-10-15T00:00:00Z', fallback: false,
      taxId: { formatted: 'IE6388047V', countryName: 'Ireland', schemeName: 'EU VAT' }, registry: { status: 'valid', name: 'GOOGLE IRELAND LIMITED' },
      certificate: { id: 'tvc_x', pdfUrl: 'https://p', verifyUrl: 'https://v' },
    } satisfies VerifyResult;
    expect(hasVerdict(r)).toBe(true);
    expect(metadataFor(r)).toEqual({ tbve_tax_status: 'registry_verified', tbve_tax_id: 'IE6388047V', tbve_checked_at: '2026-10-15T00:00:00Z', tbve_registered_name: 'GOOGLE IRELAND LIMITED', tbve_certificate: 'https://v' });
    expect(metadataForm({ tbve_tax_status: 'ok', tbve_x: 'a b&c' })).toBe('metadata%5Btbve_tax_status%5D=ok&metadata%5Btbve_x%5D=a%20b%26c');
  });
});

describe('stripe-app.json manifest', async () => {
  const manifest = (await import('../stripe-app.json', { with: { type: 'json' } })).default;

  it('targets the customer detail viewport with a default-exported view', async () => {
    expect(manifest.ui_extension.views).toEqual([{ viewport: 'stripe.dashboard.customer.detail', component: 'CustomerVerifyView' }]);
    const mod = await import('node:fs');
    expect(mod.existsSync(new URL('../src/views/CustomerVerifyView.tsx', import.meta.url))).toBe(true);
  });

  it('declares least-privilege permissions with purposes and a scoped CSP', () => {
    expect(manifest.permissions.map((p) => p.permission).sort()).toEqual(['customer_read', 'customer_write']);
    for (const p of manifest.permissions) expect(p.purpose.length).toBeGreaterThan(30);
    for (const src of manifest.ui_extension.content_security_policy['connect-src']) {
      expect(src).toMatch(/^https:\/\/[^/]+\/v1\/integrations\/stripe\/$/);
      expect(src.startsWith(manifest.constants.API_BASE)).toBe(true);
    }
  });

  it('ships a 300×300 PNG icon', async () => {
    const { readFileSync } = await import('node:fs');
    const png = readFileSync(new URL('../icon.png', import.meta.url));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([300, 300]);
  });
});
