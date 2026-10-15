import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HUBSPOT_SCOPES } from '../../core-api/src/integrations/clients.js';
import { hubspotOutputFields } from '../../core-api/src/integrations/hubspot.js';
import { toResponse } from '../../core-api/src/operations.js';
import { validateTaxId } from '../../core-api/src/taxid/index.js';
import { CARD_PROPERTIES, VERDICT_TAG, domainOf, firstTaxId, objectTypeName } from '../src/app/cards/model.js';

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const project = read('../hsproject.json');
const app = read('../src/app/app-hsmeta.json');
const card = read('../src/app/cards/tax-verify-card-hsmeta.json');
const action = read('../src/app/workflow-actions/verify-tax-id-hsmeta.json');
const legacy = read('../workflow-action-definition.json');

const sample = hubspotOutputFields(
  toResponse({
    verdict: 'registry_verified', fallback: false, confidence: 'high', validation: validateTaxId('IE6388047V'),
    registry: { source: 'vies', status: 'valid', name: 'X' }, checkedAt: '2026-10-15T00:00:00Z',
  }),
);

describe('HubSpot project config', () => {
  it('uses the 2025.2 developer platform with src/ as root', () => {
    expect(project).toEqual({ name: 'tax-id-verify', srcDir: 'src', platformVersion: '2025.2' });
  });

  it('requests every scope the backend relies on and redirects to the OAuth callback', () => {
    expect(app.config.auth.requiredScopes).toEqual(expect.arrayContaining(HUBSPOT_SCOPES));
    expect(app.config.auth.redirectUrls).toEqual(['https://verify.taxb2b.app/v1/install/hubspot/callback']);
    expect(app.config.permittedUrls.fetch).toEqual(['https://verify.taxb2b.app']);
  });

  it('registers the CRM card on companies and contacts with an existing entrypoint', () => {
    expect(card.config).toMatchObject({ location: 'crm.record.tab', objectTypes: ['companies', 'contacts'] });
    expect(existsSync(new URL(`../src${card.config.entrypoint}`, import.meta.url))).toBe(true);
  });
});

describe('workflow action ↔ backend contract', () => {
  it('posts to the backend workflow-action route', () => {
    expect(new URL(action.config.actionUrl).pathname).toBe('/v1/integrations/hubspot/workflow-action');
  });

  it('declares the input fields the backend reads', () => {
    expect(action.config.inputFields.map((f: { typeDefinition: { name: string } }) => f.typeDefinition.name)).toEqual(['tax_id', 'country', 'generate_certificate']);
  });

  it('declares exactly the output fields the backend returns', () => {
    const declared = action.config.outputFields.map((f: { typeDefinition: { name: string } }) => f.typeDefinition.name).sort();
    expect(declared).toEqual(Object.keys(sample).sort());
    const statusOptions = action.config.outputFields[0].typeDefinition.options.map((o: { value: string }) => o.value);
    expect(statusOptions).toEqual(expect.arrayContaining([...Object.keys(VERDICT_TAG), 'missing_tax_id', 'quota_exceeded']));
  });

  it('labels every field and keeps the legacy v4 definition in sync', () => {
    const l = action.config.labels.en;
    for (const f of action.config.outputFields) expect(l.outputFieldLabels[f.typeDefinition.name]).toBeTruthy();
    for (const f of action.config.inputFields) expect(l.inputFieldLabels[f.typeDefinition.name]).toBeTruthy();
    expect(legacy).toEqual(action.config);
  });
});

describe('card model', () => {
  it('finds the first populated tax property', () => {
    expect(firstTaxId({ vat_number: ' ', tax_id: 'DE136695976', vat_id: null })).toBe('DE136695976');
    expect(firstTaxId({})).toBe('');
    expect(CARD_PROPERTIES).toEqual(expect.arrayContaining(['vat_number', 'domain', 'tbve_tax_id_status']));
  });

  it('derives a bare domain from domain, website or email', () => {
    expect(domainOf({ domain: 'acme.com' })).toBe('acme.com');
    expect(domainOf({ website: 'https://www.Acme.io/about' })).toBe('acme.io');
    expect(domainOf({ email: 'jane@acme.co.uk' })).toBe('acme.co.uk');
    expect(domainOf({})).toBeUndefined();
  });

  it('maps object type ids', () => {
    expect(objectTypeName('0-2')).toBe('companies');
    expect(objectTypeName('0-1')).toBe('contacts');
    expect(objectTypeName('2-1234')).toBe('2-1234');
  });
});
