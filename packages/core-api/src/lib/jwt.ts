import { fromBase64, fromUtf8, hmacSha256, timingSafeEqual, toBase64Url, utf8 } from './crypto.js';

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

export type JwtPayload = Record<string, unknown> & { exp?: number; nbf?: number; iat?: number };

/** Verify an HS256 JWT (used by monday.com and Pipedrive app extensions). */
export async function verifyHs256(
  token: string,
  secret: string,
  opts: { now?: Date; leewaySeconds?: number } = {},
): Promise<JwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('Malformed token');
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string };
  let payload: JwtPayload;
  try {
    header = JSON.parse(fromUtf8(fromBase64(h)));
    payload = JSON.parse(fromUtf8(fromBase64(p)));
  } catch {
    throw new JwtError('Malformed token');
  }
  if (header.alg !== 'HS256') throw new JwtError(`Unsupported alg ${String(header.alg)}`);
  const expected = toBase64Url(await hmacSha256(secret, `${h}.${p}`));
  if (!timingSafeEqual(expected, s)) throw new JwtError('Bad signature');
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const leeway = opts.leewaySeconds ?? 60;
  if (typeof payload.exp === 'number' && now > payload.exp + leeway) throw new JwtError('Token expired');
  if (typeof payload.nbf === 'number' && now + leeway < payload.nbf) throw new JwtError('Token not yet valid');
  return payload;
}

export async function signHs256(payload: JwtPayload, secret: string): Promise<string> {
  const h = toBase64Url(utf8(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = toBase64Url(utf8(JSON.stringify(payload)));
  return `${h}.${p}.${toBase64Url(await hmacSha256(secret, `${h}.${p}`))}`;
}
