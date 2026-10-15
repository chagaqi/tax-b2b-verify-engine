/// <reference path="../types/qrcode-core.d.ts" />
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { create as createQr } from 'qrcode/lib/core/qrcode.js';
import type { Verdict } from '../verify/service.js';
import type { CertificatePayload } from './types.js';

/**
 * Renders the Tax/VAT Compliance Audit Certificate as a single A4 page using
 * only pdf-lib vector primitives (no raster images, no headless browser).
 * The QR code is drawn as an SVG path of merged module runs.
 */

const A4 = { w: 595.28, h: 841.89 };
const M = 48; // page margin

const C = {
  ink: rgb(0.11, 0.13, 0.18),
  muted: rgb(0.42, 0.45, 0.52),
  rule: rgb(0.86, 0.88, 0.91),
  band: rgb(0.07, 0.16, 0.31),
  bandAccent: rgb(0.2, 0.47, 0.87),
  white: rgb(1, 1, 1),
  panel: rgb(0.965, 0.972, 0.984),
};

const VERDICT_STYLE: Record<Verdict, { label: string; color: RGB }> = {
  registry_verified: { label: 'VERIFIED — ACTIVE IN EU VIES', color: rgb(0.05, 0.55, 0.32) },
  registry_not_found: { label: 'NOT ACTIVE IN EU VIES', color: rgb(0.78, 0.16, 0.16) },
  checksum_valid: { label: 'VALID — STRUCTURE & CHECK DIGIT', color: rgb(0.1, 0.42, 0.75) },
  format_valid: { label: 'VALID FORMAT — NO PUBLIC CHECK DIGIT', color: rgb(0.8, 0.52, 0.05) },
  invalid: { label: 'INVALID TAX IDENTIFIER', color: rgb(0.78, 0.16, 0.16) },
};

// WinAnsi (Windows-1252) repertoire used by the standard 14 fonts.
const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const TRANSLIT: Record<string, string> = {
  ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ı: 'i', ħ: 'h', Ħ: 'H', ŀ: 'l', Ŀ: 'L', ø: 'o', Ø: 'O', ß: 'ss', œ: 'oe', Œ: 'OE',
  '‐': '-', '‑': '-', '−': '-', '…': '...', ' ': ' ',
};
const GREEK = 'ΑAΒBΓGΔDΕEΖZΗIΘTΙIΚKΛLΜMΝNΞXΟOΠPΡRΣSΤTΥYΦFΧCΨPΩOαaβbγgδdεeζzηiθtιiκkλlμmνnξxοoπpρrσsςsτtυyφfχcψpωo';
const CYRILLIC = 'АAБBВVГGДDЕEЁEЖZЗZИIЙYКKЛLМMНNОOПPРRСSТTУUФFХHЦCЧCШSЩSЪ\'ЫYЬ\'ЭEЮUЯAаaбbвvгgдdеeёeжzзzиiйyкkлlмmнnоoпpрrсsтtуuфfхhцcчcшsщsъ\'ыyь\'эeюuяa';
for (const src of [GREEK, CYRILLIC]) for (let i = 0; i < src.length; i += 2) TRANSLIT[src[i]!] ??= src[i + 1]!;

const encodable = (ch: string) => {
  const c = ch.codePointAt(0)!;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.has(ch);
};

