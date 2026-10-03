import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateInventory } from '../src/engine/inventory.mjs';
import { calculateProductAnalytics } from '../src/engine/analytics.mjs';
import { calculateIncome } from '../src/engine/index.mjs';

const from = '2026-09-01T00:00:00Z';
const to = '2026-10-01T00:00:00Z';

test('standalone supplies require an evidenced opening and never infer Square sale consumption', () => {
  const itemDefinitions = [{ id: 'supply-boxes', name: 'Shipping boxes' }];
  const movements = [{ id: 'receipt-boxes', itemId: 'supply-boxes', itemName: 'Shipping boxes', quantityDelta: 12,
    occurredAt: from, currency: 'USD', kind: 'purchase', evidenceId: 'supplier-receipt' }];
  const unknown = calculateInventory({ from, to, currency: 'USD', itemDefinitions, movements });
  assert.equal(unknown.items[0].onHandQuantity, null);
  const counted = calculateInventory({ from, to, currency: 'USD', itemDefinitions, movements: [
    ...movements, { id: 'opening-boxes', itemId: 'supply-boxes', quantityDelta: 0, occurredAt: from,
      currency: 'USD', kind: 'opening', evidenceId: 'opening-count' },
    { id: 'used-boxes', itemId: 'supply-boxes', quantityDelta: -3, occurredAt: '2026-09-02T00:00:00Z',
      currency: 'USD', kind: 'adjustment', evidenceId: 'packing-record', reason: 'Used to package three orders' },
  ] });
  assert.equal(counted.status, 'complete');
  assert.equal(counted.items[0].soldQuantity, 0);
  assert.equal(counted.items[0].onHandQuantity, 9);
});

test('unidentified sale revenue remains in UTC trends while unknown costs stay null', () => {
  const line = { id: 'unidentified', status: 'completed', occurredAt: from, currency: 'USD',
    quantity: 1, grossMinor: 500, discountMinor: 20, unitCostMinor: null };
  const result = calculateProductAnalytics({ from, to, currency: 'USD', lines: [line] });
  assert.equal(result.totals.revenueMinor, 480);
  assert.equal(result.daily[0].revenueMinor, 480);
  assert.equal(result.monthly[0].costMinor, null);
  const reordered = Object.fromEntries(Object.entries(line).reverse());
  assert.deepEqual(calculateProductAnalytics({ from, to, currency: 'USD', lines: [line, reordered] }), result);
});

test('inventory applies opening, purchases, sales and explicit adjustments as deterministic integer deltas', () => {
  const input = {
    movements: [
      { id: 'open-1', itemId: 'catalog-A', itemName: 'Tea', quantityDelta: 10, occurredAt: from, currency: 'USD', kind: 'opening', evidenceId: 'count-1' },
      { id: 'buy-1', itemId: 'catalog-A', itemName: 'Tea', quantityDelta: 5, occurredAt: '2026-09-10T12:00:00Z', currency: 'USD', kind: 'purchase', evidenceId: 'receipt-1' },
      { id: 'adjust-1', itemId: 'catalog-A', quantityDelta: -1, occurredAt: '2026-09-12T12:00:00Z', currency: 'USD', kind: 'adjustment', evidenceId: 'count-2', reason: 'Damaged stock' },
    ],
    lines: [{ id: 'line-1', status: 'completed', currency: 'USD', occurredAt: '2026-09-20T12:00:00Z', quantity: 3, catalogObjectId: 'catalog-A', name: 'Tea' }],
    from, to, currency: 'USD',
  };
  const result = calculateInventory(input);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.items[0], { itemId: 'catalog-A', itemName: 'Tea', openingQuantity: 10, purchasedQuantity: 5, soldQuantity: 3,
    adjustmentQuantity: -1, onHandQuantity: 11, sourceRefs: ['count-1', 'count-2', 'line-1', 'receipt-1'] });
  assert.deepEqual(result, calculateInventory(structuredClone(input)));
});

