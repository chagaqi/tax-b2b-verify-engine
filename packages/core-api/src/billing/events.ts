import type { Tenant } from '../stores/types.js';
import type { TenantService } from '../auth/tenants.js';
import { planFromHint, type PlanId } from './plans.js';

/**
 * Translate provider billing events into tenant plan changes.
 * Every handler returns a short outcome string for logs/acknowledgements.
 */

// Provider payloads are large and loosely typed; we read a handful of fields defensively.
type Json = Record<string, any>;

const ACTIVE = new Set(['active', 'trialing', 'past_due']);

async function applyPlan(tenants: TenantService, tenant: Tenant, plan: PlanId, billing: Tenant['billing']): Promise<string> {
  await tenants.save({ ...tenant, plan, billing: { ...tenant.billing, ...billing } as Tenant['billing'] });
  return `tenant ${tenant.id} → ${plan}`;
}

export async function handleStripeEvent(tenants: TenantService, event: Json): Promise<string> {
  const obj: Json = event?.data?.object ?? {};
  switch (event?.type) {
    case 'checkout.session.completed': {
      const tenantId = obj.client_reference_id ?? obj.metadata?.tenant_id;
      const tenant = tenantId ? await tenants.get(String(tenantId)) : null;
      if (!tenant) return 'ignored: no tenant reference';
      if (obj.mode === 'subscription' && obj.payment_status !== 'paid' && obj.status !== 'complete') return 'ignored: checkout not complete';
      return applyPlan(tenants, tenant, planFromHint(obj.metadata?.plan), {
        provider: 'stripe',
        customerId: typeof obj.customer === 'string' ? obj.customer : undefined,
        subscriptionId: typeof obj.subscription === 'string' ? obj.subscription : undefined,
        status: 'active',
      });
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const tenantId = obj.metadata?.tenant_id;
      const tenant = tenantId ? await tenants.get(String(tenantId)) : null;
      if (!tenant) return 'ignored: subscription has no tenant_id metadata';
      const item = obj.items?.data?.[0]?.price ?? {};
      const hint = obj.metadata?.plan ?? item.lookup_key ?? item.nickname;
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
  const tenantId = sub.metadata?.tenant_id ?? sub.customer?.external_id ?? sub.customer?.metadata?.tenant_id;
  const tenant = tenantId ? await tenants.get(String(tenantId)) : null;
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
