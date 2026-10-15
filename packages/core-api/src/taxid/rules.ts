import {
  ALNUM36,
  decimalMod,
  isDigits,
  isRealDate,
  iso7064Mod11_10,
  iso7064Mod97_10,
  luhnChecksum,
  luhnValid,
  mod,
  weightedSum,
} from './algorithms.js';

export type ChecksumStatus = 'valid' | 'invalid' | 'not_applicable';

export interface RuleCheck {
  /** Length / character-class / component checks passed. */
  syntax: boolean;
  checksum: ChecksumStatus;
  reason?: string;
  details?: Record<string, string>;
}

export interface TaxIdRule {
  /** Unique jurisdiction key — ISO 3166-1 alpha-2, plus `XI` for Northern Ireland. */
  code: string;
  /** ISO 3166-1 alpha-2 country of the issuing authority. */
  country: string;
  countryName: string;
  scheme: string;
  schemeName: string;
  /** Prefix used in the canonical formatted output (e.g. `EL` for Greece). */
  prefix: string;
  algorithm: string;
  /** Number can be confirmed against the EU VIES registry. */
  vies: boolean;
  /** A syntactically and checksum-valid sample, used by docs and the playground. */
  example: string;
  /** Strip separators and the jurisdiction prefix/suffix. Input is already upper-cased. */
  compact(raw: string): string;
  check(n: string): RuleCheck;
  format?(n: string): string;
}

const ok = (checksum: ChecksumStatus = 'valid', details?: Record<string, string>): RuleCheck =>
  details ? { syntax: true, checksum, details } : { syntax: true, checksum };
const badFormat = (reason: string): RuleCheck => ({ syntax: false, checksum: 'not_applicable', reason });
const badChecksum = (reason = 'Check digit mismatch'): RuleCheck => ({ syntax: true, checksum: 'invalid', reason });
const verdict = (pass: boolean, details?: Record<string, string>): RuleCheck =>
  pass ? ok('valid', details) : { ...badChecksum(), ...(details ? { details } : {}) };

/** Upper-case and remove common separators. */
export function clean(raw: string): string {
  return raw.toUpperCase().replace(/[\s\-./,:_() ]/g, '');
}

function stripPrefix(n: string, ...prefixes: string[]): string {
  for (const p of prefixes) if (n.startsWith(p)) return n.slice(p.length);
  return n;
}

const prefixCompact = (...prefixes: string[]) => (raw: string) => stripPrefix(raw, ...prefixes);

function needDigits(n: string, lengths: readonly number[]): RuleCheck | null {
  if (!isDigits(n)) return badFormat('Must contain only digits');
  if (!lengths.includes(n.length)) return badFormat(`Expected ${lengths.join(' or ')} digits, got ${n.length}`);
  return null;
}

// ---------------------------------------------------------------------------
// Shared national algorithms
// ---------------------------------------------------------------------------

/** Czech / Slovak birth number (rodné číslo). */
function birthNumberValid(n: string): boolean {
  if (!isDigits(n) || (n.length !== 9 && n.length !== 10)) return false;
  let year = 1900 + Number(n.slice(0, 2));
  const month = (Number(n.slice(2, 4)) % 50) % 20;
  const day = Number(n.slice(4, 6));
  if (n.length === 9) {
    if (year >= 1980) year -= 100;
    if (year > 1953) return false;
  } else if (year < 1954) {
    year += 100;
  }
  if (!isRealDate(year, month, day)) return false;
  if (n.length === 10) return String(decimalMod(n.slice(0, 9), 11) % 10) === n[9];
  return true;
}

/** Bulgarian personal number (EGN). */
function egnValid(n: string): boolean {
  if (!isDigits(n) || n.length !== 10) return false;
  let year = Number(n.slice(0, 2)) + 1900;
  let month = Number(n.slice(2, 4));
  const day = Number(n.slice(4, 6));
  if (month > 40) {
    year += 100;
    month -= 40;
  } else if (month > 20) {
    year -= 100;
    month -= 20;
  }
  if (!isRealDate(year, month, day)) return false;
  return String((weightedSum(n, [2, 4, 8, 5, 10, 9, 7, 3, 6]) % 11) % 10) === n[9];
}

/** Dutch citizen service number (BSN) "11-proof". */
function bsnValid(n: string): boolean {
  return isDigits(n) && n.length === 9 && mod(weightedSum(n, [9, 8, 7, 6, 5, 4, 3, 2, -1]), 11) === 0;
}

/** Romanian company identifier (CUI/CIF), 2-10 digits. */
function cuiValid(n: string): boolean {
  if (!isDigits(n) || n.length < 2 || n.length > 10) return false;
  const body = n.slice(0, -1).padStart(9, '0');
  const check = ((10 * weightedSum(body, [7, 5, 3, 2, 1, 7, 5, 3, 2])) % 11) % 10;
  return String(check) === n[n.length - 1];
}

/** Romanian personal numeric code (CNP), 13 digits. */
function cnpValid(n: string): boolean {
  if (!isDigits(n) || n.length !== 13 || n[0] === '0') return false;
  const century: Record<string, number> = { '1': 1900, '2': 1900, '3': 1800, '4': 1800, '5': 2000, '6': 2000 };
  const base = century[n[0]!];
  if (base !== undefined && !isRealDate(base + Number(n.slice(1, 3)), Number(n.slice(3, 5)), Number(n.slice(5, 7)))) {
    return false;
  }
  const county = Number(n.slice(7, 9));
  if (!((county >= 1 && county <= 48) || county === 51 || county === 52 || county === 70 || (county >= 80 && county <= 83))) {
    return false;
  }
  let check = weightedSum(n, [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9]) % 11;
  if (check === 10) check = 1;
  return String(check) === n[12];
}

/** French SIREN (9 digits, Luhn). */
function sirenValid(n: string): boolean {
  return isDigits(n) && n.length === 9 && luhnValid(n);
}

