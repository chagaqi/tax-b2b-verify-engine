import { describe, expect, it } from 'vitest';
import { StaticResolver, joinTxt, DohResolver } from '../src/enrich/dns.js';
import { TargetError, isPrivateIp, normalizeDomain, parseTarget } from '../src/enrich/domain.js';
import { extractMetadata, fetchCompanyMetadata } from '../src/enrich/metadata.js';
import { parseDmarc, parseSpf, scorePosture } from '../src/enrich/posture.js';
import { RdapClient, parseRdap } from '../src/enrich/rdap.js';
import { EnrichmentService, detectMailProvider, parseMx } from '../src/enrich/service.js';
import { InMemoryCacheStore } from '../src/stores/memory.js';
import { CORP_ZONE, json, mockFetch } from './helpers.js';

describe('domain parsing & SSRF guard', () => {
  it.each([
    ['https://www.Acme.com/about?x=1', 'acme.com'],
    ['ACME.com.', 'acme.com'],
    ['user@Sub.Acme.co.uk', 'sub.acme.co.uk'],
    ['münchen.de', 'xn--mnchen-3ya.de'],
    ['acme.com:8443', 'acme.com'],
  ])('normalises %s → %s', (input, out) => {
    expect(normalizeDomain(input)).toBe(out);
  });

  it.each(['localhost', '127.0.0.1', '[::1]', 'printer.local', 'db.internal', 'nodots', 'a..b.com', '-bad.com', 'x.123'])('rejects %s', (input) => {
    expect(() => normalizeDomain(input)).toThrow(TargetError);
  });

  it('parses emails and rejects malformed ones', () => {
    expect(parseTarget({ email: 'Jane.Doe+crm@Acme.com' })).toEqual({ email: { address: 'Jane.Doe+crm@acme.com', localPart: 'jane.doe+crm' }, domain: 'acme.com' });
    expect(() => parseTarget({ email: 'not-an-email' })).toThrow(TargetError);
    expect(() => parseTarget({ email: '.dot@acme.com' })).toThrow(/local part/);
    expect(() => parseTarget({})).toThrow(/email or a domain/);
  });

  it.each([
    ['10.1.2.3', true], ['172.20.0.1', true], ['192.168.1.1', true], ['169.254.169.254', true], ['100.64.0.1', true],
    ['127.0.0.1', true], ['0.0.0.0', true], ['::1', true], ['fd00::1', true], ['fe80::1', true], ['::ffff:10.0.0.1', true],
    ['93.184.216.34', false], ['8.8.8.8', false], ['2606:4700::6810:84e5', false],
  ])('isPrivateIp(%s) = %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

describe('DNS', () => {
  it('joins multi-string TXT rdata', () => {
    expect(joinTxt('"v=spf1 include:_spf.google.com" " ~all"')).toBe('v=spf1 include:_spf.google.com ~all');
    expect(joinTxt('"a\\"b"')).toBe('a"b');
  });

  it('DoH resolver parses answers, filters CNAMEs and falls back to the second endpoint', async () => {
    const { fetch, calls } = mockFetch({
      'https://doh-a.test/': () => new Response('boom', { status: 500 }),
      'https://doh-b.test/': () =>
        json({ Status: 0, Answer: [{ type: 5, data: 'alias.example.com.' }, { type: 15, data: '10 mx1.example.com.' }] }),
    });
    const r = new DohResolver(fetch, ['https://doh-a.test/q', 'https://doh-b.test/q']);
    expect(await r.resolve('example.com', 'MX')).toEqual({ status: 'ok', records: ['10 mx1.example.com'] });
    expect(calls[1]!.url).toBe('https://doh-b.test/q?name=example.com&type=MX');
  });

  it('DoH resolver reports NXDOMAIN', async () => {
    const { fetch } = mockFetch({ 'https://doh.test/': () => json({ Status: 3 }) });
    expect(await new DohResolver(fetch, ['https://doh.test/q']).resolve('nope.example', 'A')).toEqual({ status: 'nxdomain', records: [] });
  });

  it('parses MX priorities and RFC 7505 null MX', () => {
    expect(parseMx(['20 b.mx.', '10 a.mx.'])).toEqual({ mx: [{ priority: 10, host: 'a.mx' }, { priority: 20, host: 'b.mx' }], nullMx: false });
    expect(parseMx(['0 .'])).toEqual({ mx: [], nullMx: true });
  });

  it.each([
    ['acme-com.mail.protection.outlook.com', 'Microsoft 365'],
    ['aspmx.l.google.com', 'Google Workspace'],
    ['mx0a-001.pphosted.com', 'Proofpoint'],
    ['eu-smtp-inbound-1.mimecast.com', 'Mimecast'],
    ['mx.unknown-host.net', undefined],
  ])('detects provider for %s', (host, provider) => {
    expect(detectMailProvider([{ priority: 10, host }])).toBe(provider);
  });
});

describe('email security posture', () => {
  it('parses SPF qualifiers, includes and lookup counts', () => {
    const spf = parseSpf(['google-site-verification=x', 'v=spf1 include:_spf.google.com include:mailgun.org mx a ip4:1.2.3.4 -all']);
    expect(spf).toMatchObject({ present: true, allQualifier: 'fail', includes: ['_spf.google.com', 'mailgun.org'], lookupCount: 4, multipleRecords: false });
    expect(parseSpf(['v=spf1 +all']).allQualifier).toBe('pass');
    expect(parseSpf(['v=spf1 redirect=_spf.example.com']).allQualifier).toBe('redirect');
    expect(parseSpf(['v=spf1 -all', 'v=spf1 ~all']).multipleRecords).toBe(true);
    expect(parseSpf([]).present).toBe(false);
  });

  it('parses DMARC tags', () => {
    expect(parseDmarc(['v=DMARC1; p=quarantine; sp=reject; pct=50; rua=mailto:a@x.com,mailto:b@x.com; adkim=s'])).toMatchObject({
      present: true, policy: 'quarantine', subdomainPolicy: 'reject', pct: 50, rua: ['mailto:a@x.com', 'mailto:b@x.com'], alignment: { dkim: 'strict', spf: 'relaxed' },
    });
    expect(parseDmarc(['v=spf1 -all']).present).toBe(false);
  });

  it('grades a hardened domain A and a bare one F', () => {
    const strong = scorePosture({
      hasMx: true, nullMx: false, spf: parseSpf(['v=spf1 -all']), dmarc: parseDmarc(['v=DMARC1; p=reject; rua=mailto:r@x.com']),
      dkimSelectors: ['google'], dkimProbed: ['google'], mtaSts: true, bimi: { present: true },
    });
    expect(strong).toMatchObject({ score: 100, grade: 'A', findings: [] });
    const weak = scorePosture({ hasMx: false, nullMx: false, spf: parseSpf([]), dmarc: parseDmarc([]), dkimSelectors: [], dkimProbed: ['default'], mtaSts: false, bimi: { present: false } });
    expect(weak.grade).toBe('F');
    expect(weak.findings).toEqual(expect.arrayContaining(['No SPF record', 'No DMARC record']));
  });

  it('penalises +all and multiple SPF records', () => {
    const p = scorePosture({ hasMx: true, nullMx: false, spf: parseSpf(['v=spf1 +all', 'v=spf1 -all']), dmarc: parseDmarc([]), dkimSelectors: [], dkimProbed: [], mtaSts: false, bimi: { present: false } });
    expect(p.findings).toEqual(expect.arrayContaining([expect.stringContaining('+all'), expect.stringContaining('Multiple SPF')]));
    expect(p.score).toBeLessThan(20);
  });
});

describe('RDAP', () => {
  const sample = {
    events: [
      { eventAction: 'registration', eventDate: '2020-10-15T00:00:00Z' },
      { eventAction: 'expiration', eventDate: '2030-10-15T00:00:00Z' },
    ],
    status: ['client transfer prohibited'],
    entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Example Registrar Inc.']]], publicIds: [{ type: 'IANA Registrar ID', identifier: '9999' }] }],
    nameservers: [{ ldhName: 'NS1.EXAMPLE.NET' }],
    secureDNS: { delegationSigned: true },
  } as Parameters<typeof parseRdap>[0];

  it('extracts registrar, dates, age and DNSSEC', () => {
    expect(parseRdap(sample, new Date('2026-10-15T00:00:00Z'))).toMatchObject({
      available: true, registrar: 'Example Registrar Inc.', registrarIanaId: '9999', ageDays: 2191, nameservers: ['ns1.example.net'], dnssec: true,
    });
  });

  it('routes via the IANA bootstrap and sends an identifying User-Agent', async () => {
    const { fetch, calls } = mockFetch({
      'https://data.iana.org/rdap/dns.json': () => json({ services: [[['com', 'net'], ['https://rdap.registry.test/']]] }),
      'https://rdap.registry.test/domain/acme.com': () => json(sample),
    });
    const r = await new RdapClient(fetch).lookup('acme.com');
    expect(r.registrar).toBe('Example Registrar Inc.');
    expect(calls[1]!.headers.get('user-agent')).toMatch(/TaxB2BVerifyBot/);
  });

  it('falls back to rdap.org for TLDs missing from the bootstrap and reports 404s', async () => {
    const { fetch, calls } = mockFetch({
      'https://data.iana.org/rdap/dns.json': () => json({ services: [] }),
      'https://rdap.org/domain/acme.ie': () => new Response('', { status: 404 }),
    });
    const r = await new RdapClient(fetch).lookup('acme.ie');
    expect(r).toMatchObject({ available: false });
    expect(calls.map((c) => c.url)).toContain('https://rdap.org/domain/acme.ie');
  });
});

const HOMEPAGE = `<!doctype html><html><head>
<title>Acme Robotics &amp; Co — Industrial automation</title>
<meta name="description" content="We build robots.">
<meta property="og:site_name" content="Acme Robotics">
<link rel="icon" href="/favicon.ico">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"x"},
{"@type":"Organization","name":"Acme Robotics","legalName":"Acme Robotics GmbH","logo":{"url":"/logo.svg"},"vatID":"DE 136 695 976",
"telephone":"+49 30 123","address":{"@type":"PostalAddress","streetAddress":"Hauptstr. 1","addressLocality":"Berlin","postalCode":"10115","addressCountry":"DE"},
"sameAs":["https://www.linkedin.com/company/acme-robotics","https://x.com/acmerobotics"]}]}</script>
</head><body><footer>Impressum · USt-IdNr.: ATU13585627 · <a href="https://github.com/acme-robotics">GitHub</a>
<a href="https://twitter.com/intent/tweet?text=x">share</a></footer></body></html>`;

describe('website metadata', () => {
  it('extracts JSON-LD organisation data, socials and VAT numbers', () => {
    const m = extractMetadata(HOMEPAGE, 'https://acme.example.com/');
    expect(m).toMatchObject({
      siteTitle: 'Acme Robotics & Co — Industrial automation',
      name: 'Acme Robotics',
      legalName: 'Acme Robotics GmbH',
      description: 'We build robots.',
      logo: 'https://acme.example.com/logo.svg',
      icon: 'https://acme.example.com/favicon.ico',
      telephone: '+49 30 123',
      address: { street: 'Hauptstr. 1', locality: 'Berlin', postalCode: '10115', country: 'DE' },
      socials: { linkedin: 'https://www.linkedin.com/company/acme-robotics', twitter: 'https://x.com/acmerobotics', github: 'https://github.com/acme-robotics' },
    });
    expect(m.detectedTaxIds).toEqual([
      { value: 'DE136695976', jurisdiction: 'DE', valid: true, source: 'json-ld' },
      { value: 'ATU13585627', jurisdiction: 'AT', valid: true, source: 'page-text' },
    ]);
  });

  it('refuses to fetch hosts that resolve to private addresses', async () => {
    const { fetch, calls } = mockFetch({});
    const dns = new StaticResolver({ 'evil.example.com': { A: ['169.254.169.254'] } });
    const m = await fetchCompanyMetadata('evil.example.com', { fetch, dns });
    expect(m).toMatchObject({ fetched: false, error: expect.stringContaining('private address') });
    expect(calls).toHaveLength(0);
  });

  it('follows redirects but re-checks every hop', async () => {
    const { fetch } = mockFetch({
      'https://acme.example.com/': () => new Response(null, { status: 301, headers: { location: 'https://www.acme.example.com/' } }),
      'https://www.acme.example.com/': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }),
    });
    const dns = new StaticResolver({ 'acme.example.com': { A: ['93.184.216.34'] }, 'www.acme.example.com': { A: ['93.184.216.34'] } });
    const m = await fetchCompanyMetadata('acme.example.com', { fetch, dns });
    expect(m).toMatchObject({ fetched: false, error: 'IP literals are not allowed' });
  });

  it('caps the body and rejects non-HTML', async () => {
    const dns = new StaticResolver({ 'acme.example.com': { A: ['93.184.216.34'] } });
    const pdf = mockFetch({ 'https://acme.example.com/': () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }) });
    expect((await fetchCompanyMetadata('acme.example.com', { fetch: pdf.fetch, dns })).error).toMatch(/content-type/);
    const big = mockFetch({ 'https://acme.example.com/': () => new Response(`<title>Big</title>${'x'.repeat(2_000_000)}`, { headers: { 'content-type': 'text/html' } }) });
    expect(await fetchCompanyMetadata('acme.example.com', { fetch: big.fetch, dns, maxBytes: 1024 })).toMatchObject({ fetched: true, siteTitle: 'Big' });
  });
});

