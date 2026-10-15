import { fetchWithTimeout, type FetchLike } from '../lib/http.js';

export type RecordType = 'A' | 'AAAA' | 'MX' | 'TXT' | 'NS' | 'CNAME';

export interface DnsAnswer {
  status: 'ok' | 'nxdomain' | 'nodata' | 'error';
  /** MX → "10 mx.example.com", TXT → joined strings, others → rdata. */
  records: string[];
}

export interface DnsResolver {
  resolve(name: string, type: RecordType): Promise<DnsAnswer>;
}

const TYPE_CODES: Record<RecordType, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };

/** Join the quoted character-strings of a TXT rdata: "\"v=spf1 a\" \" -all\"" → "v=spf1 a -all". */
export function joinTxt(data: string): string {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!parts) return data;
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, '$1')).join('');
}

/**
 * DNS-over-HTTPS (JSON API) resolver — Cloudflare first, Google as fallback.
 * Works on any runtime with `fetch`, no UDP sockets needed.
 */
export class DohResolver implements DnsResolver {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly endpoints: string[] = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'],
    private readonly timeoutMs = 2500,
  ) {}

  async resolve(name: string, type: RecordType): Promise<DnsAnswer> {
    for (const ep of this.endpoints) {
      try {
        const url = `${ep}?name=${encodeURIComponent(name)}&type=${type}`;
        const res = await fetchWithTimeout(this.fetchImpl, url, { headers: { accept: 'application/dns-json' } }, this.timeoutMs);
        if (!res.ok) continue;
        const json = (await res.json()) as { Status: number; Answer?: { type: number; data: string }[] };
        if (json.Status === 3) return { status: 'nxdomain', records: [] };
        if (json.Status !== 0) continue;
        const code = TYPE_CODES[type];
        const records = (json.Answer ?? [])
          .filter((a) => a.type === code)
          .map((a) => (type === 'TXT' ? joinTxt(a.data) : a.data.replace(/\.$/, '')));
        return { status: records.length ? 'ok' : 'nodata', records };
      } catch {
        // try the next endpoint
      }
    }
    return { status: 'error', records: [] };
  }
}

/** Fixed answers for tests and the offline playground. */
export class StaticResolver implements DnsResolver {
  constructor(private readonly zone: Record<string, Partial<Record<RecordType, string[]>> | 'NXDOMAIN'>) {}
  async resolve(name: string, type: RecordType): Promise<DnsAnswer> {
    const z = this.zone[name.toLowerCase()];
    if (z === 'NXDOMAIN') return { status: 'nxdomain', records: [] };
    const recs = z?.[type] ?? [];
    if (!z) return { status: 'nxdomain', records: [] };
    return { status: recs.length ? 'ok' : 'nodata', records: recs };
  }
}
