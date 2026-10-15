/**
 * WebCrypto helpers. Only `globalThis.crypto` is used so the core runs
 * unchanged on Node ≥ 20, Cloudflare Workers, Deno and Bun.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto rejects SharedArrayBuffer views). */
const buf = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('Invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** URL-safe random token; 16 bytes ⇒ 128 bits of entropy. */
export function randomToken(bytes = 16): string {
  return toBase64Url(randomBytes(bytes));
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf(bytes)));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return toHex(await sha256(data));
}

export async function hmacSha256(key: Uint8Array | string, data: Uint8Array | string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    buf(typeof key === 'string' ? utf8(key) : key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, buf(typeof data === 'string' ? utf8(data) : data)));
}

/** Constant-time comparison of two strings (length leak only). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** JSON with recursively sorted object keys — the byte-exact form we sign. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortKeys(val);
    }
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------
// AES-256-GCM sealing for secrets at rest (OAuth tokens).
// ---------------------------------------------------------------------------

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await hmacSha256(secret, 'tbve:aes-gcm:v1');
  return crypto.subtle.importKey('raw', buf(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(secret: string, plaintext: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, await aesKey(secret), buf(utf8(plaintext))));
  return `v1.${toBase64Url(iv)}.${toBase64Url(ct)}`;
}

export async function unseal(secret: string, sealed: string): Promise<string> {
  const [v, iv, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('Unsupported sealed payload');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(fromBase64(iv)) }, await aesKey(secret), buf(fromBase64(ct)));
  return fromUtf8(new Uint8Array(pt));
}

// ---------------------------------------------------------------------------
// Ed25519 — certificate signatures that third parties can verify offline.
// ---------------------------------------------------------------------------

export interface Ed25519KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export async function generateEd25519(): Promise<{ pair: Ed25519KeyPair; pkcs8: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = toBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)));
  return { pair: { privateKey: pair.privateKey, publicKey: pair.publicKey }, pkcs8 };
}

/** Import a base64 PKCS#8 Ed25519 private key and derive its public key. */
export async function importEd25519Pkcs8(pkcs8B64: string): Promise<Ed25519KeyPair> {
  const privateKey = await crypto.subtle.importKey('pkcs8', buf(fromBase64(pkcs8B64.trim())), { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const publicKey = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x! }, { name: 'Ed25519' }, true, ['verify']);
  return { privateKey, publicKey };
}

export async function ed25519Sign(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, buf(data)));
}

export async function ed25519Verify(key: CryptoKey, sig: Uint8Array, data: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify({ name: 'Ed25519' }, key, buf(sig), buf(data));
}