test('inventory flags missing opening, negative stock, unknown item, conflicts and mixed currency', () => {
  const result = calculateInventory({ from, to, movements: [
    { id: 'buy-1', itemId: 'A', quantityDelta: 1, occurredAt: from, currency: 'USD', kind: 'purchase' },
    { id: 'open-A', itemId: 'A', quantityDelta: 0, occurredAt: from, currency: 'USD', kind: 'opening', evidenceId: 'count-A' },
    { id: 'buy-B', itemId: 'B', quantityDelta: 1, occurredAt: from, currency: 'USD', kind: 'purchase' },
  ], lines: [
    { id: 'sale-1', status: 'completed', currency: 'USD', occurredAt: '2026-09-04T00:00:00Z', quantity: 3, catalogObjectId: 'A' },
    { id: 'sale-2', status: 'completed', currency: 'CAD', occurredAt: '2026-09-05T00:00:00Z', quantity: 1 },
  ] });
  assert.equal(result.status, 'failed');
  assert.ok(result.issues.some(issue => issue.code === 'OPENING_BALANCE_MISSING'));
  assert.ok(result.issues.some(issue => issue.code === 'NEGATIVE_STOCK'));
  assert.ok(result.issues.some(issue => issue.code === 'UNKNOWN_ITEM'));
  assert.ok(result.issues.some(issue => issue.code === 'CURRENCY_MISMATCH'));
  assert.throws(() => calculateInventory({ from, to, lines: [{ id: 'x', status: 'completed', currency: 'USD', occurredAt: from, quantity: 0, catalogObjectId: 'A' }] }), /positive integer/);
});

test('inventory does not add refunded units without explicit disposition movement and honors [from,to)', () => {
  const result = calculateInventory({ from, to,
    movements: [{ id: 'open', itemId: 'A', quantityDelta: 4, occurredAt: from, currency: 'USD', kind: 'opening' }],
    lines: [
      { id: 'inside', status: 'completed', currency: 'USD', occurredAt: '2026-09-30T23:59:59Z', quantity: 1, catalogObjectId: 'A' },
      { id: 'outside', status: 'completed', currency: 'USD', occurredAt: to, quantity: 2, catalogObjectId: 'A' },
    ], refunds: [{ id: 'refund', status: 'completed', occurredAt: '2026-09-30T12:00:00Z', currency: 'USD', amountMinor: 100 }] });
  assert.equal(result.items[0].soldQuantity, 1);
  assert.equal(result.items[0].onHandQuantity, 3);
});

test('inventory carries historical purchases and sales into opening stock; zero opening is valid', () => {
  const result = calculateInventory({ from, to, movements: [
    { id: 'prebaseline', itemId: 'A', quantityDelta: 100, occurredAt: '2026-07-30T00:00:00Z', currency: 'USD', kind: 'purchase', evidenceId: 'old-receipt' },
    { id: 'opening-zero', itemId: 'A', quantityDelta: 0, occurredAt: '2026-08-01T00:00:00Z', currency: 'USD', kind: 'opening', evidenceId: 'count-0' },
    { id: 'old-purchase', itemId: 'A', quantityDelta: 10, occurredAt: '2026-08-05T00:00:00Z', currency: 'USD', kind: 'purchase', evidenceId: 'receipt-0' },
  ], lines: [
    { id: 'old-sale', status: 'completed', currency: 'USD', occurredAt: '2026-08-20T00:00:00Z', quantity: 4, catalogObjectId: 'A' },
    { id: 'before-baseline-sale', status: 'completed', currency: 'USD', occurredAt: '2026-07-31T00:00:00Z', quantity: 50, catalogObjectId: 'A' },
    { id: 'future-sale', status: 'completed', currency: 'USD', occurredAt: to, quantity: 100, catalogObjectId: 'A' },
  ] });
  assert.equal(result.status, 'complete');
  assert.equal(result.items[0].openingQuantity, 6);
  assert.equal(result.items[0].onHandQuantity, 6);
});

test('inventory joins purchase definition UUIDs to Square variation IDs', () => {
  const result = calculateInventory({ from, to, itemDefinitions: [{ id: 'definition-A', squareCatalogObjectId: 'catalog-A', name: 'Tea' }],
    movements: [
      { id: 'opening', itemId: 'definition-A', quantityDelta: 4, occurredAt: from, currency: 'USD', kind: 'opening', evidenceId: 'count-1' },
      { id: 'purchase', itemId: 'definition-A', quantityDelta: 2, occurredAt: '2026-09-05T00:00:00Z', currency: 'USD', kind: 'purchase', evidenceId: 'receipt-1' },
    ], lines: [{ id: 'sale', status: 'completed', currency: 'USD', occurredAt: '2026-09-06T00:00:00Z', quantity: 1, catalogObjectId: 'catalog-A' }] });
  assert.equal(result.items[0].itemId, 'catalog-A');
  assert.equal(result.items[0].onHandQuantity, 5);
});

