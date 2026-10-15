import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { StaticResolver } from '../src/enrich/dns.js';
import { CORP_ZONE, VIES_REST, json, makeApp, viesValid } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof makeApp>>;

/** Boot the real /playground page + /playground/app.js in a headless DOM wired to the app. */
async function boot(ctx: Ctx) {
  const page = await ctx.request('/playground');
  const html = await page.text();
  const js = await (await ctx.request('/playground/app.js')).text();
  const window = new Window({ url: 'https://verify.test/playground', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  const w = window as unknown as Record<string, unknown> & { document: Document; eval: (code: string) => unknown };
  w.fetch = async (path: string, init?: RequestInit) => ctx.request(path, init ?? {});
  w.document.write(html);
  w.eval(js);
  const $ = <T extends Element = HTMLElement>(sel: string) => w.document.querySelector(sel) as unknown as T;
  const until = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('timed out waiting for the UI');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const submit = (formSel: string) => $(formSel).dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }) as unknown as Event);
  return { page, w, $, until, submit, window };
}

describe('playground (headless UI)', () => {
  it('serves the page with a strict CSP and no inline script', async () => {
    const ctx = await makeApp();
    const { page, w } = await boot(ctx);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(w.document.querySelectorAll('script:not([src])')).toHaveLength(0);
    expect(w.__playgroundReady).toBe(true);
    expect(w.document.title).toBe('Tax ID Playground');
  });

  it('verifies a tax ID, renders the verdict and links a watermarked certificate', async () => {
    const ctx = await makeApp({ routes: { [VIES_REST]: viesValid() } });
    const { $, until, submit } = await boot(ctx);
    $<HTMLButtonElement>('.chip[data-tax-id="IE6388047V"]').click();
    expect($<HTMLInputElement>('#taxId').value).toBe('IE6388047V');
    submit('#tax-form');
    await until(() => $('#tax-result').querySelector('.badge') !== null);
    const box = $('#tax-result');
    expect(box.querySelector('.badge')?.textContent).toBe('Verified in EU VIES');
    expect(box.textContent).toContain('GOOGLE IRELAND LIMITED');
    const link = box.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent).toBe('Download signed PDF');
    const pdfUrl = new URL(link.getAttribute('href')!);
    const pdf = await ctx.request(pdfUrl.pathname + pdfUrl.search);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const cert = await ctx.services.certificates.verify(pdfUrl.pathname.split('/').pop()!.replace('.pdf', ''));
    expect(cert?.payload.sample).toBe(true);
  });

  it('renders API errors safely (no HTML injection)', async () => {
    const ctx = await makeApp();
    const { $, until, submit } = await boot(ctx);
    $<HTMLInputElement>('#taxId').value = '<img src=x onerror=alert(1)>';
    submit('#tax-form');
    await until(() => $('#tax-result .err') !== null);
    expect($('#tax-result').querySelector('img')).toBeNull();
    expect($('#tax-result .err').textContent).toMatch(/infer the jurisdiction/);
  });

  it('switches tabs and enriches a domain', async () => {
    const ctx = await makeApp({ dns: new StaticResolver(CORP_ZONE), routes: { 'https://data.iana.org/': () => json({ services: [] }), 'https://rdap.org/': () => new Response('', { status: 404 }) } });
    const { $, until, submit } = await boot(ctx);
    $<HTMLButtonElement>('#tab-domain').click();
    expect($('#panel-domain').hidden).toBe(false);
    expect($('#panel-tax').hidden).toBe(true);
    $<HTMLInputElement>('#target').value = 'cfo@acme.example.com';
    submit('#domain-form');
    await until(() => $('#domain-result').querySelector('.badge') !== null);
    expect($('#domain-result .badge').textContent).toBe('corporate · risk low');
    expect($('#domain-result').textContent).toContain('Google Workspace');
    expect($('#domain-result').textContent).toContain('A (90/100)');
  });

  it('rate-limits playground API calls per IP', async () => {
    const ctx = await makeApp({ env: { PLAYGROUND_LIMIT: '2' } });
    const call = () => ctx.request('/v1/playground/verify-tax-id', { method: 'POST', json: { taxId: '51824753556', country: 'AU' } });
    expect((await call()).status).toBe(200);
    const second = await call();
    expect(second.headers.get('x-ratelimit-remaining')).toBe('0');
    const third = await call();
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('rate-limits page views separately and does not meter tenants', async () => {
    const ctx = await makeApp({ env: { PLAYGROUND_PAGE_LIMIT: '1' } });
    expect((await ctx.request('/playground')).status).toBe(200);
    expect((await ctx.request('/playground')).status).toBe(429);
    expect((await ctx.request('/v1/playground/verify-tax-id', { method: 'POST', json: { taxId: '51824753556', country: 'AU' } })).status).toBe(200);
  });
});
