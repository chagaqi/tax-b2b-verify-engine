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

/** Rough private/reserved IP detection for the SSRF guard (IPv4 + common IPv6 ranges). */
export function isPrivateIp(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true;
  if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
}
