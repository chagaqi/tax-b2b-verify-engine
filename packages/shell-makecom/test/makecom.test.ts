import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { StaticResolver } from '../../core-api/src/enrich/dns.js';
import { CORP_ZONE, VIES_REST, json, makeApp, viesValid } from '../../core-api/test/helpers.js';

const root = new URL('../', import.meta.url);
// Make app files are loosely-typed JSON; tests index into them freely.
const load = <T = any>(rel: string): T => JSON.parse(readFileSync(new URL(rel, root), "utf8"));
const manifest = load('makecomapp.json');
const base = load('app/base.imljson');

type Scope = Record<string, unknown>;

/** Minimal IML evaluator: `{{a.b}}` lookups; a whole-string expression keeps its type; undefined keys are omitted. */
function iml(value: unknown, scope: Scope): unknown {
  const lookup = (expr: string) => expr.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Scope)[k]), scope);
  if (typeof value === 'string') {
    const whole = /^\{\{([^{}]+)\}\}$/.exec(value);
    if (whole) return lookup(whole[1]!.trim());
    return value.replace(/\{\{([^{}]+)\}\}/g, (_, e: string) => String(lookup(e.trim()) ?? ''));
  }
  if (Array.isArray(value)) return value.map((v) => iml(v, scope));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, iml(v, scope)]).filter(([, v]) => v !== undefined));
  }
  return value;
}

const templateParams = (obj: unknown): string[] => [...JSON.stringify(obj).matchAll(/\{\{parameters\.(\w+)\}\}/g)].map((m) => m[1]!);

async function ctx() {
  const app = await makeApp({
    routes: { [VIES_REST]: viesValid(), 'https://data.iana.org/': () => json({ services: [] }), 'https://rdap.org/': () => new Response('', { status: 404 }) },
    dns: new StaticResolver(CORP_ZONE),
  });
  const { apiKey } = await app.install('Make scenario');
  /** Execute a module/RPC api.imljson the way Make does: base URL + base headers + module request. */
  const run = async (apiFile: string, parameters: Scope) => {
    const api = load(apiFile);
    const scope = { parameters, connection: { apiKey } };
    const url = new URL(String(iml(api.url, scope)), String(base.baseUrl));
    const headers = { ...(iml(base.headers, scope) as Record<string, string>), ...((iml(api.headers ?? {}, scope) as Record<string, string>) ?? {}) };
    const body = api.body ? JSON.stringify(iml(api.body, scope)) : undefined;
    const res = await app.request(url.pathname + url.search, { method: api.method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body } : {}) });
    const resBody = await res.json();
    return { status: res.status, body: resBody, output: iml(api.response.output ?? '{{body}}', { body: resBody }), api };
  };
  return { app, apiKey, run };
}

/** Interface paths absent from the actual output (recursing into collections that are present). */
function missingFields(spec: { name: string; type: string; spec?: unknown }[], output: Record<string, unknown>, path = ''): string[] {
  const missing: string[] = [];
  for (const f of spec) {
    if (!(f.name in output)) {
      missing.push(path + f.name);
      continue;
    }
    const v = output[f.name];
    if (f.type === 'collection' && Array.isArray(f.spec) && v && typeof v === 'object') {
      missing.push(...missingFields(f.spec as typeof spec, v as Record<string, unknown>, `${path}${f.name}.`));
    }
  }
  return missing;
}

/** Fields that are legitimately absent for the fixtures used below (no requester VAT, no JSON-LD, no RDAP server). */
const OPTIONAL = new Set([
  'registry.consultationNumber',
  'company.name', 'company.legalName', 'company.description', 'company.logo',
  'registration.registrar', 'registration.registeredAt', 'registration.ageDays',
  'disposable.reason', 'upgradeUrl',
]);
const assertInterface = (spec: Parameters<typeof missingFields>[0], output: Record<string, unknown>) =>
  missingFields(spec, output).filter((p) => !OPTIONAL.has(p));