/** UK VAT mod-97 ("9755") check over the first 9 digits. */
function gbVatCheck(n: string): RuleCheck {
  if (n.length === 5) {
    if (!isDigits(n.slice(2))) return badFormat('Government/health authority numbers are GD/HA + 3 digits');
    const v = Number(n.slice(2));
    if ((n.startsWith('GD') && v < 500) || (n.startsWith('HA') && v >= 500)) {
      return ok('not_applicable', { type: n.startsWith('GD') ? 'government_department' : 'health_authority' });
    }
    return badFormat('Unknown GD/HA range');
  }
  const r = needDigits(n, [9, 12]);
  if (r) return r;
  const sum = weightedSum(n.slice(0, 9), [8, 7, 6, 5, 4, 3, 2, 10, 1]) % 97;
  const pass = Number(n.slice(0, 3)) >= 100 ? sum === 0 || sum === 42 || sum === 55 : sum === 0;
  return verdict(pass, n.length === 12 ? { branch: n.slice(9) } : undefined);
}

// ---------------------------------------------------------------------------
// Spain — NIF (DNI / NIE / CIF / KLM)
// ---------------------------------------------------------------------------
const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
function esCheck(n: string): RuleCheck {
  if (n.length !== 9) return badFormat(`Expected 9 characters, got ${n.length}`);
  if (!isDigits(n.slice(1, 8))) return badFormat('Characters 2-8 must be digits');
  const first = n[0]!;
  const last = n[8]!;
  if (isDigits(first)) {
    if (!isDigits(n.slice(0, 8))) return badFormat('DNI must be 8 digits + letter');
    return verdict(DNI_LETTERS[Number(n.slice(0, 8)) % 23] === last, { type: 'DNI' });
  }
  if ('XYZ'.includes(first)) {
    const num = String('XYZ'.indexOf(first)) + n.slice(1, 8);
    return verdict(DNI_LETTERS[Number(num) % 23] === last, { type: 'NIE' });
  }
  if ('KLM'.includes(first)) {
    return verdict(DNI_LETTERS[Number(n.slice(1, 8)) % 23] === last, { type: 'NIF-KLM' });
  }
  if ('ABCDEFGHJNPQRSUVW'.includes(first)) {
    const ck = mod(-luhnChecksum(n.slice(1, 8) + '0'), 10);
    return verdict(last === String(ck) || last === 'JABCDEFGHI'[ck], { type: 'CIF' });
  }
  return badFormat('Unknown Spanish NIF type');
}

// ---------------------------------------------------------------------------
// Ireland
// ---------------------------------------------------------------------------
const IE_ALPHABET = 'WABCDEFGHIJKLMNOPQRSTUV';
function ieCheckChar(body: string): string {
  const padded = body.padStart(7, '0');
  const suffix = padded.slice(7);
  const sum = weightedSum(padded.slice(0, 7), [8, 7, 6, 5, 4, 3, 2]) + 9 * IE_ALPHABET.indexOf(suffix);
  return IE_ALPHABET[sum % 23]!;
}
function ieCheck(n: string): RuleCheck {
  if (n.length !== 8 && n.length !== 9) return badFormat(`Expected 8 or 9 characters, got ${n.length}`);
  if (!isDigits(n.slice(0, 1)) || !isDigits(n.slice(2, 7))) return badFormat('Unexpected Irish VAT format');
  if (![...n.slice(7)].every((c) => IE_ALPHABET.includes(c))) return badFormat('Unexpected Irish VAT check letters');
  if (isDigits(n.slice(0, 7))) return verdict(n[7] === ieCheckChar(n.slice(0, 7) + n.slice(8)), { style: 'new' });
  if ('ABCDEFGHIJKLMNOPQRSTUVWXYZ+*'.includes(n[1]!)) {
    return verdict(n[7] === ieCheckChar(n.slice(2, 7) + n[0]), { style: 'legacy' });
  }
  return badFormat('Unexpected Irish VAT format');
}

// ---------------------------------------------------------------------------
// France
// ---------------------------------------------------------------------------
const FR_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function frCheck(n: string): RuleCheck {
  if (n.length !== 11) return badFormat(`Expected 11 characters, got ${n.length}`);
  if (![...n.slice(0, 2)].every((c) => FR_ALPHABET.includes(c)) || !isDigits(n.slice(2))) {
    return badFormat('Expected 2-character key + 9-digit SIREN');
  }
  const siren = n.slice(2);
  if (siren.slice(0, 3) !== '000' && !sirenValid(siren)) return { ...badChecksum('SIREN Luhn check failed'), details: { siren } };
  if (isDigits(n)) return verdict(Number(n.slice(0, 2)) === decimalMod(siren + '12', 97), { siren, key: 'numeric' });
  const c0 = FR_ALPHABET.indexOf(n[0]!);
  const c1 = FR_ALPHABET.indexOf(n[1]!);
  const check = isDigits(n[0]!) ? c0 * 24 + c1 - 10 : c0 * 34 + c1 - 100;
  return verdict((decimalMod(siren, 11) + 1 + Math.floor(check / 11)) % 11 === check % 11, { siren, key: 'alphanumeric' });
}

// ---------------------------------------------------------------------------
// Latvia
// ---------------------------------------------------------------------------
function lvPersonalCheck(n: string): string {
  return String(((1 + weightedSum(n, [10, 5, 8, 4, 2, 1, 6, 3, 7, 9])) % 11) % 10);
}
function lvCheck(n: string): RuleCheck {
  const r = needDigits(n, [11]);
  if (r) return r;
  if (n[0]! > '3') return verdict(weightedSum(n, [9, 1, 4, 8, 3, 10, 2, 5, 7, 6, 1]) % 11 === 3, { type: 'legal_entity' });
  if (n.startsWith('32')) return verdict(lvPersonalCheck(n.slice(0, 10)) === n[10], { type: 'natural_person' });
  const year = 1800 + Number(n[6]) * 100 + Number(n.slice(4, 6));
  if (!isRealDate(year, Number(n.slice(2, 4)), Number(n.slice(0, 2)))) return badFormat('Invalid embedded birth date');
  return verdict(lvPersonalCheck(n.slice(0, 10)) === n[10], { type: 'natural_person' });
}

