import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import jsQR from 'jsqr';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { qrSvgPath, toWinAnsi } from '../src/certificates/pdf.js';
import { CertificateService } from '../src/certificates/service.js';
import { CertificateSigner } from '../src/certificates/signer.js';
import { canonicalJson } from '../src/lib/crypto.js';
import { InMemoryDocumentStore } from '../src/stores/memory.js';
import { validateTaxId } from '../src/taxid/index.js';
import type { VerificationResult } from '../src/verify/service.js';
import { testSigner } from './helpers.js';

function verification(taxId = 'IE6388047V', over: Partial<VerificationResult> = {}): VerificationResult {
  return {
    verdict: 'registry_verified',
    fallback: false,
    confidence: 'high',
    validation: validateTaxId(taxId),
    registry: { source: 'vies', status: 'valid', name: 'GOOGLE IRELAND LIMITED', address: 'GORDON HOUSE, DUBLIN 4', requestDate: '2026-10-15T10:00:00Z', consultationNumber: 'WAPI-1', transport: 'rest', latencyMs: 120 },
    checkedAt: '2026-10-15T10:00:00.000Z',
    ...over,
  };
}

async function service(now = () => new Date('2026-10-15T12:00:00Z'), signer?: CertificateSigner) {
  const documents = new InMemoryDocumentStore();
  return {
    documents,
    svc: new CertificateService({ signer: signer ?? (await testSigner()), documents, appSecret: 'k'.repeat(40), publicBaseUrl: 'https://verify.test/', now }),
  };
}

// WinAnsi = Latin-1 except 0x80–0x9F (Node's TextDecoder treats windows-1252 as Latin-1 there).
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const winAnsi = { decode: (b: Uint8Array) => Array.from(b, (c) => (c >= 0x80 && c <= 0x9f ? CP1252_HIGH[c - 0x80] : String.fromCharCode(c))).join('') };

/** Decoded content + embedded-file streams of a PDF (standard-font text is WinAnsi-encoded). */
async function inspect(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let text = '';
  let attachment: string | undefined;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const data = decodePDFRawStream(obj).decode();
    const latin1 = Buffer.from(data).toString('latin1');
    if (obj.dict.get(PDFName.of('Type')) === PDFName.of('EmbeddedFile')) attachment = Buffer.from(data).toString('utf8');
    for (const m of latin1.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) text += winAnsi.decode(Buffer.from(m[1]!, 'hex')) + '\n';
  }
  return { doc, text, attachment };
}

/** Rasterise the QR SVG path (runs of "M x y h n v1 h -n Z") and decode it. */
function decodeQr(path: string, size: number): string | null {
  const px = 4;
  const quiet = 4;
  const dim = (size + quiet * 2) * px;
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (const m of path.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
    const [x, y, run] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let dx = 0; dx < run * px; dx++) {
      for (let dy = 0; dy < px; dy++) {
        const i = (((y + quiet) * px + dy) * dim + (x + quiet) * px + dx) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
      }
    }
  }
  return jsQR(rgba, dim, dim)?.data ?? null;
}

describe('audit certificate PDF', () => {
  it('renders a single A4 page with metadata and the certificate text', async () => {
    const { svc } = await service();
    const cert = await svc.issue({ verification: verification(), tenantId: 'tnt_1', tenantName: 'Acme GmbH', domain: 'google.ie' });
    const { pdf } = (await svc.getRecord(cert.id))!;
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
    const { doc, text } = await inspect(pdf);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
    expect(doc.getTitle()).toBe(`Tax/VAT Compliance Audit Certificate ${cert.id}`);
    expect(doc.getKeywords()).toContain('registry_verified');
    expect(doc.getCreationDate()?.toISOString()).toBe('2026-10-15T12:00:00.000Z');
    for (const s of ['TAX / VAT COMPLIANCE AUDIT CERTIFICATE', 'VERIFIED — ACTIVE IN EU VIES', `Certificate ${cert.id}`, 'GOOGLE IRELAND LIMITED', 'WAPI-1', 'Acme GmbH (tnt_1)', cert.signature.slice(0, 20)]) {
      expect(text).toContain(s);
    }
    expect(cert.bytes).toBe(pdf.byteLength);
    expect(cert.bytes).toBeLessThan(40_000);
  });

  it('embeds the signed payload, verifiable offline with node:crypto and the published PEM', async () => {
    const signer = await testSigner();
    const { svc } = await service();
    const cert = await svc.issue({ verification: verification(), tenantId: 'tnt_1' });
    const { attachment } = await inspect((await svc.getRecord(cert.id))!.pdf);
    const embedded = JSON.parse(attachment!) as { payload: unknown; signature: string; keyId: string };
    expect(embedded.keyId).toBe(signer.keyId);
    const ok = nodeVerify(null, Buffer.from(canonicalJson(embedded.payload)), createPublicKey(signer.publicPem()), Buffer.from(embedded.signature, 'base64url'));
    expect(ok).toBe(true);
    const tampered = { ...(embedded.payload as object), issuedAt: '2020-01-01T00:00:00.000Z' };
    expect(nodeVerify(null, Buffer.from(canonicalJson(tampered)), createPublicKey(signer.publicPem()), Buffer.from(embedded.signature, 'base64url'))).toBe(false);
  });

  it('draws a scannable vector QR code that points at the verify URL', async () => {
    const url = 'https://verify.test/v1/certificates/tvc_AAAAAAAAAAAAAAAAAAAAAA/verify';
    const { path, size } = qrSvgPath(url);
    expect(path).toMatch(/^M\d+ \d+h\d+v1h-\d+Z/);
    expect(decodeQr(path, size)).toBe(url);
  });

  it('watermarks playground samples and documents fallbacks', async () => {
    const { svc } = await service();
    const v = verification('DE136695976', {
      verdict: 'checksum_valid', fallback: true, fallbackReason: 'VIES unavailable (MS_UNAVAILABLE)', confidence: 'medium',
      registry: { source: 'vies', status: 'unavailable', errorCode: 'MS_UNAVAILABLE' },
    });
    const cert = await svc.issue({ verification: v, tenantId: 'playground', sample: true });
    const { text } = await inspect((await svc.getRecord(cert.id))!.pdf);
    expect(text).toContain('SAMPLE - NOT FOR COMPLIANCE USE');
    expect(text).toContain('VALID — STRUCTURE & CHECK DIGIT');
    expect(text).toContain('VIES unavailable (MS_UNAVAILABLE)');
  });

  it('renders non-Latin registry names via transliteration', async () => {
    expect(toWinAnsi('ΕΛΛΗΝΙΚΑ ΠΕΤΡΕΛΑΙΑ Α.Ε.')).toBe('ELLINIKA PETRELAIA A.E.');
    expect(toWinAnsi('Łódź — Straße 東京')).toBe('Lódz — Straße ??');
    const { svc } = await service();
    const v = verification('EL094259216', { registry: { source: 'vies', status: 'valid', name: 'ΕΛΛΗΝΙΚΑ ΠΕΤΡΕΛΑΙΑ' } });
    const cert = await svc.issue({ verification: v, tenantId: 't' });
    expect((await inspect((await svc.getRecord(cert.id))!.pdf)).text).toContain('ELLINIKA PETRELAIA');
  });
});

