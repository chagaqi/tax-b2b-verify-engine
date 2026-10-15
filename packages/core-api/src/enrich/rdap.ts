import { fetchWithTimeout, type FetchLike } from '../lib/http.js';

export interface RegistrationInfo {
  available: boolean;
  source: 'rdap';
  registrar?: string;
  registrarIanaId?: string;
  registeredAt?: string;
  expiresAt?: string;
  updatedAt?: string;
  ageDays?: number;
  status?: string[];
  nameservers?: string[];
  dnssec?: boolean;
  error?: string;
}

interface RdapEntity {
  roles?: string[];
  vcardArray?: [string, [string, unknown, string, unknown][]];
  publicIds?: { type: string; identifier: string }[];
}
interface RdapDomain {
  events?: { eventAction: string; eventDate: string }[];
  status?: string[];
  entities?: RdapEntity[];
  nameservers?: { ldhName?: string }[];
  secureDNS?: { delegationSigned?: boolean };
}

function vcardFn(e: RdapEntity): string | undefined {
  const fn = e.vcardArray?.[1]?.find((p) => p[0] === 'fn');
  return typeof fn?.[3] === 'string' && fn[3] ? fn[3] : undefined;
}

/** Parse an RFC 9083 domain object. */
export function parseRdap(json: RdapDomain, now: Date): RegistrationInfo {
  const ev = (action: string) => json.events?.find((e) => e.eventAction === action)?.eventDate;
  const registeredAt = ev('registration');
  const registrar = json.entities?.find((e) => e.roles?.includes('registrar'));
  const out: RegistrationInfo = { available: true, source: 'rdap' };
  const name = registrar && vcardFn(registrar);
  if (name) out.registrar = name;
  const iana = registrar?.publicIds?.find((p) => /iana/i.test(p.type))?.identifier;
  if (iana) out.registrarIanaId = iana;
  if (registeredAt) {
    out.registeredAt = registeredAt;
    const t = Date.parse(registeredAt);
    if (Number.isFinite(t)) out.ageDays = Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
  }
  const exp = ev('expiration');
  if (exp) out.expiresAt = exp;
  const upd = ev('last changed');
  if (upd) out.updatedAt = upd;
  if (json.status?.length) out.status = json.status;
  const ns = json.nameservers?.map((n) => n.ldhName?.toLowerCase()).filter((n): n is string => Boolean(n));
  if (ns?.length) out.nameservers = ns;
  if (typeof json.secureDNS?.delegationSigned === 'boolean') out.dnssec = json.secureDNS.delegationSigned;
  return out;
}

export const USER_AGENT = 'TaxB2BVerifyBot/1.0 (+https://github.com/chagaqi/tax-b2b-verify-engine)';
export const IANA_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

/**
 * RDAP lookups routed with IANA's official bootstrap registry (RFC 9224),
 * falling back to the rdap.org redirector for TLDs missing from it.
 */
export class RdapClient {
  private bootstrap: { map: Map<string, string>; fetchedAt: number } | null = null;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly opts: { bootstrapUrl?: string; fallbackBase?: string; timeoutMs?: number; bootstrapTtlMs?: number } = {},
  ) {}

  private async serverFor(tld: string): Promise<string | undefined> {
    const ttl = this.opts.bootstrapTtlMs ?? 24 * 3600_000;
    if (!this.bootstrap || Date.now() - this.bootstrap.fetchedAt > ttl) {
      try {
        const res = await fetchWithTimeout(this.fetchImpl, this.opts.bootstrapUrl ?? IANA_BOOTSTRAP_URL, { headers: { 'user-agent': USER_AGENT } }, 4000);
        if (res.ok) {
          const json = (await res.json()) as { services?: [string[], string[]][] };
          const map = new Map<string, string>();
          for (const [tlds, urls] of json.services ?? []) {
            const url = urls.find((u) => u.startsWith('https://')) ?? urls[0];
            if (url) for (const t of tlds) map.set(t.toLowerCase(), url.endsWith('/') ? url : `${url}/`);
          }
          this.bootstrap = { map, fetchedAt: Date.now() };
        }
      } catch {
        // keep any previous bootstrap; fall back to rdap.org below
      }
    }
    return this.bootstrap?.map.get(tld);
  }

  async lookup(domain: string, now = new Date()): Promise<RegistrationInfo> {
    const tld = domain.split('.').pop()!.toLowerCase();
    const server = await this.serverFor(tld);
    const url = server ? `${server}domain/${encodeURIComponent(domain)}` : `${this.opts.fallbackBase ?? 'https://rdap.org/'}domain/${encodeURIComponent(domain)}`;
    try {
      const res = await fetchWithTimeout(
        this.fetchImpl,
        url,
        { headers: { accept: 'application/rdap+json, application/json', 'user-agent': USER_AGENT } },
        this.opts.timeoutMs ?? 4000,
      );
      if (res.status === 404) return { available: false, source: 'rdap', error: 'Domain not found in RDAP, or the TLD has no RDAP service' };
      if (!res.ok) return { available: false, source: 'rdap', error: `RDAP HTTP ${res.status}` };
      return parseRdap((await res.json()) as RdapDomain, now);
    } catch (err) {
      return { available: false, source: 'rdap', error: (err as Error).message };
    }
  }
}
