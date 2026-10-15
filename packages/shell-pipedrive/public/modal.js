// Pipedrive custom UI extension (modal). Loaded as an ES module by modal.html;
// `createModal` is exported so it can be driven headlessly in tests.

const VERDICT = {
  registry_verified: ['ok', 'Verified in EU VIES'],
  registry_not_found: ['bad', 'Not registered in VIES'],
  checksum_valid: ['info', 'Valid check digit'],
  format_valid: ['warn', 'Valid format'],
  invalid: ['bad', 'Invalid'],
};

/**
 * @param {{ document: Document, sdk: any, Command: Record<string,string>, fetch: typeof fetch, params: URLSearchParams, apiBase?: string }} deps
 */
export function createModal({ document, sdk, Command, fetch, params, apiBase = '' }) {
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  if (params.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
  const resource = params.get('resource') === 'deal' ? 'deal' : 'organization';
  const selectedId = (params.get('selectedIds') || '').split(',')[0] || undefined;

  async function verify() {
    const { token } = await sdk.execute(Command.GET_SIGNED_TOKEN);
    const body = { taxId: $('#taxId').value.trim(), certificate: $('#certificate').checked, resource };
    const country = $('#country').value.trim();
    const domain = $('#domain').value.trim();
    if (country) body.country = country;
    if (domain) body.domain = domain;
    if (selectedId) body.selectedId = selectedId;
    const res = await fetch(`${apiBase}/v1/integrations/pipedrive/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json.error && json.error.message) || `Request failed (${res.status})`);
    return json;
  }

  function render(r) {
    const [cls, label] = VERDICT[r.verdict] || ['info', r.verdict];
    const box = $('#result');
    const head = el('p');
    head.append(el('span', `badge ${cls}`, label), document.createTextNode(` ${r.summary}`));
    const dl = el('dl');
    const rows = [
      ['Tax ID', `${r.taxId.formatted} (${r.taxId.countryName})`],
      ['Registered name', r.registry.name],
      ['Address', r.registry.address],
      ['Registry', r.registry.source === 'none' ? `not consulted (${r.registry.status})` : `EU VIES: ${r.registry.status}`],
      ['Domain', r.enrichment ? `${r.enrichment.domain} — ${r.enrichment.security.grade} security, ${r.enrichment.risk.level} risk` : ''],
    ];
    for (const [k, v] of rows) {
      if (!v) continue;
      dl.append(el('dt', '', k), el('dd', '', v));
    }
    box.replaceChildren(head, dl);
    if (r.certificate) {
      const a = el('a', '', 'Download audit certificate (PDF)');
      a.href = r.certificate.pdfUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      box.append(a);
    }
  }

  $('#verify-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#submit');
    if (!$('#taxId').value.trim()) {
      $('#result').replaceChildren(el('p', 'err', 'Enter a VAT / tax ID'));
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    try {
      const r = await verify();
      render(r);
      await sdk.execute(Command.SHOW_SNACKBAR, {
        message: r.summary,
        ...(r.certificate ? { link: { url: r.certificate.pdfUrl, label: 'Certificate' } } : {}),
      });
      await sdk.execute(Command.RESIZE, { height: Math.min(720, document.body.scrollHeight + 24) });
    } catch (err) {
      $('#result').replaceChildren(el('p', 'err', err.message));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verify';
    }
  });
  $('#close').addEventListener('click', () => sdk.execute(Command.CLOSE_MODAL));
  return { verify, render };
}

async function boot() {
  const SDK = globalThis.AppExtensionsSDK;
  if (!SDK || globalThis.__TBVE_NO_AUTOBOOT__) return;
  const sdk = await new SDK().initialize({ size: { height: 420 } });
  createModal({ document, sdk, Command: SDK.Command, fetch: globalThis.fetch.bind(globalThis), params: new URLSearchParams(location.search) });
}

boot();