test('product analytics reconciles recognized sales, COGS and fees; unsupported allocations remain explicit', () => {
  const lines = [
    { id: 'line-1', version: '1', orderId: 'order-1', lineItemUid: 'uid-1', status: 'completed', currency: 'USD', occurredAt: '2026-09-05T00:00:00Z', quantity: 2,
      catalogObjectId: 'catalog-A', name: 'Tea', grossMinor: 2000, discountMinor: 200, refundMinor: 100, taxMinor: 150, tipMinor: 100, unitCostMinor: 500, costCurrency: 'USD' },
    { id: 'line-2', orderId: 'order-2', lineItemUid: 'uid-2', status: 'completed', currency: 'USD', occurredAt: '2026-09-06T00:00:00Z', quantity: 1,
      grossMinor: 1000, discountMinor: 0, refundMinor: 0, taxMinor: 0, tipMinor: 0 },
  ];
  const fees = [
    { id: 'fee-linked', status: 'completed', currency: 'USD', occurredAt: '2026-09-05T00:00:00Z', amountMinor: 75, orderId: 'order-1', lineItemUid: 'uid-1' },
    { id: 'fee-unknown', status: 'completed', currency: 'USD', occurredAt: '2026-09-06T00:00:00Z', amountMinor: 25 },
  ];
  const refunds = [{ id: 'refund-unknown', status: 'completed', currency: 'USD', occurredAt: '2026-09-07T00:00:00Z', amountMinor: 50, orderId: 'not-present' }];
  const result = calculateProductAnalytics({ lines, fees, refunds, incomePolicy: { tax: 'exclude', tips: 'exclude' }, from, to });
  const income = calculateIncome({ lines, fees, refundFacts: refunds, policy: { tax: 'exclude', tips: 'exclude' } });
  assert.equal(result.products[0].productId, 'catalog-A');
  assert.equal(result.products[0].revenueMinor, 1700);
  assert.equal(result.products[0].costMinor, 1000);
  assert.equal(result.products[0].feesMinor, 75);
  assert.equal(result.products[0].netMinor, 625);
  assert.equal(result.products[1].costMinor, null);
  assert.deepEqual(result.unallocated, { revenueMinor: 0, refundsMinor: 50, feesMinor: 25, cogsReversalMinor: 0 });
  assert.equal(result.totals.revenueMinor, income.netSalesMinor);
  assert.equal(result.totals.costMinor, null);
  assert.equal(result.totals.feesMinor, income.squareFeesMinor);
  assert.equal(result.totals.netMinor, null);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.daily.length, 3);
  assert.equal(result.monthly[0].period, '2026-09');
  assert.equal(result.products[0].grossMinor, 2000);
  assert.equal(typeof result.products[0].revenueRank, 'number');
});

test('payment fees allocate to a single-product order and stay unallocated for mixed-product orders', () => {
  const lines = [
    { id: 'single-line', orderId: 'single-order', lineItemUid: 'single-uid', status: 'completed', currency: 'USD', occurredAt: from,
      quantity: 1, catalogObjectId: 'A', grossMinor: 1000, discountMinor: 0, unitCostMinor: 300, costCurrency: 'USD' },
    { id: 'mixed-line-a', orderId: 'mixed-order', lineItemUid: 'mixed-uid-a', status: 'completed', currency: 'USD', occurredAt: from,
      quantity: 1, catalogObjectId: 'A', grossMinor: 500, discountMinor: 0, unitCostMinor: 200, costCurrency: 'USD' },
    { id: 'mixed-line-b', orderId: 'mixed-order', lineItemUid: 'mixed-uid-b', status: 'completed', currency: 'USD', occurredAt: from,
      quantity: 1, catalogObjectId: 'B', grossMinor: 500, discountMinor: 0, unitCostMinor: 200, costCurrency: 'USD' },
  ];
  const result = calculateProductAnalytics({ from, to, lines, fees: [
    { id: 'single-fee', orderId: 'single-order', status: 'completed', currency: 'USD', occurredAt: from, amountMinor: 25 },
    { id: 'mixed-fee', orderId: 'mixed-order', status: 'completed', currency: 'USD', occurredAt: from, amountMinor: 40 },
  ] });
  const productA = result.products.find(product => product.productId === 'A');
  const productB = result.products.find(product => product.productId === 'B');
  assert.equal(productA.feesMinor, null);
  assert.equal(productA.feesAllocationComplete, false);
  assert.equal(productA.netMinor, null);
  assert.equal(productB.feesMinor, null);
  assert.equal(productB.feesAllocationComplete, false);
  assert.equal(productB.netMinor, null);
  assert.equal(result.unallocated.feesMinor, 40);
  assert.equal(result.totals.feesMinor, 65);
  assert.equal(result.totals.netMinor, 1235);
  assert.ok(result.issues.some(issue => issue.code === 'FEE_ALLOCATION_INCOMPLETE'));

  const exact = calculateProductAnalytics({ from, to, lines: [lines[0]], fees: [{ id: 'exact-fee', orderId: 'single-order', status: 'completed', currency: 'USD', occurredAt: from, amountMinor: 25 }] });
  assert.equal(exact.products[0].feesMinor, 25);
  assert.equal(exact.products[0].feesAllocationComplete, true);

  const partlyIdentified = calculateProductAnalytics({ from, to, lines: [lines[0],
    { id: 'unknown-line', orderId: 'single-order', status: 'completed', currency: 'USD', occurredAt: from, quantity: 1, grossMinor: 500, discountMinor: 0 }],
    fees: [{ id: 'partly-identified-fee', orderId: 'single-order', status: 'completed', currency: 'USD', occurredAt: from, amountMinor: 25 }] });
  assert.equal(partlyIdentified.products[0].feesMinor, null);
  assert.equal(partlyIdentified.products[0].feesAllocationComplete, false);
  assert.equal(partlyIdentified.unallocated.feesMinor, 25);
});