/** Make arbitrary Unicode printable with a standard font; the signed JSON keeps the original. */
export function toWinAnsi(s: string): string {
  let out = '';
  for (const ch of s.replace(/[\r\n\t]+/g, ' ')) {
    if (encodable(ch)) {
      out += ch;
      continue;
    }
    // Decompose first (ά → α + combining acute), drop the marks, then transliterate what is left.
    const base = TRANSLIT[ch] !== undefined ? ch : ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    for (const b of base || '?') out += encodable(b) ? b : (TRANSLIT[b] ?? '?');
  }
  return out;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number, maxLines = 4): string[] {
  const words = toWinAnsi(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  const push = (l: string) => lines.push(l);
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) push(line);
    // Hard-break tokens (signatures, URLs) wider than the column.
    let rest = w;
    while (font.widthOfTextAtSize(rest, size) > maxWidth) {
      let n = rest.length;
      while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > maxWidth) n--;
      push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    line = rest;
  }
  if (line) push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/.{0,3}$/, '')}...`;
    return kept;
  }
  return lines;
}

/** QR modules → one SVG path with horizontal runs merged (keeps the PDF tiny). */
export function qrSvgPath(text: string): { path: string; size: number } {
  const qr = createQr(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  let d = '';
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!qr.modules.get(y, x)) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < n && qr.modules.get(y, x + run)) run++;
      d += `M${x} ${y}h${run}v1h${-run}Z`;
      x += run;
    }
  }
  return { path: d, size: n };
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

function text(page: PDFPage, s: string, x: number, y: number, font: PDFFont, size: number, color: RGB = C.ink) {
  page.drawText(toWinAnsi(s), { x, y, font, size, color });
}

/** Label/value rows; returns the y below the block. */
function rows(page: PDFPage, f: Fonts, items: [string, string | undefined][], x: number, y: number, width: number): number {
  const labelW = 150;
  for (const [label, value] of items) {
    if (value === undefined || value === '') continue;
    const lines = wrap(value, f.regular, 9.5, width - labelW);
    text(page, label, x, y, f.bold, 8.5, C.muted);
    lines.forEach((l, i) => text(page, l, x + labelW, y - i * 12, f.regular, 9.5));
    y -= Math.max(1, lines.length) * 12 + 5;
  }
  return y;
}

function section(page: PDFPage, f: Fonts, title: string, y: number): number {
  text(page, title.toUpperCase(), M, y, f.bold, 9, C.bandAccent);
  page.drawLine({ start: { x: M, y: y - 5 }, end: { x: A4.w - M, y: y - 5 }, thickness: 0.6, color: C.rule });
  return y - 20;
}

export interface RenderOptions {
  signature: string;
  keyId: string;
  payloadSha256: string;
}

export async function renderCertificatePdf(p: CertificatePayload, sig: RenderOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const issued = new Date(p.issuedAt);
  doc.setTitle(`Tax/VAT Compliance Audit Certificate ${p.id}`);
  doc.setSubject(`Verification of ${p.subject.taxId} (${p.subject.countryName})`);
  doc.setAuthor(p.issuer.name);
  doc.setCreator(p.issuer.name);
  doc.setProducer('tax-b2b-verify-engine (pdf-lib)');
  doc.setKeywords(['tax id', 'vat', 'vies', 'audit certificate', p.subject.jurisdiction, p.result.verdict, p.id]);
  doc.setCreationDate(issued);
  doc.setModificationDate(issued);

  const f: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const page = doc.addPage([A4.w, A4.h]);
  const contentW = A4.w - 2 * M;

  // Header band
  page.drawRectangle({ x: 0, y: A4.h - 120, width: A4.w, height: 120, color: C.band });
  page.drawRectangle({ x: 0, y: A4.h - 124, width: A4.w, height: 4, color: C.bandAccent });
  text(page, 'TAX / VAT COMPLIANCE AUDIT CERTIFICATE', M, A4.h - 58, f.bold, 17, C.white);
  text(page, `Issued by ${p.issuer.name}  ·  ${p.issuer.url.replace(/^https?:\/\//, '')}`, M, A4.h - 78, f.regular, 9.5, rgb(0.78, 0.84, 0.93));
  text(page, `Certificate ${p.id}`, M, A4.h - 96, f.mono, 9, rgb(0.78, 0.84, 0.93));

  // QR code (vector) — top right of the body
  const qrBox = 118;
  const qrX = A4.w - M - qrBox;
  const qrTop = A4.h - 144;
  const { path, size } = qrSvgPath(p.verifyUrl);
  const quiet = 2;
  const scale = qrBox / (size + quiet * 2);
  page.drawRectangle({ x: qrX, y: qrTop - qrBox, width: qrBox, height: qrBox, color: C.white, borderColor: C.rule, borderWidth: 0.6 });
  page.drawSvgPath(path, { x: qrX + quiet * scale, y: qrTop - quiet * scale, scale, color: C.ink });
  text(page, 'Scan to verify', qrX + 28, qrTop - qrBox - 12, f.bold, 8, C.muted);

  // Verdict badge
  const style = VERDICT_STYLE[p.result.verdict];
  let y = A4.h - 160;
  const badgeW = Math.min(contentW - qrBox - 16, f.bold.widthOfTextAtSize(style.label, 12) + 28);
  page.drawRectangle({ x: M, y: y - 8, width: badgeW, height: 26, color: style.color });
  text(page, style.label, M + 14, y + 1, f.bold, 12, C.white);
  y -= 30;
  for (const line of wrap(p.result.summary, f.regular, 10, contentW - qrBox - 16, 3)) {
    text(page, line, M, y, f.regular, 10);
    y -= 13;
  }
  text(page, `Checked ${p.result.checkedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`, M, y - 2, f.regular, 8.5, C.muted);
  y = Math.min(y - 26, qrTop - qrBox - 34);

  y = section(page, f, 'Subject', y);
  y = rows(page, f, [
    ['Tax identifier', p.subject.taxId],
    ['As submitted', p.subject.input],
    ['Jurisdiction', `${p.subject.countryName} (${p.subject.jurisdiction})`],
    ['Scheme', p.subject.schemeName],
    ['Company name', p.subject.companyName],
    ['Address', p.subject.address],
    ['Domain', p.subject.domain],
  ], M, y, contentW);

  y = section(page, f, 'Verification', y - 6);
  const reg = p.result.registry;
  y = rows(page, f, [
    ['Verdict', p.result.verdict.replace(/_/g, ' ')],
    ['Confidence', p.result.confidence],
    ['Structure', p.result.syntaxValid ? 'valid' : 'invalid'],
    ['Check digit', `${p.result.checksum.replace(/_/g, ' ')} — ${p.result.algorithm}`],
    ['Registry', reg.source === 'none' ? `not consulted (${reg.status.replace(/_/g, ' ')})` : `EU VIES — ${reg.status}${reg.source === 'vies_cache' ? ' (cached)' : ''}`],
    ['Registry name', reg.name],
    ['Registry address', reg.address],
    ['Registry request date', reg.requestDate],
    ['Consultation number', reg.consultationNumber],
    ['Registry error', reg.errorCode],
    ['Fallback', p.result.fallback ? p.result.fallbackReason ?? 'offline checksum' : undefined],
  ], M, y, contentW);

  if (p.enrichment) {
    y = section(page, f, 'Domain intelligence', y - 6);
    y = rows(page, f, [
      ['Domain', p.enrichment.domain],
      ['Classification', p.enrichment.classification.replace(/_/g, ' ')],
      ['Email security', `${p.enrichment.securityGrade} (${p.enrichment.securityScore}/100)`],
      ['Mail provider', p.enrichment.mailProvider],
      ['Risk level', p.enrichment.riskLevel],
    ], M, y, contentW);
  }

  // Integrity panel
  y = section(page, f, 'Integrity', y - 6);
  const panelTop = y + 10;
  const sigLines = wrap(sig.signature, f.mono, 7.5, contentW - 170, 3);
  const panelH = 86 + sigLines.length * 9;
  page.drawRectangle({ x: M, y: panelTop - panelH, width: contentW, height: panelH, color: C.panel });
  let iy = panelTop - 16;
  const integrity: [string, string][] = [
    ['Issued (UTC)', p.issuedAt],
    ['Tenant', p.tenant.name ? `${p.tenant.name} (${p.tenant.id})` : p.tenant.id],
    ['Signature algorithm', `Ed25519, key ${sig.keyId}`],
    ['Payload SHA-256', sig.payloadSha256],
  ];
  for (const [label, value] of integrity) {
    text(page, label, M + 10, iy, f.bold, 8, C.muted);
    text(page, value, M + 160, iy, f.mono, 7.5);
    iy -= 13;
  }
  text(page, 'Signature', M + 10, iy, f.bold, 8, C.muted);
  sigLines.forEach((l, i) => text(page, l, M + 160, iy - i * 9, f.mono, 7.5));
  iy -= sigLines.length * 9 + 4;
  for (const l of wrap(`Verify: ${p.verifyUrl}`, f.regular, 8, contentW - 20, 2)) {
    text(page, l, M + 10, iy, f.regular, 8, C.bandAccent);
    iy -= 10;
  }

  // Footer disclaimer
  const disclaimer =
    'This certificate records the outcome of an automated check at the time stated. EU VIES confirms whether a VAT number ' +
    'is valid for intra-community transactions on the request date; check-digit validation confirms structure only and does not ' +
    'prove registration. The signed JSON payload is attached to this PDF (certificate.json) and can be verified offline against ' +
    'the issuer public key. This document is not legal or tax advice.';
  let fy = 64;
  for (const l of wrap(disclaimer, f.regular, 7.5, contentW, 5)) {
    text(page, l, M, fy, f.regular, 7.5, C.muted);
    fy -= 9.5;
  }
  page.drawLine({ start: { x: M, y: 76 }, end: { x: A4.w - M, y: 76 }, thickness: 0.6, color: C.rule });

  if (p.sample) {
    page.drawText('SAMPLE — NOT FOR COMPLIANCE USE'.replace('—', '-'), {
      x: 95, y: 250, size: 38, font: f.bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.16, rotate: degrees(35),
    });
  }

  const json = new TextEncoder().encode(JSON.stringify({ payload: p, signature: sig.signature, keyId: sig.keyId, algorithm: 'Ed25519', payloadSha256: sig.payloadSha256 }, null, 2));
  await doc.attach(json, 'certificate.json', {
    mimeType: 'application/json',
    description: 'Signed certificate payload (canonical JSON signed with Ed25519)',
    creationDate: issued,
    modificationDate: issued,
  });
  return doc.save({ useObjectStreams: true });
}
