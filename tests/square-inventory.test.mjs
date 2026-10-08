import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInventoryCount, retrieveSquareInventoryCounts } from '../src/square/inventory.mjs';

test('Square inventory counts retain opaque identities and a deterministic timestamped source version', () => {
  const normalized = normalizeInventoryCount({ catalog_object_id: 'variation_long_id', catalog_object_type: 'ITEM_VARIATION',
    location_id: 'location-1', state: 'IN_STOCK', quantity: '12.25000', calculated_at: '2026-10-01T12:00:00.123456Z' });
  assert.equal(normalized.catalogObjectId, 'variation_long_id');
  assert.equal(normalized.locationId, 'location-1');
  assert.equal(normalized.quantity, 12.25);
  assert.equal(normalized.sourceId, 'variation_long_id:location-1:IN_STOCK');
  assert.match(normalized.sourceVersion, /^2026-10-01T12:00:00\.123456Z\|[0-9a-f]{64}$/);
  assert.equal(normalizeInventoryCount({ catalog_object_id: 'x', location_id: 'y', state: 'IN_STOCK', quantity: '-1', calculated_at: '2026-10-01T12:00:00Z' }), null);
  assert.equal(normalizeInventoryCount({ catalog_object_id: 'x', location_id: 'y', state: 'UNKNOWN', quantity: '1', calculated_at: '2026-10-01T12:00:00Z' }), null);
});

test('Square inventory retrieve paginates idempotently by object and location batches', async () => {
  const calls = []; const persisted = [];
  const client = { async request(path, options) {
    calls.push({ path, body: JSON.parse(options.body) });
    if (calls.length === 1) return { counts: [{ catalog_object_id: 'variation-1', catalog_object_type: 'ITEM_VARIATION', location_id: 'location-1', state: 'IN_STOCK', quantity: '2', calculated_at: '2026-10-01T12:00:00Z' }], cursor: 'next' };
    return { counts: [{ catalog_object_id: 'variation-1', catalog_object_type: 'ITEM_VARIATION', location_id: 'location-1', state: 'SOLD', quantity: '3', calculated_at: '2026-10-01T12:00:00Z' }] };
  } };
  const result = await retrieveSquareInventoryCounts({ client, catalogObjectIds: ['variation-1', 'variation-1'], locationIds: ['location-1'],
    persist: async values => persisted.push(...values) });
  assert.deepEqual(result, { count: 2, pages: 2 });
  assert.equal(calls[0].path, '/v2/inventory/counts/batch-retrieve');
  assert.deepEqual(calls[0].body, { catalog_object_ids: ['variation-1'], location_ids: ['location-1'], limit: 1000 });
  assert.equal(calls[1].body.cursor, 'next');
  assert.deepEqual(persisted.map(item => item.state), ['IN_STOCK', 'SOLD']);
});

test('Square inventory retrieve rejects repeated cursors before it loops forever', async () => {
  const client = { async request() { return { counts: [], cursor: 'same' }; } };
  await assert.rejects(retrieveSquareInventoryCounts({ client, catalogObjectIds: ['variation-1'], locationIds: ['location-1'], persist: async () => {} }),
    /repeated an inventory count cursor/);
});
