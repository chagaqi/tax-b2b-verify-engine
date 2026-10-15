import { ApiError } from '../lib/errors.js';
import type { IUsageStore, Tenant } from '../stores/types.js';
import { METRICS, PLANS, type Metric } from './plans.js';

export interface QuotaState {
  metric: Metric;
  used: number;
  limit: number | null;
  remaining: number | null;
  period: string;
}

function period(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** Seconds until the end of the UTC month, plus a day of slack. */
function secondsLeftInMonth(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.ceil((next - now.getTime()) / 1000) + 86_400;
}

export class EntitlementService {
  constructor(
    private readonly usage: IUsageStore,
    private readonly opts: { now?: () => Date; upgradeUrl?: (tenant: Tenant) => string | undefined } = {},
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private key(tenantId: string, metric: Metric, p: string): string {
    return `quota:${tenantId}:${metric}:${p}`;
  }

  async state(tenant: Tenant, metric: Metric): Promise<QuotaState> {
    const p = period(this.now());
    const used = await this.usage.get(this.key(tenant.id, metric, p));
    const limit = PLANS[tenant.plan].limits[metric];
    return { metric, used, limit, remaining: limit === null ? null : Math.max(0, limit - used), period: p };
  }

  async summary(tenant: Tenant): Promise<Record<Metric, QuotaState>> {
    const entries = await Promise.all(METRICS.map(async (m) => [m, await this.state(tenant, m)] as const));
    return Object.fromEntries(entries) as Record<Metric, QuotaState>;
  }

  /** Throws 402 when `n` more units would exceed the plan's monthly quota. */
  async assertAvailable(tenant: Tenant, metric: Metric, n = 1): Promise<QuotaState> {
    const s = await this.state(tenant, metric);
    if (s.limit !== null && s.used + n > s.limit) {
      const upgradeUrl = this.opts.upgradeUrl?.(tenant);
      throw new ApiError(402, 'quota_exceeded', `Monthly ${metric} quota of ${s.limit} reached on the ${PLANS[tenant.plan].name} plan`, {
        metric,
        limit: s.limit,
        used: s.used,
        period: s.period,
        plan: tenant.plan,
        ...(upgradeUrl ? { upgradeUrl } : {}),
      });
    }
    return s;
  }

  /**
   * Atomically reserve `n` units: increment first (INCRBY returns the new total), and roll
   * back + throw 402 if that overshoots the limit. Concurrent requests cannot all slip past.
   */
  async consume(tenant: Tenant, metric: Metric, n = 1): Promise<QuotaState> {
    const s = await this.assertAvailable(tenant, metric, n);
    const key = this.key(tenant.id, metric, s.period);
    const used = await this.usage.increment(key, n, secondsLeftInMonth(this.now()));
    if (s.limit !== null && used > s.limit) {
      await this.usage.increment(key, -n, secondsLeftInMonth(this.now()));
      await this.assertAvailable(tenant, metric, n); // throws the standard 402 with current numbers
    }
    return { ...s, used, remaining: s.limit === null ? null : Math.max(0, s.limit - used) };
  }

  /** Give back units reserved for work that did not happen. */
  async refund(tenant: Tenant, metric: Metric, n = 1): Promise<void> {
    await this.usage.increment(this.key(tenant.id, metric, period(this.now())), -n, secondsLeftInMonth(this.now()));
  }
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

/** Fixed-window limiter keyed by window index, so counters reset cleanly. */
export async function rateLimit(
  usage: IUsageStore,
  scope: string,
  id: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): Promise<RateLimitResult> {
  const window = Math.floor(now / 1000 / windowSeconds);
  const count = await usage.increment(`rl:${scope}:${id}:${window}`, 1, windowSeconds + 5);
  const resetSeconds = (window + 1) * windowSeconds - Math.floor(now / 1000);
  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetSeconds };
}
