import { fetchWithTimeout, type FetchLike } from '../lib/http.js';

/**
 * Client for the European Commission's free VIES registry.
 *
 *  - REST:  POST https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number
 *  - SOAP:  https://ec.europa.eu/taxation_customs/vies/services/checkVatService
 *
 * REST is tried first; on a transient failure (member state down, throttling,
 * network error, 5xx) the SOAP endpoint is tried with whatever time budget is
 * left. Callers treat `unavailable` as "fall back to checksum validation".
 */

export type ViesStatus = 'valid' | 'invalid' | 'unavailable';

export interface ViesResult {
  status: ViesStatus;
  countryCode: string;
  vatNumber: string;
  name?: string;
  address?: string;
  requestDate?: string;
  /** VIES consultation number — only issued when a requester VAT number is configured. */
  consultationNumber?: string;
  errorCode?: string;
  transport: 'rest' | 'soap';
  latencyMs: number;
}

export interface ViesClientOptions {
  fetch?: FetchLike;
  /** Total budget across REST + SOAP attempts. */
  timeoutMs?: number;
  /** Your own EU VAT number, e.g. `DE123456789`. Makes VIES return a consultation number. */
  requesterVat?: string;
  restUrl?: string;
  soapUrl?: string;
  now?: () => number;
}

export const VIES_REST_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';
export const VIES_SOAP_URL = 'https://ec.europa.eu/taxation_customs/vies/services/checkVatService';

/**
 * The only VIES error that says something about the number itself. Every other code
 * (MS_UNAVAILABLE, TIMEOUT, IP_BLOCKED, VAT_BLOCKED, throttling, unknown faults…) is an
 * outage from our point of view and must never be reported as "not registered".
 */
const NUMBER_ERRORS = new Set(['INVALID_INPUT']);
const errorStatus = (code: string): ViesStatus => (NUMBER_ERRORS.has(code) ? 'invalid' : 'unavailable');

const PLACEHOLDER = /^-+$/;

