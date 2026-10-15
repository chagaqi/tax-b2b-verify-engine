import type { CertificateVerification } from '../certificates/service.js';
import { BASE_CSS, escapeHtml } from './html.js';

const shell = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${escapeHtml(title)}</title><style>${BASE_CSS}</style></head><body><main>${body}</main></body></html>`;

/** Landing page for the certificate QR code. */
export function verifyPageHtml(v: CertificateVerification | null, id: string): string {
  if (!v) {
    return shell('Certificate not found', `<h1>Certificate not found</h1><p class="muted">No certificate <code>${escapeHtml(id)}</code> exists, or its retention period has elapsed.</p>`);
  }
  const p = v.payload;
  const genuine = v.authentic && v.pdfIntact;
  const rows: [string, unknown][] = [
    ['Tax identifier', p.subject.taxId],
    ['Jurisdiction', `${p.subject.countryName} — ${p.subject.schemeName}`],
    ['Company', p.subject.companyName],
    ['Result', p.result.summary],
    ['Checked', p.result.checkedAt],
    ['Registry', p.result.registry.source === 'none' ? 'not consulted' : `EU VIES — ${p.result.registry.status}`],
    ['Consultation no.', p.result.registry.consultationNumber],
    ['Issued', v.issuedAt],
    ['Issuer key', `Ed25519 ${v.keyId}`],
    ['Payload SHA-256', v.payloadSha256],
  ];
  const dl = rows
    .filter(([, val]) => val !== undefined && val !== '')
    .map(([k, val]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(val)}</dd>`)
    .join('');
  return shell(
    'Certificate verification',
    `<h1>Certificate verification</h1><p class="muted"><code>${escapeHtml(v.id)}</code></p>` +
      `<div class="card"><span class="badge ${genuine ? 'ok' : 'bad'}">${genuine ? 'Authentic — signature valid' : 'NOT authentic'}</span>` +
      (p.sample ? ' <span class="badge warn">Sample (playground)</span>' : '') +
      `<dl>${dl}</dl></div>`,
  );
}

export function resultPageHtml(title: string, message: string, ok: boolean): string {
  return shell(title, `<div class="card"><span class="badge ${ok ? 'ok' : 'bad'}">${ok ? 'Done' : 'Error'}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>`);
}
