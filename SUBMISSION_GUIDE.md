# Submission Guide

This guide takes the engine from this repository to five live marketplace listings. Do the steps in order:

1. Deploy the gateway once (step 0).
2. Submit each shell.

Every shell talks to the same backend, so each submission is mostly configuration.

> Marketplace review rules change often. The checklists below are what this codebase was built against. Re-check each vendor's current requirements page before you press submit.

---

## 0. Deploy the gateway

The whole backend is one file, `packages/gateway/dist/server.mjs`. It needs only Node 20+, with no `node_modules`.

```bash
pnpm install && pnpm check            # typecheck + build + 389 tests
docker build -t tax-b2b-verify .      # or copy dist/server.mjs to any Node host
```

### Required environment

| Variable | How to get it |
|---|---|
| `NODE_ENV=production` | — |
| `PUBLIC_BASE_URL` | Your HTTPS origin, e.g. `https://verify.taxb2b.app`. It is used in OAuth callbacks, signed links and HubSpot signature checks, so it must be the exact public URL. |
| `APP_SECRET` | `openssl rand -base64 48`. **Never rotate casually**: rotating it invalidates every API key, sealed OAuth token and certificate link. |
| `CERT_SIGNING_KEY` | `node server.mjs --generate-signing-key`. Back this up: certificates are verified against it. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Upstash console → REST API. Without these, tenants and certificates live only in memory. |
| `TRUST_PROXY=true` | Set this only if the gateway sits behind a proxy or CDN that sets `X-Forwarded-For` or `CF-Connecting-IP`. |

### Optional environment

| Variable | Purpose |
|---|---|
| `VIES_REQUESTER_VAT` | Your own EU VAT number. With it, VIES returns a **consultation number**, which is printed on certificates and is the standard evidence that you checked the number on that date. |
| `VIES_TIMEOUT_MS` (6000), `HUBSPOT_SLA_MS` (4200) | Registry time budgets. |
| `CERTIFICATE_RETENTION_DAYS` (90), `CERTIFICATE_LINK_TTL_SECONDS` (7 days) | Certificate storage and download-link lifetime. |
| `PLAYGROUND_LIMIT` / `PLAYGROUND_WINDOW_SECONDS` / `PLAYGROUND_PAGE_LIMIT` | Abuse limits for the public demo. |

### Smoke test after deploying

```bash
curl https://verify.taxb2b.app/health                       # ok:true, ephemeralKey:false
KEY=$(curl -s -X POST https://verify.taxb2b.app/v1/install -H 'content-type: application/json' -d '{"name":"smoke"}' | jq -r .apiKey)
curl -s -X POST https://verify.taxb2b.app/v1/verify/tax-id -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"taxId":"IE6388047V","certificate":true}' | jq '{verdict, pdf: .certificate.pdfUrl}'
```

Open `/playground` in a browser and verify `IE6388047V`; it should come back **Verified in EU VIES**. Then download the sample PDF and scan its QR code with a phone. The verify page should say **Authentic**.

### Billing

| Provider | Steps |
|---|---|
| **Stripe** | 1. Create Pro ($29) and Business ($99) prices with lookup keys `pro_monthly` / `business_monthly`, plus Payment Links.<br>2. Set `UPGRADE_URL_STRIPE` to the Pro link. The API appends `client_reference_id=<tenant>`.<br>3. Add a webhook to `/v1/webhooks/stripe` for `checkout.session.completed` and `customer.subscription.{created,updated,deleted}`, then set `STRIPE_WEBHOOK_SECRET`.<br>4. No metadata setup is needed: the subscription and customer ids recorded at checkout link later subscription events (renewals, cancellations) back to the tenant. `metadata.tenant_id` is honoured if present. |
| **Polar.sh** | 1. Create the products; a product named or tagged `business` maps to Business, anything else to Pro.<br>2. Set `UPGRADE_URL_POLAR`.<br>3. Add a webhook to `/v1/webhooks/polar` for the `subscription.*` events, then set `POLAR_WEBHOOK_SECRET`.<br>4. Pass the tenant id as customer `external_id` or metadata `tenant_id` on the first subscription event. Later events are matched by subscription id. |
| **monday.com** | Configure monetization plans in the Developer Center. `plan_id`s containing `business` map to Business, any other paid plan to Pro. |

All webhook handlers are idempotent per event id. Unknown tenants are acknowledged with `200` and ignored, so providers don't retry forever.

---

## 1. Stripe App Marketplace (`packages/shell-stripe`)

**What reviewers see:** on a customer's page, a **Tax ID Verify** drawer lists the customer's tax IDs. It offers:

- **Verify**: a VIES or checksum verdict, plus email-domain risk
- **Verify + certificate PDF**
- **Save to customer**: writes `tbve_*` metadata

### Steps

1. In `stripe-app.json`, set `id`, `constants.API_BASE` and `content_security_policy.connect-src` to your domain. The connect-src entry must be `https://<domain>/v1/integrations/stripe/`, and a test enforces the trailing path.
2. In the Stripe Dashboard → Apps → your app → Signing secret, copy the secret into the gateway's `STRIPE_APP_SECRET`.
3. Build and test locally:
   ```bash
   cd packages/shell-stripe && stripe apps start   # opens a test-mode customer page
   stripe apps upload
   ```
