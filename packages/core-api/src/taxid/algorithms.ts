/**
 * Check-digit primitives shared by the per-jurisdiction rules.
 *
 * Every helper is pure and operates on already-compacted strings. The
 * algorithms follow the published national specifications and are
 * cross-validated against python-stdnum vectors in
 * `test/fixtures/stdnum-vectors.json` (see scripts/gen-stdnum-vectors.py).
 */

export const DIGITS = '0123456789';
export const ALNUM36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Positive modulo (JS `%` keeps the dividend's sign). */
export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function isDigits(s: string): boolean {
  return s.length > 0 && /^[0-9]+$/.test(s);
}

export function toDigits(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0) - 48);
}

/** Σ wᵢ·dᵢ over the shorter of the two sequences. */
export function weightedSum(s: string, weights: readonly number[]): number {
  let sum = 0;
  const len = Math.min(s.length, weights.length);
  for (let i = 0; i < len; i++) sum += (s.charCodeAt(i) - 48) * weights[i]!;
  return sum;
}

/** Remainder of a long decimal string, without BigInt overflow concerns. */
export function decimalMod(s: string, m: number): number {
  let r = 0;
  for (const c of s) r = (r * 10 + (c.charCodeAt(0) - 48)) % m;
  return r;
}

/**
 * Luhn checksum generalised to any alphabet (mod-N Luhn). For a complete
 * number (payload + check character) a result of 0 means valid.
 */
export function luhnChecksum(s: string, alphabet = DIGITS): number {
  const n = alphabet.length;
  let sum = 0;
  let pos = 0;
  for (let i = s.length - 1; i >= 0; i--, pos++) {
    const v = alphabet.indexOf(s[i]!);
    if (v < 0) return -1;
    if (pos % 2 === 0) sum += v;
    else {
      const d = v * 2;
      sum += Math.floor(d / n) + (d % n);
    }
  }
  return sum % n;
}

export function luhnValid(s: string, alphabet = DIGITS): boolean {
  return luhnChecksum(s, alphabet) === 0;
}

/** Check character that makes `payload + c` Luhn-valid. */
export function luhnCheckChar(payload: string, alphabet = DIGITS): string {
  const ck = luhnChecksum(payload + alphabet[0], alphabet);
  return alphabet[mod(-ck, alphabet.length)]!;
}

/** ISO 7064 MOD 11,10 (hybrid system) — valid when the result is 1. */
export function iso7064Mod11_10(s: string): number {
  let check = 5;
  for (const c of s) {
    check = ((((check || 10) * 2) % 11) + (c.charCodeAt(0) - 48)) % 10;
  }
  return check;
}

/**
 * ISO 7064 MOD 97-10 over an alphanumeric string (letters A=10 … Z=35, as in
 * IBAN). Valid when the result is 1.
 */
export function iso7064Mod97_10(s: string): number {
  let expanded = '';
  for (const c of s) {
    const v = ALNUM36.indexOf(c);
    if (v < 0) return -1;
    expanded += String(v);
  }
  return decimalMod(expanded, 97);
}

/** Validates a Gregorian calendar date (month 1-12, real day-of-month). */
export function isRealDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}
