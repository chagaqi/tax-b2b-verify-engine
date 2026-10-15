import type { PlanId } from '../billing/plans.js';

/** Fixed-window counters for quotas and IP rate limits. */
export interface IUsageStore {
  /** Atomically add `by` to `key`; the window starts at the first increment. Returns the new total. */
  increment(key: string, by: number, windowSeconds: number): Promise<number>;
  get(key: string): Promise<number>;
}

export interface StoredDocument {
  id: string;
  contentType: string;
  bytes: Uint8Array;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Blob storage for generated certificate PDFs. */
export interface IDocumentStore {
  put(doc: StoredDocument, ttlSeconds: number): Promise<void>;
  get(id: string): Promise<StoredDocument | null>;
  delete(id: string): Promise<void>;
}

/** JSON cache with TTL (VIES responses, DNS/RDAP lookups, webhook idempotency). */
export interface ICacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  /** Set only when absent; returns true when this call created the key. */
  setIfAbsent<T>(key: string, value: T, ttlSeconds: number): Promise<boolean>;
}

export type Platform = 'direct' | 'stripe' | 'hubspot' | 'pipedrive' | 'monday' | 'makecom' | 'playground';

export interface IntegrationTokens {
  /** AES-GCM sealed JSON ({ accessToken, refreshToken, expiresAt, apiDomain }). */
  sealed: string;
  updatedAt: string;
}

export interface Tenant {
  id: string;
  platform: Platform;
  externalAccountId?: string;
  name?: string;
  email?: string;
  plan: PlanId;
  apiKeyHash?: string;
  billing?: {
    provider: 'stripe' | 'polar' | 'monday';
    customerId?: string;
    subscriptionId?: string;
    status?: string;
    currentPeriodEnd?: string;
  };
  integrations?: Partial<Record<Platform, IntegrationTokens>>;
  createdAt: string;
  updatedAt: string;
}

export interface ITenantStore {
  get(id: string): Promise<Tenant | null>;
  put(tenant: Tenant): Promise<void>;
  findByApiKeyHash(hash: string): Promise<Tenant | null>;
  findByExternal(platform: Platform, accountId: string): Promise<Tenant | null>;
}

export interface Stores {
  usage: IUsageStore;
  documents: IDocumentStore;
  cache: ICacheStore;
  tenants: ITenantStore;
}
