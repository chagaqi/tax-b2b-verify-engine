import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { MONDAY_STATUS_LABELS } from '../../core-api/src/integrations/monday.js';
import { signHs256 } from '../../core-api/src/lib/jwt.js';
import { VIES_REST, makeApp, viesValid } from '../../core-api/test/helpers.js';
import { ITEM_VIEW_ROUTE } from '../index.js';
import { createItemView, pickColumns, type ColumnValue } from '../public/item-view.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const config = JSON.parse(read('../monday-app.json'));
const HTML = read('../public/item-view.html');
const JS = read('../public/item-view.js');

const COLUMNS: ColumnValue[] = [
  { id: 'name', type: 'name', text: 'Google Ireland', column: { title: 'Name' } },
  { id: 'text_vat', type: 'text', text: 'IE6388047V', column: { title: 'VAT number' } },
  { id: 'country', type: 'country', text: 'IE', column: { title: 'Country' } },
  { id: 'email', type: 'email', text: 'ap@google.ie', column: { title: 'Billing email' } },
  { id: 'status_9', type: 'status', text: '', column: { title: 'Tax status' } },
];

describe('monday app configuration ↔ backend contract', () => {
  it('item view is served by the gateway; lifecycle webhooks hit the backend', () => {
    expect(new URL(config.features[0].url).pathname).toBe(ITEM_VIEW_ROUTE);
    expect(new URL(config.app.webhooks.lifecycle).pathname).toBe('/v1/webhooks/monday');
  });

  it('custom action fields match what the backend reads', () => {
    const action = config.features[1].customActions[0];
    expect(new URL(action.runUrl).pathname).toBe('/v1/integrations/monday/action');
    expect(action.inputFields.map((f: { key: string }) => f.key)).toEqual(['boardId', 'itemId', 'taxIdColumnId', 'statusColumnId', 'countryColumnId', 'summaryColumnId']);
    for (const r of config.features[1].recipes) {
      for (const ref of r.sentence.match(/\{(\w+)\}/g) ?? []) expect(action.inputFields.map((f: { key: string }) => `{${f.key}}`)).toContain(ref);
    }
  });

  it('status labels are identical in the backend, the item view and the config', () => {
    const backend = Object.values(MONDAY_STATUS_LABELS);
    expect(config.statusLabels).toEqual([...backend, 'Missing tax ID']);
    for (const label of backend) expect(JS).toContain(`'${label}']`);
  });

  it('pins monday-sdk-js with Subresource Integrity', () => {
    expect(HTML).toMatch(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/monday-sdk-js@0\.5\.9\/dist\/main\.js" integrity="sha384-[A-Za-z0-9+/=]{64}" crossorigin="anonymous">/);
  });
});

describe('pickColumns', () => {
  it('finds tax, country, domain and status columns by title and type', () => {
    const c = pickColumns(COLUMNS);
    expect([c.tax?.id, c.country?.id, c.domain?.id, c.status?.id]).toEqual(['text_vat', 'country', 'email', 'status_9']);
    expect(pickColumns([{ id: 'x', type: 'status', text: '', column: { title: 'VAT number' } }]).tax).toBeUndefined();
  });
});

describe('Item View (headless)', () => {
  async function boot(columns = COLUMNS) {
    const backend = await makeApp({ routes: { [VIES_REST]: viesValid() } });
    const window = new Window({ url: 'https://verify.test/apps/monday/item-view', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    window.document.write(HTML);
    const document = window.document as unknown as Document;
    const api: { query: string; variables: Record<string, unknown> }[] = [];
    const notices: unknown[] = [];
    const monday = {
      api: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
        api.push({ query, variables: opts?.variables ?? {} });
        return query.startsWith('query')
          ? { data: { items: [{ name: 'Google Ireland', column_values: columns }] } }
          : { data: { change_multiple_column_values: { id: '555' } } };
      },
      get: async () => ({ data: await signHs256({ dat: { account_id: 4242, user_id: 1 }, exp: Math.floor(Date.now() / 1000) + 300 }, 'monday_client_test') }),
      execute: async (_type: string, args?: unknown) => notices.push(args),
    };
    const fetch = ((url: string, init?: RequestInit) => backend.request(url, init ?? {})) as typeof globalThis.fetch;
    const view = createItemView({ document, monday, fetch });
    await view.load({ boardId: 1, itemId: 555, theme: 'dark' });
    const $ = (s: string) => document.querySelector(s) as HTMLInputElement;
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
      if (!pred()) throw new Error('timeout');
    };
    const submit = () => $('#verify-form').dispatchEvent(new window.Event('submit', { cancelable: true }) as unknown as Event);
    return { backend, document, api, notices, $, until, submit };
  }

  it('prefills from item columns and applies the monday theme', async () => {
    const { $, document } = await boot();
    expect($('#taxId').value).toBe('IE6388047V');
    expect($('#country').value).toBe('IE');
    expect(document.querySelector('#source')!.textContent).toBe('Google Ireland · from column “VAT number”');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('verifies with the sessionToken and writes the status label back', async () => {
    const { $, until, submit, document, api, notices, backend } = await boot();
    submit();
    await until(() => document.querySelector('#result .badge') !== null);
    expect(document.querySelector('#result .badge')!.textContent).toBe('Verified in EU VIES');
    expect(document.querySelector('#result')!.textContent).toContain('google.ie');
    expect(await backend.services.tenants.findByExternal('monday', '4242')).toBeTruthy();
    ($('#write-status') as unknown as HTMLButtonElement).click();
    await until(() => notices.length > 0);
    const mutation = api.find((c) => c.query.startsWith('mutation'))!;
    expect(mutation.variables).toMatchObject({ board: '1', item: '555' });
    expect(JSON.parse(mutation.variables.vals as string)).toEqual({ status_9: { label: 'Verified' } });
    expect(notices[0]).toMatchObject({ type: 'success', message: 'Status set to “Verified”' });
  });

  it('works without a tax column and reports errors as text', async () => {
    const { $, until, submit, document } = await boot(COLUMNS.filter((c) => c.id !== 'text_vat'));
    expect(document.querySelector('#source')!.textContent).toContain('no tax-ID column found');
    submit();
    expect(document.querySelector('#result .err')!.textContent).toBe('Enter a VAT / tax ID');
    $('#taxId').value = '999';
    $('#country').value = 'ZZ';
    submit();
    await until(() => (document.querySelector('#result .err')?.textContent ?? '').includes('country'));
    expect(document.querySelector('#write-status')).toBeNull();
  });
});
