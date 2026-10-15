import type { StripeVerifyResponse } from './model';

export interface ApiDeps {
  baseUrl: string;
  /** `fetchStripeSignature` from the SDK (signs { user_id, account_id }). */
  sign: () => Promise<string>;
  fetch: typeof fetch;
  userId: string;
  accountId: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly upgradeUrl?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(d: ApiDeps, path: string, body: Record<string, unknown>): Promise<T> {
  const res = await d.fetch(`${d.baseUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': await d.sign() },
    body: JSON.stringify({ ...body, user_id: d.userId, account_id: d.accountId }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; details?: { upgradeUrl?: string } } } & T;
  if (!res.ok) throw new ApiError(json.error?.message ?? `Request failed (${res.status})`, res.status, json.error?.details?.upgradeUrl);
  return json;
}

export function createApi(d: ApiDeps) {
  return {
    verify: (body: { taxId?: string; country?: string; email?: string; customerName?: string; certificate?: boolean }) =>
      call<StripeVerifyResponse>(d, '/v1/integrations/stripe/verify', body),
    account: () => call<{ plan: { id: string; name: string }; upgradeUrl?: string }>(d, '/v1/integrations/stripe/account', {}),
  };
}
