# Tax ID Verify for Make

Verify VAT / tax IDs for 49 jurisdictions (EU-27 + Northern Ireland via live EU VIES, plus UK, US, CA, AU, IN, CH, NO, NZ, BR, MX, JP, SG, ZA, KR, RU, TR, AR, CL, CO, SA, AE check-digit rules), enrich company email domains, and issue Ed25519-signed audit certificate PDFs.

1. Create a free API key: `curl -X POST https://verify.taxb2b.app/v1/install -H 'content-type: application/json' -d '{"platform":"makecom"}'`
2. Add the **Tax ID Verify API key** connection.
3. Use **Verify a Tax ID** after any CRM or e-commerce trigger, then route on `valid` / `verdict`.
