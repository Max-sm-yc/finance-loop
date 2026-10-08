import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseAdapters } from '../src/adapters/supabase.mjs';

const organizationId = '11111111-1111-4111-8111-111111111111';
const accessToken = 'caller.jwt.value';
const secretKey = 'server-secret-must-not-be-used-for-human-inventory';

function json(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('inventory feature and snapshot reads use the caller JWT and preserve a null snapshot safely', async () => {
  const seen = [];
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable', secretKey,
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : undefined });
      return String(url).includes('/organization_feature_flags?') ? json([]) : json(null);
    }
  });
  assert.deepEqual(await adapters.db.getOrganizationFeatureFlags({ organizationId, accessToken }), {
    inventoryTracking: false, productAnalytics: false
  });
  const snapshot = await adapters.db.getInventorySnapshot({
    organizationId, from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z', currency: 'USD', accessToken
  });
  assert.deepEqual(snapshot, {
    from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z', currency: 'USD',
    items: [], movements: [], lines: []
  });
  assert.equal(seen[0].url.includes('/rest/v1/organization_feature_flags?'), true);
  assert.equal(seen[1].url, 'https://tenant.supabase.test/rest/v1/rpc/get_inventory_snapshot_authorized');
  assert.deepEqual(seen[1].body, {
    p_organization_id: organizationId, p_start_at: '2026-09-01T00:00:00Z',
    p_end_at: '2026-10-01T00:00:00Z', p_currency: 'USD'
  });
  for (const call of seen) {
    assert.equal(call.headers.get('apikey'), 'publishable');
    assert.equal(call.headers.get('authorization'), `Bearer ${accessToken}`);
    assert.ok(!call.headers.get('authorization').includes(secretKey));
  }
});

test('atomic purchase and correction adapters send the exact tenant RPC contracts under caller JWT', async () => {
  const seen = [];
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable', secretKey,
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return json('movement-id');
    }
  });
  const purchase = await adapters.db.recordInventoryPurchase({
    organizationId, accountId: 'account-id', amountMinor: -1200, currency: 'USD',
    occurredAt: '2026-10-01T12:00:00Z', description: 'Supply purchase', evidenceFileId: 'evidence-id',
    idempotencyKey: 'purchase-key-1', accessToken,
    lines: [{ itemId: 'definition-id', itemName: 'Tea', quantity: 2, unitCostMinor: 500 }]
  });
  assert.equal(purchase, 'movement-id');
  assert.deepEqual(seen[0].body, {
    p_organization_id: organizationId, p_account_id: 'account-id', p_amount_minor: -1200,
    p_currency: 'USD', p_occurred_at: '2026-10-01T12:00:00Z', p_description: 'Supply purchase',
    p_evidence_file_id: 'evidence-id', p_idempotency_key: 'purchase-key-1',
    p_lines: [{ itemId: 'definition-id', itemName: 'Tea', quantity: 2, unitCostMinor: 500 }]
  });
  const correction = await adapters.db.recordInventoryCorrection({
    organizationId, itemId: 'definition-id', quantityDelta: -1, occurredAt: '2026-10-01T12:00:00Z',
    reason: 'Counted one damaged unit', evidenceFileId: 'evidence-id', idempotencyKey: 'correction-1', accessToken
  });
  assert.deepEqual(correction, { movementId: 'movement-id' });
  assert.deepEqual(seen[1].body, {
    p_organization_id: organizationId, p_item_id: 'definition-id', p_quantity_delta: -1,
    p_occurred_at: '2026-10-01T12:00:00Z', p_reason: 'Counted one damaged unit',
    p_evidence_file_id: 'evidence-id', p_idempotency_key: 'correction-1'
  });
  for (const call of seen) {
    assert.equal(call.headers.get('authorization'), `Bearer ${accessToken}`);
    assert.ok(!call.headers.get('authorization').includes(secretKey));
  }
});

test('product analytics adapter preserves health and source revision context', async () => {
  const expected = {
    from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z', facts: [],
    policy: { currency: 'USD' }, sourceHealth: [{ resource: 'payouts', status: 'fresh', gap: null }],
    sourceCoverage: { windows: [{ from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }] },
    sourceGaps: { missingParentOrderLineCount: 0 }, openIssueCount: 0, sourceRevision: 42
  };
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable', secretKey,
    fetchImpl: async () => json(expected)
  });
  assert.deepEqual(await adapters.db.listProductAnalyticsFacts({
    organizationId, from: expected.from, to: expected.to, accessToken
  }), expected);
});

