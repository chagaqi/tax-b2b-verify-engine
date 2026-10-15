/** SPF / DMARC / DKIM / MTA-STS / BIMI parsing and the email-security score. */

export interface SpfInfo {
  present: boolean;
  record?: string;
  /** `-all` fail, `~all` softfail, `?all` neutral, `+all` pass (dangerous), `redirect`, or none. */
  allQualifier?: 'fail' | 'softfail' | 'neutral' | 'pass' | 'redirect' | 'missing';
  includes: string[];
  /** DNS-querying mechanisms at the top level (RFC 7208 caps the recursive total at 10). */
  lookupCount: number;
  multipleRecords: boolean;
}

export interface DmarcInfo {
  present: boolean;
  record?: string;
  policy?: 'none' | 'quarantine' | 'reject';
  subdomainPolicy?: 'none' | 'quarantine' | 'reject';
  pct?: number;
  rua: string[];
  alignment?: { dkim: 'relaxed' | 'strict'; spf: 'relaxed' | 'strict' };
}

export interface SecurityPosture {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  spf: SpfInfo;
  dmarc: DmarcInfo;
  dkim: { found: boolean; selectors: string[]; probed: string[] };
  mtaSts: { present: boolean };
  bimi: { present: boolean; logo?: string };
  findings: string[];
}

const QUALIFIERS: Record<string, SpfInfo['allQualifier']> = { '-': 'fail', '~': 'softfail', '?': 'neutral', '+': 'pass' };

export function parseSpf(txtRecords: string[]): SpfInfo {
  const spf = txtRecords.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
  if (!spf.length) return { present: false, includes: [], lookupCount: 0, multipleRecords: false, allQualifier: 'missing' };
  const record = spf[0]!.trim();
  const terms = record.split(/\s+/).slice(1);
  const includes: string[] = [];
  let lookupCount = 0;
  let allQualifier: SpfInfo['allQualifier'] = 'missing';
  for (const raw of terms) {
    const m = /^([+~?-]?)([a-z0-9]+)(?:[:=](.*))?$/i.exec(raw);
    if (!m) continue;
    const [, q = '', mech = '', arg] = m;
    const name = mech.toLowerCase();
    if (name === 'include') {
      lookupCount++;
      if (arg) includes.push(arg.toLowerCase());
    } else if (['a', 'mx', 'ptr', 'exists'].includes(name)) {
      lookupCount++;
    } else if (name === 'redirect') {
      lookupCount++;
      if (allQualifier === 'missing') allQualifier = 'redirect';
    } else if (name === 'all') {
      allQualifier = QUALIFIERS[q || '+'];
    }
  }
  return { present: true, record, allQualifier, includes, lookupCount, multipleRecords: spf.length > 1 };
}

function tagMap(record: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of record.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) m.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  return m;
}

const POLICY = (v?: string) => (v === 'none' || v === 'quarantine' || v === 'reject' ? v : undefined);

export function parseDmarc(txtRecords: string[]): DmarcInfo {
  const record = txtRecords.map((r) => r.trim()).find((r) => /^v=DMARC1\s*(;|$)/i.test(r));
  if (!record) return { present: false, rua: [] };
  const tags = tagMap(record);
  const policy = POLICY(tags.get('p')?.toLowerCase());
  const sp = POLICY(tags.get('sp')?.toLowerCase());
  const pct = tags.has('pct') ? Number(tags.get('pct')) : 100;
  const rua = (tags.get('rua') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    present: true,
    record,
    ...(policy ? { policy } : {}),
    ...(sp ? { subdomainPolicy: sp } : {}),
    pct: Number.isFinite(pct) ? pct : 100,
    rua,
    alignment: {
      dkim: tags.get('adkim')?.toLowerCase() === 's' ? 'strict' : 'relaxed',
      spf: tags.get('aspf')?.toLowerCase() === 's' ? 'strict' : 'relaxed',
    },
  };
}

export interface PostureInputs {
  hasMx: boolean;
  nullMx: boolean;
  spf: SpfInfo;
  dmarc: DmarcInfo;
  dkimSelectors: string[];
  dkimProbed: string[];
  mtaSts: boolean;
  bimi: { present: boolean; logo?: string };
}

/**
 * 100-point score: MX 20, SPF 25, DMARC 35, DKIM 10, MTA-STS 5, BIMI 5.
 * Grades: A ≥ 85, B ≥ 70, C ≥ 50, D ≥ 30, else F.
 */
export function scorePosture(i: PostureInputs): SecurityPosture {
  let score = 0;
  const findings: string[] = [];

  if (i.hasMx && !i.nullMx) score += 20;
  else findings.push(i.nullMx ? 'Domain publishes a null MX — it does not accept email' : 'No MX records — domain cannot receive email');

  if (i.spf.present) {
    score += 15;
    if (i.spf.allQualifier === 'fail') score += 10;
    else if (i.spf.allQualifier === 'softfail' || i.spf.allQualifier === 'redirect') score += 5;
    else if (i.spf.allQualifier === 'pass') {
      score -= 15;
      findings.push('SPF ends in +all — anyone can send as this domain');
    } else findings.push('SPF has no restrictive "all" mechanism');
    if (i.spf.multipleRecords) {
      score -= 10;
      findings.push('Multiple SPF records (RFC 7208 permerror)');
    }
    if (i.spf.lookupCount > 10) findings.push(`SPF uses ${i.spf.lookupCount} DNS lookups (limit is 10)`);
  } else findings.push('No SPF record');

  if (i.dmarc.present) {
    score += 15;
    if (i.dmarc.policy === 'reject') score += 15;
    else if (i.dmarc.policy === 'quarantine') score += 10;
    else findings.push('DMARC policy is p=none (monitoring only)');
    if ((i.dmarc.pct ?? 100) < 100) {
      score -= 5;
      findings.push(`DMARC applies to only ${i.dmarc.pct}% of mail`);
    }
    if (i.dmarc.rua.length) score += 5;
    else findings.push('DMARC has no aggregate-report (rua) address');
  } else findings.push('No DMARC record');

  if (i.dkimSelectors.length) score += 10;
  else findings.push('No DKIM key found on common selectors');
  if (i.mtaSts) score += 5;
  if (i.bimi.present) score += 5;

  score = Math.max(0, Math.min(100, score));
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : score >= 30 ? 'D' : 'F';
  return {
    score,
    grade,
    spf: i.spf,
    dmarc: i.dmarc,
    dkim: { found: i.dkimSelectors.length > 0, selectors: i.dkimSelectors, probed: i.dkimProbed },
    mtaSts: { present: i.mtaSts },
    bimi: i.bimi,
    findings,
  };
}
