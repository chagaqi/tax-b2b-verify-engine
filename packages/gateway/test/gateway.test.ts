import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '@tbve/core-api';
import { loadShellAssets } from '../src/assets.js';
import { NodeDnsResolver } from '../src/dns.js';
import { createGateway } from '../src/gateway.js';
// @ts-expect-error build.mjs is plain JS
import { bundle } from '../build.mjs';

const DIST = fileURLToPath(new URL('../dist/server.mjs', import.meta.url));
const ENV = { NODE_ENV: 'test', APP_SECRET: 'x'.repeat(40), PUBLIC_BASE_URL: 'https://gw.test', VIES_MODE: 'offline' };

describe('createGateway', () => {
  it('serves core routes and the embedded shell pages with platform-specific CSP', async () => {
    const gw = await createGateway({ env: ENV, assets: loadShellAssets(), logger: silentLogger });
    expect(gw.storage).toBe('memory');
    expect(await (await gw.app.request('/health')).json()).toMatchObject({ ok: true, viesMode: 'offline' });

    const pd = await gw.app.request('/apps/pipedrive/modal');
    expect(pd.headers.get('content-type')).toContain('text/html');
    expect(pd.headers.get('content-security-policy')).toContain('frame-ancestors https://*.pipedrive.com');
    expect(await pd.text()).toContain('<script type="module" src="./modal.js">');
    expect((await gw.app.request('/apps/pipedrive/modal.js')).headers.get('content-type')).toContain('text/javascript');

    const md = await gw.app.request('/apps/monday/item-view');
    expect(md.headers.get('content-security-policy')).toContain('frame-ancestors https://*.monday.com');
    expect(await (await gw.app.request('/apps/monday/item-view.js')).text()).toContain('export function createItemView');
  });

  it('uses Upstash when configured', async () => {
    const calls: string[] = [];
    const fetch = async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify([{ result: 1 }, { result: 1 }]), { headers: { 'content-type': 'application/json' } });
    };
    const gw = await createGateway({ env: { ...ENV, UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 't' }, assets: loadShellAssets(), logger: silentLogger, fetch });
    expect(gw.storage).toBe('upstash');
    await gw.services.stores.usage.increment('k', 1, 60);
    expect(calls).toEqual(['https://redis.test/pipeline']);
  });

  it('refuses to start in production without secrets and a signing key', async () => {
    await expect(createGateway({ env: { NODE_ENV: 'production' }, assets: loadShellAssets(), logger: silentLogger })).rejects.toThrow('APP_SECRET is required');
    await expect(createGateway({ env: { NODE_ENV: 'production', APP_SECRET: 'y'.repeat(40) }, assets: loadShellAssets(), logger: silentLogger })).rejects.toThrow('CERT_SIGNING_KEY is required');
  });
});

describe('NodeDnsResolver', () => {
  const err = (code: string) => Object.assign(new Error(code), { code });
  it('maps answers and resolver errors', async () => {
    const r = new NodeDnsResolver({
      resolveMx: async () => [{ priority: 10, exchange: 'mx.acme.com' }],
      resolveTxt: async () => [['v=spf1 ', '-all']],
      resolve4: async () => { throw err('ENOTFOUND'); },
      resolve6: async () => { throw err('ENODATA'); },
      resolveNs: async () => { throw err('ETIMEOUT'); },
      resolveCname: async () => [],
    } as never);
    expect(await r.resolve('acme.com', 'MX')).toEqual({ status: 'ok', records: ['10 mx.acme.com'] });
    expect(await r.resolve('acme.com', 'TXT')).toEqual({ status: 'ok', records: ['v=spf1 -all'] });
    expect((await r.resolve('acme.com', 'A')).status).toBe('nxdomain');
    expect((await r.resolve('acme.com', 'AAAA')).status).toBe('nodata');
    expect((await r.resolve('acme.com', 'NS')).status).toBe('error');
    expect((await r.resolve('acme.com', 'CNAME')).status).toBe('nodata');
  });
});

describe('single-file bundle (dist/server.mjs)', () => {
  let proc: ChildProcess | undefined;
  let baseUrl = '';
  let tmp = '';

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tbve-gw-'));
    const port = 20000 + Math.floor(Math.random() * 20000);
    proc = spawn(process.execPath, [DIST], {
      cwd: tmp, // prove the bundle needs nothing next to it
      env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'development', APP_SECRET: 'z'.repeat(40), PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, VIES_MODE: 'offline' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 15_000);
      proc!.stdout!.on('data', (d: Buffer) => {
        if (d.toString().includes('"msg":"listening"')) {
          clearTimeout(timer);
          resolve();
        }
      });
      proc!.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
    });
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    proc?.kill('SIGTERM');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('only imports Node built-ins', () => {
    const code = readFileSync(DIST, 'utf8');
    const specifiers = [...code.matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+)["']|\brequire\(["']([^"']+)["']\)/g)]
      .map((m) => m[1] ?? m[2]!)
      .filter((s) => /^(node:)?[@a-z][\w./@-]*$/i.test(s));
    expect(specifiers).toContain('node:module');
    expect(specifiers.filter((s) => !s.startsWith('node:') && !['fs', 'path', 'crypto', 'stream', 'http', 'http2', 'https', 'zlib', 'url', 'util', 'events', 'net', 'buffer', 'os'].includes(s))).toEqual([]);
  });

  it('is up to date with the sources', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'tbve-build-')), 'server.mjs');
    await bundle(out);
    const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
    expect(hash(out), 'dist/server.mjs is stale — run `pnpm build`').toBe(hash(DIST));
  });

  it('runs end to end: install → verify with certificate → download PDF → verify certificate', async () => {
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    const { apiKey } = (await (await fetch(`${baseUrl}/v1/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Smoke"}' })).json()) as { apiKey: string };
    const v = (await (
      await fetch(`${baseUrl}/v1/verify/tax-id`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify({ taxId: 'DE136695976', certificate: true }) })
    ).json()) as { verdict: string; fallback: boolean; certificate: { pdfUrl: string; verifyUrl: string } };
    expect(v).toMatchObject({ verdict: 'checksum_valid', fallback: true });
    const pdf = await fetch(v.certificate.pdfUrl);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    expect(await (await fetch(v.certificate.verifyUrl)).json()).toMatchObject({ authentic: true, pdfIntact: true });
  });

  it('serves the playground and the shell pages from the bundle', async () => {
    expect(await (await fetch(`${baseUrl}/playground`)).text()).toContain('Tax ID &amp; B2B Domain Playground');
    expect(await (await fetch(`${baseUrl}/apps/monday/item-view`)).text()).toContain('monday-sdk-js@0.5.9');
    expect(await (await fetch(`${baseUrl}/apps/pipedrive/modal.js`)).text()).toContain('export function createModal');
  });
});
