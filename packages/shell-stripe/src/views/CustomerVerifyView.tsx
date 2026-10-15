import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';
import {
  Badge,
  Banner,
  Box,
  Button,
  ContextView,
  Divider,
  Inline,
  Link,
  PropertyList,
  PropertyListItem,
  Select,
  Spinner,
  TextField,
} from '@stripe/ui-extension-sdk/ui';
import { fetchStripeSignature, showToast, stripeApiFetch } from '@stripe/ui-extension-sdk/utils';
import { ApiError, createApi } from '../lib/api';
import {
  VERDICT_LABEL,
  domainFromEmail,
  hasVerdict,
  metadataFor,
  metadataForm,
  toVerifyRequest,
  verdictTone,
  type StripeCustomer,
  type StripeVerifyResponse,
} from '../lib/model';

export interface ViewDeps {
  stripeApiFetch: typeof stripeApiFetch;
  sign: () => Promise<string>;
  fetch: typeof fetch;
  toast: (message: string, opts?: { type?: 'success' | 'caution' | 'pending' }) => unknown;
}

const defaultDeps: ViewDeps = {
  stripeApiFetch,
  sign: () => fetchStripeSignature(),
  fetch: (...args) => fetch(...args),
  toast: (message, opts) => showToast(message, opts),
};

const MANUAL = '__manual__';

