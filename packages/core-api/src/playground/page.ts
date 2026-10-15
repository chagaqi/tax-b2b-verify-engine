import { BASE_CSS, escapeHtml } from './html.js';

const EXAMPLES: [string, string, string][] = [
  ['IE6388047V', '', 'Ireland (live VIES)'],
  ['DE136695976', '', 'Germany'],
  ['GB980780684', '', 'UK (checksum)'],
  ['04-3341285', 'US', 'US EIN'],
  ['51824753556', 'AU', 'AU ABN'],
  ['27AAPFU0939F1ZV', '', 'India GSTIN'],
  ['DE136695977', '', 'Bad check digit'],
];

export function playgroundHtml(opts: { limit: number; windowSeconds: number; jurisdictions: number }): string {
  const ex = EXAMPLES.map(
    ([id, cc, label]) => `<button type="button" class="chip" data-tax-id="${escapeHtml(id)}" data-country="${escapeHtml(cc)}">${escapeHtml(label)}</button>`,
  ).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tax ID Playground</title>
<style>${BASE_CSS}
.tabs{display:flex;gap:8px;margin-top:20px}.tab{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:7px 16px;cursor:pointer;font:inherit}
.tab[aria-selected="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
form{display:grid;grid-template-columns:1fr 110px auto;gap:10px;align-items:end}@media (max-width:640px){form{grid-template-columns:1fr}}
label{display:grid;gap:4px;font-size:13px;color:var(--muted)}input{font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);width:100%}
button.primary{font:inherit;font-weight:600;padding:10px 18px;border-radius:8px;border:0;background:var(--accent);color:#fff;cursor:pointer}button.primary:disabled{opacity:.6;cursor:wait}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.chip{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--chip);color:var(--ink);border-radius:999px;padding:3px 10px;cursor:pointer}
.check{display:flex;gap:8px;align-items:center;margin-top:10px;font-size:14px}.check input{width:auto}
.result:empty{display:none}.err{color:var(--bad);font-weight:600}[hidden]{display:none!important}
</style></head><body><main>
<h1>Tax ID &amp; B2B Domain Playground</h1>
<p class="muted">Checksums for ${opts.jurisdictions} jurisdictions, live EU VIES lookups, email-security posture and signed audit-certificate PDFs. Free demo: ${opts.limit} requests per ${Math.round(opts.windowSeconds / 60)} minutes per IP; certificates are watermarked as samples.</p>
<div class="tabs" role="tablist">
  <button class="tab" role="tab" id="tab-tax" aria-selected="true" aria-controls="panel-tax">Tax / VAT ID</button>
  <button class="tab" role="tab" id="tab-domain" aria-selected="false" aria-controls="panel-domain">Company domain</button>
</div>
<section class="card" id="panel-tax" role="tabpanel">
  <h2>Verify a tax identifier</h2>
  <form id="tax-form">
    <label>Tax / VAT ID<input name="taxId" id="taxId" required maxlength="64" placeholder="e.g. IE6388047V" autocomplete="off"></label>
    <label>Country<input name="country" id="country" maxlength="2" placeholder="auto"></label>
    <button class="primary" type="submit">Verify</button>
  </form>
  <label class="check"><input type="checkbox" id="certificate" checked> Generate a signed sample certificate PDF</label>
  <div class="chips">${ex}</div>
  <div class="result" id="tax-result" aria-live="polite"></div>
</section>
<section class="card" id="panel-domain" role="tabpanel" hidden>
  <h2>Enrich an email or domain</h2>
  <form id="domain-form">
    <label>Email or domain<input name="target" id="target" required maxlength="320" placeholder="ops@stripe.com"></label>
    <span></span>
    <button class="primary" type="submit">Enrich</button>
  </form>
  <div class="result" id="domain-result" aria-live="polite"></div>
</section>
<p class="muted" style="margin-top:24px">API: <code>POST /v1/verify/tax-id</code> · <code>POST /v1/enrich/company</code> · <a href="/v1/countries">supported countries</a> · <a href="/v1/certificates/public-key">signing key</a></p>
</main><script src="/playground/app.js" defer></script></body></html>`;
}

/** Client script — DOM built with textContent only (no innerHTML of API data). */
export const PLAYGROUND_JS = `(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const VERDICT = {
    registry_verified: ['ok', 'Verified in EU VIES'], registry_not_found: ['bad', 'Not active in VIES'],
    checksum_valid: ['info', 'Valid check digit'], format_valid: ['warn', 'Valid format'], invalid: ['bad', 'Invalid'],
  };
  async function api(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json.error && json.error.message) || 'Request failed (' + res.status + ')');
    return json;
  }
  function list(rows) {
    const dl = el('dl');
    for (const [k, v] of rows) {
      if (v === undefined || v === null || v === '') continue;
      dl.append(el('dt', '', k));
      const dd = el('dd');
      if (v instanceof Node) dd.append(v); else dd.textContent = String(v);
      dl.append(dd);
    }
    return dl;
  }
  function link(href, text) { const a = el('a', '', text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; }
  function busy(form, on) { form.querySelector('button[type=submit]').disabled = on; }
  function fail(box, err) { box.replaceChildren(el('p', 'err', err.message)); }

  function renderTax(box, r) {
    const [cls, label] = VERDICT[r.verdict] || ['info', r.verdict];
    const head = el('p');
    head.append(el('span', 'badge ' + cls, label), document.createTextNode(' ' + r.summary));
    const reg = r.registry || {};
    box.replaceChildren(head, list([
      ['Normalized', r.taxId.formatted], ['Jurisdiction', r.taxId.countryName + ' (' + r.taxId.jurisdiction + ')'],
      ['Scheme', r.taxId.schemeName], ['Algorithm', r.taxId.algorithm], ['Check digit', r.taxId.checksum],
      ['Registry', reg.source === 'none' ? 'not consulted (' + reg.status + ')' : 'EU VIES: ' + reg.status],
      ['Registered name', reg.name], ['Address', reg.address], ['Fallback', r.fallback ? r.fallbackReason : ''],
      ['Certificate', r.certificate ? link(r.certificate.pdfUrl, 'Download signed PDF') : ''],
      ['Verify page', r.certificate ? link(r.certificate.verifyUrl, r.certificate.id) : ''],
    ]));
  }
  function renderDomain(box, r) {
    const cls = r.risk.level === 'low' ? 'ok' : r.risk.level === 'medium' ? 'warn' : 'bad';
    const head = el('p');
    head.append(el('span', 'badge ' + cls, r.classification.replace('_', ' ') + ' · risk ' + r.risk.level), document.createTextNode(' ' + r.domain));
    const c = r.company || {};
    box.replaceChildren(head, list([
      ['Mail provider', r.dns.mailProvider || (r.dns.mx[0] && r.dns.mx[0].host)],
      ['Email security', r.security.grade + ' (' + r.security.score + '/100)'],
      ['SPF', r.security.spf.present ? r.security.spf.allQualifier : 'missing'],
      ['DMARC', r.security.dmarc.present ? 'p=' + (r.security.dmarc.policy || '?') : 'missing'],
      ['Disposable', r.disposable.value ? 'yes (' + r.disposable.reason + ')' : 'no'],
      ['Registrar', r.registration && r.registration.registrar],
      ['Domain age', r.registration && r.registration.ageDays !== undefined ? r.registration.ageDays + ' days' : ''],
      ['Company', c.legalName || c.name || c.siteTitle], ['Description', c.description],
      ['VAT on website', (c.detectedTaxIds || []).map((t) => t.value + (t.valid ? '' : ' (invalid)')).join(', ')],
      ['Risk factors', r.risk.reasons.join('; ')],
    ]));
  }

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      }
    });
  }
  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => { $('#taxId').value = chip.dataset.taxId; $('#country').value = chip.dataset.country; });
  }
  $('#tax-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget, box = $('#tax-result');
    busy(form, true); box.replaceChildren(el('p', 'muted', 'Checking…'));
    const body = { taxId: $('#taxId').value, certificate: $('#certificate').checked };
    if ($('#country').value.trim()) body.country = $('#country').value.trim();
    try { renderTax(box, await api('/v1/playground/verify-tax-id', body)); } catch (err) { fail(box, err); } finally { busy(form, false); }
  });
  $('#domain-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget, box = $('#domain-result'), v = $('#target').value.trim();
    busy(form, true); box.replaceChildren(el('p', 'muted', 'Looking up DNS, RDAP and website…'));
    try { renderDomain(box, await api('/v1/playground/enrich', v.includes('@') ? { email: v } : { domain: v })); } catch (err) { fail(box, err); } finally { busy(form, false); }
  });
  window.__playgroundReady = true;
})();`;
