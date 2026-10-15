export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class TimeoutError extends Error {
  constructor(readonly url: string, readonly ms: number) {
    super(`Request to ${new URL(url).host} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** fetch with a hard deadline that also aborts the underlying request. */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
  ms = 5000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) throw new TimeoutError(url, ms);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Read at most `maxBytes` of a body as text (protects against huge pages). */
export async function readTextLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.length - off);
    all.set(c.subarray(0, take), off);
    off += take;
    if (off >= all.length) break;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(all);
}

/** Race a promise against a deadline; resolves to `fallback()` on timeout. */
export async function withDeadline<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<{ value: T; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ value: T; timedOut: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ value: fallback(), timedOut: true }), ms);
  });
  try {
    return await Promise.race([p.then((value) => ({ value, timedOut: false })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
