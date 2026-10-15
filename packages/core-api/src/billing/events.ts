import type { ICacheStore, Tenant } from '../stores/types.js';
import type { TenantService } from '../auth/tenants.js';
import { planFromHint, type PlanId } from './plans.js';

/**
 * Translate provider billing events into tenant plan changes.
 * Every handler returns a short outcome string for logs/acknowledgements.
 */

// Provider payloads are large and loosely typed; we read a handful of fields defensively.
type Json = Record<string, any>;

const ACTIVE = new Set(['active', 'trialing', 'past_due']);

async function applyPlan(tenants: TenantService, tenant: Tenant, plan: PlanId, billing: NonNullable<Tenant['billing']>): Promise<string> {
  const defined = Object.fromEntries(Object.entries(billing).filter(([, v]) => v !== undefined)) as NonNullable<Tenant['billing']>;
  await tenants.update(tenant.id, (t) => ({ ...t, plan, billing: { ...t.billing, ...defined } }));
  // Later Stripe/Polar subscription events often carry only provider ids, so remember them.
  // (monday identifies accounts directly; its plan ids are shared and must not become aliases.)
  if (billing.provider !== 'monday') {
    if (billing.subscriptionId) await tenants.setAlias(`${billing.provider}:sub:${billing.subscriptionId}`, tenant.id);
    if (billing.customerId) await tenants.setAlias(`${billing.provider}:cus:${billing.customerId}`, tenant.id);
  }
  return `tenant ${tenant.id} → ${plan}`;
}

/** Resolve a tenant from an explicit id, then from subscription/customer aliases. */
async function resolveTenant(tenants: TenantService, provider: string, ids: { tenantId?: unknown; subscriptionId?: unknown; customerId?: unknown }): Promise<Tenant | null> {
  if (ids.tenantId) {
    const t = await tenants.get(String(ids.tenantId));
    if (t) return t;
  }
  if (typeof ids.subscriptionId === 'string') {
    const t = await tenants.findByAlias(`${provider}:sub:${ids.subscriptionId}`);
    if (t) return t;
  }
  if (typeof ids.customerId === 'string') return tenants.findByAlias(`${provider}:cus:${ids.customerId}`);
  return null;
}

const PLAN_HINT_TTL = 2 * 86_400;

/**
 * @param cache Holds plan hints from subscription events that arrive *before*
 *   `checkout.session.completed` has linked the subscription to a tenant.
 */
export async function handleStripeEvent(tenants: TenantService, event: Json, cache?: ICacheStore): Promise<string> {
  const obj: Json = event?.data?.object ?? {};
  switch (event?.type) {
    case 'checkout.session.completed': {
      const tenantId = obj.client_reference_id ?? obj.metadata?.tenant_id;
      const tenant = tenantId ? await tenants.get(String(tenantId)) : null;
      if (!tenant) return 'ignored: no tenant reference';
      if (obj.mode === 'subscription' && obj.payment_status !== 'paid' && obj.status !== 'complete') return 'ignored: checkout not complete';
      // Sessions carry no price; use the link's metadata.plan, else a hint left by an earlier subscription event.
      const pending = typeof obj.subscription === 'string' ? await cache?.get<string>(`stripe:planhint:${obj.subscription}`) : null;
      return applyPlan(tenants, tenant, planFromHint(obj.metadata?.plan ?? pending), {
        provider: 'stripe',
        customerId: typeof obj.customer === 'string' ? obj.customer : undefined,
        subscriptionId: typeof obj.subscription === 'string' ? obj.subscription : undefined,
        status: 'active',
      });
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const item = obj.items?.data?.[0]?.price ?? {};
      const hint = obj.metadata?.plan ?? item.lookup_key ?? item.nickname;
      const tenant = await resolveTenant(tenants, 'stripe', { tenantId: obj.metadata?.tenant_id, subscriptionId: obj.id, customerId: obj.customer });
      if (!tenant) {
        if (cache && typeof obj.id === 'string' && hint) await cache.set(`stripe:planhint:${obj.id}`, String(hint), PLAN_HINT_TTL);
        return 'ignored: subscription not linked to a tenant';
      }
      const active = event.type !== 'customer.subscription.deleted' && ACTIVE.has(obj.status);
      return applyPlan(tenants, tenant, active ? planFromHint(hint) : 'free', {
        provider: 'stripe',
        customerId: typeof obj.customer === 'string' ? obj.customer : undefined,
        subscriptionId: obj.id,
        status: obj.status,
        currentPeriodEnd: typeof obj.current_period_end === 'number' ? new Date(obj.current_period_end * 1000).toISOString() : undefined,
      });
    }
    default:
      return `ignored: ${String(event?.type)}`;
  }
}

export async function handlePolarEvent(tenants: TenantService, event: Json): Promise<string> {
  const type = String(event?.type ?? '');
  if (!type.startsWith('subscription.')) return `ignored: ${type}`;
  const sub: Json = event.data ?? {};
  const tenant = await resolveTenant(tenants, 'polar', {
    tenantId: sub.metadata?.tenant_id ?? sub.metadata?.reference_id ?? sub.customer?.external_id ?? sub.customer?.metadata?.tenant_id,
    subscriptionId: sub.id,
    customerId: sub.customer_id ?? sub.customer?.id,
  });
  if (!tenant) return 'ignored: no tenant reference';
  const hint = sub.product?.metadata?.plan ?? sub.product?.name ?? sub.metadata?.plan;
  // `subscription.canceled` = cancel at period end (still paid); `revoked` = access ends now.
  const ends = type === 'subscription.revoked' || sub.status === 'canceled' || sub.status === 'unpaid' || sub.status === 'incomplete_expired';
  return applyPlan(tenants, tenant, ends ? 'free' : planFromHint(hint), {
    provider: 'polar',
    customerId: sub.customer_id ?? sub.customer?.id,
    subscriptionId: sub.id,
    status: type === 'subscription.canceled' ? 'canceling' : sub.status,
    currentPeriodEnd: sub.current_period_end ?? undefined,
  });
}

/** monday.com app lifecycle + monetization webhooks. */
export async function handleMondayEvent(tenants: TenantService, event: Json): Promise<string> {
  const type = String(event?.type ?? '');
  const data: Json = event?.data ?? {};
  const accountId = data.account_id !== undefined ? String(data.account_id) : undefined;
  if (!accountId) return 'ignored: no account_id';
  const tenant = await tenants.ensurePlatformTenant('monday', accountId, { name: data.account_name, email: data.user_email });
  const sub: Json = data.subscription ?? {};
  switch (type) {
    case 'install':
      return `installed: tenant ${tenant.id}`;
    case 'uninstall':
    case 'app_subscription_cancelled':
    case 'app_subscription_cancelled_by_user_and_uninstalled':
    case 'app_trial_subscription_ended':
      return applyPlan(tenants, tenant, 'free', { provider: 'monday', status: type });
    case 'app_subscription_created':
    case 'app_subscription_changed':
    case 'app_subscription_renewed':
    case 'app_trial_subscription_started':
      return applyPlan(tenants, tenant, planFromHint(sub.plan_id), {
        provider: 'monday',
        subscriptionId: sub.plan_id ? String(sub.plan_id) : undefined,
        status: sub.is_trial ? 'trialing' : 'active',
        currentPeriodEnd: sub.renewal_date ?? undefined,
      });
    case 'app_subscription_cancelled_by_user':
      return applyPlan(tenants, tenant, tenant.plan, { provider: 'monday', status: 'canceling', currentPeriodEnd: sub.renewal_date ?? undefined });
    default:
      return `ignored: ${type}`;
  }
}