describe('certificate service', () => {
  it('verifies authenticity and detects tampered PDFs', async () => {
    const { svc, documents } = await service();
    const cert = await svc.issue({ verification: verification(), tenantId: 't' });
    expect(await svc.verify(cert.id)).toMatchObject({ authentic: true, pdfIntact: true, payloadSha256: cert.payloadSha256 });
    const doc = (await documents.get(cert.id))!;
    const bytes = new Uint8Array(doc.bytes);
    const i = bytes.length - 20;
    bytes[i] = bytes[i]! ^ 0xff;
    await documents.put({ ...doc, bytes }, 60);
    expect(await svc.verify(cert.id)).toMatchObject({ authentic: true, pdfIntact: false });
  });

  it('rejects certificates signed by a different key', async () => {
    const { svc, documents } = await service();
    const cert = await svc.issue({ verification: verification(), tenantId: 't' });
    const other = new CertificateService({ signer: await CertificateSigner.ephemeral(), documents, appSecret: 'k'.repeat(40), publicBaseUrl: 'https://verify.test' });
    expect((await other.verify(cert.id))?.authentic).toBe(false);
  });

  it('issues HMAC-signed, expiring download links', async () => {
    let now = new Date('2026-10-15T12:00:00Z');
    const { svc } = await service(() => now);
    const cert = await svc.issue({ verification: verification(), tenantId: 't' });
    const u = new URL(cert.pdfUrl);
    expect(u.pathname).toBe(`/v1/certificates/${cert.id}.pdf`);
    const [exp, sig] = [u.searchParams.get('exp')!, u.searchParams.get('sig')!];
    expect(await svc.checkLink(cert.id, exp, sig)).toBe('ok');
    expect(await svc.checkLink(cert.id, String(Number(exp) + 1), sig)).toBe('bad_signature');
    expect(await svc.checkLink('tvc_BBBBBBBBBBBBBBBBBBBBBB', exp, sig)).toBe('bad_signature');
    now = new Date('2026-10-30T12:00:00Z');
    expect(await svc.checkLink(cert.id, exp, sig)).toBe('expired');
  });

  it('ignores malformed ids', async () => {
    const { svc } = await service();
    expect(await svc.getRecord('../../etc/passwd')).toBeNull();
    expect(await svc.verify('tvc_short')).toBeNull();
  });
});

describe('CertificateSigner', () => {
  it('round-trips a PKCS#8 key and publishes a matching JWK', async () => {
    const { generateEd25519 } = await import('../src/lib/crypto.js');
    const { pkcs8 } = await generateEd25519();
    const a = await CertificateSigner.fromPkcs8(pkcs8);
    const b = await CertificateSigner.fromPkcs8(pkcs8);
    expect(a.keyId).toBe(b.keyId);
    expect(a.ephemeral).toBe(false);
    const signed = await a.sign({ hello: 'world', n: 1 });
    expect(await b.verify({ n: 1, hello: 'world' }, signed.signature)).toBe(true);
    expect(await b.verify({ n: 2, hello: 'world' }, signed.signature)).toBe(false);
    expect(a.publicJwk()).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: a.keyId });
    expect(a.publicPem()).toMatch(/^-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA/);
  });
});
