import type { Context } from 'hono';

/** Run work after the response: `waitUntil` on edge runtimes, a detached promise on Node. */
export function background(c: Context, work: Promise<unknown>): void {
  const p = work.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    void p; // Node: no ExecutionContext — the event loop keeps the promise alive.
  }
}