// ---------------------------------------------------------------------------
// India — GSTIN
// ---------------------------------------------------------------------------
const IN_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli', '27': 'Maharashtra', '28': 'Andhra Pradesh',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh (New)', '38': 'Ladakh',
  '97': 'Other Territory', '99': 'Centre Jurisdiction',
};
const PAN_HOLDER: Record<string, string> = {
  A: 'Association of Persons', B: 'Body of Individuals', C: 'Company', F: 'Firm/LLP', G: 'Government Agency',
  H: 'Hindu Undivided Family', L: 'Local Authority', J: 'Artificial Juridical Person', P: 'Individual', T: 'Trust',
  K: 'Krish (Trust Krish)',
};
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;
function inCheck(n: string): RuleCheck {
  if (n.length !== 15) return badFormat(`Expected 15 characters, got ${n.length}`);
  if (!GSTIN_RE.test(n)) return badFormat('Expected 2-digit state + 10-char PAN + entity + Z + check');
  const state = IN_STATES[n.slice(0, 2)];
  if (!state) return badFormat(`Unknown state code ${n.slice(0, 2)}`);
  if (n[12] === '0' || n[13] !== 'Z') return badFormat('Invalid entity number or default character');
  const holder = PAN_HOLDER[n[5]!];
  if (!holder || n.slice(7, 11) === '0000') return badFormat('Embedded PAN is malformed');
  return verdict(luhnValid(n, ALNUM36), { state, pan: n.slice(2, 12), holderType: holder });
}

// ---------------------------------------------------------------------------
// United States — EIN prefix → IRS campus
// ---------------------------------------------------------------------------
const EIN_CAMPUS: Record<string, string> = {};
for (const [campus, prefixes] of Object.entries({
  Brookhaven: '01,02,03,04,05,06,11,13,14,16,21,22,23,25,34,51,52,54,55,56,57,58,59,65',
  Andover: '10,12',
  Fresno: '15,24',
  Internet: '20,26,27,45,46,47,81,82,83,84',
  Cincinnati: '30,32,35,36,37,38,61',
  'Small Business Administration (SBA)': '31',
  Philadelphia: '33,39,41,42,43,48,62,63,64,66,68,71,72,73,74,75,76,77,85,86,87,88,91,92,93,98,99',
  'Kansas City': '40,44',
  Austin: '50,53',
  Atlanta: '60,67',
  Ogden: '80,90',
  Memphis: '94,95',
})) {
  for (const p of prefixes.split(',')) EIN_CAMPUS[p] ??= campus;
}

// ---------------------------------------------------------------------------
// Singapore — UEN
// ---------------------------------------------------------------------------
const SG_OTHER_TYPES = new Set([
  'CC', 'CD', 'CH', 'CL', 'CM', 'CP', 'CS', 'CX', 'DP', 'FB', 'FC', 'FM', 'FN', 'GA', 'GB', 'GS', 'HS', 'LL', 'LP',
  'MB', 'MC', 'MD', 'MH', 'MM', 'MQ', 'NB', 'NR', 'PA', 'PB', 'PF', 'RF', 'RP', 'SM', 'SS', 'TC', 'TU', 'VH', 'XL',
]);
const SG_OTHER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWX0123456789';
function sgCheck(n: string): RuleCheck {
  if (n.length !== 9 && n.length !== 10) return badFormat(`Expected 9 or 10 characters, got ${n.length}`);
  const year = new Date().getUTCFullYear();
  if (n.length === 9) {
    if (!isDigits(n.slice(0, 8)) || !/[A-Z]/.test(n[8]!)) return badFormat('Business UEN is 8 digits + letter');
    const ck = 'XMKECAWLJDB'[weightedSum(n, [10, 4, 9, 3, 8, 2, 7, 1]) % 11];
    return verdict(ck === n[8], { type: 'business' });
  }
  if (isDigits(n[0]!)) {
    if (!isDigits(n.slice(0, 9))) return badFormat('Local company UEN is 9 digits + letter');
    if (Number(n.slice(0, 4)) > year) return badFormat('Registration year is in the future');
    const ck = 'ZKCMDNERGWH'[weightedSum(n, [10, 8, 6, 4, 9, 7, 5, 3, 1]) % 11];
    return verdict(ck === n[9], { type: 'local_company' });
  }
  if (!'RST'.includes(n[0]!) || !isDigits(n.slice(1, 3))) return badFormat('Unexpected UEN prefix');
  if (n[0] === 'T' && Number(n.slice(1, 3)) > year % 100) return badFormat('Registration year is in the future');
  if (!SG_OTHER_TYPES.has(n.slice(3, 5))) return badFormat(`Unknown entity type ${n.slice(3, 5)}`);
  if (!isDigits(n.slice(5, 9))) return badFormat('Unexpected UEN serial');
  let sum = 0;
  const w = [4, 3, 5, 3, 10, 2, 2, 5, 7];
  for (let i = 0; i < 9; i++) sum += SG_OTHER_ALPHABET.indexOf(n[i]!) * w[i]!;
  return verdict(SG_OTHER_ALPHABET[mod(sum - 5, 11)] === n[9], { type: 'other_entity', entityType: n.slice(3, 5) });
}

