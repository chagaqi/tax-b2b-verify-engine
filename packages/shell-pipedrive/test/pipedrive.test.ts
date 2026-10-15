import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { pipedrivePanelRow } from '../../core-api/src/integrations/pipedrive.js';
import { signHs256 } from '../../core-api/src/lib/jwt.js';
import { toResponse } from '../../core-api/src/operations.js';
import { validateTaxId } from '../../core-api/src/taxid/index.js';
import { VIES_REST, makeApp, viesValid } from '../../core-api/test/helpers.js';
import { MODAL_ROUTE } from '../index.js';
import { createModal } from '../public/modal.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const config = JSON.parse(read('../app-extensions.json'));
const schema = JSON.parse(read('../panel-schema.json'));
const MODAL_HTML = read('../public/modal.html');

describe('Pipedrive app configuration ↔ backend contract', () => {
  it('JSON panels call the backend panel route for deals and organizations', () => {
    const urls = config.jsonPanels.map((p: { apiEndpoint: string }) => new URL(p.apiEndpoint));
    expect(urls.map((u: URL) => u.pathname)).toEqual(['/v1/integrations/pipedrive/panel', '/v1/integrations/pipedrive/panel']);
    expect(urls.map((u: URL) => u.searchParams.get('resource'))).toEqual(['deal', 'organization']);
    expect(config.jsonPanels.every((p: { authentication: string }) => p.authentication === 'jwt')).toBe(true);
  });

  it('every field the backend emits is declared in the panel schema', () => {
    const v = { verdict: 'registry_verified' as const, fallback: false, confidence: 'high' as const, validation: validateTaxId('IE6388047V'), registry: { source: 'vies' as const, status: 'valid' as const, name: 'X', address: 'Y' }, checkedAt: '2026-10-15T00:00:00Z' };
    const row = pipedrivePanelRow('1', { ...toResponse(v), certificate: { pdfUrl: 'https://p' } as never });
    const declared = Object.keys(schema.data.items.properties);
    expect(Object.keys(row).filter((k) => !declared.includes(k))).toEqual([]);
    expect(schema.data.items.required.every((k: string) => k in row)).toBe(true);
    expect(Object.keys(pipedrivePanelRow('1', null)).filter((k) => !declared.includes(k))).toEqual([]);
  });

  it('custom modal is served by the gateway and OAuth returns to the backend callback', () => {
    expect(new URL(config.customModals[0].iframeUrl).pathname).toBe(MODAL_ROUTE);
    expect(new URL(config.app.callbackUrl).pathname).toBe('/v1/install/pipedrive/callback');
  });

  it('pins the Pipedrive SDK with Subresource Integrity', () => {
    expect(MODAL_HTML).toMatch(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@pipedrive\/app-extensions-sdk@0\.16\.1\/dist\/index\.umd\.js" integrity="sha384-[A-Za-z0-9+/=]{64}" crossorigin="anonymous">/);
    expect(MODAL_HTML).toContain('<script type="module" src="./modal.js">');
  });
});

describe('custom modal (headless)', () => {
  const Command = { GET_SIGNED_TOKEN: 'get_signed_token', SHOW_SNACKBAR: 'show_snackbar', RESIZE: 'resize', CLOSE_MODAL: 'close_modal' };

  async function boot(query = 'id=ext_1&resource=organization&selectedIds=12&companyId=900&userId=5') {
    const backend = await makeApp({ routes: { [VIES_REST]: viesValid() } });
    const window = new Window({ url: `https://verify.test/apps/pipedrive/modal?${query}`, settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    window.document.write(MODAL_HTML);
    const document = window.document as unknown as Document;
    const executed: [string, unknown][] = [];
    const sdk = {
      execute: async (cmd: string, args?: unknown) => {
        executed.push([cmd, args]);
        if (cmd === Command.GET_SIGNED_TOKEN) return { token: await signHs256({ companyId: 900, userId: 5, exp: Math.floor(Date.now() / 1000) + 300 }, 'pd-jwt-secret') };
        return undefined;
      },
    };
    const fetch = ((url: string, init?: RequestInit) => backend.request(url, init ?? {})) as typeof globalThis.fetch;
    createModal({ document, sdk, Command, fetch, params: new URLSearchParams(query) });
    const $ = (s: string) => document.querySelector(s) as HTMLInputElement;
    const submit = () => $('#verify-form').dispatchEvent(new window.Event('submit', { cancelable: true }) as unknown as Event);
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
      if (!pred()) throw new Error('timeout');
    };
    return { backend, document, executed, $, submit, until };
  }

  it('verifies with a signed token, renders the result and notifies Pipedrive', async () => {
    const { $, submit, until, executed, backend, document } = await boot();
    $('#taxId').value = 'IE6388047V';
    submit();
    await until(() => document.querySelector('#result .badge') !== null);
    expect(document.querySelector('#result .badge')!.textContent).toBe('Verified in EU VIES');
    expect(document.querySelector('#result')!.textContent).toContain('GOOGLE IRELAND LIMITED');
    expect((document.querySelector('#result a') as HTMLAnchorElement).href).toMatch(/\/v1\/certificates\/tvc_.+\.pdf\?exp=/);
    expect(executed.map(([c]) => c)).toEqual(['get_signed_token', 'show_snackbar', 'resize']);
    expect(executed[1]![1]).toMatchObject({ message: expect.stringContaining('active in EU VIES'), link: { label: 'Certificate' } });
    // The panel now shows the stored result for organization 12.
    const token = await signHs256({ companyId: 900, iat: Math.floor(Date.now() / 1000) }, 'pd-jwt-secret');
    const panel = (await (await backend.request(`/v1/integrations/pipedrive/panel?resource=organization&selectedIds=12&token=${token}`)).json()) as { data: { header: string }[] };
    expect(panel.data[0]!.header).toBe('IE6388047V');
  });

  it('validates input locally and renders API errors as text', async () => {
    const { $, submit, until, document, executed } = await boot();
    submit();
    expect(document.querySelector('#result .err')!.textContent).toBe('Enter a VAT / tax ID');
    expect(executed).toEqual([]);
    $('#taxId').value = '<b>123456789</b>';
    submit();
    await until(() => (document.querySelector('#result .err')?.textContent ?? '').includes('jurisdiction'));
    expect(document.querySelector('#result b')).toBeNull();
    expect(($('#submit') as unknown as HTMLButtonElement).disabled).toBe(false);
  });

  it('closes via the SDK and honours the dark theme', async () => {
    const { $, executed, document } = await boot('id=ext_1&resource=deal&selectedIds=77&theme=dark');
    ($('#close') as unknown as HTMLButtonElement).click();
    expect(executed).toEqual([['close_modal', undefined]]);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
