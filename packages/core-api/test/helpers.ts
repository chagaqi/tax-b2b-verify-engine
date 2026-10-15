import { createApp, loadConfig, type AppConfig, type CoreDeps } from '../src/index.js';
import { CertificateSigner } from '../src/certificates/signer.js';
import { StaticResolver, type DnsResolver } from '../src/enrich/dns.js';
import type { FetchLike } from '../src/lib/http.js';
import { silentLogger } from '../src/services.js';
import { createMemoryStores } from '../src/stores/memory.js';
import type { Stores } from '../src/stores/types.js';

export type Handler = (req: Request) => Response | Promise<Response>;

/** Route outbound fetches by URL prefix; records every call; unmatched → 599. */
export function mockFetch(routes: Record<string, Handler> = {}) {
  const calls: { url: string; method: string; body: string; headers: Headers }[] = [];
  const fn: FetchLike = async (input, init) => {
    const req = new Request(input as string, init);
    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.clone().text();
    calls.push({ url: req.url, method: req.method, body, headers: req.headers });
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => req.url.startsWith(k));
    if (!key) return new Response('no mock for ' + req.url, { status: 599 });
    return routes[key]!(req);
  };
  return { fetch: fn, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const VIES_REST = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';
export const VIES_SOAP = 'https://ec.europa.eu/taxation_customs/vies/services/checkVatService';

export function viesValid(name = 'GOOGLE IRELAND LIMITED', address = '3RD FLOOR, GORDON HOUSE,\nBARROW STREET, DUBLIN 4') {
  return async (req: Request) => {
    const b = (await req.json()) as { countryCode: string; vatNumber: string };
    return json({ countryCode: b.countryCode, vatNumber: b.vatNumber, requestDate: '2026-10-15T10:00:00.000Z', valid: true, requestIdentifier: '', name, address, traderName: '---' });
  };
}

export function viesInvalid() {
  return async (req: Request) => {
    const b = (await req.json()) as { countryCode: string; vatNumber: string };
    return json({ countryCode: b.countryCode, vatNumber: b.vatNumber, requestDate: '2026-10-15T10:00:00.000Z', valid: false, requestIdentifier: '', name: '---', address: '---' });
  };
}

export const viesError = (code: string) => () => json({ actionSucceed: false, errorWrappers: [{ error: code }] });

export const soapValid = (name = 'ACME BV', address = 'DAM 1 AMSTERDAM') => () =>
  new Response(
    `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><ns2:checkVatResponse xmlns:ns2="urn:ec.europa.eu:taxud:vies:services:checkVat:types"><ns2:countryCode>NL</ns2:countryCode><ns2:vatNumber>004495445B01</ns2:vatNumber><ns2:requestDate>2026-10-15+02:00</ns2:requestDate><ns2:valid>true</ns2:valid><ns2:name>${name}</ns2:name><ns2:address>${address}</ns2:address></ns2:checkVatResponse></env:Body></env:Envelope>`,
    { headers: { 'content-type': 'text/xml' } },
  );

export const soapFault = (code: string) => () =>
  new Response(`<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><env:Fault><faultcode>env:Server</faultcode><faultstring>${code}</faultstring></env:Fault></env:Body></env:Envelope>`);

let signerPromise: Promise<CertificateSigner> | undefined;
export const testSigner = () => (signerPromise ??= CertificateSigner.ephemeral());

export interface TestAppOptions {
  env?: Record<string, string>;
  routes?: Record<string, Handler>;
  dns?: DnsResolver;
  now?: () => Date;
  stores?: Stores;
  vies?: CoreDeps['vies'];
  ip?: string;
}

export const TEST_ENV = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'https://verify.test',
  APP_SECRET: 'test-secret-0123456789-0123456789-abcdef',
  STRIPE_WEBHOOK_SECRET: 'whsec_stripe_test',
  POLAR_WEBHOOK_SECRET: 'polar_secret_test',
  MONDAY_SIGNING_SECRET: 'monday_signing_test',
  MONDAY_CLIENT_SECRET: 'monday_client_test',
  STRIPE_APP_SECRET: 'absec_stripe_app_test',
  HUBSPOT_CLIENT_ID: 'hs-client-id',
  HUBSPOT_CLIENT_SECRET: 'hs-client-secret',
  PIPEDRIVE_CLIENT_ID: 'pd-client-id',
  PIPEDRIVE_CLIENT_SECRET: 'pd-client-secret',
  PIPEDRIVE_JWT_SECRET: 'pd-jwt-secret',
  PIPEDRIVE_BASIC_USER: 'pd-user',
  PIPEDRIVE_BASIC_PASSWORD: 'pd-pass',
  UPGRADE_URL_STRIPE: 'https://buy.stripe.com/test_abc',
  VIES_TIMEOUT_MS: '3000',
};

export async function makeApp(o: TestAppOptions = {}) {
  const config: AppConfig = loadConfig({ ...TEST_ENV, ...o.env });
  const mf = mockFetch(o.routes ?? {});
  const stores = o.stores ?? createMemoryStores();
  const { app, services } = createApp({
    config,
    stores,
    signer: await testSigner(),
    fetch: mf.fetch,
    dns: o.dns ?? new StaticResolver({}),
    logger: silentLogger,
    getClientIp: () => o.ip ?? '203.0.113.7',
    ...(o.now ? { now: o.now } : {}),
    ...(o.vies !== undefined ? { vies: o.vies } : {}),
  });
  const request = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json: body, headers, ...rest } = init;
    const h = new Headers(headers);
    if (body !== undefined) h.set('content-type', 'application/json');
    return app.request(path, { ...rest, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  };
  const install = async (name = 'Acme Ltd') => {
    const res = await request('/v1/install', { method: 'POST', json: { name } });
    const j = (await res.json()) as { apiKey: string; tenantId: string };
    return j;
  };
  return { app, services, stores, config, calls: mf.calls, request, install };
}

export const CORP_ZONE = {
  'acme.example.com': {
    MX: ['10 aspmx.l.google.com.', '20 alt1.aspmx.l.google.com.'],
    TXT: ['v=spf1 include:_spf.google.com ~all', 'google-site-verification=abc'],
    A: ['93.184.216.34'],
  },
  '_dmarc.acme.example.com': { TXT: ['v=DMARC1; p=reject; rua=mailto:dmarc@acme.example.com; pct=100'] },
  'google._domainkey.acme.example.com': { TXT: ['v=DKIM1; k=rsa; p=MIIBIjANBgkqh'] },
  '_mta-sts.acme.example.com': { TXT: ['v=STSv1; id=2026'] },
  'default._bimi.acme.example.com': 'NXDOMAIN' as const,
};
