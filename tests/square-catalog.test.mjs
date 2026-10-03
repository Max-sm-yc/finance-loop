import test from 'node:test';
import assert from 'node:assert/strict';
import { createSquareCatalogItem } from '../src/square/catalog.mjs';

test('Square catalog creation writes an item with a fixed-price variation and normalizes both facts', async () => {
  const calls = [];
  const item = {
    id: 'square-item-1', type: 'ITEM', version: 3,
    item_data: {
      name: 'Canvas Tote',
      description: 'Natural cotton tote',
      variations: [{
        id: 'square-variation-1', type: 'ITEM_VARIATION', version: 4,
        item_variation_data: {
          item_id: 'square-item-1', name: 'Regular', sku: 'TOTE-01',
          pricing_type: 'FIXED_PRICING',
          price_money: { amount: 1299, currency: 'USD' },
        },
      }],
    },
  };
  const client = { request: async (path, options) => {
    calls.push({ path, options });
    return { catalog_object: item, id_mappings: [] };
  } };

  const result = await createSquareCatalogItem({ client,
    organizationId: '11111111-1111-4111-8111-111111111111', idempotencyKey: 'catalog-key-1',
    name: 'Canvas Tote', variationName: 'Regular', description: 'Natural cotton tote',
    sku: 'TOTE-01', priceMinor: 1299, currency: 'USD' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/v2/catalog/object');
  assert.equal(calls[0].options.method, 'POST');
  const requestBody = JSON.parse(calls[0].options.body);
  assert.ok(requestBody.idempotency_key.length <= 45);
  assert.equal(requestBody.object.type, 'ITEM');
  assert.equal(requestBody.object.item_data.name, 'Canvas Tote');
  assert.equal(requestBody.object.item_data.variations[0].type, 'ITEM_VARIATION');
  assert.equal(requestBody.object.item_data.variations[0].item_variation_data.price_money.amount, 1299);
  assert.equal(requestBody.object.item_data.variations[0].item_variation_data.sku, 'TOTE-01');
  assert.equal(result.squareItemId, 'square-item-1');
  assert.equal(result.squareCatalogObjectId, 'square-variation-1');
  assert.deepEqual(result.facts.map(fact => [fact.objectType, fact.objectId]), [
    ['ITEM', 'square-item-1'], ['ITEM_VARIATION', 'square-variation-1'],
  ]);
});

test('Square catalog creation rejects a provider response that differs from the requested price', async () => {
  const client = { request: async () => ({
    catalog_object: {
      id: 'square-item-1', type: 'ITEM', version: 3,
      item_data: { name: 'Canvas Tote', variations: [{
        id: 'square-variation-1', type: 'ITEM_VARIATION', version: 4,
        item_variation_data: { item_id: 'square-item-1', name: 'Regular', sku: '', price_money: { amount: 100, currency: 'USD' } },
      }] },
    }, id_mappings: [],
  }) };

  await assert.rejects(() => createSquareCatalogItem({ client,
    organizationId: '11111111-1111-4111-8111-111111111111', idempotencyKey: 'catalog-key-2',
    name: 'Canvas Tote', variationName: 'Regular', description: '', sku: '', priceMinor: 1299, currency: 'USD' }),
  error => error.code === 'SQUARE_CATALOG_RESPONSE_INVALID');
});