test('missing refund return disposition leaves product COGS and net incomplete', () => {
  const result = calculateProductAnalytics({ from, to,
    lines: [{ id: 'line', orderId: 'order', status: 'completed', currency: 'USD', occurredAt: from, quantity: 1, grossMinor: 500, discountMinor: 0, unitCostMinor: 200, costCurrency: 'USD' }],
    refunds: [{ id: 'refund', orderId: 'order', status: 'completed', currency: 'USD', occurredAt: '2026-09-05T00:00:00Z', amountMinor: 100 }],
  });
  assert.equal(result.totals.revenueMinor, 400);
  assert.equal(result.totals.costMinor, null);
  assert.ok(result.issues.some(issue => issue.code === 'REFUND_COGS_REVIEW'));
  assert.equal(result.daily.find(row => row.period === '2026-09-05').costMinor, null);
  assert.equal(result.daily.find(row => row.period === '2026-09-05').netMinor, null);
});

test('reviewed refund reversals reconcile product COGS and operational net with the income projection', () => {
  const lines = [{ id: 'line', orderId: 'order', lineItemUid: 'uid', status: 'completed', currency: 'USD', occurredAt: '2026-09-05T00:00:00Z', quantity: 2,
    grossMinor: 2000, discountMinor: 0, refundMinor: 0, unitCostMinor: 250, costCurrency: 'USD' }];
  const refunds = [{ id: 'refund', orderId: 'order', lineItemUid: 'uid', status: 'completed', currency: 'USD', occurredAt: '2026-09-20T00:00:00Z', amountMinor: 300,
    reviewDisposition: 'returned_to_inventory', approvedCogsReversalMinor: 250, reviewCurrency: 'USD' }];
  const fees = [{ id: 'fee', status: 'completed', currency: 'USD', occurredAt: '2026-09-21T00:00:00Z', amountMinor: 75 }];
  const result = calculateProductAnalytics({ lines, refunds, fees, from, to });
  const income = calculateIncome({ lines, refundFacts: refunds, fees });
  assert.equal(result.totals.revenueMinor, income.netSalesMinor);
  assert.equal(result.totals.costMinor, income.cogsMinor);
  assert.equal(result.totals.netMinor, income.operationalMarginMinor);
  assert.equal(result.products[0].costMinor, 250);
  assert.equal(result.daily.reduce((total, row) => total + row.revenueMinor, 0), income.netSalesMinor);
  assert.equal(result.daily.reduce((total, row) => total + row.costMinor, 0), income.cogsMinor);
  assert.equal(result.daily.reduce((total, row) => total + row.feesMinor, 0), income.squareFeesMinor);
  assert.throws(() => calculateProductAnalytics({ lines, refunds: [{ ...refunds[0], approvedCogsReversalMinor: 1000 }], fees, from, to }), /exceeds known order COGS/);
});

test('unknown sale money and completed fee amounts remain null with visible issues', () => {
  const missingSale = calculateProductAnalytics({ from, to, lines: [{ id: 'line', status: 'completed', currency: 'USD', occurredAt: from,
    quantity: 1, grossMinor: null, discountMinor: null, unitCostMinor: 100, costCurrency: 'USD' }] });
  assert.equal(missingSale.totals.revenueMinor, null);
  assert.equal(missingSale.totals.netMinor, null);
  assert.ok(missingSale.issues.some(issue => issue.code === 'SOURCE_GAP'));
  const missingFee = calculateProductAnalytics({ from, to, lines: [{ id: 'valid', status: 'completed', currency: 'USD', occurredAt: from,
    quantity: 1, grossMinor: 100, discountMinor: 0, unitCostMinor: 20, costCurrency: 'USD' }],
    fees: [{ id: 'fee', status: 'completed', currency: 'USD', occurredAt: from, amountMinor: null }] });
  assert.equal(missingFee.totals.feesMinor, null);
  assert.equal(missingFee.totals.netMinor, null);
  assert.ok(missingFee.issues.some(issue => issue.code === 'FEE_MISSING'));
  assert.throws(() => calculateProductAnalytics({ lines: [], from: '2026-02-30T00:00:00Z', to }), /valid ISO UTC timestamp/);
});