// ---------------------------------------------------------------------------
// Mexico — RFC
// ---------------------------------------------------------------------------
const MX_ALPHABET = '0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ Ñ';
const MX_BLACKLIST = new Set(
  ('BUEI BUEY CACA CACO CAGA CAGO CAKA CAKO COGE COJA COJE COJI COJO CULO FETO GUEY JOTO KACA KACO KAGA KAGO ' +
    'KAKA KOGE KOJO KULO MAME MAMO MEAR MEAS MEON MION MOCO MULA PEDA PEDO PENE PUTA PUTO QULO RATA RUIN').split(' '),
);
function mxCheckDigit(body: string): string {
  const padded = ('   ' + body).slice(-12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += MX_ALPHABET.indexOf(padded[i]!) * (13 - i);
  return MX_ALPHABET[mod(11 - sum, 11)]!;
}
function mxCheck(n: string): RuleCheck {
  let dateStart: number;
  let type: string;
  if (n.length === 10 || n.length === 13) {
    if (!/^[A-Z&Ñ]{4}[0-9]{6}[0-9A-Z]{0,3}$/.test(n)) return badFormat('Unexpected RFC format');
    if (MX_BLACKLIST.has(n.slice(0, 4))) return badFormat('RFC name part is on the SAT blacklist');
    dateStart = 4;
    type = 'natural_person';
  } else if (n.length === 12) {
    if (!/^[A-Z&Ñ]{3}[0-9]{6}[0-9A-Z]{3}$/.test(n)) return badFormat('Unexpected RFC format');
    dateStart = 3;
    type = 'legal_entity';
  } else {
    return badFormat(`Expected 10, 12 or 13 characters, got ${n.length}`);
  }
  const d = n.slice(dateStart, dateStart + 6);
  if (!isRealDate(2000 + Number(d.slice(0, 2)), Number(d.slice(2, 4)), Number(d.slice(4, 6)))) {
    return badFormat('Invalid embedded date');
  }
  // SAT does not guarantee the homoclave check digit, so a mismatch is advisory only.
  const details: Record<string, string> = { type };
  if (n.length >= 12) details.checkDigitMatches = String(mxCheckDigit(n.slice(0, -1)) === n[n.length - 1]);
  return ok('not_applicable', details);
}

// ---------------------------------------------------------------------------
// Rule table — 49 jurisdictions (EU-27 + XI + 21 others)
// ---------------------------------------------------------------------------

type RuleSpec = Omit<TaxIdRule, 'scheme' | 'schemeName' | 'prefix' | 'vies'> &
  Partial<Pick<TaxIdRule, 'scheme' | 'schemeName' | 'prefix' | 'vies'>>;

function euVat(spec: RuleSpec): TaxIdRule {
  return { scheme: 'eu_vat', schemeName: 'EU VAT identification number', prefix: spec.code, vies: true, ...spec };
}

const EU_RULES: TaxIdRule[] = [
  euVat({
    code: 'AT', country: 'AT', countryName: 'Austria', algorithm: 'UID Luhn variant (6 − Luhn) mod 10', example: 'ATU13585627',
    compact: prefixCompact('AT'),
    check: (n) => {
      if (!/^U\d{8}$/.test(n)) return badFormat('Expected U + 8 digits');
      return verdict(String(mod(6 - luhnChecksum(n.slice(1, 8)), 10)) === n[8]);
    },
  }),
  euVat({
    code: 'BE', country: 'BE', countryName: 'Belgium', algorithm: 'MOD 97 (enterprise number)', example: 'BE0403019261',
    compact: (raw) => {
      let n = stripPrefix(raw, 'BE');
      if (n.length === 9) n = '0' + n;
      return n;
    },
    check: (n) => {
      const r = needDigits(n, [10]);
      if (r) return r;
      if (!'01'.includes(n[0]!)) return badFormat('Enterprise number must start with 0 or 1');
      return verdict((Number(n.slice(0, 8)) + Number(n.slice(8))) % 97 === 0);
    },
  }),
  euVat({
    code: 'BG', country: 'BG', countryName: 'Bulgaria', algorithm: 'Weighted MOD 11 (BULSTAT / EGN / PNF)', example: 'BG175074752',
    compact: prefixCompact('BG'),
    check: (n) => {
      const r = needDigits(n, [9, 10]);
      if (r) return r;
      if (n.length === 9) {
        let c = weightedSum(n, [1, 2, 3, 4, 5, 6, 7, 8]) % 11;
        if (c === 10) c = weightedSum(n, [3, 4, 5, 6, 7, 8, 9, 10]) % 11;
        return verdict(String(c % 10) === n[8], { type: 'legal_entity' });
      }
      if (egnValid(n)) return ok('valid', { type: 'natural_person' });
      if (String(weightedSum(n, [21, 19, 17, 13, 11, 9, 7, 3, 1]) % 10) === n[9]) return ok('valid', { type: 'foreigner' });
      return verdict(String(mod(11 - weightedSum(n, [4, 3, 2, 7, 6, 5, 4, 3, 2]), 11)) === n[9], { type: 'other' });
    },
  }),
  euVat({
    code: 'CY', country: 'CY', countryName: 'Cyprus', algorithm: 'Odd-position translation MOD 26', example: 'CY10259033P',
    compact: prefixCompact('CY'),
    check: (n) => {
      if (!/^\d{8}[A-Z]$/.test(n)) return badFormat('Expected 8 digits + letter');
      if (n.startsWith('12')) return badFormat('Numbers starting with 12 are not issued');
      const tr = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21];
      let sum = 0;
      for (let i = 0; i < 8; i++) sum += i % 2 === 0 ? tr[Number(n[i])]! : Number(n[i]);
      return verdict(String.fromCharCode(65 + (sum % 26)) === n[8]);
    },
  }),
  euVat({
    code: 'CZ', country: 'CZ', countryName: 'Czechia', algorithm: 'Weighted MOD 11 (DIČ) / birth-number MOD 11', example: 'CZ25123891',
    compact: prefixCompact('CZ'),
    check: (n) => {
      const r = needDigits(n, [8, 9, 10]);
      if (r) return r;
      if (n.length === 8) {
        if (n.startsWith('9')) return badFormat('Legal entity DIČ cannot start with 9');
        const c = mod(11 - weightedSum(n, [8, 7, 6, 5, 4, 3, 2]), 11);
        return verdict(String((c || 1) % 10) === n[7], { type: 'legal_entity' });
      }
      if (n.length === 9 && n.startsWith('6')) {
        const s = weightedSum(n.slice(1, 8), [8, 7, 6, 5, 4, 3, 2]) % 11;
        return verdict(String(mod(8 - mod(10 - s, 11), 10)) === n[8], { type: 'special' });
      }
      return verdict(birthNumberValid(n), { type: 'natural_person' });
    },
  }),
  euVat({
    code: 'DE', country: 'DE', countryName: 'Germany', algorithm: 'ISO 7064 MOD 11,10', example: 'DE136695976',
    compact: prefixCompact('DE'),
    check: (n) => {
      const r = needDigits(n, [9]);
      if (r) return r;
      if (n[0] === '0') return badFormat('USt-IdNr cannot start with 0');
      return verdict(iso7064Mod11_10(n) === 1);
    },
  }),
  euVat({
    code: 'DK', country: 'DK', countryName: 'Denmark', algorithm: 'Weighted MOD 11 (CVR)', example: 'DK13585628',
    compact: prefixCompact('DK'),
    check: (n) => {
      const r = needDigits(n, [8]);
      if (r) return r;
      if (n[0] === '0') return badFormat('CVR cannot start with 0');
      return verdict(weightedSum(n, [2, 7, 6, 5, 4, 3, 2, 1]) % 11 === 0);
    },
  }),
  euVat({
    code: 'EE', country: 'EE', countryName: 'Estonia', algorithm: 'Weighted MOD 10 (KMKR)', example: 'EE100931558',
    compact: prefixCompact('EE'),
    check: (n) => {
      const r = needDigits(n, [9]);
      if (r) return r;
      if (!n.startsWith('10')) return badFormat('KMKR must start with 10');
      return verdict(weightedSum(n, [3, 7, 1, 3, 7, 1, 3, 7, 1]) % 10 === 0);
    },
  }),
  euVat({
    code: 'GR', country: 'GR', countryName: 'Greece', prefix: 'EL', algorithm: 'Powers-of-two MOD 11 (ΑΦΜ)', example: 'EL094259216',
    compact: (raw) => {
      const n = stripPrefix(raw, 'EL', 'GR');
      return n.length === 8 ? '0' + n : n;
    },
    check: (n) => {
      const r = needDigits(n, [9]);
      if (r) return r;
      let c = 0;
      for (const d of n.slice(0, 8)) c = c * 2 + Number(d);
      return verdict(String(((c * 2) % 11) % 10) === n[8]);
    },
  }),
  euVat({
    code: 'ES', country: 'ES', countryName: 'Spain', algorithm: 'NIF: DNI/NIE MOD 23 letter, CIF Luhn', example: 'ESA13585625',
    compact: prefixCompact('ES'),
    check: esCheck,
  }),
  euVat({
    code: 'FI', country: 'FI', countryName: 'Finland', algorithm: 'Weighted MOD 11 (ALV / Y-tunnus)', example: 'FI20774740',
    compact: prefixCompact('FI'),
    check: (n) => {
      const r = needDigits(n, [8]);
      return r ?? verdict(weightedSum(n, [7, 9, 10, 5, 8, 4, 2, 1]) % 11 === 0);
    },
  }),
  euVat({
    code: 'FR', country: 'FR', countryName: 'France', algorithm: 'SIREN Luhn + MOD 97 key', example: 'FR40303265045',
    compact: prefixCompact('FR'),
    check: frCheck,
  }),
  euVat({
    code: 'HR', country: 'HR', countryName: 'Croatia', algorithm: 'ISO 7064 MOD 11,10 (OIB)', example: 'HR33392005961',
    compact: prefixCompact('HR'),
    check: (n) => needDigits(n, [11]) ?? verdict(iso7064Mod11_10(n) === 1),
  }),
  euVat({
    code: 'HU', country: 'HU', countryName: 'Hungary', algorithm: 'Weighted MOD 10 (ANUM)', example: 'HU12892312',
    compact: prefixCompact('HU'),
    check: (n) => needDigits(n, [8]) ?? verdict(weightedSum(n, [9, 7, 3, 1, 9, 7, 3, 1]) % 10 === 0),
  }),
  euVat({
    code: 'IE', country: 'IE', countryName: 'Ireland', algorithm: 'Weighted MOD 23 letter', example: 'IE6433435F',
    compact: prefixCompact('IE'),
    check: ieCheck,
  }),
  euVat({
    code: 'IT', country: 'IT', countryName: 'Italy', algorithm: 'Luhn (Partita IVA) + office code', example: 'IT00743110157',
    compact: prefixCompact('IT'),
    check: (n) => {
      const r = needDigits(n, [11]);
      if (r) return r;
      if (Number(n.slice(0, 7)) === 0) return badFormat('Taxpayer number cannot be zero');
      const office = n.slice(7, 10);
      if (!((office >= '001' && office <= '100') || ['120', '121', '888', '999'].includes(office))) {
        return badFormat(`Unknown provincial office code ${office}`);
      }
      return verdict(luhnValid(n), { office });
    },
  }),
  euVat({
    code: 'LT', country: 'LT', countryName: 'Lithuania', algorithm: 'Two-pass weighted MOD 11 (PVM)', example: 'LT119511515',
    compact: prefixCompact('LT'),
    check: (n) => {
      const r = needDigits(n, [9, 12]);
      if (r) return r;
      if ((n.length === 9 && n[7] !== '1') || (n.length === 12 && n[10] !== '1')) return badFormat('Unexpected PVM type digit');
      const body = n.slice(0, -1);
      let c = 0;
      for (let i = 0; i < body.length; i++) c += (1 + (i % 9)) * Number(body[i]);
      c %= 11;
      if (c === 10) {
        c = 0;
        for (let i = 0; i < body.length; i++) c += (1 + ((i + 2) % 9)) * Number(body[i]);
      }
      return verdict(String((c % 11) % 10) === n[n.length - 1], { type: n.length === 9 ? 'legal_entity' : 'temporary' });
    },
  }),
  euVat({
    code: 'LU', country: 'LU', countryName: 'Luxembourg', algorithm: 'MOD 89', example: 'LU15027442',
    compact: prefixCompact('LU'),
    check: (n) => needDigits(n, [8]) ?? verdict(Number(n.slice(0, 6)) % 89 === Number(n.slice(6))),
  }),
  euVat({
    code: 'LV', country: 'LV', countryName: 'Latvia', algorithm: 'Weighted MOD 11 (PVN)', example: 'LV40003521600',
    compact: prefixCompact('LV'),
    check: lvCheck,
  }),
  euVat({
    code: 'MT', country: 'MT', countryName: 'Malta', algorithm: 'Weighted MOD 37', example: 'MT11679112',
    compact: prefixCompact('MT'),
    check: (n) => {
      const r = needDigits(n, [8]);
      if (r) return r;
      if (n[0] === '0') return badFormat('Cannot start with 0');
      return verdict(weightedSum(n, [3, 4, 6, 7, 8, 9, 10, 1]) % 37 === 0);
    },
  }),
  euVat({
    code: 'NL', country: 'NL', countryName: 'Netherlands', algorithm: 'BSN 11-proof or ISO 7064 MOD 97-10', example: 'NL004495445B01',
    compact: (raw) => {
      const n = stripPrefix(raw, 'NL');
      if (n.length < 4) return n;
      return n.slice(0, -3).padStart(9, '0') + n.slice(-3);
    },
    check: (n) => {
      if (n.length !== 12) return badFormat(`Expected 12 characters, got ${n.length}`);
      if (!isDigits(n.slice(0, 9)) || Number(n.slice(0, 9)) <= 0) return badFormat('Expected 9 digits before B');
      if (n[9] !== 'B' || !isDigits(n.slice(10)) || Number(n.slice(10)) <= 0) return badFormat('Expected B + 2-digit suffix');
      if (bsnValid(n.slice(0, 9))) return ok('valid', { algorithm: 'bsn' });
      return verdict(iso7064Mod97_10('NL' + n) === 1, { algorithm: 'mod97' });
    },
  }),
  euVat({
    code: 'PL', country: 'PL', countryName: 'Poland', algorithm: 'Weighted MOD 11 (NIP)', example: 'PL8567346215',
    compact: prefixCompact('PL'),
    check: (n) => needDigits(n, [10]) ?? verdict(mod(weightedSum(n, [6, 5, 7, 2, 3, 4, 5, 6, 7, -1]), 11) === 0),
  }),
  euVat({
    code: 'PT', country: 'PT', countryName: 'Portugal', algorithm: 'Weighted MOD 11 (NIF)', example: 'PT501964843',
    compact: prefixCompact('PT'),
    check: (n) => {
      const r = needDigits(n, [9]);
      if (r) return r;
      if (n[0] === '0') return badFormat('NIF cannot start with 0');
      return verdict(String((mod(11 - weightedSum(n, [9, 8, 7, 6, 5, 4, 3, 2]), 11)) % 10) === n[8]);
    },
  }),
  euVat({
    code: 'RO', country: 'RO', countryName: 'Romania', algorithm: 'Weighted MOD 11 (CUI) / CNP', example: 'RO18547290',
    compact: prefixCompact('RO'),
    check: (n) => {
      if (!isDigits(n)) return badFormat('Must contain only digits');
      if (n.length === 13) return verdict(cnpValid(n), { type: 'natural_person' });
      if (n.length < 2 || n.length > 10) return badFormat(`Expected 2-10 or 13 digits, got ${n.length}`);
      return verdict(cuiValid(n), { type: 'legal_entity' });
    },
  }),
  euVat({
    code: 'SE', country: 'SE', countryName: 'Sweden', algorithm: 'Luhn (organisationsnummer) + 01', example: 'SE123456789701',
    compact: prefixCompact('SE'),
    check: (n) => {
      const r = needDigits(n, [12]);
      if (r) return r;
      if (!n.endsWith('01')) return badFormat('Swedish VAT numbers end in 01');
      return verdict(luhnValid(n.slice(0, 10)));
    },
  }),
  euVat({
    code: 'SI', country: 'SI', countryName: 'Slovenia', algorithm: 'Weighted MOD 11 (DDV)', example: 'SI15012557',
    compact: prefixCompact('SI'),
    check: (n) => {
      const r = needDigits(n, [8]);
      if (r) return r;
      if (n[0] === '0') return badFormat('Cannot start with 0');
      const c = 11 - (weightedSum(n, [8, 7, 6, 5, 4, 3, 2]) % 11);
      return verdict((c === 10 ? '0' : String(c)) === n[7]);
    },
  }),
  euVat({
    code: 'SK', country: 'SK', countryName: 'Slovakia', algorithm: 'MOD 11 (IČ DPH)', example: 'SK2022749619',
    compact: prefixCompact('SK'),
    check: (n) => {
      const r = needDigits(n, [10]);
      if (r) return r;
      if (birthNumberValid(n)) return ok('valid', { type: 'natural_person' });
      if (n[0] === '0' || !'234789'.includes(n[2]!)) return badFormat('Unexpected IČ DPH structure');
      return verdict(decimalMod(n, 11) === 0, { type: 'legal_entity' });
    },
  }),
  {
    code: 'XI', country: 'GB', countryName: 'United Kingdom (Northern Ireland)', scheme: 'xi_vat',
    schemeName: 'Northern Ireland VAT number (EU VIES)', prefix: 'XI', algorithm: 'HMRC MOD 97 / 9755', vies: true,
    example: 'XI980780684', compact: prefixCompact('XI'), check: gbVatCheck,
  },
];

