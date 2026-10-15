import { hmacSha256, randomToken, sha256Hex, timingSafeEqual, toBase64Url } from '../lib/crypto.js';
import type { EnrichmentResult } from '../enrich/service.js';
import type { IDocumentStore } from '../stores/types.js';
import { summarize, type VerificationResult } from '../verify/service.js';
import { renderCertificatePdf } from './pdf.js';
import type { CertificateSigner } from './signer.js';
import type { CertificatePayload, CertificateRecord } from './types.js';

export interface IssueInput {
  verification: VerificationResult;
  tenantId: string;
  tenantName?: string;
  companyName?: string;
  domain?: string;
  enrichment?: EnrichmentResult;
  sample?: boolean;
}

export interface IssuedCertificate {
  id: string;
  pdfUrl: string;
  pdfUrlExpiresAt: string;
  verifyUrl: string;
  issuedAt: string;
  payloadSha256: string;
  pdfSha256: string;
  signature: string;
  keyId: string;
  bytes: number;
}

export interface CertificateVerification {
  id: string;
  authentic: boolean;
  /** PDF bytes still match the hash recorded at issue time. */
  pdfIntact: boolean;
  keyId: string;
  issuedAt: string;
  payloadSha256: string;
  pdfSha256: string;
  payload: CertificatePayload;
}

export interface CertificateServiceOptions {
  signer: CertificateSigner;
  documents: IDocumentStore;
  appSecret: string;
  publicBaseUrl: string;
  issuerName?: string;
  now?: () => Date;
  retentionSeconds?: number;
  linkTtlSeconds?: number;
}

export const CERT_ID_RE = /^tvc_[A-Za-z0-9_-]{22}$/;

export class CertificateService {
  private readonly now: () => Date;
  readonly retentionSeconds: number;
  readonly linkTtlSeconds: number;

  constructor(private readonly o: CertificateServiceOptions) {
    this.now = o.now ?? (() => new Date());
    this.retentionSeconds = o.retentionSeconds ?? 90 * 86_400;
    this.linkTtlSeconds = o.linkTtlSeconds ?? 7 * 86_400;
  }

  private base(): string {
    return this.o.publicBaseUrl.replace(/\/+$/, '');
  }

  verifyUrl(id: string): string {
    return `${this.base()}/v1/certificates/${id}/verify`;
  }

