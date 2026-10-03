import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers } from '../src/server/index.mjs';

const org = '11111111-1111-4111-8111-111111111111';
const item = '22222222-2222-4222-8222-222222222222';
const evidence = '33333333-3333-4333-8333-333333333333';
const from = '2026-09-01T00:00:00Z', to = '2026-10-01T00:00:00Z';
const ready = () => ({ sourceHealth: ['square', 'orders', 'payments', 'refunds', 'catalog', 'payouts'].map(resource => ({ resource, status: 'fresh', gap: null, lastSuccessfulSyncAt: new Date().toISOString() })),
  sourceCoverage: { requiredFrom: from, windows: [{ from, to }] }, sourceRevision: 4 });
function handlers({ snapshot, facts, role = 'owner', membership = true } = {}) {
  const db = Object.fromEntries(['getDashboard', 'listIssues', 'listManualMovements', 'listObservations', 'listAuditEvents', 'getSettings', 'getIssue', 'getIssueEvidence',
    'recordItemDefinition', 'recordSaleLineCostOverride', 'recordRefundCostReview', 'createProposalAtomic', 'reserveModelBudget', 'recordModelUsage', 'getReplaySnapshot', 'saveProjectionRun', 'asUser']
    .map(name => [name, async () => ({})]));
  Object.assign(db, { getMembership: async () => membership ? { role } : null,
    getOrganizationFeatureFlags: async () => ({ inventoryTracking: true, productAnalytics: true }),
    listInventoryMovements: async () => [], getInventorySnapshot: async () => snapshot,
    listProductAnalyticsFacts: async () => facts,
    recordInventoryOpening: async args => ({ movementId: args.itemId }),
    recordInventoryItem: async args => ({ itemId: args.evidenceFileId }) });
  return createHandlers({ db, supabase: { auth: { getUser: async () => ({ data: { user: { id: item } } }) } },
    queue: Object.fromEntries(['enqueueSquareSync', 'enqueueSquareWebhook', 'enqueueProjectionReplay'].map(name => [name, async () => ({})])),
    config: { inventoryTrackingEnabled: true, productAnalyticsEnabled: true } });
}
const get = resource => new Request(`https://example.test/api/${resource}?organizationId=${org}&from=${from}&to=${to}&currency=USD`, { headers: { authorization: 'Bearer test.jwt' } });
const post = (resource, body) => new Request(`https://example.test/api/inventory/${resource}`, { method: 'POST',
  headers: { authorization: 'Bearer test.jwt', 'content-type': 'application/json', 'idempotency-key': 'staged-test-key' }, body: JSON.stringify(body) });

test('inventory API normalizes database UTC offsets and retains evidenced standalone stock', async () => {
  const snapshot = { ...ready(), items: [{ id: item, name: 'Supply', square_catalog_object_id: null }], lines: [], movements: [
    { id: 'opening', inventory_item_id: item, item_name: 'Supply', movement_type: 'opening_balance', quantity_delta: '5', currency: 'USD',
      occurred_at: '2026-09-01T00:00:00+00:00', evidence_file_id: evidence },
    { id: 'usage', inventory_item_id: item, item_name: 'Supply', movement_type: 'manual_correction', quantity_delta: '-2', currency: 'USD',
      occurred_at: '2026-09-03T00:00:00+00:00', evidence_file_id: evidence, reason: 'Receipt-backed usage' },
  ] };
  const response = await handlers({ snapshot }).inventory(get('inventory'));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.inventory.status, 'complete');
  assert.equal(result.inventory.items[0].onHandQuantity, 3);
  snapshot.sourceGaps = { missingParentOrderLineCount: 1 };
  const incomplete = await (await handlers({ snapshot }).inventory(get('inventory'))).json();
  assert.equal(incomplete.inventory.items[0].onHandQuantity, null);
  assert.ok(incomplete.inventory.issues.some(issue => issue.code === 'SOURCE_PARENT_MISSING'));
});

