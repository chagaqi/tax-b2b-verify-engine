import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { isPrivateIp, type FetchLike } from '@tbve/core-api';

type Resolve = (hostname: string, options: LookupOptions & { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

export interface PinnedFetchOptions {
  resolve?: Resolve;
  isBlocked?: (ip: string) => boolean;
}

/**
 * A `lookup` for http(s).request that refuses private/reserved addresses. Because the socket
 * connects to exactly the address this returns, a DNS-rebinding server cannot swap in an internal
 * IP between the SSRF check and the connection.
 */
export function createGuardedLookup({ resolve = dnsLookup as unknown as Resolve, isBlocked = isPrivateIp }: PinnedFetchOptions = {}): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      if (!addresses.length || addresses.some((a) => isBlocked(a.address))) {
        const e = Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'EPRIVATEADDR' });
        return callback(e, '', 0);
      }
      if ((options as LookupOptions).all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

function headerRecord(h: RequestInit['headers']): Record<string, string> {
  return Object.fromEntries(new Headers(h ?? {}).entries());
}

/** Minimal fetch over node:http(s) with the guarded lookup. Does not follow redirects. */
export function createPinnedFetch(opts: PinnedFetchOptions = {}): FetchLike {
  const lookup = createGuardedLookup(opts);
  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return reject(new Error(`Unsupported protocol ${url.protocol}`));
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(
        url,
        { method: init.method ?? 'GET', headers: headerRecord(init.headers), lookup, ...(init.signal ? { signal: init.signal } : {}) },
        (res) => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            for (const item of Array.isArray(v) ? v : [v]) headers.append(k, item);
          }
          const status = res.statusCode ?? 502;
          const empty = [204, 205, 304].includes(status) || (init.method ?? 'GET') === 'HEAD';
          if (empty) res.resume();
          resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? '', headers }));
        },
      );
      req.on('error', reject);
      if (typeof init.body === 'string') req.write(init.body);
      req.end();
    });
}