test('analytics output is stable when source order and product display names vary', () => {
  const lines = [
    { id: 'line-a', status: 'completed', currency: 'USD', occurredAt: '2026-09-02T00:00:00Z', quantity: 1, catalogObjectId: 'A', name: 'Zed', grossMinor: 100, discountMinor: 0, unitCostMinor: 40, costCurrency: 'USD' },
    { id: 'line-b', status: 'completed', currency: 'USD', occurredAt: '2026-09-01T00:00:00Z', quantity: 1, catalogObjectId: 'A', name: 'Alpha', grossMinor: 100, discountMinor: 0, unitCostMinor: 40, costCurrency: 'USD' },
  ];
  const left = calculateProductAnalytics({ lines, from, to });
  const right = calculateProductAnalytics({ lines: [...lines].reverse(), from, to });
  assert.deepEqual(left, right);
  assert.equal(left.products[0].productName, 'Alpha');
});

test('order-level refund reversal stays unallocated across multiple products and matches income COGS', () => {
  const lines = ['A', 'B'].map((catalogObjectId, index) => ({ id: `line-${catalogObjectId}`, orderId: 'order', lineItemUid: `uid-${index}`,
    status: 'completed', currency: 'USD', occurredAt: from, quantity: 1, catalogObjectId, grossMinor: 1000, discountMinor: 0,
    unitCostMinor: 300, costCurrency: 'USD' }));
  const refunds = [{ id: 'refund', orderId: 'order', status: 'completed', currency: 'USD', occurredAt: '2026-09-15T00:00:00Z', amountMinor: 200,
    reviewDisposition: 'returned_to_inventory', approvedCogsReversalMinor: 100, reviewCurrency: 'USD' }];
  const result = calculateProductAnalytics({ lines, refunds, from, to });
  const income = calculateIncome({ lines, refundFacts: refunds });
  assert.equal(result.totals.costMinor, income.cogsMinor);
  assert.equal(result.unallocated.cogsReversalMinor, 100);
  assert.equal(result.products[0].costMinor, 300);
  assert.equal(result.products[1].costMinor, 300);
});

test('cross-period refunds keep negative revenue and unknown historical COGS visible', () => {
  const result = calculateProductAnalytics({ from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z', refunds: [
    { id: 'late-refund', orderId: 'prior-order', status: 'completed', currency: 'USD', occurredAt: '2026-10-03T00:00:00Z', amountMinor: 150,
      reviewDisposition: 'returned_to_inventory', approvedCogsReversalMinor: 50, reviewCurrency: 'USD' },
  ] });
  assert.equal(result.totals.revenueMinor, -150);
  assert.equal(result.totals.costMinor, null);
  assert.equal(result.status, 'incomplete');
  assert.ok(result.issues.some(issue => issue.code === 'SOURCE_GAP'));
});

test('product analytics rejects currency conflicts and conflicting source versions', () => {
  const line = { id: 'line', status: 'completed', currency: 'USD', occurredAt: '2026-09-01T00:00:00Z', quantity: 1, grossMinor: 100, unitCostMinor: 20, costCurrency: 'USD' };
  const conflict = calculateProductAnalytics({ lines: [line, { ...line, grossMinor: 99 }], from, to });
  assert.equal(conflict.status, 'failed');
  assert.equal(conflict.unallocated.revenueMinor, null);
  assert.equal(conflict.unallocated.feesMinor, null);
  assert.ok(conflict.issues.some(issue => issue.code === 'SOURCE_CONFLICT'));
  const mixed = calculateProductAnalytics({ lines: [line, { ...line, id: 'other', currency: 'CAD', costCurrency: 'CAD' }], from, to });
  assert.equal(mixed.status, 'failed');
  assert.equal(mixed.totals.revenueMinor, null);
  assert.equal(mixed.daily[0].revenueMinor, null);
  assert.ok(mixed.issues.some(issue => issue.code === 'CURRENCY_MISMATCH'));
});
