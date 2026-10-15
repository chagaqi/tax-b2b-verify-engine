import { hmacSha256, randomToken, seal, toHex, unseal } from '../lib/crypto.js';
import type { ITenantStore, Platform, Tenant } from '../stores/types.js';
import type { PlanId } from '../billing/plans.js';

export const API_KEY_RE = /^tbv_(live|test)_[A-Za-z0-9_-]{32}$/;

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt?: number;
  apiDomain?: string;
}

export class TenantService {
  constructor(
    private readonly store: ITenantStore,
    private readonly appSecret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async hashKey(apiKey: string): Promise<string> {
    return toHex(await hmacSha256(this.appSecret, `apikey:${apiKey}`));
  }

  private newId(): string {
    return `tnt_${randomToken(12)}`;
  }

  private newKey(): string {
    return `tbv_live_${randomToken(24)}`;
  }

  get(id: string): Promise<Tenant | null> {
    return this.store.get(id);
  }

  save(t: Tenant): Promise<void> {
    return this.store.put({ ...t, updatedAt: this.now().toISOString() });
  }

  /** Apply a change to the *latest* stored record, so concurrent writers don't clobber each other's fields. */
  async update(id: string, change: (current: Tenant) => Tenant): Promise<Tenant> {
    const current = await this.store.get(id);
    if (!current) throw new Error(`Tenant ${id} not found`);
    const next = { ...change(current), updatedAt: this.now().toISOString() };
    await this.store.put(next);
    return next;
  }

  /** Creates a tenant with an API key. The plaintext key is only ever returned here. */
  async createWithKey(input: { platform: Platform; name?: string; email?: string; externalAccountId?: string; plan?: PlanId }): Promise<{ tenant: Tenant; apiKey: string }> {
    const apiKey = this.newKey();
    const ts = this.now().toISOString();
    const tenant: Tenant = {
      id: this.newId(),
      platform: input.platform,
      plan: input.plan ?? 'free',
      apiKeyHash: await this.hashKey(apiKey),
      createdAt: ts,
      updatedAt: ts,
      ...(input.name ? { name: input.name } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.externalAccountId ? { externalAccountId: input.externalAccountId } : {}),
    };
    await this.store.put(tenant);
    return { tenant, apiKey };
  }

  async rotateKey(tenant: Tenant): Promise<{ tenant: Tenant; apiKey: string }> {
    const apiKey = this.newKey();
    const next = { ...tenant, apiKeyHash: await this.hashKey(apiKey), updatedAt: this.now().toISOString() };
    await this.store.put(next);
    return { tenant: next, apiKey };
  }

  async findByApiKey(apiKey: string): Promise<Tenant | null> {
    if (!API_KEY_RE.test(apiKey)) return null;
    return this.store.findByApiKeyHash(await this.hashKey(apiKey));
  }

  findByExternal(platform: Platform, accountId: string): Promise<Tenant | null> {
    return this.store.findByExternal(platform, accountId);
  }

  setAlias(alias: string, tenantId: string): Promise<void> {
    return this.store.setAlias(alias, tenantId);
  }

  findByAlias(alias: string): Promise<Tenant | null> {
    return this.store.findByAlias(alias);
  }

  /**
   * Marketplace installs are zero-config: the first signed request from an
   * account provisions a Free tenant for it.
   */
  async ensurePlatformTenant(platform: Platform, accountId: string, extra: { name?: string; email?: string } = {}): Promise<Tenant> {
    const existing = await this.store.findByExternal(platform, accountId);
    if (existing) return existing;
    const ts = this.now().toISOString();
    const tenant: Tenant = {
      id: this.newId(),
      platform,
      externalAccountId: accountId,
      plan: 'free',
      createdAt: ts,
      updatedAt: ts,
      ...(extra.name ? { name: extra.name } : {}),
      ...(extra.email ? { email: extra.email } : {}),
    };
    await this.store.put(tenant);
    // Two first requests can race; the external index is first-writer-wins, so return the winner.
    return (await this.store.findByExternal(platform, accountId)) ?? tenant;
  }

  async storeTokens(tenant: Tenant, platform: Platform, tokens: OAuthTokens): Promise<Tenant> {
    const sealed = await seal(this.appSecret, JSON.stringify(tokens));
    return this.update(tenant.id, (t) => ({
      ...t,
      integrations: { ...t.integrations, [platform]: { sealed, updatedAt: this.now().toISOString() } },
    }));
  }

  async readTokens(tenant: Tenant, platform: Platform): Promise<OAuthTokens | null> {
    const rec = tenant.integrations?.[platform];
    if (!rec) return null;
    try {
      return JSON.parse(await unseal(this.appSecret, rec.sealed)) as OAuthTokens;
    } catch {
      return null;
    }
  }
}
