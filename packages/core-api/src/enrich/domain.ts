/** Email / domain parsing, normalisation and the SSRF guard for outbound fetches. */

export interface ParsedTarget {
  email?: { address: string; localPart: string };
  domain: string;
}

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const BLOCKED_TLDS = new Set(['local', 'localhost', 'internal', 'intranet', 'lan', 'home', 'corp', 'arpa', 'test', 'example', 'invalid', 'onion', 'localdomain']);

/** Lower-case, IDNA (punycode) encode, strip scheme/path/port/trailing dot. */
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0] ?? '';
  s = s.replace(/^[^@]*@/, '');
  s = s.replace(/:\d+$/, '').replace(/\.$/, '');
  if (!s) throw new TargetError('Domain is empty');
  let host: string;
  try {
    host = new URL(`http://${s}`).hostname;
  } catch {
    throw new TargetError(`"${input}" is not a valid domain`);
  }
  if (host.startsWith('www.')) host = host.slice(4);
  assertPublicHostname(host);
  return host;
}

export function assertPublicHostname(host: string): void {
  if (/^\[.*\]$/.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw new TargetError('IP literals are not allowed');
  const labels = host.split('.');
  if (labels.length < 2) throw new TargetError(`"${host}" is not a fully-qualified domain`);
  if (!labels.every((l) => LABEL.test(l))) throw new TargetError(`"${host}" is not a valid hostname`);
  const tld = labels[labels.length - 1]!;
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(tld)) throw new TargetError(`"${host}" has an invalid TLD`);
  if (BLOCKED_TLDS.has(tld)) throw new TargetError(`".${tld}" domains are not routable on the public internet`);
  if (host.length > 253) throw new TargetError('Domain is too long');
}

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[^@\s]{1,253}$/i;

export function parseTarget(input: { email?: string | null; domain?: string | null }): ParsedTarget {
  if (input.email) {
    const address = input.email.trim();
    if (!EMAIL_RE.test(address)) throw new TargetError(`"${address}" is not a valid email address`);
    const at = address.lastIndexOf('@');
    const localPart = address.slice(0, at);
    if (localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) {
      throw new TargetError(`"${address}" has an invalid local part`);
    }
    const domain = normalizeDomain(address.slice(at + 1));
    return { email: { address: `${localPart}@${domain}`, localPart: localPart.toLowerCase() }, domain };
  }
  if (input.domain) return { domain: normalizeDomain(input.domain) };
  throw new TargetError('Provide an email or a domain');
}

function parseIpv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

/** Parse an IPv6 literal (incl. `::` compression and a dotted IPv4 tail) into 16 bytes. */
export function parseIpv6(input: string): number[] | null {
  let s = input.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  const tail: number[] = [];
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const b = parseIpv4(v4[1]!);
    if (!b) return null;
    tail.push(...b);
    s = s.slice(0, -v4[1]!.length);
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (h: string) => (h ? h.split(':') : []);
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const needed = 8 - tail.length / 2;
  const fill = halves.length === 2 ? needed - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== needed)) return null;
  const words = [...head, ...Array<string>(fill).fill('0'), ...rest];
  if (words.length !== needed || !words.every((w) => /^[0-9a-f]{1,4}$/.test(w))) return null;
  const bytes: number[] = [];
  for (const w of words) {
    const v = parseInt(w, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  return [...bytes, ...tail];
}

function privateV4([a, b]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a! >= 224 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/**
 * Private/reserved address detection for the SSRF guard, on parsed bytes so every
 * textual form (hex-mapped `::ffff:7f00:1`, NAT64, uncompressed IPv6, …) is covered.
 * Unparseable input is treated as private.
 */
export function isPrivateIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return privateV4(v4);
  const b = parseIpv6(ip);
  if (!b) return true;
  const zeroPrefix = (n: number) => b.slice(0, n).every((x) => x === 0);
  // ::/128, ::1, IPv4-compatible ::/96 and IPv4-mapped ::ffff:0:0/96 → judge the embedded IPv4.
  if (zeroPrefix(12) || (zeroPrefix(10) && b[10] === 0xff && b[11] === 0xff)) return zeroPrefix(15) || privateV4(b.slice(12));
  // NAT64 64:ff9b::/96 (and the local-use 64:ff9b:1::/48) embed IPv4 too.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true;
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true; // multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every((x) => x === 0)) return true; // 100::/64 discard
  return false;
}
