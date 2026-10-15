import type { FetchLike } from '../lib/http.js';
import type { ICacheStore } from '../stores/types.js';
import { parseTarget } from './domain.js';
import type { DnsResolver } from './dns.js';
import { DISPOSABLE_DOMAINS, DISPOSABLE_MX_SUFFIXES, DISPOSABLE_PATTERNS, FREE_PROVIDERS, MAIL_PROVIDERS, ROLE_LOCAL_PARTS } from './lists.js';
import { fetchCompanyMetadata, type CompanyMetadata } from './metadata.js';
import { parseDmarc, parseSpf, scorePosture, type SecurityPosture } from './posture.js';
import type { RdapClient, RegistrationInfo } from './rdap.js';

export type DomainClassification = 'corporate' | 'free_provider' | 'disposable' | 'no_mail' | 'unresolvable';

export interface MxRecord {
  priority: number;
  host: string;
}

export interface EnrichmentResult {
  domain: string;
  classification: DomainClassification;
  email?: {
    address: string;
    localPart: string;
    isRole: boolean;
    isFreeProvider: boolean;
    isDisposable: boolean;
    /** `likely` = domain accepts mail; we never open an SMTP session. */
    deliverability: 'likely' | 'unlikely';
  };
  disposable: { value: boolean; reason?: 'domain_list' | 'pattern' | 'mx_host' };
  freeProvider: boolean;
  dns: { resolves: boolean; mx: MxRecord[]; nullMx: boolean; mailProvider?: string };
  security: SecurityPosture;
  registration?: RegistrationInfo;
  company?: CompanyMetadata;
  risk: { score: number; level: 'low' | 'medium' | 'high'; reasons: string[] };
  checkedAt: string;
}

export interface EnrichOptions {
  rdap?: boolean;
  metadata?: boolean;
}

export interface EnrichmentServiceDeps {
  dns: DnsResolver;
  fetch: FetchLike;
  rdap: RdapClient;
  cache: ICacheStore;
  now?: () => Date;
  cacheTtlSeconds?: number;
}

export function parseMx(records: string[]): { mx: MxRecord[]; nullMx: boolean } {
  const mx = records
    .map((r) => {
      const [p, h] = r.trim().split(/\s+/);
      return { priority: Number(p), host: (h ?? '').replace(/\.$/, '').toLowerCase() };
    })
    .filter((m) => Number.isFinite(m.priority))
    .sort((a, b) => a.priority - b.priority);
  const nullMx = mx.length === 1 && (mx[0]!.host === '' || mx[0]!.host === '.');
  return { mx: nullMx ? [] : mx, nullMx };
}

export function detectMailProvider(mx: MxRecord[]): string | undefined {
  for (const { host } of mx) {
    for (const [suffix, name] of MAIL_PROVIDERS) if (host === suffix || host.endsWith(`.${suffix}`)) return name;
  }
  return undefined;
}

