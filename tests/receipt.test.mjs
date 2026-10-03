import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReceipt } from '../src/agent/receipt.mjs';
import { rankReceiptCatalogCandidates } from '../src/agent/receipt-matching.mjs';
import { calculatePackageUnitCostMinor, parseReceiptPackageUnits } from '../src/agent/receipt-units.mjs';

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

test('locally read printed package prices and totals take precedence over inconsistent model amounts', async () => {
  const text = '[KIT KAT Milk Chocolate Wafer Candy, Full Size, 1.5 oz., 36 pk.](https://supplier.example/item)\n\n$42.56/ea\n\nQty 5\n\n**$21280**';
  const result = await extractWith({
    supplier: null,
    invoice_date: null,
    lines: [{ description: 'KIT KAT Milk Chocolate Wafer Candy, Full Size, 1.5 oz., 36 pk.', quantity: '5', unit_price: '3456', line_amount: '3456' }],
  }, text);

  assert.equal(result.lines[0].unitPriceText, '42.56');
  assert.equal(result.lines[0].unitCostMinor, 4256);
  assert.equal(result.lines[0].sourceLineAmountText, '21280');
  assert.equal(result.lines[0].expectedLineAmountText, '212.80');
  assert.equal(result.lines[0].suggestedLineAmountText, '212.80');
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

test('printed totals stay attached to their own item across multiple linked receipt rows', async () => {
  const text = [
    '[Chocolate A, 3 oz., 24 pk.](https://supplier.example/a)', '$2.50/ea', 'Qty 2', '**$500**', '**Add to Cart**',
    '[Chocolate B, 2 oz., 18 pk.](https://supplier.example/b)', '$3.75/ea', 'Qty 3', '**$1125**', '**Add to Cart**',
  ].join('\n\n');
  const result = await extractWith({
    supplier: null,
    invoice_date: null,
    lines: [
      { description: 'Chocolate A, 3 oz., 24 pk.', quantity: '2', unit_price: '2.50', line_amount: '5.00' },
      { description: 'Chocolate B, 2 oz., 18 pk.', quantity: '3', unit_price: '3.75', line_amount: '11.25' },
    ],
  }, text);

  assert.deepEqual(result.lines.map(line => line.sourceLineAmountText), ['500', '1125']);
  assert.deepEqual(result.lines.map(line => line.suggestedLineAmountText), ['5.00', '11.25']);
});

test('the Sam-style multi-pack layout extracts each printed total and box price independently', async () => {
  const items = [
    ['KIT KAT Milk Chocolate Wafer Candy, Full Size, 1.5 oz., 36 pk.', '42.56', '5', '21280', '42.56'],
    ['Airheads Xtremes Candy, 2 oz., 18 pk.', '17.12', '3', '5136', '17.12'],
    ['SOUR PATCH KIDS Soft & Chewy Candy, 2 oz., 24 pk.', '25.98', '1', '2598', null],
    ['OREO Chocolate Sandwich Cookies, 5.23 oz., 12 pk.', '10.98', '1', '1098', null],
    ['OREO Fall Treats Orange Creme Sandwich Cookies, 1.02 oz., 40 pk.', '14.72', '4', '5888', '14.72'],
    ['Nerds Share Size Gummy Clusters Candy, 3 oz., 12 pk.', '18.74', '1', '1874', null],
    ['Diet Coke Soda Soft Drink, 12 fl. oz., 35 pk.', '18.48', '1', '1848', null],
    ['Dr Pepper Soda 12 fl. oz. cans, 36 pk.', '17.28', '2', '3456', '17.28'],
  ];
  const text = items.flatMap(([name, unitPrice, quantity, total], index) => [
    `[${name}](https://supplier.example/item-${index + 1})`,
    `$${unitPrice}${Number(quantity) > 1 ? '/ea' : ''}`,
    `Qty ${quantity}`,
    `**$${total}**`,
    '**Add to Cart**',
  ]).join('\n\n');
  const result = await extractWith({
    supplier: 'Not identified',
    invoice_date: null,
    lines: items.map(([description, unitPrice, quantity, total, extractedPrice]) => ({
      description, quantity, unit_price: extractedPrice, line_amount: total,
    })),
  }, text);

  assert.deepEqual(result.lines.map(line => line.sourceLineAmountText), items.map(item => item[3]));
  assert.deepEqual(result.lines.map(line => line.unitCostMinor), [4256, 1712, 2598, 1098, 1472, 1874, 1848, 1728]);
  assert.deepEqual(result.lines.map(line => line.packageUnitCount), [36, 18, 24, 12, 40, 12, 35, 36]);
  assert.deepEqual(result.lines.map(line => line.suggestedLineAmountText), ['212.80', '51.36', '25.98', '10.98', '58.88', '18.74', '18.48', '34.56']);
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

test('receipt catalog ranking ignores generic package words and prefers meaningful item names', () => {
  const candidates = [
    { catalogObjectId: 'sour-patch', name: 'Sour Patch Kids Soft & Chewy Candy oz', sku: null, currency: 'USD' },
    { catalogObjectId: 'kit-kat', name: 'Kit Kat Wafer Candy', sku: 'KITKAT36', currency: 'USD' },
    { catalogObjectId: 'powerade', name: 'Powerade Zero Sports Drink Variety Pack', sku: null, currency: 'USD' },
    { catalogObjectId: 'diet-coke', name: 'Diet Coke', sku: null, currency: 'USD' },
  ];

  assert.deepEqual(rankReceiptCatalogCandidates('KIT KAT Milk Chocolate Wafer Candy, Full Size, 1.5 oz., 36 pk.', candidates, 'USD').map(row => row.candidate.catalogObjectId), ['kit-kat']);
  assert.deepEqual(rankReceiptCatalogCandidates('Diet Coke Soda Soft Drink, 12 fl. oz., 35 pk.', candidates, 'USD').map(row => row.candidate.catalogObjectId), ['diet-coke']);
  assert.deepEqual(rankReceiptCatalogCandidates('KITKAT36', candidates, 'USD').map(row => row.candidate.catalogObjectId), ['kit-kat']);
});

test('package unit counts and nearest-cent conversion preserve the purchase-total variance', () => {
  assert.equal(parseReceiptPackageUnits('KIT KAT, 1.5 oz., 36 pk.'), 36);
  assert.equal(parseReceiptPackageUnits('Soda 12 fl. oz. cans'), null);
  assert.equal(parseReceiptPackageUnits('Variety pack: 12 cans in each of 3 boxes'), null);

  assert.deepEqual(calculatePackageUnitCostMinor(4256, 5, 36), {
    unitCostMinor: 118, appliedUnitCostMinor: 118, roundingDeltaMinor: -40, squareUnitCount: '180',
  });
  assert.equal(calculatePackageUnitCostMinor(5, 1, 2).unitCostMinor, 3);
  assert.equal(calculatePackageUnitCostMinor(4256, null, 36).roundingDeltaMinor, null);
  assert.deepEqual(calculatePackageUnitCostMinor(4256, 5, 36, 119), {
    unitCostMinor: 118, appliedUnitCostMinor: 119, roundingDeltaMinor: 140, squareUnitCount: '180',
  });
  assert.equal(calculatePackageUnitCostMinor(4256, 0, 36), null);
});