const OTHER_RULES: TaxIdRule[] = [
  {
    code: 'GB', country: 'GB', countryName: 'United Kingdom', scheme: 'gb_vat', schemeName: 'UK VAT registration number',
    prefix: 'GB', algorithm: 'HMRC MOD 97 / 9755', vies: false, example: 'GB980780684',
    compact: prefixCompact('GB'), check: gbVatCheck,
  },
  {
    code: 'US', country: 'US', countryName: 'United States', scheme: 'us_ein', schemeName: 'Employer Identification Number',
    prefix: '', algorithm: 'IRS campus prefix rule (EINs carry no check digit)', vies: false, example: '04-3341285',
    compact: prefixCompact('US'),
    check: (n) => {
      const r = needDigits(n, [9]);
      if (r) return r;
      const campus = EIN_CAMPUS[n.slice(0, 2)];
      if (!campus) return badFormat(`Prefix ${n.slice(0, 2)} has never been assigned by the IRS`);
      return ok('not_applicable', { campus });
    },
    format: (n) => `${n.slice(0, 2)}-${n.slice(2)}`,
  },
  {
    code: 'CA', country: 'CA', countryName: 'Canada', scheme: 'ca_bn', schemeName: 'Business Number (BN / GST-HST)',
    prefix: '', algorithm: 'Luhn (9-digit BN) + program account', vies: false, example: '123456782RT0001',
    compact: prefixCompact('CA'),
    check: (n) => {
      if (n.length !== 9 && n.length !== 15) return badFormat(`Expected 9 or 15 characters, got ${n.length}`);
      if (!isDigits(n.slice(0, 9))) return badFormat('First 9 characters must be digits');
      let details: Record<string, string> | undefined;
      if (n.length === 15) {
        const program = n.slice(9, 11);
        if (!['RC', 'RM', 'RP', 'RR', 'RT', 'RZ'].includes(program)) return badFormat(`Unknown program identifier ${program}`);
        if (!isDigits(n.slice(11))) return badFormat('Reference number must be 4 digits');
        details = { programAccount: program, reference: n.slice(11) };
      }
      return verdict(luhnValid(n.slice(0, 9)), details);
    },
    format: (n) => (n.length === 15 ? `${n.slice(0, 9)} ${n.slice(9)}` : n),
  },
  {
    code: 'AU', country: 'AU', countryName: 'Australia', scheme: 'au_abn', schemeName: 'Australian Business Number / ACN',
    prefix: '', algorithm: 'ABN MOD 89 / ACN weighted MOD 10', vies: false, example: '51824753556',
    compact: prefixCompact('AU'),
    check: (n) => {
      const r = needDigits(n, [9, 11]);
      if (r) return r;
      if (n.length === 9) {
        const c = mod(-weightedSum(n, [8, 7, 6, 5, 4, 3, 2, 1]), 10);
        return verdict(String(c) === n[8], { type: 'ACN' });
      }
      const adjusted = String(Number(n[0]) - 1) + n.slice(1);
      if (n[0] === '0') return badFormat('ABN cannot start with 0');
      return verdict(weightedSum(adjusted, [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]) % 89 === 0, { type: 'ABN' });
    },
    format: (n) => (n.length === 11 ? `${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5, 8)} ${n.slice(8)}` : `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`),
  },
  {
    code: 'IN', country: 'IN', countryName: 'India', scheme: 'in_gstin', schemeName: 'Goods and Services Tax Identification Number',
    prefix: '', algorithm: 'Luhn MOD 36 + PAN structure', vies: false, example: '27AAPFU0939F1ZV',
    compact: prefixCompact('IN'), check: inCheck,
  },
  {
    code: 'CH', country: 'CH', countryName: 'Switzerland', scheme: 'ch_uid', schemeName: 'UID / MWST number',
    prefix: '', algorithm: 'Weighted MOD 11 (UID)', vies: false, example: 'CHE116281710MWST',
    compact: (raw) => raw.replace(/(MWST|TVA|IVA|TPV)$/, ''),
    check: (n) => {
      if (!n.startsWith('CHE')) return badFormat('UID must start with CHE');
      const d = n.slice(3);
      const r = needDigits(d, [9]);
      if (r) return r;
      const c = mod(11 - weightedSum(d, [5, 4, 3, 2, 7, 6, 5, 4]), 11);
      return verdict(String(c) === d[8]);
    },
    format: (n) => `CHE-${n.slice(3, 6)}.${n.slice(6, 9)}.${n.slice(9)}`,
  },
  {
    code: 'NO', country: 'NO', countryName: 'Norway', scheme: 'no_vat', schemeName: 'Organisasjonsnummer / MVA',
    prefix: 'NO', algorithm: 'Weighted MOD 11', vies: false, example: 'NO988077917MVA',
    compact: (raw) => stripPrefix(raw, 'NO').replace(/MVA$/, ''),
    check: (n) => needDigits(n, [9]) ?? verdict(weightedSum(n, [3, 2, 7, 6, 5, 4, 3, 2, 1]) % 11 === 0),
    format: (n) => `NO${n}MVA`,
  },
  {
    code: 'NZ', country: 'NZ', countryName: 'New Zealand', scheme: 'nz_ird', schemeName: 'IRD / GST number',
    prefix: '', algorithm: 'Dual-weight MOD 11', vies: false, example: '49091850',
    compact: prefixCompact('NZ'),
    check: (n) => {
      const r = needDigits(n, [8, 9]);
      if (r) return r;
      const v = Number(n);
      if (!(v > 10_000_000 && v < 150_000_000)) return badFormat('IRD number outside the issued range');
      const body = n.slice(0, -1).padStart(8, '0');
      let s = mod(-weightedSum(body, [3, 2, 7, 6, 5, 4, 3, 2]), 11);
      if (s === 10) s = mod(-weightedSum(body, [7, 4, 3, 2, 5, 2, 7, 6]), 11);
      return verdict(String(s) === n[n.length - 1]);
    },
  },
  {
    code: 'BR', country: 'BR', countryName: 'Brazil', scheme: 'br_cnpj', schemeName: 'CNPJ',
    prefix: '', algorithm: 'Double weighted MOD 11', vies: false, example: '11222333000181',
    compact: prefixCompact('BR'),
    check: (n) => {
      const r = needDigits(n, [14]);
      if (r) return r;
      if (/^(\d)\1{13}$/.test(n)) return badFormat('Repeated-digit CNPJ is not valid');
      const dv = (body: string, w: number[]) => {
        const s = weightedSum(body, w) % 11;
        return s < 2 ? 0 : 11 - s;
      };
      const d1 = dv(n.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
      const d2 = dv(n.slice(0, 12) + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
      return verdict(`${d1}${d2}` === n.slice(12));
    },
    format: (n) => `${n.slice(0, 2)}.${n.slice(2, 5)}.${n.slice(5, 8)}/${n.slice(8, 12)}-${n.slice(12)}`,
  },
  {
    code: 'MX', country: 'MX', countryName: 'Mexico', scheme: 'mx_rfc', schemeName: 'RFC (Registro Federal de Contribuyentes)',
    prefix: '', algorithm: 'SAT structure + embedded date (homoclave check advisory)', vies: false, example: 'GODE561231GR8',
    // No prefix stripping: an RFC legitimately starts with letters such as "MX".
    compact: (raw) => raw, check: mxCheck,
  },
  {
    code: 'JP', country: 'JP', countryName: 'Japan', scheme: 'jp_cn', schemeName: 'Corporate Number / Invoice registration (T-number)',
    prefix: '', algorithm: 'Leading check digit, alternating 1/2 weights MOD 9', vies: false, example: 'T5835678256246',
    compact: (raw) => (/^T\d{13}$/.test(raw) ? raw.slice(1) : raw),
    check: (n) => {
      const r = needDigits(n, [13]);
      if (r) return r;
      const body = n.slice(1);
      let s = 0;
      for (let i = 0; i < 12; i++) s += Number(body[11 - i]) * (i % 2 === 0 ? 1 : 2);
      return verdict(String(9 - (s % 9)) === n[0]);
    },
    format: (n) => `T${n}`,
  },
  {
    code: 'SG', country: 'SG', countryName: 'Singapore', scheme: 'sg_uen', schemeName: 'Unique Entity Number (GST)',
    prefix: '', algorithm: 'UEN weighted MOD 11 letter', vies: false, example: '00192200M',
    compact: prefixCompact('SG'), check: sgCheck,
  },
  {
    code: 'ZA', country: 'ZA', countryName: 'South Africa', scheme: 'za_vat', schemeName: 'SARS VAT number',
    prefix: '', algorithm: 'Structure only (SARS publishes no check digit)', vies: false, example: '4220123456',
    compact: prefixCompact('ZA'),
    check: (n) => needDigits(n, [10]) ?? (n[0] === '4' ? ok('not_applicable') : badFormat('VAT numbers start with 4')),
  },
  {
    code: 'KR', country: 'KR', countryName: 'South Korea', scheme: 'kr_brn', schemeName: 'Business Registration Number',
    prefix: '', algorithm: 'Structure only (office / type / serial components)', vies: false, example: '1168119477',
    compact: prefixCompact('KR'),
    check: (n) => {
      const r = needDigits(n, [10]);
      if (r) return r;
      if (n.slice(0, 3) < '101' || n.slice(3, 5) === '00' || n.slice(5, 9) === '0000') return badFormat('Invalid BRN component');
      return ok('not_applicable', { taxOffice: n.slice(0, 3) });
    },
    format: (n) => `${n.slice(0, 3)}-${n.slice(3, 5)}-${n.slice(5)}`,
  },
  {
    code: 'RU', country: 'RU', countryName: 'Russia', scheme: 'ru_inn', schemeName: 'INN (taxpayer number)',
    prefix: '', algorithm: 'Weighted MOD 11 (single / double check)', vies: false, example: '7707083893',
    compact: prefixCompact('RU'),
    check: (n) => {
      const r = needDigits(n, [10, 12]);
      if (r) return r;
      if (n.length === 10) return verdict(String((weightedSum(n, [2, 4, 10, 3, 5, 9, 4, 6, 8]) % 11) % 10) === n[9], { type: 'legal_entity' });
      const d1 = String((weightedSum(n, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) % 11) % 10);
      const d2 = String((weightedSum(n.slice(0, 10) + d1, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) % 11) % 10);
      return verdict(d1 + d2 === n.slice(10), { type: 'individual' });
    },
  },
  {
    code: 'TR', country: 'TR', countryName: 'Türkiye', scheme: 'tr_vkn', schemeName: 'Vergi Kimlik Numarası',
    prefix: '', algorithm: 'VKN powers-of-two MOD 9 / MOD 10', vies: false, example: '4540536920',
    compact: prefixCompact('TR'),
    check: (n) => {
      const r = needDigits(n, [10]);
      if (r) return r;
      let s = 0;
      for (let i = 1; i <= 9; i++) {
        const c1 = (Number(n[9 - i]) + i) % 10;
        if (c1) s += (c1 * 2 ** i) % 9 || 9;
      }
      return verdict(String(mod(10 - s, 10)) === n[9]);
    },
  },
  {
    code: 'AR', country: 'AR', countryName: 'Argentina', scheme: 'ar_cuit', schemeName: 'CUIT',
    prefix: '', algorithm: 'Weighted MOD 11', vies: false, example: '20267565393',
    compact: prefixCompact('AR'),
    check: (n) => {
      const r = needDigits(n, [11]);
      if (r) return r;
      if (!['20', '23', '24', '27', '30', '33', '34', '50', '51', '55'].includes(n.slice(0, 2))) return badFormat('Unknown CUIT type prefix');
      const c = weightedSum(n, [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]) % 11;
      return verdict('012345678990'[11 - c] === n[10], { type: n[0] === '3' ? 'company' : 'individual' });
    },
    format: (n) => `${n.slice(0, 2)}-${n.slice(2, 10)}-${n.slice(10)}`,
  },
  {
    code: 'CL', country: 'CL', countryName: 'Chile', scheme: 'cl_rut', schemeName: 'RUT',
    prefix: '', algorithm: 'Cyclic 2-7 weights MOD 11 (K check)', vies: false, example: '76086428-5',
    compact: prefixCompact('CL'),
    check: (n) => {
      if (n.length !== 8 && n.length !== 9) return badFormat(`Expected 8 or 9 characters, got ${n.length}`);
      if (!isDigits(n.slice(0, -1))) return badFormat('Body must be digits');
      const body = n.slice(0, -1);
      let s = 0;
      for (let i = 0; i < body.length; i++) s += Number(body[body.length - 1 - i]) * (4 + mod(5 - i, 6));
      return verdict('0123456789K'[s % 11] === n[n.length - 1]);
    },
    format: (n) => `${n.slice(0, -1)}-${n.slice(-1)}`,
  },
  {
    code: 'CO', country: 'CO', countryName: 'Colombia', scheme: 'co_nit', schemeName: 'NIT',
    prefix: '', algorithm: 'Prime-weighted MOD 11', vies: false, example: '2131234321',
    compact: prefixCompact('CO'),
    check: (n) => {
      if (!isDigits(n)) return badFormat('Must contain only digits');
      if (n.length < 8 || n.length > 16) return badFormat(`Expected 8-16 digits, got ${n.length}`);
      const w = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
      const body = n.slice(0, -1);
      let s = 0;
      for (let i = 0; i < body.length; i++) s += Number(body[body.length - 1 - i]) * w[i]!;
      return verdict('01987654321'[s % 11] === n[n.length - 1]);
    },
  },
  {
    code: 'SA', country: 'SA', countryName: 'Saudi Arabia', scheme: 'sa_vat', schemeName: 'ZATCA VAT registration number',
    prefix: '', algorithm: 'Structure only (15 digits, 3…3)', vies: false, example: '300000000000003',
    compact: prefixCompact('SA'),
    check: (n) =>
      needDigits(n, [15]) ?? (n.startsWith('3') && n.endsWith('3') ? ok('not_applicable') : badFormat('Must start and end with 3')),
  },
  {
    code: 'AE', country: 'AE', countryName: 'United Arab Emirates', scheme: 'ae_trn', schemeName: 'Tax Registration Number (TRN)',
    prefix: '', algorithm: 'Structure only (15 digits, 100…)', vies: false, example: '100000000000003',
    compact: prefixCompact('AE'),
    check: (n) => needDigits(n, [15]) ?? (n.startsWith('100') ? ok('not_applicable') : badFormat('TRN must start with 100')),
  },
];

export const RULES: readonly TaxIdRule[] = [...EU_RULES, ...OTHER_RULES];
export const RULES_BY_CODE: ReadonlyMap<string, TaxIdRule> = new Map(RULES.map((r) => [r.code, r]));
export const EU_VAT_CODES: ReadonlySet<string> = new Set(EU_RULES.map((r) => r.prefix));
