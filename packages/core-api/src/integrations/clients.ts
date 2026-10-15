import type { OAuthTokens } from '../auth/tenants.js';
import { fetchWithTimeout, type FetchLike } from '../lib/http.js';
import type { Services } from '../services.js';
import type { Platform, Tenant } from '../stores/types.js';

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new IntegrationError(`${what} failed with HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
  return (await res.json()) as T;
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** Returns usable tokens, refreshing (and persisting) them when they expire within a minute. */
export async function freshTokens(
  s: Services,
  tenant: Tenant,
  platform: Platform,
  refresh: (refreshToken: string) => Promise<OAuthTokens>,
): Promise<OAuthTokens | null> {
  const t = await s.tenants.readTokens(tenant, platform);
  if (!t) return null;
  if (!t.expiresAt || t.expiresAt - 60_000 > s.now().getTime() || !t.refreshToken) return t;
  const next = await refresh(t.refreshToken);
  await s.tenants.storeTokens(tenant, platform, { ...next, refreshToken: next.refreshToken ?? t.refreshToken });
  return next;
}

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

export const HUBSPOT_SCOPES = ['oauth', 'crm.objects.companies.read', 'crm.objects.companies.write', 'crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.schemas.companies.write', 'crm.schemas.contacts.write', 'automation'];

/** Custom properties the workflow action writes back to. */
export const HUBSPOT_PROPERTIES = [
  {
    name: 'tbve_tax_id_status',
    label: 'Tax ID verification status',
    type: 'enumeration',
    fieldType: 'select',
    options: ['registry_verified', 'registry_not_found', 'checksum_valid', 'format_valid', 'invalid'].map((v, i) => ({
      label: v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      value: v,
      displayOrder: i,
    })),
  },
  { name: 'tbve_tax_id_checked_at', label: 'Tax ID checked at', type: 'datetime', fieldType: 'date' },
  { name: 'tbve_registered_name', label: 'Tax registry name', type: 'string', fieldType: 'text' },
  { name: 'tbve_normalized_tax_id', label: 'Normalized tax ID', type: 'string', fieldType: 'text' },
  { name: 'tbve_certificate_url', label: 'Tax audit certificate', type: 'string', fieldType: 'text' },
] as const;

export class HubSpotClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly base = 'https://api.hubapi.com',
  ) {}

  private async token(body: Record<string, string>): Promise<OAuthTokens> {
    const res = await fetchWithTimeout(this.fetchImpl, `${this.base}/oauth/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: this.clientId, client_secret: this.clientSecret, ...body }),
    });
    const j = await json<{ access_token: string; refresh_token?: string; expires_in?: number }>(res, 'HubSpot token exchange');
    return { accessToken: j.access_token, ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}), ...(j.expires_in ? { expiresAt: Date.now() + j.expires_in * 1000 } : {}) };
  }

  exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  }

  refresh(refreshToken: string): Promise<OAuthTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async tokenInfo(accessToken: string): Promise<{ hubId: string; user?: string; hubDomain?: string }> {
    const res = await fetchWithTimeout(this.fetchImpl, `${this.base}/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`);
    const j = await json<{ hub_id: number; user?: string; hub_domain?: string }>(res, 'HubSpot token info');
    return { hubId: String(j.hub_id), ...(j.user ? { user: j.user } : {}), ...(j.hub_domain ? { hubDomain: j.hub_domain } : {}) };
  }

  /** Create our custom properties on companies + contacts (409 = already there). */
  async ensureProperties(accessToken: string): Promise<void> {
    for (const [objectType, groupName] of [['companies', 'companyinformation'], ['contacts', 'contactinformation']] as const) {
      const res = await fetchWithTimeout(this.fetchImpl, `${this.base}/crm/v3/properties/${objectType}/batch/create`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: HUBSPOT_PROPERTIES.map((p) => ({ ...p, groupName })) }),
      });
      if (!res.ok && res.status !== 409 && res.status !== 207) throw new IntegrationError(`HubSpot property setup failed (${res.status})`, res.status);
    }
  }

  async updateObject(accessToken: string, objectType: string, objectId: string, properties: Record<string, string>, timeoutMs = 3000): Promise<void> {
    const type = objectType.toLowerCase().replace(/^company$/, 'companies').replace(/^contact$/, 'contacts');
    const res = await fetchWithTimeout(
      this.fetchImpl,
      `${this.base}/crm/v3/objects/${encodeURIComponent(type)}/${encodeURIComponent(objectId)}`,
      { method: 'PATCH', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ properties }) },
      timeoutMs,
    );
    if (!res.ok) throw new IntegrationError(`HubSpot write-back failed (${res.status})`, res.status);
  }
}

// ---------------------------------------------------------------------------
// Pipedrive
// ---------------------------------------------------------------------------

