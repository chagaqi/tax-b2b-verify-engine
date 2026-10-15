import type { Verdict } from '../verify/service.js';

/** The exact object that is canonicalised, signed and embedded in the PDF. */
export interface CertificatePayload {
  v: 1;
  id: string;
  issuedAt: string;
  issuer: { name: string; url: string; keyId: string };
  tenant: { id: string; name?: string };
  sample: boolean;
  subject: {
    taxId: string;
    input: string;
    jurisdiction: string;
    country: string;
    countryName: string;
    scheme: string;
    schemeName: string;
    companyName?: string;
    address?: string;
    domain?: string;
  };
  result: {
    verdict: Verdict;
    summary: string;
    confidence: string;
    syntaxValid: boolean;
    checksum: string;
    algorithm: string;
    checkedAt: string;
    fallback: boolean;
    fallbackReason?: string;
    registry: {
      source: string;
      status: string;
      name?: string;
      address?: string;
      requestDate?: string;
      consultationNumber?: string;
      errorCode?: string;
    };
  };
  enrichment?: {
    domain: string;
    classification: string;
    securityGrade: string;
    securityScore: number;
    riskLevel: string;
    mailProvider?: string;
  };
  verifyUrl: string;
}

export interface CertificateRecord {
  payload: CertificatePayload;
  signature: string;
  keyId: string;
  payloadSha256: string;
  pdfSha256: string;
  tenantId: string;
}