function disposableBy(domain: string, mx: MxRecord[]): EnrichmentResult['disposable'] {
  if (DISPOSABLE_DOMAINS.has(domain)) return { value: true, reason: 'domain_list' };
  if (DISPOSABLE_PATTERNS.some((re) => re.test(domain))) return { value: true, reason: 'pattern' };
  if (mx.some(({ host }) => DISPOSABLE_MX_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`)))) return { value: true, reason: 'mx_host' };
  return { value: false };
}

const DKIM_SELECTORS: Record<string, string[]> = {
  'Google Workspace': ['google'],
  'Microsoft 365': ['selector1', 'selector2'],
  'Zoho Mail': ['zmail', 'zoho'],
  Fastmail: ['fm1', 'fm2'],
  'Amazon SES': ['amazonses'],
};
const DEFAULT_SELECTORS = ['default', 'k1', 's1', 'dkim', 'mail'];

export class EnrichmentService {
  private readonly now: () => Date;
  constructor(private readonly deps: EnrichmentServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Throws `TargetError` for malformed input. */
  async enrich(input: { email?: string | null; domain?: string | null }, opts: EnrichOptions = {}): Promise<EnrichmentResult> {
    const target = parseTarget(input);
    const domain = target.domain;
    const cacheKey = `enrich:${domain}:${opts.rdap !== false ? 1 : 0}${opts.metadata !== false ? 1 : 0}`;
    let base = await this.deps.cache.get<Omit<EnrichmentResult, 'email'>>(cacheKey).catch(() => null);
    if (!base) {
      base = await this.enrichDomain(domain, opts);
      await this.deps.cache.set(cacheKey, base, this.deps.cacheTtlSeconds ?? 3600).catch(() => undefined);
    }
    if (!target.email) return base;

    const isRole = ROLE_LOCAL_PARTS.has(target.email.localPart.split('+')[0]!);
    const deliverable = base.dns.mx.length > 0 && !base.disposable.value;
    const reasons = [...base.risk.reasons];
    let score = base.risk.score;
    if (isRole) {
      score = Math.min(100, score + 5);
      reasons.push('Role-based mailbox (not a named person)');
    }
    return {
      ...base,
      email: {
        address: target.email.address,
        localPart: target.email.localPart,
        isRole,
        isFreeProvider: base.freeProvider,
        isDisposable: base.disposable.value,
        deliverability: deliverable ? 'likely' : 'unlikely',
      },
      risk: { score, level: riskLevel(score), reasons },
    };
  }

  private async enrichDomain(domain: string, opts: EnrichOptions): Promise<Omit<EnrichmentResult, 'email'>> {
    const { dns } = this.deps;
    const [mxAns, txtAns, dmarcAns, stsAns, bimiAns, aAns] = await Promise.all([
      dns.resolve(domain, 'MX'),
      dns.resolve(domain, 'TXT'),
      dns.resolve(`_dmarc.${domain}`, 'TXT'),
      dns.resolve(`_mta-sts.${domain}`, 'TXT'),
      dns.resolve(`default._bimi.${domain}`, 'TXT'),
      dns.resolve(domain, 'A'),
    ]);
    const { mx, nullMx } = parseMx(mxAns.records);
    const mailProvider = detectMailProvider(mx);
    const resolves = mxAns.status === 'ok' || aAns.status === 'ok' || txtAns.status === 'ok';

    const selectors = (mailProvider && DKIM_SELECTORS[mailProvider]) || DEFAULT_SELECTORS;
    const dkimAnswers = await Promise.all(selectors.map((s) => dns.resolve(`${s}._domainkey.${domain}`, 'TXT')));
    const dkimFound = selectors.filter((_, i) => dkimAnswers[i]!.records.some((r) => /(^|;)\s*(v=DKIM1|p=)/i.test(r)));

    const bimiRec = bimiAns.records.find((r) => /^v=BIMI1/i.test(r));
    const bimiLogo = bimiRec ? /(?:^|;)\s*l=([^;\s]+)/i.exec(bimiRec)?.[1] : undefined;
    const security = scorePosture({
      hasMx: mx.length > 0,
      nullMx,
      spf: parseSpf(txtAns.records),
      dmarc: parseDmarc(dmarcAns.records),
      dkimSelectors: dkimFound,
      dkimProbed: selectors,
      mtaSts: stsAns.records.some((r) => /^v=STSv1/i.test(r)),
      bimi: { present: Boolean(bimiRec), ...(bimiLogo ? { logo: bimiLogo } : {}) },
    });

    const disposable = disposableBy(domain, mx);
    const freeProvider = FREE_PROVIDERS.has(domain);
    const skipWeb = !resolves || disposable.value || freeProvider;
    const [registration, company] = await Promise.all([
      opts.rdap === false || !resolves ? Promise.resolve(undefined) : this.deps.rdap.lookup(domain, this.now()),
      opts.metadata === false || skipWeb ? Promise.resolve(undefined) : fetchCompanyMetadata(domain, { fetch: this.deps.fetch, dns }),
    ]);

    const classification: DomainClassification = !resolves
      ? 'unresolvable'
      : disposable.value
        ? 'disposable'
        : freeProvider
          ? 'free_provider'
          : mx.length === 0
            ? 'no_mail'
            : 'corporate';

    const reasons: string[] = [];
    let score = 0;
    const add = (points: number, reason: string) => {
      score += points;
      reasons.push(reason);
    };
    if (classification === 'unresolvable') add(90, 'Domain does not resolve');
    if (disposable.value) add(80, `Disposable email provider (${disposable.reason})`);
    if (freeProvider) add(25, 'Free consumer mailbox provider, not a company domain');
    if (resolves && mx.length === 0) add(40, nullMx ? 'Domain refuses email (null MX)' : 'No MX records');
    if (registration?.ageDays !== undefined) {
      if (registration.ageDays < 30) add(30, `Domain registered ${registration.ageDays} days ago`);
      else if (registration.ageDays < 180) add(15, `Domain is younger than 6 months (${registration.ageDays} days)`);
    }
    if (classification === 'corporate') {
      if (!security.dmarc.present) add(10, 'No DMARC — domain is easy to spoof');
      if (company && !company.fetched) add(5, 'Company website did not load');
    }
    score = Math.min(100, score);

    const out: Omit<EnrichmentResult, 'email'> = {
      domain,
      classification,
      disposable,
      freeProvider,
      dns: { resolves, mx, nullMx, ...(mailProvider ? { mailProvider } : {}) },
      security,
      risk: { score, level: riskLevel(score), reasons },
      checkedAt: this.now().toISOString(),
    };
    if (registration) out.registration = registration;
    if (company) out.company = company;
    return out;
  }
}

function riskLevel(score: number): 'low' | 'medium' | 'high' {
  return score < 25 ? 'low' : score < 60 ? 'medium' : 'high';
}
