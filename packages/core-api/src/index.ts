export { createApp, type CoreApp } from './app.js';
export { loadConfig, type AppConfig } from './config.js';
export { createServices, consoleLogger, silentLogger, type CoreDeps, type Logger, type Services } from './services.js';
export type { AppEnv } from './types.js';

export { validateTaxId, listJurisdictions, resolveRule, TaxIdInputError, RULES, type TaxIdValidation, type JurisdictionInfo } from './taxid/index.js';
export { TaxVerificationService, summarize, type VerificationResult, type Verdict } from './verify/service.js';
export { ViesClient, VIES_REST_URL, VIES_SOAP_URL, type ViesResult } from './vies/client.js';
export { EnrichmentService, type EnrichmentResult } from './enrich/service.js';
export { DohResolver, StaticResolver, type DnsResolver, type DnsAnswer, type RecordType } from './enrich/dns.js';
export { CertificateSigner } from './certificates/signer.js';
export { CertificateService, type IssuedCertificate } from './certificates/service.js';
export { renderCertificatePdf } from './certificates/pdf.js';
export { runVerification, toResponse, type VerifyResponse } from './operations.js';
export { PLANS, type PlanId, type Plan } from './billing/plans.js';
export { EntitlementService, rateLimit } from './billing/entitlements.js';
export { verifyStripeSignature, signStripePayload, verifyStandardWebhook, signStandardWebhook, verifyHubSpotV3, signHubSpotV3 } from './billing/signatures.js';
export { signHs256, verifyHs256 } from './lib/jwt.js';
export { generateEd25519 } from './lib/crypto.js';
export { ApiError } from './lib/errors.js';
export type { FetchLike } from './lib/http.js';

export * from './stores/types.js';
export { createMemoryStores, InMemoryUsageStore, InMemoryDocumentStore, InMemoryCacheStore, InMemoryTenantStore } from './stores/memory.js';
export { createUpstashStores, UpstashClient, UpstashUsageStore, UpstashDocumentStore, UpstashCacheStore, UpstashTenantStore } from './stores/upstash.js';
