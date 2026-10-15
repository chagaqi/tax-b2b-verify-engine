import { Alert, Button, Checkbox, Input, Link, LoadingSpinner, StatusTag, Text } from '@hubspot/ui-extensions';
import { createRenderer } from '@hubspot/ui-extensions/testing';
import { describe, expect, it, vi } from 'vitest';
import { signHubSpotV3 } from '../../core-api/src/index.js';
import { VIES_REST, makeApp, viesValid } from '../../core-api/test/helpers.js';
import { TaxVerifyCard } from '../src/app/cards/TaxVerifyCard.js';

const props = (over: Record<string, string | null> = {}) => ({
  properties: { name: 'Google Ireland', domain: 'google.ie', vat_number: 'IE6388047V', ...over },
  error: null,
  isLoading: false,
  isRefetching: false,
  refetch: async () => {},
});

/** Behaves like hubspot.fetch: appends portal/user query params, JSON-encodes and v3-signs the body. */
async function signedFetcher(portalId = 4455) {
  const backend = await makeApp({ routes: { [VIES_REST]: viesValid() } });
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = async (url: string, opts: { method: 'POST'; body: Record<string, unknown> }) => {
    const u = new URL(url);
    u.search = new URLSearchParams({ userId: '7', portalId: String(portalId), userEmail: 'rep@acme.co', appId: '99' }).toString();
    const raw = JSON.stringify(opts.body);
    const ts = String(Date.now());
    calls.push({ url: u.toString(), body: opts.body });
    return backend.request(u.pathname + u.search, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hubspot-request-timestamp': ts,
        'x-hubspot-signature-v3': await signHubSpotV3('POST', `https://verify.test${u.pathname}${u.search}`, raw, ts, 'hs-client-secret'),
      },
      body: raw,
    });
  };
  return { backend, fetcher, calls };
}

describe('TaxVerifyCard (official HubSpot renderer)', () => {
  it('shows a spinner while CRM properties load', () => {
    const { render, mocks, find } = createRenderer('crm.record.tab');
    mocks.useCrmProperties.nextResult({ ...props(), isLoading: true });
    render(<TaxVerifyCard fetcher={vi.fn()} />);
    expect(find(LoadingSpinner).props.label).toBe('Loading record…');
  });

  it('prefills the tax ID from the record and mentions the domain', async () => {
    const { render, mocks, find, waitFor } = createRenderer('crm.record.tab');
    mocks.useCrmProperties.willCall(() => props());
    render(<TaxVerifyCard fetcher={vi.fn()} />);
    await waitFor(() => expect(find(Input).props.value).toBe('IE6388047V'));
    expect(find(Text, (n) => Boolean(n.text?.includes('google.ie'))).text).toBe('Domain intelligence for google.ie is included.');
  });

  it('verifies end-to-end through a v3-signed request and renders the verdict', async () => {
    const { fetcher, calls, backend } = await signedFetcher();
    const { render, mocks, find, findAll, waitFor } = createRenderer('crm.record.tab');
    mocks.useCrmProperties.willCall(() => props());
    render(<TaxVerifyCard fetcher={fetcher} />);
    await waitFor(() => expect(find(Input).props.value).toBe('IE6388047V'));
    find(Checkbox).trigger('onChange', true as never);
    find(Button, { testId: 'verify' }).trigger('onClick');
    await waitFor(() => expect(findAll(StatusTag).length).toBeGreaterThan(0), { timeoutInMs: 5000 });
    expect(find(StatusTag).props.variant).toBe('success');
    expect(find(StatusTag).text).toBe('Verified in EU VIES');
    expect(find(Link).text).toBe('Download audit certificate (PDF)');
    expect(calls[0]!.body).toMatchObject({ taxId: 'IE6388047V', certificate: true, domain: 'google.ie', companyName: 'Google Ireland', objectType: expect.any(String) });
    expect(mocks.actions.addAlert.calls[0]?.[0]).toMatchObject({ type: 'success', message: expect.stringContaining('GOOGLE IRELAND LIMITED') });
    expect(await backend.services.tenants.findByExternal('hubspot', '4455')).toBeTruthy();
  });

  it('shows backend errors in an Alert', async () => {
    const { fetcher } = await signedFetcher();
    const { render, mocks, find, findAll, waitFor } = createRenderer('crm.record.tab');
    mocks.useCrmProperties.willCall(() => props({ vat_number: null, domain: null }));
    render(<TaxVerifyCard fetcher={fetcher} />);
    find(Input).trigger('onChange', '123456789' as never);
    await waitFor(() => expect(find(Button, { testId: 'verify' }).props.disabled).toBe(false));
    find(Button, { testId: 'verify' }).trigger('onClick');
    await waitFor(() => expect(findAll(Alert).length).toBe(1), { timeoutInMs: 5000 });
    expect(find(Alert).props.title).toBe('Verification failed');
    expect(find(Alert).text).toContain('Cannot infer the jurisdiction');
  });

  it('refreshes record properties after a successful write-back', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ verdict: 'checksum_valid', valid: true, summary: 'ok', checkedAt: 'x', fallback: false, taxId: { formatted: 'DE1', countryName: 'Germany', schemeName: 'VAT' }, registry: { status: 'skipped' }, writeback: 'written' })),
    );
    const { render, mocks, find, findAll, waitFor } = createRenderer('crm.record.tab');
    mocks.useCrmProperties.willCall(() => props({ vat_number: 'DE136695976' }));
    render(<TaxVerifyCard fetcher={fetcher} />);
    await waitFor(() => expect(find(Input).props.value).toBe('DE136695976'));
    find(Button, { testId: 'verify' }).trigger('onClick');
    await waitFor(() => expect(findAll(StatusTag).length).toBe(1));
    expect(mocks.actions.refreshObjectProperties.callCount).toBe(1);
  });
});