describe('EnrichmentService', () => {
  const svc = (zone: ConstructorParameters<typeof StaticResolver>[0], routes = {}) => {
    const mf = mockFetch({ 'https://data.iana.org/': () => json({ services: [] }), 'https://rdap.org/': () => new Response('', { status: 404 }), ...routes });
    return new EnrichmentService({ dns: new StaticResolver(zone), fetch: mf.fetch, rdap: new RdapClient(mf.fetch), cache: new InMemoryCacheStore() });
  };

  it('classifies a hardened corporate domain as low risk', async () => {
    const r = await svc(CORP_ZONE, { 'https://acme.example.com/': () => new Response(HOMEPAGE, { headers: { 'content-type': 'text/html' } }) }).enrich({ email: 'jane@acme.example.com' });
    expect(r).toMatchObject({
      classification: 'corporate',
      dns: { resolves: true, mailProvider: 'Google Workspace' },
      security: { grade: 'A', dkim: { found: true, selectors: ['google'] }, mtaSts: { present: true } },
      email: { isRole: false, isFreeProvider: false, isDisposable: false, deliverability: 'likely' },
      risk: { level: 'low' },
      company: { legalName: 'Acme Robotics GmbH' },
    });
  });

  it('flags role mailboxes', async () => {
    const r = await svc(CORP_ZONE).enrich({ email: 'billing@acme.example.com' }, { metadata: false });
    expect(r.email?.isRole).toBe(true);
    expect(r.risk.reasons).toContain('Role-based mailbox (not a named person)');
  });

  it.each([
    ['mailinator.com', { MX: ['10 mail.mailinator.com.'] }, 'domain_list'],
    ['my-tempmail.example.com', { MX: ['10 mx.tempmail-host.net.'] }, 'pattern'],
    ['fresh-throwaway.example.com', { MX: ['10 mx1.guerrillamail.com.'] }, 'mx_host'],
  ])('detects disposable %s via %s', async (domain, records, reason) => {
    const r = await svc({ [domain]: records }).enrich({ domain });
    expect(r).toMatchObject({ classification: 'disposable', disposable: { value: true, reason }, risk: { level: 'high' } });
  });

  it('classifies free providers and skips the website fetch', async () => {
    const r = await svc({ 'gmail.com': { MX: ['5 gmail-smtp-in.l.google.com.'] } }).enrich({ email: 'someone@gmail.com' });
    expect(r).toMatchObject({ classification: 'free_provider', freeProvider: true, risk: { level: 'medium' } });
    expect(r.company).toBeUndefined();
  });

  it('marks unresolvable and mail-less domains', async () => {
    expect((await svc({}).enrich({ domain: 'nope.example.com' })).classification).toBe('unresolvable');
    const r = await svc({ 'web-only.example.com': { A: ['93.184.216.34'], MX: ['0 .'] } }).enrich({ domain: 'web-only.example.com' }, { metadata: false });
    expect(r).toMatchObject({ classification: 'no_mail', dns: { nullMx: true } });
  });

  it('caches per domain', async () => {
    const s = svc(CORP_ZONE);
    const a = await s.enrich({ domain: 'acme.example.com' }, { metadata: false });
    const b = await s.enrich({ email: 'x@acme.example.com' }, { metadata: false });
    expect(b.checkedAt).toBe(a.checkedAt);
  });
});
