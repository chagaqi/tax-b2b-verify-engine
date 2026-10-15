import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { ApiError, zodToApiError } from './errors.js';

export async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'bad_request', 'Body must be valid JSON');
  }
}

export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  const r = schema.safeParse(await readJson(c));
  if (!r.success) throw zodToApiError(r.error);
  return r.data;
}
