import { fromBase64, hmacSha256, timingSafeEqual, toBase64, toHex, utf8 } from '../lib/crypto.js';

/**
 * Stripe `Stripe-Signature: t=…,v1=…` scheme — used for both billing webhooks
 * and Stripe Apps' `fetchStripeSignature()` requests.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | undefined | null,
  secret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): Promise<boolean> {
  if (!header) return false;
  let t: string | undefined;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s.trim());
    if (k === 't') t = v;
    else if (k === 'v1' && v) v1.push(v);
  }
  if (!t || !v1.length || !/^\d+$/.test(t)) return false;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - Number(t)) > (opts.toleranceSeconds ?? 300)) return false;
  const expected = toHex(await hmacSha256(secret, `${t}.${payload}`));
  return v1.some((s) => timingSafeEqual(s, expected));
}

export async function signStripePayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${timestamp},v1=${toHex(await hmacSha256(secret, `${timestamp}.${payload}`))}`;
}

/** Standard Webhooks key material: `whsec_<base64>` or (Polar) the raw secret string. */
function standardWebhookKey(secret: string): Uint8Array {
  return secret.startsWith('whsec_') ? fromBase64(secret.slice(6)) : utf8(secret);
}

/** https://www.standardwebhooks.com — used by Polar.sh. */
export async function verifyStandardWebhook(
  body: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  secret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - Number(timestamp)) > (opts.toleranceSeconds ?? 300)) return false;
  const expected = toBase64(await hmacSha256(standardWebhookKey(secret), `${id}.${timestamp}.${body}`));
  return signature
    .split(' ')
    .map((s) => s.split(',', 2))
    .some(([ver, sig]) => ver === 'v1' && sig !== undefined && timingSafeEqual(sig, expected));
}

export async function signStandardWebhook(body: string, id: string, timestamp: number, secret: string): Promise<string> {
  return `v1,${toBase64(await hmacSha256(standardWebhookKey(secret), `${id}.${timestamp}.${body}`))}`;
}

/** HubSpot request signature v3: base64(HMAC-SHA256(method + uri + body + timestamp)). */
export async function verifyHubSpotV3(
  req: { method: string; url: string; body: string; signature?: string | null; timestamp?: string | null },
  clientSecret: string,
  opts: { maxAgeMs?: number; now?: number } = {},
): Promise<boolean> {
  if (!req.signature || !req.timestamp || !/^\d+$/.test(req.timestamp)) return false;
  if (Math.abs((opts.now ?? Date.now()) - Number(req.timestamp)) > (opts.maxAgeMs ?? 5 * 60_000)) return false;
  const expected = toBase64(await hmacSha256(clientSecret, hubspotBaseString(req.method, req.url, req.body, req.timestamp)));
  return timingSafeEqual(expected, req.signature);
}

const HUBSPOT_DECODE: Record<string, string> = {
  '%3A': ':', '%2F': '/', '%3F': '?', '%40': '@', '%21': '!', '%24': '$', '%27': "'", '%28': '(', '%29': ')', '%2A': '*', '%2C': ',', '%3B': ';',
};

export function hubspotBaseString(method: string, url: string, body: string, timestamp: string): string {
  const uri = url.replace(/%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi, (m) => HUBSPOT_DECODE[m.toUpperCase()]!);
  return `${method.toUpperCase()}${uri}${body}${timestamp}`;
}

export async function signHubSpotV3(method: string, url: string, body: string, timestamp: string, clientSecret: string): Promise<string> {
  return toBase64(await hmacSha256(clientSecret, hubspotBaseString(method, url, body, timestamp)));
}
