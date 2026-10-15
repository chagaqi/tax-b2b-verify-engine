// monday.com Item View. Loaded as an ES module by item-view.html;
// `createItemView` is exported so it can be driven headlessly in tests.

const VERDICT = {
  registry_verified: ['ok', 'Verified in EU VIES', 'Verified'],
  registry_not_found: ['bad', 'Not registered in VIES', 'Not registered'],
  checksum_valid: ['info', 'Valid check digit', 'Valid checksum'],
  format_valid: ['warn', 'Valid format', 'Valid format'],
  invalid: ['bad', 'Invalid', 'Invalid'],
};

const TAX_TITLE = /\b(vat|tax|tin|ein|gst|gstin|abn|siret|cif|nif|nip|uid|ust|btw|cnpj|rfc)\b/i;
const STATUS_TITLE = /(tax|vat).*(status|check)|verification/i;
const DOMAIN_TITLE = /domain|website|e-?mail/i;

/** Pick the tax-ID, country, domain and status columns of an item by their titles. */
export function pickColumns(columnValues) {
  const find = (re, types) => columnValues.find((cv) => re.test(cv.column.title) && (!types || types.includes(cv.type)));
  return {
    tax: find(TAX_TITLE, ['text', 'long_text']),
    country: find(/country/i, ['text', 'country']),
    domain: find(DOMAIN_TITLE, ['text', 'link', 'email']),
    status: find(STATUS_TITLE, ['status']),
  };
}

/**
 * @param {{ document: Document, monday: any, fetch: typeof fetch, apiBase?: string }} deps
 */
export function createItemView({ document, monday, fetch, apiBase = '' }) {
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  let ctx = null;
  let columns = {};
  let domain = '';

  async function load(context) {
    ctx = context;
    if (context.theme) document.documentElement.dataset.theme = context.theme;
    const res = await monday.api(
      'query ($ids: [ID!]) { items(ids: $ids) { name column_values { id type text column { title } } } }',
      { variables: { ids: [String(context.itemId)] } },
    );
    const item = res.data.items[0];
    columns = pickColumns(item.column_values);
    $('#taxId').value = columns.tax?.text ?? '';
    $('#country').value = columns.country?.text?.length === 2 ? columns.country.text : '';
    domain = (columns.domain?.text ?? '').replace(/^.*@/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/\s]/)[0];
    $('#source').textContent = columns.tax ? `${item.name} · from column “${columns.tax.column.title}”` : `${item.name} · no tax-ID column found, enter one below`;
  }

  async function verify() {
    const { data: token } = await monday.get('sessionToken');
    const body = { taxId: $('#taxId').value.trim(), certificate: $('#certificate').checked };
    if ($('#country').value.trim()) body.country = $('#country').value.trim();
    if (domain) body.domain = domain;
    const res = await fetch(`${apiBase}/v1/integrations/monday/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: token },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json.error && json.error.message) || `Request failed (${res.status})`);
    return json;
  }

  async function writeStatus(r) {
    const values = { [columns.status.id]: { label: VERDICT[r.verdict][2] } };
    await monday.api(
      'mutation ($board: ID!, $item: ID!, $vals: JSON!) { change_multiple_column_values(board_id: $board, item_id: $item, column_values: $vals, create_labels_if_missing: true) { id } }',
      { variables: { board: String(ctx.boardId), item: String(ctx.itemId), vals: JSON.stringify(values) } },
    );
    await monday.execute('notice', { message: `Status set to “${VERDICT[r.verdict][2]}”`, type: 'success', timeout: 4000 });
  }

  function render(r) {
    const [cls, label] = VERDICT[r.verdict] || ['info', r.verdict];
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
    for (const [k, v] of rows) if (v) dl.append(el('dt', '', k), el('dd', '', v));
    const actions = el('div', 'actions');
    if (r.certificate) {
      const a = el('a', '', 'Download audit certificate (PDF)');
      a.href = r.certificate.pdfUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      actions.append(a);
    }
    if (columns.status) {
      const b = el('button', '', `Write status to “${columns.status.column.title}”`);
      b.type = 'button';
      b.id = 'write-status';
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await writeStatus(r);
        } catch (err) {
          await monday.execute('notice', { message: err.message, type: 'error', timeout: 6000 });
        } finally {
          b.disabled = false;
        }
      });
      actions.append(b);
    }
    $('#result').replaceChildren(head, dl, actions);
  }

  $('#verify-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('#taxId').value.trim()) {
      $('#result').replaceChildren(el('p', 'err', 'Enter a VAT / tax ID'));
      return;
    }
    const btn = $('#submit');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    try {
      render(await verify());
    } catch (err) {
      $('#result').replaceChildren(el('p', 'err', err.message));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verify';
    }
  });

  return { load, verify, render };
}

function boot() {
  const factory = globalThis.mondaySdk;
  if (!factory || globalThis.__TBVE_NO_AUTOBOOT__) return;
  const monday = factory();
  const view = createItemView({ document, monday, fetch: globalThis.fetch.bind(globalThis) });
  monday.listen('context', (res) => {
    view.load(res.data).catch((err) => {
      document.querySelector('#source').textContent = `Could not read the item: ${err.message}`;
    });
  });
}

boot();