4. Fill in the listing:
   - name, a ≥ 300×300 icon (`icon.png` is provided)
   - 3–5 screenshots of the customer drawer: before, verified, certificate, and not-registered
   - privacy policy URL, support email
5. **Permissions justification** (also in the manifest):
   - `customer_read`: read tax IDs, email and country to verify them.
   - `customer_write`: optional; saves the verification status to customer metadata only when the user clicks **Save to customer**.
6. **Data disclosure:** each check sends the tax ID and email domain to your backend, which queries EU VIES, DNS, RDAP and the company's homepage. Certificates are retained for `CERTIFICATE_RETENTION_DAYS`.
7. Tell the reviewer to try `IE6388047V` (Google Ireland, live in VIES) and `DE136695977` (bad check digit).

### Auth model

The UI extension calls `fetchStripeSignature()`. The backend verifies it against `STRIPE_APP_SECRET`, and the Stripe account is provisioned as a Free tenant on first use. No API key is needed.

---

## 2. HubSpot App Marketplace (`packages/shell-hubspot`)

**What's included:**

- an OAuth app with the 2025.2 developer-platform project layout
- a **CRM card** on company and contact records
- a **custom workflow action**, *Verify tax ID*, with 10 output fields

### Steps

1. Create the app in a HubSpot developer account. Set `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET` on the gateway; the secret also verifies request signature v3.
2. Replace `verify.taxb2b.app` with your domain in these files, then upload:
   - `src/app/app-hsmeta.json`: `redirectUrls` and `permittedUrls.fetch`
   - `src/app/workflow-actions/verify-tax-id-hsmeta.json`: `actionUrl`
   ```bash
   cd packages/shell-hubspot && hs project upload && hs project deploy
   ```
   If you register the action through the legacy Automation API instead, `POST workflow-action-definition.json` to `/automation/v4/actions/{appId}`. It is kept identical to the hsmeta config by a test.
3. Install the app into a test portal through `GET /v1/install`, which returns `channels.hubspot.authorizeUrl`. On install, the backend:
   - stores the tokens sealed
   - creates the `tbve_*` company and contact properties
4. Test both entry points:
   - **Card:** open a company with a `vat_number` property, then click Verify.
   - **Workflow:** create a company-based workflow → *Verify tax ID* → map **Tax / VAT ID** to the VAT property. Branch on `verification_status`, or copy `registered_name` into a property.
5. Fill in the listing:
   - **Scopes rationale:** company/contact read and write (read the tax ID, write back status), schema write (create the four custom properties), `automation` (the workflow action).
   - **Performance:** the action answers inside HubSpot's 5 s callback window. The registry gets a `HUBSPOT_SLA_MS` budget; if VIES is slow, the action returns the checksum verdict with `registry_status=unavailable`. This is covered by a test that uses a hanging registry.
   - Collect the minimum number of active installs HubSpot requires before listing, using design-partner portals.
6. **Support material:** a setup guide covering where the card appears, how to map the VAT property and how to read verdicts. Reuse the verdict table from the README.

---

## 3. Pipedrive Marketplace (`packages/shell-pipedrive`)

**What's included:**

- JSON panels on **deal** and **organization** details
- a **custom modal** (custom UI extension) served by the gateway at `/apps/pipedrive/modal`

### Steps

1. In Developer Hub, create the app and set the OAuth callback to `https://<domain>/v1/install/pipedrive/callback`. Use the scopes in `app-extensions.json`: `base`, `deals:read`, `contacts:read`. Set these on the gateway:
   - `PIPEDRIVE_CLIENT_ID` and `PIPEDRIVE_CLIENT_SECRET`
   - `PIPEDRIVE_JWT_SECRET`, from the app extensions JWT secret
2. **JSON panels.** Add one per location, as listed in `app-extensions.json`:
   - API endpoint: `https://<domain>/v1/integrations/pipedrive/panel?resource=deal` (or `organization`)
   - Authentication: JWT
   - Data structure: paste `panel-schema.json`
   - Action: open the custom modal "Verify tax ID"
3. **Custom modal.** Set the iframe URL to `https://<domain>/apps/pipedrive/modal`. The gateway serves it with:
   - `frame-ancestors https://*.pipedrive.com`
   - an SRI-pinned `@pipedrive/app-extensions-sdk@0.16.1`
4. Test both paths:
   - **Auto:** after OAuth, the panel reads the organization's first field whose name looks like a tax ID (VAT, Tax ID, USt-IdNr, SIRET, …) and verifies it, caching the result for 24 h.
   - **Manual:** *Verify tax ID* opens the modal. The result is stored for the record and appears in the panel.
5. For the listing, provide screenshots of the panel in each state (not checked, verified, invalid) and of the modal, plus a test account for the review team.

---

## 4. monday.com Apps Marketplace (`packages/shell-monday`)

**What's included:**

