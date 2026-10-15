export type PlanId = 'free' | 'pro' | 'business';
export type Metric = 'taxVerifications' | 'enrichments' | 'certificates';

export interface Plan {
  id: PlanId;
  name: string;
  priceUsdMonthly: number;
  /** Monthly limits; `null` = unlimited. */
  limits: Record<Metric, number | null>;
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: 'free', name: 'Free', priceUsdMonthly: 0, limits: { taxVerifications: 100, enrichments: 100, certificates: 10 } },
  pro: { id: 'pro', name: 'Pro', priceUsdMonthly: 29, limits: { taxVerifications: 5_000, enrichments: 5_000, certificates: null } },
  business: { id: 'business', name: 'Business', priceUsdMonthly: 99, limits: { taxVerifications: 50_000, enrichments: 50_000, certificates: null } },
};

export const METRICS: readonly Metric[] = ['taxVerifications', 'enrichments', 'certificates'];

/** Map a product/price/plan label from a billing provider onto our plans. */
export function planFromHint(hint: string | null | undefined): PlanId {
  const h = (hint ?? '').toLowerCase();
  if (/business|scale|team|enterprise/.test(h)) return 'business';
  if (/\bfree\b/.test(h)) return 'free';
  return 'pro';
}