export function CustomerVerify({ userContext, environment, deps }: ExtensionContextValue & { deps: ViewDeps }) {
  const customerId = environment.objectContext?.id;
  const constants = (environment.constants ?? {}) as { API_BASE?: string };
  const api = useMemo(
    () =>
      createApi({
        baseUrl: constants.API_BASE ?? 'https://verify.taxb2b.app',
        sign: deps.sign,
        fetch: deps.fetch,
        userId: userContext.id ?? '',
        accountId: userContext.account.id,
      }),
    [constants.API_BASE, deps, userContext.id, userContext.account.id],
  );

  const [customer, setCustomer] = useState<StripeCustomer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(MANUAL);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState<'verify' | 'certificate' | 'save' | null>(null);
  const [result, setResult] = useState<StripeVerifyResponse | null>(null);
  const [error, setError] = useState<{ message: string; upgradeUrl?: string } | null>(null);

  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    deps
      .stripeApiFetch(`/v1/customers/${encodeURIComponent(customerId)}?expand[]=tax_ids`)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok || !res.json) throw new Error(`Could not load the customer (${res.status})`);
        const c = res.json as StripeCustomer;
        setCustomer(c);
        const first = c.tax_ids?.data[0];
        if (first) setSelected(first.id);
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [customerId, deps]);

  const taxIds = customer?.tax_ids?.data ?? [];
  const email = customer?.email ?? undefined;

  const run = useCallback(
    async (certificate: boolean) => {
      setBusy(certificate ? 'certificate' : 'verify');
      setError(null);
      try {
        const chosen = taxIds.find((t) => t.id === selected);
        const req = chosen ? toVerifyRequest(chosen) : manual.trim() ? { taxId: manual.trim() } : {};
        const r = await api.verify({
          ...req,
          ...(email ? { email } : {}),
          ...(customer?.name ? { customerName: customer.name } : {}),
          certificate,
        });
        setResult(r);
      } catch (e) {
        setError({ message: (e as Error).message, ...(e instanceof ApiError && e.upgradeUrl ? { upgradeUrl: e.upgradeUrl } : {}) });
      } finally {
        setBusy(null);
      }
    },
    [api, customer?.name, email, manual, selected, taxIds],
  );

  const save = useCallback(async () => {
    if (!result || !hasVerdict(result) || !customerId) return;
    setBusy('save');
    try {
      const res = await deps.stripeApiFetch(`/v1/customers/${encodeURIComponent(customerId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: metadataForm(metadataFor(result)),
      });
      if (!res.ok) throw new Error(`Stripe returned ${res.status}`);
      deps.toast('Verification saved to customer metadata', { type: 'success' });
    } catch (e) {
      deps.toast(`Could not save: ${(e as Error).message}`, { type: 'caution' });
    } finally {
      setBusy(null);
    }
  }, [customerId, deps, result]);

  const canVerify = Boolean(taxIds.length || manual.trim() || email);

  return (
    <ContextView title="Tax ID Verify" description="EU VIES, 49-country check digits and domain risk — with a signed audit certificate.">
      {!customer && !loadError && (
        <Inline css={{ alignY: 'center', gap: 'small' }}>
          <Spinner size="small" /> Loading customer…
        </Inline>
      )}
      {loadError && <Banner type="critical" title="Customer unavailable" description={loadError} />}
      {customer && (
        <Box css={{ stack: 'y', gap: 'medium' }}>
          {taxIds.length > 0 ? (
            <Select label="Tax ID" value={selected} onChange={(e) => setSelected(e.target.value)}>
              {taxIds.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.value} ({t.type})
                </option>
              ))}
              <option value={MANUAL}>Enter another…</option>
            </Select>
          ) : (
            <Banner type="default" title="No tax ID on this customer" description="Enter one below, or verify the email domain only." />
          )}
          {selected === MANUAL && (
            <TextField label="Tax / VAT ID" placeholder="e.g. DE136695976" value={manual} onChange={(e) => setManual(e.target.value)} />
          )}
          {email && <Box css={{ font: 'caption', color: 'secondary' }}>Domain checked: {domainFromEmail(email)}</Box>}
          <Inline css={{ gap: 'small' }}>
            <Button type="primary" disabled={!canVerify || busy !== null} onPress={() => run(false)}>
              {busy === 'verify' ? 'Verifying…' : 'Verify'}
            </Button>
            <Button type="secondary" disabled={!canVerify || busy !== null} onPress={() => run(true)}>
              {busy === 'certificate' ? 'Generating…' : 'Verify + certificate PDF'}
            </Button>
          </Inline>
        </Box>
      )}

      {error && (
        <Box css={{ marginTop: 'medium' }}>
          <Banner
            type="critical"
            title="Verification failed"
            description={error.message}
            actions={error.upgradeUrl ? <Button href={error.upgradeUrl} target="_blank">Upgrade plan</Button> : undefined}
          />
        </Box>
      )}

      {result && (
        <Box css={{ stack: 'y', gap: 'medium', marginTop: 'large' }}>
          <Divider />
          {hasVerdict(result) && (
            <>
              <Inline css={{ gap: 'small', alignY: 'center' }}>
                <Badge type={verdictTone(result.verdict)}>{VERDICT_LABEL[result.verdict]}</Badge>
                {result.fallback && <Badge type="warning">Offline fallback</Badge>}
              </Inline>
              <Box>{result.summary}</Box>
            </>
          )}
          <PropertyList>
            {hasVerdict(result) && <PropertyListItem label="Tax ID" value={`${result.taxId.formatted} · ${result.taxId.countryName}`} />}
            {hasVerdict(result) && result.registry.name && <PropertyListItem label="Registered name" value={result.registry.name} />}
            {hasVerdict(result) && result.registry.address && <PropertyListItem label="Registered address" value={result.registry.address} />}
            {result.enrichment && (
              <PropertyListItem
                label="Email domain"
                value={`${result.enrichment.domain} — ${result.enrichment.classification.replace('_', ' ')}, security ${result.enrichment.security.grade}, risk ${result.enrichment.risk.level}`}
              />
            )}
            {hasVerdict(result) && <PropertyListItem label="Checked" value={new Date(result.checkedAt).toUTCString()} />}
          </PropertyList>
          {hasVerdict(result) && (
            <Inline css={{ gap: 'small' }}>
              {result.certificate && (
                <Link href={result.certificate.pdfUrl} target="_blank" type="primary">
                  Download audit certificate (PDF)
                </Link>
              )}
              <Button type="secondary" size="small" disabled={busy !== null} onPress={save}>
                {busy === 'save' ? 'Saving…' : 'Save to customer'}
              </Button>
            </Inline>
          )}
        </Box>
      )}
    </ContextView>
  );
}

const CustomerVerifyView = (ctx: ExtensionContextValue) => <CustomerVerify {...ctx} deps={defaultDeps} />;

export default CustomerVerifyView;
