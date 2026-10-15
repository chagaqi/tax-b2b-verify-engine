import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  DescriptionList,
  DescriptionListItem,
  Divider,
  Flex,
  Input,
  Link,
  LoadingSpinner,
  StatusTag,
  Text,
  hubspot,
  useExtensionActions,
  useExtensionContext,
} from '@hubspot/ui-extensions';
import { useCrmProperties } from '@hubspot/ui-extensions/crm';
import { API_BASE, CARD_PROPERTIES, VERDICT_TAG, domainOf, firstTaxId, objectTypeName, type CardResult } from './model';

type Fetcher = (url: string, options: { method: 'POST'; body: Record<string, unknown>; timeout?: number }) => Promise<Response>;

hubspot.extend<'crm.record.tab'>(() => <TaxVerifyCard fetcher={hubspot.fetch} />);

export function TaxVerifyCard({ fetcher, apiBase = API_BASE }: { fetcher: Fetcher; apiBase?: string }) {
  const context = useExtensionContext<'crm.record.tab'>();
  const actions = useExtensionActions<'crm.record.tab'>();
  const { properties, isLoading, error: propsError } = useCrmProperties(CARD_PROPERTIES);

  const [taxId, setTaxId] = useState('');
  const [certificate, setCertificate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CardResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading) setTaxId((current) => current || firstTaxId(properties));
  }, [isLoading, properties]);

  if (isLoading) return <LoadingSpinner label="Loading record…" />;
  if (propsError) return <Alert title="Could not read this record" variant="error">{propsError.message}</Alert>;

  const domain = domainOf(properties);

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      // hubspot.fetch signs the request (X-HubSpot-Signature-v3) and appends portalId/userId.
      const res = await fetcher(`${apiBase}/v1/integrations/hubspot/card`, {
        method: 'POST',
        timeout: 10_000,
        body: {
          taxId: taxId.trim(),
          certificate,
          ...(domain ? { domain } : {}),
          ...(properties.name ? { companyName: properties.name } : {}),
          objectId: context.crm.objectId,
          objectType: objectTypeName(context.crm.objectTypeId),
        },
      });
      const body = (await res.json()) as CardResult & { error?: { message: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `Request failed (${res.status})`);
      setResult(body);
      actions.addAlert({ type: body.valid ? 'success' : 'warning', message: body.summary });
      if (body.writeback === 'written') actions.refreshObjectProperties();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tag = result ? VERDICT_TAG[result.verdict] : null;

  return (
    <Flex direction="column" gap="md">
      {properties.tbve_tax_id_status && !result && (
        <Text format={{ fontWeight: 'demibold' }}>
          Last check: {properties.tbve_tax_id_status.replace(/_/g, ' ')}
          {properties.tbve_tax_id_checked_at ? ` (${new Date(Number(properties.tbve_tax_id_checked_at)).toISOString().slice(0, 10)})` : ''}
        </Text>
      )}
      <Flex direction="row" gap="sm" align="end">
        <Input name="taxId" label="VAT / tax ID" placeholder="e.g. DE136695976" value={taxId} onChange={(v) => setTaxId(v)} />
        <Button variant="primary" testId="verify" disabled={busy || !taxId.trim()} onClick={verify}>
          {busy ? 'Verifying…' : 'Verify'}
        </Button>
      </Flex>
      <Checkbox name="certificate" checked={certificate} onChange={(c) => setCertificate(c)}>
        Generate a signed audit certificate (PDF)
      </Checkbox>
      {domain && <Text variant="microcopy">Domain intelligence for {domain} is included.</Text>}
      {error && (
        <Alert title="Verification failed" variant="error">
          {error}
        </Alert>
      )}
      {result && tag && (
        <>
          <Divider />
          <Flex direction="row" gap="sm" align="center">
            <StatusTag variant={tag.variant}>{tag.label}</StatusTag>
            {result.fallback && <StatusTag variant="warning">Registry offline — checksum only</StatusTag>}
          </Flex>
          <Text>{result.summary}</Text>
          <DescriptionList direction="row">
            <DescriptionListItem label="Tax ID">{`${result.taxId.formatted} (${result.taxId.countryName})`}</DescriptionListItem>
            <DescriptionListItem label="Registered name">{result.registry.name ?? '—'}</DescriptionListItem>
            <DescriptionListItem label="Registry">{result.registry.status}</DescriptionListItem>
            {result.enrichment ? (
              <DescriptionListItem label="Domain">{`${result.enrichment.domain}: ${result.enrichment.security.grade} security, ${result.enrichment.risk.level} risk`}</DescriptionListItem>
            ) : null}
          </DescriptionList>
          {result.certificate && (
            <Link href={{ url: result.certificate.pdfUrl, external: true }}>Download audit certificate (PDF)</Link>
          )}
        </>
      )}
    </Flex>
  );
}
