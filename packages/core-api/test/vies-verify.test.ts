import { describe, expect, it } from 'vitest';
import { InMemoryCacheStore } from '../src/stores/memory.js';
import { TaxVerificationService, summarize } from '../src/verify/service.js';
import { ViesClient } from '../src/vies/client.js';
import { VIES_REST, VIES_SOAP, json, mockFetch, soapFault, soapValid, viesError, viesInvalid, viesValid } from './helpers.js';

describe('ViesClient', () => {
  it('parses a valid REST response and normalises the address', async () => {
    const { fetch, calls } = mockFetch({ [VIES_REST]: viesValid() });
    const r = await new ViesClient({ fetch }).check('IE', '6388047V');
    expect(r).toMatchObject({ status: 'valid', transport: 'rest', name: 'GOOGLE IRELAND LIMITED', address: '3RD FLOOR, GORDON HOUSE, BARROW STREET, DUBLIN 4' });
    expect(JSON.parse(calls[0]!.body)).toEqual({ countryCode: 'IE', vatNumber: '6388047V' });
  });

  it('maps "---" placeholders to undefined for inactive numbers', async () => {
    const { fetch } = mockFetch({ [VIES_REST]: viesInvalid() });
    const r = await new ViesClient({ fetch }).check('DE', '136695976');
    expect(r.status).toBe('invalid');
    expect(r.name).toBeUndefined();
    expect(r.address).toBeUndefined();
  });

  it('falls back to SOAP when the member state is unavailable over REST', async () => {
    const { fetch, calls } = mockFetch({ [VIES_REST]: viesError('MS_UNAVAILABLE'), [VIES_SOAP]: soapValid('ACME &amp; SONS BV') });
    const r = await new ViesClient({ fetch }).check('NL', '004495445B01');
    expect(r).toMatchObject({ status: 'valid', transport: 'soap', name: 'ACME & SONS BV' });
    expect(calls.map((c) => c.url)).toEqual([VIES_REST, VIES_SOAP]);
    expect(calls[1]!.body).toContain('<urn:checkVat>');
  });

  it('reports unavailable when both transports fail transiently', async () => {
    const { fetch } = mockFetch({ [VIES_REST]: viesError('MS_MAX_CONCURRENT_REQ'), [VIES_SOAP]: soapFault('MS_UNAVAILABLE') });
    const r = await new ViesClient({ fetch }).check('FR', '40303265045');
    expect(r).toMatchObject({ status: 'unavailable', errorCode: 'MS_MAX_CONCURRENT_REQ' });
  });

  it('treats INVALID_INPUT as a definitive negative, without SOAP retry', async () => {
    const { fetch, calls } = mockFetch({ [VIES_REST]: viesError('INVALID_INPUT') });
    const r = await new ViesClient({ fetch }).check('BE', '0000000000');
    expect(r).toMatchObject({ status: 'invalid', errorCode: 'INVALID_INPUT' });
    expect(calls).toHaveLength(1);
  });

  it('times out slow registries', async () => {
    const hang = (req: Request) =>
      new Promise<Response>((_, reject) => req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const { fetch } = mockFetch({ [VIES_REST]: hang, [VIES_SOAP]: hang });
    const started = Date.now();
    const r = await new ViesClient({ fetch, timeoutMs: 300 }).check('DE', '136695976');
    expect(r).toMatchObject({ status: 'unavailable', errorCode: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('sends the requester VAT and returns the consultation number', async () => {
    const { fetch, calls } = mockFetch({
      [VIES_REST]: () => json({ countryCode: 'IE', vatNumber: '6388047V', valid: true, requestIdentifier: 'WAPIAAAAZ1x2', name: 'X', address: 'Y', requestDate: '2026-10-15T00:00:00Z' }),
    });
    const r = await new ViesClient({ fetch, requesterVat: 'DE 136 695 976' }).check('IE', '6388047V');
    expect(r.consultationNumber).toBe('WAPIAAAAZ1x2');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ requesterMemberStateCode: 'DE', requesterNumber: '136695976' });
  });

  it('uses checkVatApprox over SOAP when a requester is configured', async () => {
    const { fetch, calls } = mockFetch({
      [VIES_REST]: () => new Response('bad gateway', { status: 502 }),
      [VIES_SOAP]: () =>
        new Response(
          '<e:Envelope xmlns:e="x"><e:Body><r:checkVatApproxResponse xmlns:r="y"><r:valid>true</r:valid><r:traderName>APPROX LTD</r:traderName><r:traderAddress>1 MAIN ST</r:traderAddress><r:requestIdentifier>WAPI-42</r:requestIdentifier></r:checkVatApproxResponse></e:Body></e:Envelope>',
        ),
    });
    const r = await new ViesClient({ fetch, requesterVat: 'IE6388047V' }).check('DE', '136695976');
    expect(r).toMatchObject({ status: 'valid', transport: 'soap', name: 'APPROX LTD', consultationNumber: 'WAPI-42' });
    expect(calls[1]!.body).toContain('<urn:checkVatApprox>');
    expect(calls[1]!.body).toContain('<urn:requesterVatNumber>6388047V</urn:requesterVatNumber>');
  });
});

describe('TaxVerificationService', () => {
  const service = (routes: Parameters<typeof mockFetch>[0], vies = true) => {
    const mf = mockFetch(routes);
    const cache = new InMemoryCacheStore();
    return { svc: new TaxVerificationService({ vies: vies ? new ViesClient({ fetch: mf.fetch, timeoutMs: 1000 }) : null, cache }), calls: mf.calls, cache };
  };

  it('short-circuits invalid numbers without touching the registry', async () => {
    const { svc, calls } = service({ [VIES_REST]: viesValid() });
    const r = await svc.verify('DE136695977');
    expect(r).toMatchObject({ verdict: 'invalid', confidence: 'high', registry: { source: 'none', status: 'skipped' } });
    expect(calls).toHaveLength(0);
  });

  it('confirms active EU numbers against VIES', async () => {
    const { svc } = service({ [VIES_REST]: viesValid() });
    const r = await svc.verify('IE6388047V');
    expect(r).toMatchObject({ verdict: 'registry_verified', confidence: 'high', fallback: false, registry: { source: 'vies', status: 'valid' } });
    expect(summarize(r)).toBe('IE6388047V is active in EU VIES (GOOGLE IRELAND LIMITED).');
  });

  it('flags checksum-valid numbers that VIES does not know', async () => {
    const { svc } = service({ [VIES_REST]: viesInvalid() });
    const r = await svc.verify('DE136695976');
    expect(r.verdict).toBe('registry_not_found');
    expect(summarize(r)).toContain('NOT active');
  });

  it('degrades gracefully to the offline checksum when VIES is down', async () => {
    const { svc } = service({ [VIES_REST]: viesError('SERVICE_UNAVAILABLE'), [VIES_SOAP]: soapFault('SERVICE_UNAVAILABLE') });
    const r = await svc.verify('DE136695976');
    expect(r).toMatchObject({ verdict: 'checksum_valid', fallback: true, confidence: 'medium', registry: { status: 'unavailable', errorCode: 'SERVICE_UNAVAILABLE' } });
    expect(r.fallbackReason).toMatch(/offline checksum/);
  });

  it('caches registry answers but not outages', async () => {
    const ok = service({ [VIES_REST]: viesValid() });
    await ok.svc.verify('IE6388047V');
    const second = await ok.svc.verify('IE 6388047 V');
    expect(second.registry.source).toBe('vies_cache');
    expect(ok.calls).toHaveLength(1);
    const fresh = await ok.svc.verify('IE6388047V', null, { fresh: true });
    expect(fresh.registry.source).toBe('vies');

    const down = service({ [VIES_REST]: viesError('TIMEOUT'), [VIES_SOAP]: soapFault('TIMEOUT') });
    await down.svc.verify('DE136695976');
    await down.svc.verify('DE136695976');
    expect(down.calls.filter((c) => c.url === VIES_REST)).toHaveLength(2);
  });

  it('never queries VIES for non-EU schemes', async () => {
    const { svc, calls } = service({});
    expect(await svc.verify('51824753556', 'AU')).toMatchObject({ verdict: 'checksum_valid', fallback: false, registry: { status: 'not_supported' } });
    expect(await svc.verify('04-3341285', 'US')).toMatchObject({ verdict: 'format_valid', confidence: 'low' });
    expect(calls).toHaveLength(0);
  });

  it('honours liveLookup=false and offline mode', async () => {
    const { svc } = service({});
    expect((await svc.verify('IE6388047V', null, { liveLookup: false })).registry.status).toBe('skipped');
    const offline = service({}, false).svc;
    expect(await offline.verify('IE6388047V')).toMatchObject({ verdict: 'checksum_valid', fallback: true, registry: { errorCode: 'OFFLINE_MODE' } });
  });

  it('uses the EL prefix when querying VIES for Greece and XI for Northern Ireland', async () => {
    const { svc, calls } = service({ [VIES_REST]: viesValid('X', 'Y') });
    await svc.verify('094259216', 'GR');
    await svc.verify('XI980780684');
    expect(calls.map((c) => JSON.parse(c.body).countryCode)).toEqual(['EL', 'XI']);
  });
});
