# tax-b2b-verify-engine

Tax / VAT ID verification and B2B domain enrichment, delivered as one headless API plus five marketplace apps (Stripe, HubSpot, Pipedrive, monday.com, Make.com). Every check can produce an **Ed25519-signed audit certificate PDF** that third parties can verify offline.

It needs **no paid third-party APIs**. It uses:

- **EU VIES** (the European Commission's free REST + SOAP registry), for EU-27 and Northern Ireland.
- **Check-digit and structure rules** for 49 jurisdictions, cross-validated against [`python-stdnum`](https://arthurdejong.org/python-stdnum/) (1,633 generated vectors, 0 mismatches).
- **DNS** for MX, SPF, DMARC, DKIM, MTA-STS and BIMI, through native Node DNS or DNS-over-HTTPS.
- **RDAP**, routed through IANA's bootstrap registry.
- **The company's own homepage**: JSON-LD, social links and VAT numbers. The fetch goes through an SSRF guard.
- **Built-in lists** of disposable and free-mail providers.

```
packages/
  core-api/        Hono + Zod core: tax IDs, VIES, enrichment, certificates, billing, integrations, playground
  gateway/         Node server → single-file bundle dist/server.mjs (shell pages inlined)
  shell-stripe/    Stripe Dashboard App (stripe.dashboard.customer.detail)
  shell-hubspot/   HubSpot 2025.2 project: CRM card + custom workflow action
  shell-pipedrive/ JSON panels (deal/organization) + custom modal
  shell-monday/    Item View + custom automation action
  shell-makecom/   Make.com custom app (.imljson)
```

## Quick start

```bash
pnpm install
pnpm test          # 389 Vitest tests
pnpm typecheck
pnpm build         # → packages/gateway/dist/server.mjs
node packages/gateway/dist/server.mjs   # http://localhost:8787/playground
```

The bundle depends only on Node built-ins, so you can deploy the one file:

```bash
docker build -t tax-b2b-verify . && docker run -p 8787:8787 --env-file .env tax-b2b-verify
```

Before running in production (`NODE_ENV=production`), the server refuses to start without these:

- `APP_SECRET`: at least 32 characters.
- `CERT_SIGNING_KEY`: generate one with `node dist/server.mjs --generate-signing-key`.

Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for durable storage; without them, storage is in-memory. See [`.env.example`](.env.example) for the full list.

## API

All `/v1/*` endpoints take JSON. API-key endpoints expect a `x-api-key: tbv_live_…` header (`Authorization: Bearer` also works).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/v1/install` | IP rate-limited | Create a tenant and return its API key (once) |
| `POST` | `/v1/verify/tax-id` | API key | Validate, look up in VIES, optionally enrich and certify |
| `POST` | `/v1/enrich/company` | API key | Email/domain classification, security posture, RDAP, homepage metadata |
| `GET` | `/v1/certificates/:id` | API key (owner) | Certificate metadata + a fresh signed PDF link |
| `GET` | `/v1/certificates/:id.pdf?exp&sig` | HMAC-signed link | Download the PDF |
| `GET` | `/v1/certificates/:id/verify` | public | Signature + integrity check (JSON, or HTML for QR scans) |
| `GET` | `/v1/certificates/public-key` | public | Ed25519 key (JWK + PEM) for offline verification |
| `GET` | `/v1/countries` | public | Supported jurisdictions |
| `GET` | `/v1/usage` · `POST /v1/keys/rotate` | API key | Plan, monthly usage, key rotation |
| `POST` | `/v1/webhooks/{stripe,polar,monday}` | provider signature | Billing → plan changes (idempotent) |
| `GET` | `/playground` | IP rate-limited | Interactive demo (sample certificates are watermarked) |
| — | `/v1/integrations/{stripe,hubspot,pipedrive,monday}/…` | platform signatures | Marketplace backends |

```bash
curl -X POST localhost:8787/v1/verify/tax-id -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"taxId":"IE6388047V","certificate":true,"email":"ap@google.ie","enrich":true}'
```

```jsonc
{
  "verdict": "registry_verified",       // see below
  "valid": true,
  "summary": "IE6388047V is active in EU VIES (GOOGLE IRELAND LIMITED).",
  "confidence": "high",
  "fallback": false,
  "taxId":   { "formatted": "IE6388047V", "jurisdiction": "IE", "checksum": "valid", "algorithm": "Weighted MOD 23 letter", ... },
  "registry": { "source": "vies", "status": "valid", "name": "GOOGLE IRELAND LIMITED", "address": "3RD FLOOR, GORDON HOUSE, ..." },
  "certificate": { "id": "tvc_…", "pdfUrl": "…/v1/certificates/tvc_….pdf?exp=…&sig=…", "verifyUrl": "…/verify", ... },
  "enrichment":  { "classification": "corporate", "security": { "grade": "A", ... }, "risk": { "level": "low" } }
}
```

### Verdicts

| Verdict | Meaning | `valid` |
|---|---|---|
| `registry_verified` | EU VIES confirms the number is active | ✅ |
| `registry_not_found` | The check digit passes, but VIES says the number is not active | ❌ |
| `checksum_valid` | Structure and check digit pass. This covers non-EU schemes, and EU numbers when VIES is down (`fallback: true`) | ✅ |
| `format_valid` | Structure passes, but the scheme has no public check digit (US EIN, ZA, KR, SA, AE, MX homoclave) | ✅ |
| `invalid` | Structure or check digit fails (`taxId.reason` explains why) | ❌ |

VIES answers are cached: valid results for 24 h, invalid ones for 6 h. Outages are never cached. A slow or unavailable member state never fails the request: the result degrades to the checksum verdict and reports `fallback` and `fallbackReason`.

### Audit certificates

Each certificate is a single A4 page drawn entirely with pdf-lib vector primitives, including the QR code (drawn as an SVG path). It contains:

- the subject, the verdict, the algorithm, the registry response and the VIES consultation number (if `VIES_REQUESTER_VAT` is set)
- an integrity panel: the payload SHA-256 and the Ed25519 signature
- `certificate.json`, an embedded attachment holding the signed canonical payload

To check a certificate:

- Anyone can verify it with the published key, for example with `crypto.verify(null, canonicalJson(payload), publicKeyPem, sig)` in Node.
- The QR code opens `/v1/certificates/:id/verify`, which also detects a tampered PDF.

## Supported jurisdictions (49)

| Code | Country | Scheme | Check | Registry | Example |
|---|---|---|---|---|---|
| AT | Austria | EU VAT identification number | UID Luhn variant (6 − Luhn) mod 10 | EU VIES | `ATU13585627` |
| BE | Belgium | EU VAT identification number | MOD 97 (enterprise number) | EU VIES | `BE0403019261` |
| BG | Bulgaria | EU VAT identification number | Weighted MOD 11 (BULSTAT / EGN / PNF) | EU VIES | `BG175074752` |
| CY | Cyprus | EU VAT identification number | Odd-position translation MOD 26 | EU VIES | `CY10259033P` |
| CZ | Czechia | EU VAT identification number | Weighted MOD 11 (DIČ) / birth-number MOD 11 | EU VIES | `CZ25123891` |
| DE | Germany | EU VAT identification number | ISO 7064 MOD 11,10 | EU VIES | `DE136695976` |
| DK | Denmark | EU VAT identification number | Weighted MOD 11 (CVR) | EU VIES | `DK13585628` |
| EE | Estonia | EU VAT identification number | Weighted MOD 10 (KMKR) | EU VIES | `EE100931558` |
| GR | Greece | EU VAT identification number | Powers-of-two MOD 11 (ΑΦΜ) | EU VIES | `EL094259216` |
| ES | Spain | EU VAT identification number | NIF: DNI/NIE MOD 23 letter, CIF Luhn | EU VIES | `ESA13585625` |
| FI | Finland | EU VAT identification number | Weighted MOD 11 (ALV / Y-tunnus) | EU VIES | `FI20774740` |
| FR | France | EU VAT identification number | SIREN Luhn + MOD 97 key | EU VIES | `FR40303265045` |
| HR | Croatia | EU VAT identification number | ISO 7064 MOD 11,10 (OIB) | EU VIES | `HR33392005961` |
| HU | Hungary | EU VAT identification number | Weighted MOD 10 (ANUM) | EU VIES | `HU12892312` |
| IE | Ireland | EU VAT identification number | Weighted MOD 23 letter | EU VIES | `IE6433435F` |
| IT | Italy | EU VAT identification number | Luhn (Partita IVA) + office code | EU VIES | `IT00743110157` |
| LT | Lithuania | EU VAT identification number | Two-pass weighted MOD 11 (PVM) | EU VIES | `LT119511515` |
| LU | Luxembourg | EU VAT identification number | MOD 89 | EU VIES | `LU15027442` |
| LV | Latvia | EU VAT identification number | Weighted MOD 11 (PVN) | EU VIES | `LV40003521600` |
| MT | Malta | EU VAT identification number | Weighted MOD 37 | EU VIES | `MT11679112` |
| NL | Netherlands | EU VAT identification number | BSN 11-proof or ISO 7064 MOD 97-10 | EU VIES | `NL004495445B01` |
| PL | Poland | EU VAT identification number | Weighted MOD 11 (NIP) | EU VIES | `PL8567346215` |
| PT | Portugal | EU VAT identification number | Weighted MOD 11 (NIF) | EU VIES | `PT501964843` |
| RO | Romania | EU VAT identification number | Weighted MOD 11 (CUI) / CNP | EU VIES | `RO18547290` |
| SE | Sweden | EU VAT identification number | Luhn (organisationsnummer) + 01 | EU VIES | `SE123456789701` |
| SI | Slovenia | EU VAT identification number | Weighted MOD 11 (DDV) | EU VIES | `SI15012557` |
| SK | Slovakia | EU VAT identification number | MOD 11 (IČ DPH) | EU VIES | `SK2022749619` |
| XI | United Kingdom (Northern Ireland) | Northern Ireland VAT number (EU VIES) | HMRC MOD 97 / 9755 | EU VIES | `XI980780684` |
| GB | United Kingdom | UK VAT registration number | HMRC MOD 97 / 9755 | — | `GB980780684` |
| US | United States | Employer Identification Number | IRS campus prefix rule (EINs carry no check digit) | — | `04-3341285` |
| CA | Canada | Business Number (BN / GST-HST) | Luhn (9-digit BN) + program account | — | `123456782RT0001` |
| AU | Australia | Australian Business Number / ACN | ABN MOD 89 / ACN weighted MOD 10 | — | `51824753556` |
| IN | India | Goods and Services Tax Identification Number | Luhn MOD 36 + PAN structure | — | `27AAPFU0939F1ZV` |
| CH | Switzerland | UID / MWST number | Weighted MOD 11 (UID) | — | `CHE116281710MWST` |
| NO | Norway | Organisasjonsnummer / MVA | Weighted MOD 11 | — | `NO988077917MVA` |
| NZ | New Zealand | IRD / GST number | Dual-weight MOD 11 | — | `49091850` |
| BR | Brazil | CNPJ | Double weighted MOD 11 | — | `11222333000181` |
| MX | Mexico | RFC (Registro Federal de Contribuyentes) | SAT structure + embedded date (homoclave check advisory) | — | `GODE561231GR8` |
| JP | Japan | Corporate Number / Invoice registration (T-number) | Leading check digit, alternating 1/2 weights MOD 9 | — | `T5835678256246` |
| SG | Singapore | Unique Entity Number (GST) | UEN weighted MOD 11 letter | — | `00192200M` |
| ZA | South Africa | SARS VAT number | Structure only (SARS publishes no check digit) | — | `4220123456` |
| KR | South Korea | Business Registration Number | Structure only (office / type / serial components) | — | `1168119477` |
| RU | Russia | INN (taxpayer number) | Weighted MOD 11 (single / double check) | — | `7707083893` |
| TR | Türkiye | Vergi Kimlik Numarası | VKN powers-of-two MOD 9 / MOD 10 | — | `4540536920` |
| AR | Argentina | CUIT | Weighted MOD 11 | — | `20267565393` |
| CL | Chile | RUT | Cyclic 2-7 weights MOD 11 (K check) | — | `76086428-5` |
| CO | Colombia | NIT | Prime-weighted MOD 11 | — | `2131234321` |
| SA | Saudi Arabia | ZATCA VAT registration number | Structure only (15 digits, 3…3) | — | `300000000000003` |
| AE | United Arab Emirates | Tax Registration Number (TRN) | Structure only (15 digits, 100…) | — | `100000000000003` |

`format_valid` schemes (no public check digit) are validated for structure and components only.

## Plans and billing

| Plan | Price | Tax verifications | Enrichments | Certificates |
|---|---|---|---|---|
| Free | $0 | 100 / month | 100 / month | 10 / month |
| Pro | $29 / month | 5,000 | 5,000 | unlimited |
| Business | $99 / month | 50,000 | 50,000 | unlimited |

Upgrades arrive through any of these channels:

- Stripe webhooks (`checkout.session.completed` with `client_reference_id` = tenant id, or `customer.subscription.*` with `metadata.tenant_id`)
- Polar.sh, through Standard Webhooks
- monday.com monetization webhooks

Marketplace tenants (Stripe, HubSpot, Pipedrive, monday) are provisioned on the first signed request from an account; no API key is needed.

## Security notes

- **API keys** are stored only as HMAC-SHA256 hashes. OAuth tokens (HubSpot, Pipedrive) are sealed with AES-256-GCM.
- **Marketplace requests are authenticated with each platform's own mechanism:**
  - Stripe Apps: `Stripe-Signature`
  - HubSpot: request signature v3, with a 5-minute window
  - monday.com: HS256 session and signing-secret JWTs
  - Pipedrive: JWT or Basic auth
- **Webhooks** are verified against the raw body and de-duplicated by event id.
- **Outbound website fetches** must pass these checks, on every redirect hop:
  - the target must be a public hostname
  - every resolved IP must be non-private
  - only ports 80 and 443 are allowed
  - the whole fetch has a 5 s budget and a 512 KB cap
- **Pages and HTML:**
  - The playground serves a strict CSP with no inline script.
  - The embedded shell pages pin their CDN SDKs with SRI and restrict `frame-ancestors` to the host platform.
  - All server HTML is escaped, and the browser shells build DOM with `textContent` only.

## Development

```bash
pnpm test                                   # all packages
npx vitest run packages/core-api            # one package
python3 -m venv .venv && .venv/bin/pip install python-stdnum
.venv/bin/python scripts/gen-stdnum-vectors.py > packages/core-api/test/fixtures/stdnum-vectors.json
```

The test suite includes:

- real PDF generation, parsed back with pdf-lib, with the QR code decoded by jsQR and the signature verified with `node:crypto`
- headless UI tests:
  - the Stripe and HubSpot official test renderers
  - happy-dom for the playground, the Pipedrive modal and the monday Item View
- contract tests that keep each shell's manifest fields in sync with the backend
- a smoke test that boots `dist/server.mjs` and fails if the committed bundle is stale

Submitting the apps to each marketplace is covered in [SUBMISSION_GUIDE.md](SUBMISSION_GUIDE.md).