- an **Item View**, served by the gateway at `/apps/monday/item-view`
- an **integration** with a custom action and two recipes, plus lifecycle and monetization webhooks

### Steps

1. In the Developer Center, create the app. Use the OAuth scopes `boards:read boards:write me:read`. Set `MONDAY_CLIENT_SECRET` (it verifies the Item View `sessionToken`) and `MONDAY_SIGNING_SECRET` (it verifies actions and webhooks).
2. **Item View feature:** set the URL to `https://<domain>/apps/monday/item-view`. The view:
   - auto-detects the tax, country, email/domain and status columns by title
   - verifies the tax ID
   - can write the status label back
3. **Integration feature:** create the custom action *Verify tax ID* with:
   - run URL `https://<domain>/v1/integrations/monday/action`
   - the input fields exactly as in `monday-app.json`. A test pins these to what the backend reads.

   Then add the recipes from `monday-app.json`. Status labels are created automatically if missing (`Verified`, `Not registered`, `Valid checksum`, `Valid format`, `Invalid`, `Missing tax ID`).
4. **Webhooks:** point the app lifecycle and monetization webhooks to `https://<domain>/v1/webhooks/monday`. Install provisions the account; subscription events change its plan.
5. For review, record a short video of the recipe firing on a new item, and fill in the security questionnaire. The facts to give:
   - tokens are sealed with AES-256-GCM
   - no board data is stored, except verification results kept in the cache (24 h)
   - certificates are kept for the retention period

---

## 5. Make.com (`packages/shell-makecom`)

**What's included:** a custom app with these components:

- an API-key connection
- four modules: *Verify a Tax ID*, *Enrich a Company Domain*, *Get a Certificate*, *Get Usage*
- the `listCountries` RPC

### Steps

1. Install the **Make Apps Editor** VS Code extension and create an app. Import the components listed in `makecomapp.json`; each code file maps to the matching tab (Base, Communication, Mappable parameters, Interface, Samples). Replace `verify.taxb2b.app` with your domain in `app/base.imljson` and `app/connections/apiKey/api.imljson`.
2. Test in a scenario, following the README in `app/readme.md`: create a key with `POST /v1/install {"platform":"makecom"}`, then add the connection. Try *Verify a Tax ID* with `IE6388047V`, then *Get a Certificate* with the returned `certificate.id`.
3. The shipped definitions are already validated: the test suite runs every module's IML against the real API and checks that each interface field exists in the actual responses.
4. Request a review to make the app public. Make requires these, all of which are present:
   - module descriptions
   - samples
   - error mapping (`base.imljson` maps 401/402/429 to the proper error types)
   - `log.sanitize` for the API key

---

## Pre-submission checklist

- [ ] `pnpm check` is green; CI runs the same commands.
- [ ] `/health` shows `ephemeralKey: false` and the expected `signingKey` id.
- [ ] Upstash is configured, and a restart keeps tenants and certificates.
- [ ] `PUBLIC_BASE_URL` matches the domain used in every shell manifest:
  ```bash
  grep -r verify.taxb2b.app packages/shell-*
  ```
- [ ] Billing webhooks are tested with each provider's test mode, and a Free tenant upgrades to Pro.
- [ ] Privacy policy and DPA are published. Processors and data flows to list:
  - EU VIES (European Commission)
  - Cloudflare and Google DoH, if not using native DNS
  - RDAP registries
  - the company websites being enriched
  - Upstash
- [ ] Support inbox monitored; `/playground` linked from each listing.

## Test evidence

| Area | File(s) | What is proven |
|---|---|---|
| Tax IDs | `core-api/test/taxid.test.ts` | 49 rule examples are valid; agreement with `python-stdnum` on 1,633 vectors; check-character mutation; detection and normalisation |
| VIES | `core-api/test/vies-verify.test.ts` | REST/SOAP parsing, SOAP fallback, timeouts, consultation numbers, caching, offline fallback |
| Enrichment | `core-api/test/enrich.test.ts` | SPF/DMARC/DKIM scoring, RDAP via IANA bootstrap, SSRF guard (private IPs, redirects, size and content-type caps), JSON-LD/VAT extraction, classification |
| Certificates | `core-api/test/certificates.test.ts` | Real PDF parsed back, text extracted, embedded JSON verified with `node:crypto`, QR decoded with jsQR, tamper detection, signed links |
| API | `core-api/test/routes.test.ts`, `webhooks.test.ts`, `integrations.test.ts`, `stores.test.ts` | Auth, quotas (402 + upgrade link), rate limits, CORS, Stripe/Polar/monday webhooks, all marketplace backends, the HubSpot 5 s SLA, Upstash wire format |
| Playground | `core-api/test/playground.test.ts` | Headless DOM: CSP, form flows, XSS-safe rendering, rate limits |
| Shells | `shell-*/test/*` | Stripe and HubSpot official renderers end-to-end against the core; Pipedrive and monday iframes in happy-dom; Make IML executed against the API; manifest ↔ backend contracts |
| Gateway | `gateway/test/gateway.test.ts` | Spawns `dist/server.mjs` from an empty directory; full install → verify → PDF → verify flow; bundle freshness |