  async issue(input: IssueInput): Promise<IssuedCertificate> {
    const id = `tvc_${randomToken(16)}`;
    const issuedAt = this.now().toISOString();
    const v = input.verification;
    const reg = v.registry;
    const companyName = input.companyName ?? reg.name ?? input.enrichment?.company?.legalName ?? input.enrichment?.company?.name;
    const domain = input.domain ?? input.enrichment?.domain;

    const payload: CertificatePayload = {
      v: 1,
      id,
      issuedAt,
      issuer: { name: this.o.issuerName ?? 'Tax B2B Verify Engine', url: this.base(), keyId: this.o.signer.keyId },
      tenant: { id: input.tenantId, ...(input.tenantName ? { name: input.tenantName } : {}) },
      sample: Boolean(input.sample),
      subject: {
        taxId: v.validation.formatted,
        input: v.validation.input,
        jurisdiction: v.validation.jurisdiction,
        country: v.validation.country,
        countryName: v.validation.countryName,
        scheme: v.validation.scheme,
        schemeName: v.validation.schemeName,
        ...(companyName ? { companyName } : {}),
        ...(reg.address ? { address: reg.address } : {}),
        ...(domain ? { domain } : {}),
      },
      result: {
        verdict: v.verdict,
        summary: summarize(v),
        confidence: v.confidence,
        syntaxValid: v.validation.syntaxValid,
        checksum: v.validation.checksum,
        algorithm: v.validation.algorithm,
        checkedAt: v.checkedAt,
        fallback: v.fallback,
        ...(v.fallbackReason ? { fallbackReason: v.fallbackReason } : {}),
        registry: {
          source: reg.source,
          status: reg.status,
          ...(reg.name ? { name: reg.name } : {}),
          ...(reg.address ? { address: reg.address } : {}),
          ...(reg.requestDate ? { requestDate: reg.requestDate } : {}),
          ...(reg.consultationNumber ? { consultationNumber: reg.consultationNumber } : {}),
          ...(reg.errorCode ? { errorCode: reg.errorCode } : {}),
        },
      },
      ...(input.enrichment
        ? {
            enrichment: {
              domain: input.enrichment.domain,
              classification: input.enrichment.classification,
              securityGrade: input.enrichment.security.grade,
              securityScore: input.enrichment.security.score,
              riskLevel: input.enrichment.risk.level,
              ...(input.enrichment.dns.mailProvider ? { mailProvider: input.enrichment.dns.mailProvider } : {}),
            },
          }
        : {}),
      verifyUrl: this.verifyUrl(id),
    };

    const signed = await this.o.signer.sign(payload);
    const pdf = await renderCertificatePdf(payload, signed);
    const pdfSha256 = await sha256Hex(pdf);
    const record: CertificateRecord = {
      payload,
      signature: signed.signature,
      keyId: signed.keyId,
      payloadSha256: signed.payloadSha256,
      pdfSha256,
      tenantId: input.tenantId,
    };
    await this.o.documents.put(
      { id, contentType: 'application/pdf', bytes: pdf, metadata: record as unknown as Record<string, unknown>, createdAt: issuedAt },
      this.retentionSeconds,
    );
    const link = await this.signedPdfUrl(id);
    return {
      id,
      pdfUrl: link.url,
      pdfUrlExpiresAt: link.expiresAt,
      verifyUrl: payload.verifyUrl,
      issuedAt,
      payloadSha256: signed.payloadSha256,
      pdfSha256,
      signature: signed.signature,
      keyId: signed.keyId,
      bytes: pdf.byteLength,
    };
  }

  private async linkSig(id: string, exp: number): Promise<string> {
    return toBase64Url(await hmacSha256(this.o.appSecret, `cert-link:${id}:${exp}`)).slice(0, 32);
  }

  /** Time-limited, HMAC-signed download link (no API key needed to follow it). */
  async signedPdfUrl(id: string, ttlSeconds = this.linkTtlSeconds): Promise<{ url: string; expiresAt: string }> {
    const exp = Math.floor(this.now().getTime() / 1000) + ttlSeconds;
    const sig = await this.linkSig(id, exp);
    return { url: `${this.base()}/v1/certificates/${id}.pdf?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async checkLink(id: string, exp: string | undefined, sig: string | undefined): Promise<'ok' | 'expired' | 'bad_signature'> {
    const e = Number(exp);
    if (!exp || !sig || !Number.isInteger(e)) return 'bad_signature';
    if (!timingSafeEqual(await this.linkSig(id, e), sig)) return 'bad_signature';
    if (e * 1000 < this.now().getTime()) return 'expired';
    return 'ok';
  }

  async getRecord(id: string): Promise<{ record: CertificateRecord; pdf: Uint8Array } | null> {
    if (!CERT_ID_RE.test(id)) return null;
    const doc = await this.o.documents.get(id);
    if (!doc) return null;
    return { record: doc.metadata as unknown as CertificateRecord, pdf: doc.bytes };
  }

  async verify(id: string): Promise<CertificateVerification | null> {
    const found = await this.getRecord(id);
    if (!found) return null;
    const { record, pdf } = found;
    const authentic = record.keyId === this.o.signer.keyId && (await this.o.signer.verify(record.payload, record.signature));
    return {
      id,
      authentic,
      pdfIntact: (await sha256Hex(pdf)) === record.pdfSha256,
      keyId: record.keyId,
      issuedAt: record.payload.issuedAt,
      payloadSha256: record.payloadSha256,
      pdfSha256: record.pdfSha256,
      payload: record.payload,
    };
  }
}