describe('Make.com app manifest', () => {
  it('references code files that exist and parse', () => {
    const files: string[] = [
      ...Object.values(manifest.generalCodeFiles as Record<string, string>),
      ...Object.values(manifest.components as Record<string, Record<string, { codeFiles: Record<string, string> }>>).flatMap((group) =>
        Object.values(group).flatMap((c) => Object.values(c.codeFiles)),
      ),
    ];
    expect(files.length).toBeGreaterThan(15);
    for (const f of files) {
      expect(existsSync(new URL(f, root)), f).toBe(true);
      if (f.endsWith('.imljson')) expect(() => load(f)).not.toThrow();
    }
  });

  it('declares four action modules, one API-key connection and a country RPC', () => {
    expect(Object.keys(manifest.components.module)).toEqual(['verifyTaxId', 'enrichCompany', 'getCertificate', 'getUsage']);
    expect(Object.keys(manifest.components.connection)).toEqual(['apiKey']);
    expect(Object.keys(manifest.components.rpc)).toEqual(['listCountries']);
  });

  it('base sends the key header and masks it in logs', () => {
    expect(base.headers['x-api-key']).toBe('{{connection.apiKey}}');
    expect(base.log.sanitize).toContain('request.headers.x-api-key');
  });

  it.each(['verifyTaxId', 'enrichCompany', 'getCertificate', 'getUsage'])('%s: every template parameter is mappable and vice versa', (m) => {
    const used = new Set(templateParams(load(`app/modules/${m}/api.imljson`)));
    const declared = new Set(load<{ name: string }[]>(`app/modules/${m}/mappable.imljson`).map((p) => p.name));
    expect([...used].sort()).toEqual([...declared].sort());
  });

  it.each(['verifyTaxId', 'enrichCompany', 'getCertificate', 'getUsage'])('%s: samples only use interface fields', (m) => {
    const names = new Set(load<{ name: string }[]>(`app/modules/${m}/interface.imljson`).map((f) => f.name));
    expect(Object.keys(load(`app/modules/${m}/samples.imljson`)).filter((k) => !names.has(k))).toEqual([]);
  });
});

describe('Make.com modules against the real API', () => {
  it('connection test call succeeds and labels the connection', async () => {
    const { app, apiKey } = await ctx();
    const conn = load('app/connections/apiKey/api.imljson');
    const scope = { parameters: { apiKey } };
    const url = new URL(String(iml(conn.url, scope)));
    const res = await app.request(url.pathname, { headers: iml(conn.headers, scope) as Record<string, string> });
    expect(res.status).toBe(200);
    expect(iml(conn.response.metadata.value, { body: await res.json() })).toMatch(/^tnt_[\w-]+ \(Free plan\)$/);
  });

  it('Verify a Tax ID → Get a Certificate round trip; interfaces match real responses', async () => {
    const { run } = await ctx();
    const v = await run('app/modules/verifyTaxId/api.imljson', { taxId: 'IE 6388047V', certificate: true });
    expect(v.status).toBe(200);
    expect(v.output).toMatchObject({ verdict: 'registry_verified', valid: true, certificate: { id: expect.stringMatching(/^tvc_/) } });
    expect(assertInterface(load('app/modules/verifyTaxId/interface.imljson'), v.output as Record<string, unknown>)).toEqual([]);

    const certId = (v.output as { certificate: { id: string } }).certificate.id;
    const c = await run('app/modules/getCertificate/api.imljson', { certificateId: certId });
    expect(c.status).toBe(200);
    expect(assertInterface(load('app/modules/getCertificate/interface.imljson'), c.output as Record<string, unknown>)).toEqual([]);
  });

  it('Enrich a Company Domain and Get Usage return every interface field', async () => {
    const { run } = await ctx();
    const e = await run('app/modules/enrichCompany/api.imljson', { email: 'cfo@acme.example.com' });
    expect(e.status).toBe(200);
    const missing = assertInterface(load('app/modules/enrichCompany/interface.imljson'), e.output as Record<string, unknown>);
    expect(missing).toEqual([]);
    const u = await run('app/modules/getUsage/api.imljson', {});
    expect(u.output).toMatchObject({ plan: { id: 'free' }, usage: { taxVerifications: { used: 0 }, enrichments: { used: 1 } } });
  });

  it('country RPC yields 49 options whose values the API accepts', async () => {
    const { app, run } = await ctx();
    const rpc = load('app/rpcs/listCountries/api.imljson');
    const res = await app.request(rpc.url);
    const body = await res.json();
    const items = iml(rpc.response.iterate, { body }) as unknown[];
    const options = items.map((item) => iml(rpc.response.output, { item }) as { label: string; value: string });
    expect(options).toHaveLength(49);
    expect(options).toContainEqual({ label: 'Australia — Australian Business Number / ACN', value: 'AU' });
    const v = await run('app/modules/verifyTaxId/api.imljson', { taxId: '51 824 753 556', country: options.find((o) => o.value === 'AU')!.value });
    expect(v.output).toMatchObject({ verdict: 'checksum_valid', taxId: { formatted: '51 824 753 556' } });
  });

  it('base error template renders the API error message', async () => {
    const { run } = await ctx();
    const bad = await run('app/modules/verifyTaxId/api.imljson', { taxId: '123456789' });
    expect(bad.status).toBe(422);
    expect(iml(base.response.error.message, { statusCode: bad.status, body: bad.body })).toMatch(/^\[422\] Cannot infer the jurisdiction/);
  });
});
