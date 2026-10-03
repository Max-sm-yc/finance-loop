import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReceipt } from '../src/agent/receipt.mjs';
import { rankReceiptCatalogCandidates } from '../src/agent/receipt-matching.mjs';

async function extractWith(response, text) {
  return extractReceipt({ text, currency: 'USD' }, {
    apiKey: 'test-key',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(response) } }], usage: {} }) }),
    reserveBudget: async () => true,
    recordUsage: async () => {},
  });
}

test('receipt extraction preserves a printed total and flags an exact missing-decimal match', async () => {
  const text = `[KIT KAT Milk Chocolate Wafer Candy, Full Size, 1.5 oz., 36 pk.](https://supplier.example/item)\n\n$42.56/ea\n\nQty 5\n\n**$21280**\n\n**Add to Cart**`;
  const result = await extractWith({
    supplier: null,
    invoice_date: null,
    lines: [{ description: 'KIT KAT Milk Chocolate Wafer Candy, Full Size, 1.5 oz., 36 pk.', quantity: '5', unit_price: '42.56', line_amount: '212.80' }],
  }, text);

  assert.equal(result.lines[0].unitCostMinor, 4256);
  assert.equal(result.lines[0].costBasis, 'explicit_unit_price');
  assert.equal(result.lines[0].sourceLineAmountText, '21280');
  assert.equal(result.lines[0].suggestedLineAmountText, '212.80');
  assert.equal(result.lines[0].reviewReason, 'line_amount_decimal_may_be_missing');
});

test('receipt extraction keeps an explicit unit price available when the total conflicts', async () => {
  const text = `Canvas Tote\n\n$8.25/ea\n\nQty 4\n\n$40.00`;
  const result = await extractWith({
    supplier: null,
    invoice_date: null,
    lines: [{ description: 'Canvas Tote', quantity: '4', unit_price: '8.25', line_amount: '40.00' }],
  }, text);

  assert.equal(result.lines[0].unitCostMinor, 825);
  assert.equal(result.lines[0].reviewReason, 'unit_price_and_line_amount_disagree');
  assert.equal(result.lines[0].suggestedLineAmountText, null);
});

test('receipt extraction uses a printed one-item price to expose an unpunctuated total', async () => {
  const text = '[OREO Chocolate Sandwich Cookies, 5.23 oz., 12 pk.](https://supplier.example/item)\n\n$10.98\n\nQty 1\n\n**$1098**';
  const result = await extractWith({
    supplier: null,
    invoice_date: null,
    lines: [{ description: 'OREO Chocolate Sandwich Cookies, 5.23 oz., 12 pk.', quantity: '1', unit_price: null, line_amount: '10.98' }],
  }, text);

  assert.equal(result.lines[0].unitCostMinor, 1098);
  assert.equal(result.lines[0].sourceUnitPriceText, '10.98');
  assert.equal(result.lines[0].sourceLineAmountText, '1098');
  assert.equal(result.lines[0].suggestedLineAmountText, '10.98');
  assert.equal(result.lines[0].reviewReason, 'line_amount_decimal_may_be_missing');
});

test('catalog suggestions rank same-name Square items and exclude other currencies', () => {
  const ranked = rankReceiptCatalogCandidates('SOUR PATCH KIDS Soft & Chewy Candy, 2 oz., 24 pk.', [
    { catalogObjectId: 'other', name: 'Chocolate Bar', sku: null, currency: 'USD' },
    { catalogObjectId: 'same', name: 'SOUR PATCH KIDS Soft & Chewy Candy', sku: null, currency: 'USD' },
    { catalogObjectId: 'cad', name: 'SOUR PATCH KIDS Soft & Chewy Candy', sku: null, currency: 'CAD' },
  ], 'USD');

  assert.deepEqual(ranked.map(row => row.candidate.catalogObjectId), ['same']);
  assert.equal(ranked[0].nameWordsMatch, true);
  assert.equal(ranked[0].exactNameMatch, false);
});