const TAX_FIELD_RE = /\b(vat|tax|tin|ein|gst|gstin|abn|siret|siren|cif|nif|nip|uid|ust|btw|mwst|tva|iva|cnpj|rfc)\b/i;

export class PipedriveClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly oauthBase = 'https://oauth.pipedrive.com',
  ) {}

  private async token(body: Record<string, string>): Promise<OAuthTokens> {
    const res = await fetchWithTimeout(this.fetchImpl, `${this.oauthBase}/oauth/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form(body),
    });
    const j = await json<{ access_token: string; refresh_token?: string; expires_in?: number; api_domain?: string }>(res, 'Pipedrive token exchange');
    return {
      accessToken: j.access_token,
      ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}),
      ...(j.expires_in ? { expiresAt: Date.now() + j.expires_in * 1000 } : {}),
      ...(j.api_domain ? { apiDomain: j.api_domain } : {}),
    };
  }

  exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  }

  refresh(refreshToken: string): Promise<OAuthTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  private async get<T>(t: OAuthTokens, path: string): Promise<T> {
    const base = (t.apiDomain ?? 'https://api.pipedrive.com').replace(/\/+$/, '');
    const res = await fetchWithTimeout(this.fetchImpl, `${base}${path}`, { headers: { authorization: `Bearer ${t.accessToken}` } });
    return (await json<{ data: T }>(res, `Pipedrive GET ${path}`)).data;
  }

  me(t: OAuthTokens) {
    return this.get<{ id: number; company_id: number; company_name?: string; email?: string }>(t, '/api/v1/users/me');
  }

  /**
   * Find the organization's tax ID and website: the first organization field
   * whose name looks like a tax identifier, plus the standard `website` field.
   */
  async organizationTaxProfile(t: OAuthTokens, resource: 'organization' | 'deal', id: string): Promise<{ orgId: string; name?: string; taxId?: string; website?: string } | null> {
    let orgId = id;
    if (resource === 'deal') {
      const deal = await this.get<{ org_id?: { value?: number } | number | null }>(t, `/api/v1/deals/${encodeURIComponent(id)}`);
      const v = typeof deal.org_id === 'object' && deal.org_id ? deal.org_id.value : deal.org_id;
      if (!v) return null;
      orgId = String(v);
    }
    const [org, fields] = await Promise.all([
      this.get<Record<string, unknown>>(t, `/api/v1/organizations/${encodeURIComponent(orgId)}`),
      this.get<{ key: string; name: string }[]>(t, '/api/v1/organizationFields'),
    ]);
    const taxField = fields.find((f) => TAX_FIELD_RE.test(f.name) && typeof org[f.key] === 'string' && org[f.key]);
    const website = Object.entries(org).find(([k, v]) => /website|domain/i.test(k) && typeof v === 'string' && v)?.[1] as string | undefined;
    return {
      orgId,
      ...(typeof org.name === 'string' ? { name: org.name } : {}),
      ...(taxField ? { taxId: org[taxField.key] as string } : {}),
      ...(website ? { website } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// monday.com
// ---------------------------------------------------------------------------

export class MondayClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly endpoint = 'https://api.monday.com/v2',
  ) {}

  async graphql<T>(token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetchWithTimeout(this.fetchImpl, this.endpoint, {
      method: 'POST',
      headers: { authorization: token, 'content-type': 'application/json', 'api-version': '2025-04' },
      body: JSON.stringify({ query, variables }),
    });
    const j = await json<{ data?: T; errors?: { message: string }[]; error_message?: string }>(res, 'monday GraphQL');
    if (j.errors?.length || j.error_message) throw new IntegrationError(j.errors?.[0]?.message ?? j.error_message ?? 'monday GraphQL error');
    return j.data as T;
  }

  async readColumns(token: string, itemId: string, columnIds: string[]): Promise<{ name: string; values: Record<string, string> }> {
    const data = await this.graphql<{ items: { name: string; column_values: { id: string; text: string | null }[] }[] }>(
      token,
      'query ($ids: [ID!], $cols: [String!]) { items(ids: $ids) { name column_values(ids: $cols) { id text } } }',
      { ids: [itemId], cols: columnIds },
    );
    const item = data.items?.[0];
    if (!item) throw new IntegrationError(`Item ${itemId} not found`);
    return { name: item.name, values: Object.fromEntries(item.column_values.map((cv) => [cv.id, cv.text ?? ''])) };
  }

  async writeColumns(token: string, boardId: string, itemId: string, values: Record<string, unknown>): Promise<void> {
    await this.graphql(
      token,
      'mutation ($board: ID!, $item: ID!, $vals: JSON!) { change_multiple_column_values(board_id: $board, item_id: $item, column_values: $vals, create_labels_if_missing: true) { id } }',
      { board: boardId, item: itemId, vals: JSON.stringify(values) },
    );
  }
}