test('standalone supply registration uses the caller JWT and lists without a Square catalog ID', async () => {
  const seen = [];
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable', secretKey,
    fetchImpl: async (url, init) => {
      const request = { url: String(url), headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : undefined };
      seen.push(request);
      if (request.url.includes('/rpc/record_inventory_item')) return json('manual-item-id');
      if (request.url.includes('/inventory_items?')) return json([{ id: 'manual-item-id', sku: 'SUPPLY-1', name: 'Uncatalogued supply', currency: 'USD' }]);
      if (request.url.includes('/item_definitions?')) return json([{ id: 'catalog-item-id', name: 'Catalog tea', square_catalog_object_id: 'variation-1', currency: 'USD' }]);
      throw new Error(`Unexpected request ${request.url}`);
    }
  });
  assert.deepEqual(await adapters.db.recordInventoryItem({
    organizationId, sku: 'SUPPLY-1', name: 'Uncatalogued supply', currency: 'USD',
    evidenceFileId: 'evidence-id', reason: 'Supplier receipt supports this item',
    idempotencyKey: 'supply-key-1', accessToken
  }), { itemId: 'manual-item-id' });
  const rows = await adapters.db.listInventoryItems({ organizationId, asOf: '2026-10-01T00:00:00Z', accessToken });
  assert.deepEqual(rows.map(row => row.item_kind), ['catalog', 'manual']);
  assert.equal(rows[1].square_catalog_object_id, null);
  assert.equal(rows[1].unit_cost_minor, null);
  assert.deepEqual(seen[0].body, {
    p_organization_id: organizationId, p_sku: 'SUPPLY-1', p_name: 'Uncatalogued supply',
    p_currency: 'USD', p_evidence_file_id: 'evidence-id',
    p_reason: 'Supplier receipt supports this item', p_idempotency_key: 'supply-key-1'
  });
  assert.ok(seen.every(request => request.headers.get('authorization') === `Bearer ${accessToken}`));
  assert.ok(seen.every(request => !request.headers.get('authorization').includes(secretKey)));
});

test('Square count reads use the caller JWT while worker count targets and writes use only the server key', async () => {
  const seen = [];
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable', secretKey,
    fetchImpl: async (url, init) => {
      const request = { url: String(url), headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : undefined };
      seen.push(request);
      if (request.url.endsWith('/rpc/get_square_inventory_targets_system')) return json({ catalogObjectIds: ['variation-1'], locationIds: ['location-1'] });
      if (request.url.endsWith('/rpc/upsert_square_inventory_counts')) return json({ inserted: 1, changed: 1, unmappedCount: 0, conflictCount: 0, unmappedRefs: [] });
      if (request.url.endsWith('/rpc/get_square_inventory_counts')) return json([{ variationId: 'domain-variation-1', quantity: 4 }]);
      throw new Error(`Unexpected request ${request.url}`);
    }
  });
  assert.deepEqual(await adapters.db.getSquareInventoryTargetsSystem({ organizationId }), {
    catalogObjectIds: ['variation-1'], locationIds: ['location-1']
  });
  const count = { catalogObjectId: 'variation-1', catalogObjectType: 'ITEM_VARIATION', locationId: 'location-1',
    state: 'IN_STOCK', quantity: 4, calculatedAt: '2026-10-01T12:00:00Z', sourceVersion: 'version-1', sourceHash: 'a'.repeat(64) };
  assert.deepEqual(await adapters.db.upsertSquareInventoryCounts({ organizationId, counts: [count] }), {
    inserted: 1, changed: 1, unmappedCount: 0, conflictCount: 0, unmappedRefs: []
  });
  assert.deepEqual(await adapters.db.getSquareInventoryCounts({ organizationId, accessToken }), [{ variationId: 'domain-variation-1', quantity: 4 }]);
  assert.deepEqual(seen[0].body, { p_organization_id: organizationId });
  assert.deepEqual(seen[1].body, { p_organization_id: organizationId, p_counts: [count] });
  assert.deepEqual(seen[2].body, { p_organization_id: organizationId });
  assert.equal(seen[0].headers.get('apikey'), secretKey);
  assert.equal(seen[1].headers.get('apikey'), secretKey);
  assert.equal(seen[2].headers.get('apikey'), 'publishable');
  assert.equal(seen[2].headers.get('authorization'), `Bearer ${accessToken}`);
});