function clean(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/,+$/, '').trim())
    .filter(Boolean)
    .join(', ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s && !PLACEHOLDER.test(s) ? s : undefined;
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function xmlTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(xml);
  return m ? xmlUnescape(m[1]!) : undefined;
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

export class ViesClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly requester?: { countryCode: string; vatNumber: string };
  private readonly restUrl: string;
  private readonly soapUrl: string;
  private readonly now: () => number;

  constructor(opts: ViesClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 6000;
    this.restUrl = opts.restUrl ?? VIES_REST_URL;
    this.soapUrl = opts.soapUrl ?? VIES_SOAP_URL;
    this.now = opts.now ?? Date.now;
    const req = opts.requesterVat?.replace(/[\s.-]/g, '').toUpperCase();
    if (req && /^[A-Z]{2}[0-9A-Z+*]{2,13}$/.test(req)) {
      this.requester = { countryCode: req.slice(0, 2), vatNumber: req.slice(2) };
    }
  }

  async check(countryCode: string, vatNumber: string, budgetMs = this.timeoutMs): Promise<ViesResult> {
    const started = this.now();
    const rest = await this.checkRest(countryCode, vatNumber, budgetMs);
    if (rest.status !== 'unavailable') return rest;
    const left = budgetMs - (this.now() - started);
    if (left < 250) return rest;
    const soap = await this.checkSoap(countryCode, vatNumber, left);
    // Prefer whichever transport produced an answer; otherwise report the REST error.
    return soap.status !== 'unavailable' ? soap : { ...rest, latencyMs: this.now() - started };
  }

  async checkRest(countryCode: string, vatNumber: string, timeoutMs: number): Promise<ViesResult> {
    const started = this.now();
    const base = { countryCode, vatNumber, transport: 'rest' as const };
    const body: Record<string, string> = { countryCode, vatNumber };
    if (this.requester) {
      body.requesterMemberStateCode = this.requester.countryCode;
      body.requesterNumber = this.requester.vatNumber;
    }
    try {
      const res = await fetchWithTimeout(
        this.fetchImpl,
        this.restUrl,
        { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) },
        timeoutMs,
      );
      if (!res.ok) return { ...base, status: 'unavailable', errorCode: res.status >= 500 ? 'HTTP_ERROR' : `HTTP_${res.status}`, latencyMs: this.now() - started };
      const json = (await res.json()) as Record<string, unknown>;
      if (json.actionSucceed === false) {
        const wrappers = (json.errorWrappers as { error?: string }[] | undefined) ?? [];
        const code = wrappers[0]?.error ?? 'UNKNOWN_ERROR';
        return { ...base, status: errorStatus(code), errorCode: code, latencyMs: this.now() - started };
      }
      if (typeof json.valid !== 'boolean') {
        return { ...base, status: 'unavailable', errorCode: 'UNEXPECTED_RESPONSE', latencyMs: this.now() - started };
      }
      const consultation = clean(json.requestIdentifier);
      return {
        ...base,
        status: json.valid ? 'valid' : 'invalid',
        ...(clean(json.name) ? { name: clean(json.name)! } : {}),
        ...(clean(json.address) ? { address: clean(json.address)! } : {}),
        ...(typeof json.requestDate === 'string' ? { requestDate: json.requestDate } : {}),
        ...(consultation ? { consultationNumber: consultation } : {}),
        latencyMs: this.now() - started,
      };
    } catch (err) {
      const code = (err as Error).name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      return { ...base, status: 'unavailable', errorCode: code, latencyMs: this.now() - started };
    }
  }

  async checkSoap(countryCode: string, vatNumber: string, timeoutMs: number): Promise<ViesResult> {
    const started = this.now();
    const base = { countryCode, vatNumber, transport: 'soap' as const };
    const approx = Boolean(this.requester);
    const op = approx ? 'checkVatApprox' : 'checkVat';
    const requester = this.requester
      ? `<urn:requesterCountryCode>${xmlEscape(this.requester.countryCode)}</urn:requesterCountryCode><urn:requesterVatNumber>${xmlEscape(this.requester.vatNumber)}</urn:requesterVatNumber>`
      : '';
    const envelope =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">' +
      `<soapenv:Header/><soapenv:Body><urn:${op}><urn:countryCode>${xmlEscape(countryCode)}</urn:countryCode>` +
      `<urn:vatNumber>${xmlEscape(vatNumber)}</urn:vatNumber>${requester}</urn:${op}></soapenv:Body></soapenv:Envelope>`;
    try {
      const res = await fetchWithTimeout(
        this.fetchImpl,
        this.soapUrl,
        { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '' }, body: envelope },
        timeoutMs,
      );
      const xml = await res.text();
      const fault = xmlTag(xml, 'faultstring');
      if (fault) {
        const code = fault.trim();
        return { ...base, status: errorStatus(code), errorCode: code, latencyMs: this.now() - started };
      }
      const valid = xmlTag(xml, 'valid');
      if (valid !== 'true' && valid !== 'false') {
        return { ...base, status: 'unavailable', errorCode: res.ok ? 'UNEXPECTED_RESPONSE' : 'HTTP_ERROR', latencyMs: this.now() - started };
      }
      const name = clean(xmlTag(xml, approx ? 'traderName' : 'name'));
      const address = clean(xmlTag(xml, approx ? 'traderAddress' : 'address'));
      const consultation = clean(xmlTag(xml, 'requestIdentifier'));
      const requestDate = xmlTag(xml, 'requestDate');
      return {
        ...base,
        status: valid === 'true' ? 'valid' : 'invalid',
        ...(name ? { name } : {}),
        ...(address ? { address } : {}),
        ...(requestDate ? { requestDate } : {}),
        ...(consultation ? { consultationNumber: consultation } : {}),
        latencyMs: this.now() - started,
      };
    } catch (err) {
      const code = (err as Error).name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      return { ...base, status: 'unavailable', errorCode: code, latencyMs: this.now() - started };
    }
  }
}