test('analytics missing card fees never become zero and incomplete source coverage hides financial rankings', async () => {
  const facts = { ...ready(), facts: [
    { kind: 'order_line', objectId: 'line', fact: { orderId: 'order', lineItemUid: 'uid', status: 'COMPLETED', occurredAt: from,
      catalogObjectId: 'variation', currency: 'USD', quantity: 1, grossMinor: 1000, discountMinor: 0, unitCostMinor: 300, costCurrency: 'USD' } },
    { kind: 'payment', objectId: 'payment', fact: { status: 'COMPLETED', occurredAt: from, currency: 'USD', feeStatus: 'missing', feeMinor: null } },
  ] };
  const result = await (await handlers({ facts }).analytics(get('analytics'))).json();
  assert.equal(result.analytics.totals.revenueMinor, 1000);
  assert.equal(result.analytics.totals.feesMinor, null);
  assert.equal(result.analytics.products[0].feesMinor, null);
  assert.equal(result.analytics.daily[0].feesMinor, null);
  facts.sourceCoverage.windows = [];
  const unverified = await (await handlers({ facts }).analytics(get('analytics'))).json();
  assert.equal(unverified.analytics.totals.revenueMinor, null);
  assert.equal(unverified.analytics.products[0].revenueRank, null);
  assert.equal(unverified.analytics.products[0].marginBps, null);
  facts.sourceCoverage = ready().sourceCoverage;
  facts.sourceHealth = facts.sourceHealth.filter(row => row.resource !== 'payouts');
  const absentResource = await (await handlers({ facts }).analytics(get('analytics'))).json();
  assert.ok(absentResource.analytics.issues.some(issue => issue.code === 'SOURCE_HEALTH_INCOMPLETE'));
  assert.equal(absentResource.analytics.totals.revenueMinor, 1000);
  assert.equal(absentResource.analytics.products[0].revenueMinor, 1000);
  assert.equal(absentResource.analytics.products[0].costMinor, 300);
  assert.equal(absentResource.analytics.products[0].feesMinor, null);
  assert.equal(absentResource.analytics.products[0].netMinor, null);

  facts.sourceHealth = ready().sourceHealth.map(row => ['square', 'payments'].includes(row.resource)
    ? { ...row, status: 'incomplete', gap: { code: 'PROCESSING_FEE_UNAVAILABLE' }, lastSuccessfulSyncAt: null } : row);
  const feeGap = await (await handlers({ facts }).analytics(get('analytics'))).json();
  assert.equal(feeGap.analytics.totals.revenueMinor, 1000);
  assert.equal(feeGap.analytics.products[0].revenueMinor, 1000);
  assert.equal(feeGap.analytics.products[0].costMinor, 300);
  assert.equal(feeGap.analytics.products[0].feesMinor, null);
  assert.equal(feeGap.analytics.products[0].netMinor, null);

  facts.sourceHealth = ready().sourceHealth.filter(row => row.resource !== 'orders');
  const missingOrders = await (await handlers({ facts }).analytics(get('analytics'))).json();
  assert.equal(missingOrders.analytics.totals.revenueMinor, null);
  assert.equal(missingOrders.analytics.products[0].revenueMinor, null);
});

test('opening counts and supply registration permit reviewers while rejecting operator writes and foreign membership', async () => {
  const opening = { organizationId: org, itemId: item, quantity: 0, occurredAt: from, reason: 'Physical count evidenced', evidenceRef: evidence };
  const supply = { organizationId: org, sku: 'SUPPLY', name: 'Supply', currency: 'USD', reason: 'Supplier receipt source', evidenceRef: evidence };
  assert.equal((await handlers({ role: 'reviewer' }).inventoryOpening(post('openings', opening))).status, 201);
  assert.equal((await handlers({ role: 'reviewer' }).inventoryItem(post('items', supply))).status, 201);
  assert.equal((await handlers({ role: 'operator' }).inventoryOpening(post('openings', opening))).status, 403);
  assert.equal((await handlers({ role: 'operator' }).inventoryItem(post('items', supply))).status, 403);
  assert.equal((await handlers({ membership: false }).inventoryItem(post('items', supply))).status, 403);
});
