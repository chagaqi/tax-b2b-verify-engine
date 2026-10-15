import { validateTaxId } from '../taxid/index.js';
import { fetchWithTimeout, readTextLimited, type FetchLike } from '../lib/http.js';
import { assertPublicHostname, isPrivateIp } from './domain.js';
import type { DnsResolver } from './dns.js';
import { USER_AGENT } from './rdap.js';

export interface DetectedTaxId {
  value: string;
  jurisdiction: string;
  valid: boolean;
  source: 'json-ld' | 'page-text';
}

export interface CompanyMetadata {
  website: string;
  fetched: boolean;
  siteTitle?: string;
  name?: string;
  legalName?: string;
  description?: string;
  logo?: string;
  icon?: string;
  telephone?: string;
  email?: string;
  foundingDate?: string;
  address?: { street?: string; locality?: string; postalCode?: string; region?: string; country?: string };
  socials: Partial<Record<'linkedin' | 'twitter' | 'facebook' | 'instagram' | 'github' | 'youtube', string>>;
  detectedTaxIds: DetectedTaxId[];
  error?: string;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

const tidy = (s: string | undefined) => {
  const t = s ? decodeEntities(s).replace(/\s+/g, ' ').trim() : '';
  return t ? t.slice(0, 500) : undefined;
};

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

function absolute(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(decodeEntities(href), base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

type Json = Record<string, unknown>;
const ORG_TYPES = /^(Organization|Corporation|LocalBusiness|Company|OnlineBusiness|OnlineStore|Store|ProfessionalService|NGO|EducationalOrganization|GovernmentOrganization)$/;

function findOrganization(node: unknown): Json | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findOrganization(n);
      if (f) return f;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const o = node as Json;
  const types = ([] as unknown[]).concat(o['@type'] ?? []);
  if (types.some((t) => typeof t === 'string' && ORG_TYPES.test(t))) return o;
  if (o['@graph']) return findOrganization(o['@graph']);
  return undefined;
}

const str = (v: unknown) => (typeof v === 'string' ? tidy(v) : undefined);

const SOCIAL: [keyof CompanyMetadata['socials'], RegExp][] = [
  ['linkedin', /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(company|school|showcase)\/[^/?#\s"']+/i],
  ['twitter', /^https?:\/\/(www\.)?(twitter|x)\.com\/(?!intent|share|home)[A-Za-z0-9_]{1,15}\/?$/i],
  ['facebook', /^https?:\/\/(www\.)?facebook\.com\/(?!sharer|share|dialog)[^/?#\s"']+\/?$/i],
  ['instagram', /^https?:\/\/(www\.)?instagram\.com\/[^/?#\s"']+\/?$/i],
  ['github', /^https?:\/\/(www\.)?github\.com\/[^/?#\s"']+\/?$/i],
  ['youtube', /^https?:\/\/(www\.)?youtube\.com\/(c\/|channel\/|user\/|@)[^/?#\s"']+/i],
];

/** VAT labels in EU languages followed by something that looks like a VAT number. */
const VAT_TEXT_RE = /\b(?:VAT(?:\s*(?:No|Number|ID|Reg(?:istration)?))?|USt-?Id(?:Nr)?|UID|TVA|IVA|BTW|NIF|CIF|P\.?\s?IVA|MwSt|ALV|DIČ|NIP|ΑΦΜ|Moms)\.?\s*(?:No\.?|Nr\.?|number|nummer)?\s*[:#]?\s*((?:ATU|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK|XI|GB)\s?[0-9A-Z][0-9A-Z .\-]{6,16}[0-9A-Z])/gi;

export function extractMetadata(html: string, url: string): Omit<CompanyMetadata, 'website' | 'fetched'> {
  const out: Omit<CompanyMetadata, 'website' | 'fetched'> = { socials: {}, detectedTaxIds: [] };
  const head = html.slice(0, 400_000);

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const siteTitle = tidy(title);
  if (siteTitle) out.siteTitle = siteTitle;

  const meta: Record<string, string> = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
  }
  const name = tidy(meta['og:site_name'] ?? meta['application-name']);
  if (name) out.name = name;
  const description = tidy(meta['og:description'] ?? meta.description ?? meta['twitter:description']);
  if (description) out.description = description;
  const ogImage = absolute(meta['og:logo'] ?? meta['og:image'], url);

  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rel = (a.rel ?? '').toLowerCase();
    if (!out.icon && /(^|\s)(icon|apple-touch-icon)(\s|$)/.test(rel)) {
      const icon = absolute(a.href, url);
      if (icon) out.icon = icon;
    }
  }

  const seen = new Set<string>();
  const addTaxId = (raw: string, source: DetectedTaxId['source']) => {
    try {
      const v = validateTaxId(raw);
      if (seen.has(v.formatted)) return;
      seen.add(v.formatted);
      out.detectedTaxIds.push({ value: v.formatted, jurisdiction: v.jurisdiction, valid: v.valid, source });
    } catch {
      // not a recognisable VAT number
    }
  };

  for (const m of head.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]!.trim());
    } catch {
      continue;
    }
    const org = findOrganization(data);
    if (!org) continue;
    out.name ??= str(org.name);
    const legal = str(org.legalName);
    if (legal) out.legalName = legal;
    out.description ??= str(org.description);
    const logo = org.logo;
    const logoUrl = typeof logo === 'string' ? logo : typeof (logo as Json | undefined)?.url === 'string' ? ((logo as Json).url as string) : undefined;
    const abs = absolute(logoUrl, url);
    if (abs) out.logo = abs;
    const tel = str(org.telephone);
    if (tel) out.telephone = tel;
    const email = str(org.email)?.replace(/^mailto:/i, '');
    if (email) out.email = email;
    const founded = str(org.foundingDate);
    if (founded) out.foundingDate = founded;
    const addr = (Array.isArray(org.address) ? org.address[0] : org.address) as Json | undefined;
    if (addr && typeof addr === 'object') {
      const country = addr.addressCountry;
      const a = {
        street: str(addr.streetAddress),
        locality: str(addr.addressLocality),
        postalCode: str(addr.postalCode),
        region: str(addr.addressRegion),
        country: typeof country === 'string' ? tidy(country) : str((country as Json | undefined)?.name),
      };
      const clean = Object.fromEntries(Object.entries(a).filter(([, v]) => v)) as CompanyMetadata['address'];
      if (clean && Object.keys(clean).length) out.address = clean;
    }
    for (const key of ['vatID', 'taxID']) {
      const v = org[key];
      if (typeof v === 'string') addTaxId(v, 'json-ld');
    }
    const sameAs = ([] as unknown[]).concat(org.sameAs ?? []).filter((s): s is string => typeof s === 'string');
    for (const s of sameAs) {
      for (const [k, re] of SOCIAL) if (!out.socials[k] && re.test(s)) out.socials[k] = s;
    }
  }
  if (!out.logo && ogImage) out.logo = ogImage;

  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    const href = decodeEntities(m[1]!);
    for (const [k, re] of SOCIAL) if (!out.socials[k] && re.test(href)) out.socials[k] = href.replace(/\/$/, '');
  }

  const text = decodeEntities(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
  for (const m of text.matchAll(VAT_TEXT_RE)) {
    if (out.detectedTaxIds.length >= 5) break;
    addTaxId(m[1]!, 'page-text');
  }
  return out;
}

/**
 * Fetch the homepage with redirect-by-hand so every hop passes the SSRF guard
 * (public hostname, non-private resolved IPs), a 5 s budget and a 512 KB cap.
 */
export async function fetchCompanyMetadata(
  domain: string,
  deps: { fetch: FetchLike; dns: DnsResolver; timeoutMs?: number; maxBytes?: number },
): Promise<CompanyMetadata> {
  const website = `https://${domain}/`;
  let url = website;
  const deadline = Date.now() + (deps.timeoutMs ?? 5000);
  try {
    for (let hop = 0; hop < 4; hop++) {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Unsupported redirect scheme');
      if (u.port && u.port !== '443' && u.port !== '80') throw new Error('Non-standard port in redirect');
      assertPublicHostname(u.hostname);
      const [a, aaaa] = await Promise.all([deps.dns.resolve(u.hostname, 'A'), deps.dns.resolve(u.hostname, 'AAAA')]);
      const ips = [...a.records, ...aaaa.records].filter((r) => /^[\d.:a-f]+$/i.test(r));
      if (!ips.length) throw new Error(`${u.hostname} does not resolve`);
      if (ips.some(isPrivateIp)) throw new Error(`${u.hostname} resolves to a private address`);

      const left = deadline - Date.now();
      if (left <= 0) throw new Error('Timed out');
      const res = await fetchWithTimeout(
        deps.fetch,
        url,
        { redirect: 'manual', headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' } },
        left,
      );
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location')!, url).toString();
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get('content-type') ?? '';
      if (ct && !/html|xml/i.test(ct)) throw new Error(`Unexpected content-type ${ct}`);
      const html = await readTextLimited(res, deps.maxBytes ?? 512 * 1024);
      return { website: url, fetched: true, ...extractMetadata(html, url) };
    }
    throw new Error('Too many redirects');
  } catch (err) {
    return { website, fetched: false, socials: {}, detectedTaxIds: [], error: (err as Error).message };
  }
}
