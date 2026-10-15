import { describe, expect, it, vi } from 'vitest';
import { signStripePayload } from '../../core-api/src/index.js';
import { VIES_REST, makeApp, viesValid } from '../../core-api/test/helpers.js';
import type { ViewDeps } from '../src/views/CustomerVerifyView';

// Stripe's official test harness registers its matchers on a global `expect`.
(globalThis as { expect?: unknown }).expect = expect;
const { render, getMockContextProps } = await import('@stripe/ui-extension-sdk/testing');
const { Badge, Banner, Button, Link, PropertyListItem, Select, TextField } = await import('@stripe/ui-extension-sdk/ui');
const { CustomerVerify } = await import('../src/views/CustomerVerifyView');

const CUSTOMER = {
  id: 'cus_123',
  name: 'Google Ireland',
  email: 'ap@google.ie',
  tax_ids: { data: [{ id: 'txi_1', type: 'eu_vat', value: 'IE6388047V', country: 'IE' }] },
};

async function setup(customer: Record<string, unknown> = CUSTOMER) {
  const backend = await makeApp({ routes: { [VIES_REST]: viesValid() } });
  const context = getMockContextProps({
    environment: { objectContext: { id: 'cus_123', object: 'customer' }, constants: { API_BASE: 'https://verify.test' } },
  });
  const stripeApiFetch = vi.fn(async (path: string, init?: { method?: string; body?: unknown }) =>
    init?.method === 'POST'
      ? { ok: true, status: 200, json: { id: 'cus_123' }, headers: {}, redirected: false, statusText: 'OK', type: 'basic', url: path }
      : { ok: true, status: 200, json: customer, headers: {}, redirected: false, statusText: 'OK', type: 'basic', url: path },
  );
  const deps: ViewDeps = {
    stripeApiFetch: stripeApiFetch as unknown as ViewDeps['stripeApiFetch'],
    // Same scheme as fetchStripeSignature(): signs { user_id, account_id } with the app secret.
    sign: () => signStripePayload(JSON.stringify({ user_id: context.userContext.id, account_id: context.userContext.account.id }), 'absec_stripe_app_test'),
    fetch: ((url: string, init?: RequestInit) => backend.request(new URL(url).pathname, init ?? {})) as typeof fetch,
    toast: vi.fn(),
  };
  const view = render(<CustomerVerify {...context} deps={deps} />);
  await view.update();
  return { ...view, deps, stripeApiFetch, backend, context };
}

const settle = async (update: () => Promise<void>, until: () => boolean) => {
  for (let i = 0; i < 50 && !until(); i++) await update();
};

describe('CustomerVerifyView (official Stripe test renderer)', () => {
  it('loads the customer with expanded tax IDs and preselects the first one', async () => {
    const { wrapper, stripeApiFetch } = await setup();
    expect(stripeApiFetch).toHaveBeenCalledWith('/v1/customers/cus_123?expand[]=tax_ids');
    expect(wrapper.find(Select)?.props.value).toBe('txi_1');
    expect(wrapper).toContainText('Domain checked: google.ie');
  });

  it('verifies end-to-end against the core API and renders the verdict', async () => {
    const { wrapper, update, backend, context } = await setup();
    wrapper.findAll(Button)[0]!.trigger('onPress');
    await settle(update, () => wrapper.findAll(Badge).length > 0);
    expect(wrapper.find(Badge)?.props.type).toBe('positive');
    expect(wrapper).toContainText('Verified in VIES');
    expect(wrapper).toContainText('IE6388047V is active in EU VIES (GOOGLE IRELAND LIMITED).');
    const labels = wrapper.findAll(PropertyListItem).map((n) => n.props.label);
    expect(labels).toEqual(expect.arrayContaining(['Tax ID', 'Registered name', 'Email domain', 'Checked']));
    expect(await backend.services.tenants.findByExternal('stripe', context.userContext.account.id)).toBeTruthy();
  });

  it('issues a certificate and saves the result to customer metadata', async () => {
    const { wrapper, update, stripeApiFetch, deps } = await setup();
    wrapper.findAll(Button)[1]!.trigger('onPress');
    await settle(update, () => wrapper.findAll(Link).length > 0);
    expect(wrapper.find(Link)?.props.href).toMatch(/^https:\/\/verify\.test\/v1\/certificates\/tvc_[\w-]{22}\.pdf\?exp=\d+&sig=/);
    const save = wrapper.findAll(Button).find((b) => b.props.size === 'small')!;
    save.trigger('onPress');
    await settle(update, () => (deps.toast as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    const post = stripeApiFetch.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(post[0]).toBe('/v1/customers/cus_123');
    expect(decodeURIComponent(String(post[1]!.body))).toContain('metadata[tbve_tax_status]=registry_verified');
    expect(deps.toast).toHaveBeenCalledWith('Verification saved to customer metadata', { type: 'success' });
  });

  it('offers manual entry when the customer has no tax ID and surfaces API errors', async () => {
    const { wrapper, update } = await setup({ id: 'cus_123', name: 'No Tax', email: null, tax_ids: { data: [] } });
    expect(wrapper.find(Banner)?.props.title).toBe('No tax ID on this customer');
    const field = wrapper.find(TextField)!;
    field.trigger('onChange', { target: { value: '123456789' } } as never);
    await update();
    wrapper.findAll(Button)[0]!.trigger('onPress');
    await settle(update, () => wrapper.findAll(Banner).length > 1);
    const error = wrapper.findAll(Banner).at(-1)!;
    expect(error.props).toMatchObject({ type: 'critical', title: 'Verification failed' });
    expect(String(error.props.description)).toContain('Cannot infer the jurisdiction');
  });
});
