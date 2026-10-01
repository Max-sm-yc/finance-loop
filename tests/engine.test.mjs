import test from 'node:test';
import assert from 'node:assert/strict';
import { CALCULATION_VERSION, calculateIncome, deduplicateFacts, reconcileAccount, replayAccounting, validateTransfers } from '../src/engine/index.mjs';

test('income uses explicit tax/tip policy, discounts, refund, fees and approved return cost reversal', () => {
  const result = calculateIncome({
    lines: [{ id: 'line-1', status: 'completed', currency: 'USD', quantity: 2, grossMinor: 2000,
      discountMinor: 200, refundMinor: 300, taxMinor: 150, tipMinor: 100, unitCostMinor: 500,
      costCurrency: 'USD', returnedQuantity: 1, approvedReturnReversalMinor: 500 }],
    fees: [{ id: 'fee-1', status: 'completed', amountMinor: 75, currency: 'USD' }],
    policy: { tax: 'exclude', tips: 'exclude' },
  });
  assert.equal(result.calculationVersion, CALCULATION_VERSION);
  assert.equal(result.netSalesMinor, 1500);
  assert.equal(result.cogsMinor, 500);
  assert.equal(result.operationalMarginMinor, 925);
  assert.equal(result.status, 'complete');
  assert.deepEqual(calculateIncome({
    lines: [{ id: 'line-1', status: 'completed', currency: 'USD', quantity: 2, grossMinor: 2000,
      discountMinor: 200, refundMinor: 300, taxMinor: 150, tipMinor: 100, unitCostMinor: 500, costCurrency: 'USD' }],
    policy: { tax: 'include', tips: 'include' },
  }).netSalesMinor, 1750);
});

test('missing cost marks margin incomplete and never treats COGS as zero', () => {
  const result = calculateIncome({ lines: [{ id: 'unknown', status: 'completed', currency: 'USD', quantity: 1, grossMinor: 900 }] });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.cogsMinor, null);
  assert.equal(result.operationalMarginMinor, null);
  assert.ok(result.issues.some(x => x.code === 'UNKNOWN_ITEM'));
});

test('completed Square refunds reduce recognized income and hold margin for human return-cost review', () => {
  const result = calculateIncome({
    lines: [{ id: 'line-1', status: 'completed', currency: 'USD', quantity: 2, grossMinor: 2000,
      discountMinor: 0, refundMinor: 0, taxMinor: 0, tipMinor: 0, unitCostMinor: 500, costCurrency: 'USD' }],
    refundFacts: [{ id: 'refund-1', status: 'completed', currency: 'USD', amountMinor: 250 }],
    policy: { tax: 'exclude', tips: 'exclude' },
  });
  assert.equal(result.grossItemSalesMinor, 2000);
  assert.equal(result.refundsMinor, 250);
  assert.equal(result.netSalesMinor, 1750);
  assert.equal(result.unitsSold, 2);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.cogsMinor, null);
  assert.equal(result.operationalMarginMinor, null);
  assert.ok(result.issues.some(issue => issue.code === 'REFUND_COGS_REVIEW'));
});

test('exact duplicate source replay is idempotent and conflicting same-version facts are exceptions', () => {
  const fact = { id: 'o1', version: '2', status: 'completed', currency: 'USD', quantity: 1, grossMinor: 100, unitCostMinor: 20, costCurrency: 'USD' };
  const replay = calculateIncome({ lines: [fact, structuredClone(fact)] });
  assert.equal(replay.netSalesMinor, 100);
  assert.equal(replay.cogsMinor, 20);
  const conflict = deduplicateFacts([fact, { ...fact, grossMinor: 101 }]);
  assert.equal(conflict.facts.length, 1);
  assert.equal(conflict.issues[0].code, 'SOURCE_CONFLICT');
});

test('account reconciliation includes only posted facts for the requested account; transfer pairs are validated', () => {
  const occurredAt = '2026-09-30T12:00:00Z';
  const movements = [
    { id: 'payout', kind: 'square_payout', accountId: 'bank', status: 'posted', currency: 'USD', amountMinor: 500, idempotencyKey: 'sq:payout' },
    { id: 'purchase', kind: 'purchase', accountId: 'bank', status: 'posted', currency: 'USD', amountMinor: -125, idempotencyKey: 'human:purchase' },
    { id: 'pending', kind: 'misc_spend', accountId: 'bank', status: 'pending', currency: 'USD', amountMinor: -900, idempotencyKey: 'human:pending' },
    { id: 'out', kind: 'transfer', transferId: 't1', accountId: 'bank', status: 'posted', currency: 'USD', amountMinor: -100, idempotencyKey: 't1:bank' },
    { id: 'in', kind: 'transfer', transferId: 't1', accountId: 'cash', status: 'posted', currency: 'USD', amountMinor: 100, idempotencyKey: 't1:cash' },
  ].map(m => ({ ...m, occurredAt }));
  assert.deepEqual(validateTransfers(movements), []);
  const result = reconcileAccount({ account: { id: 'bank', currency: 'USD' },
    opening: { id: 'open', accountId: 'bank', currency: 'USD', amountMinor: 1000, observedAt: '2026-09-30T00:00:00Z' },
    observed: { id: 'obs', accountId: 'bank', currency: 'USD', amountMinor: 1275, observedAt: '2026-10-01T00:00:00Z' }, movements });
  assert.equal(result.expectedBalanceMinor, 1275);
  assert.equal(result.discrepancyMinor, 0);
  assert.equal(result.status, 'matched');
  assert.equal(result.includedMovementIds.length, 3);
});

test('unpaired transfer and mismatched currencies fail reconciliation', () => {
  const result = reconcileAccount({ account: { id: 'bank', currency: 'USD' },
    opening: { accountId: 'bank', currency: 'USD', amountMinor: 0, observedAt: '2026-09-30T00:00:00Z' },
    observed: { accountId: 'bank', currency: 'USD', amountMinor: 0, observedAt: '2026-10-01T00:00:00Z' },
    movements: [{ id: 't', kind: 'transfer', transferId: 'lonely', accountId: 'bank', status: 'posted', currency: 'USD', amountMinor: -100, occurredAt: '2026-09-30T12:00:00Z' }] });
  assert.equal(result.status, 'failed');
  assert.ok(result.issues.some(x => x.code === 'TRANSFER_UNPAIRED'));
  const mixed = calculateIncome({ lines: [
    { id: 'a', status: 'completed', currency: 'USD', quantity: 1, grossMinor: 100, unitCostMinor: 10, costCurrency: 'USD' },
    { id: 'b', status: 'completed', currency: 'CAD', quantity: 1, grossMinor: 100, unitCostMinor: 10, costCurrency: 'CAD' },
  ] });
  assert.equal(mixed.status, 'failed');
  assert.equal(mixed.operationalMarginMinor, null);
});

test('reconciliation includes movements after opening and through observed cutoff only', () => {
  const base = { account: { id: 'bank', currency: 'USD' },
    opening: { accountId: 'bank', currency: 'USD', amountMinor: 1000, observedAt: '2026-09-01T00:00:00Z' },
    observed: { accountId: 'bank', currency: 'USD', amountMinor: 1050, observedAt: '2026-09-30T23:59:59Z' } };
  const movements = [
    { id: 'before', accountId: 'bank', kind: 'purchase', status: 'posted', currency: 'USD', amountMinor: -100, occurredAt: '2026-08-31T23:59:59Z' },
    { id: 'within', accountId: 'bank', kind: 'square_payout', status: 'posted', currency: 'USD', amountMinor: 50, occurredAt: '2026-09-10T10:00:00Z' },
    { id: 'after', accountId: 'bank', kind: 'purchase', status: 'posted', currency: 'USD', amountMinor: -500, occurredAt: '2026-10-01T00:00:00Z' },
  ];
  const result = reconcileAccount({ ...base, movements });
  assert.equal(result.expectedBalanceMinor, 1050);
  assert.deepEqual(result.includedMovementIds, ['within']);
  assert.equal(result.status, 'matched');
  assert.throws(() => reconcileAccount({ ...base, observed: { ...base.observed, observedAt: '2026-02-30T00:00:00Z' }, movements: [] }), /valid ISO UTC timestamp/);
});

test('snapshot replay produces identical projections and leaves inputs unchanged', () => {
  const snapshot = { incomePolicy: { tax: 'exclude', tips: 'exclude' }, lines: [{ id: 's', status: 'completed', currency: 'USD', quantity: 1, grossMinor: 200, unitCostMinor: 50, costCurrency: 'USD' }],
    accounts: [{ id: 'bank', currency: 'USD' }], reconciliations: { bank: {
      opening: { accountId: 'bank', currency: 'USD', amountMinor: 0, observedAt: '2026-09-30T00:00:00Z' }, observed: { accountId: 'bank', currency: 'USD', amountMinor: 0, observedAt: '2026-10-01T00:00:00Z' }, movements: [],
    } } };
  const before = structuredClone(snapshot);
  assert.deepEqual(replayAccounting(snapshot), replayAccounting(snapshot));
  assert.deepEqual(snapshot, before);
  assert.throws(() => replayAccounting({ ...snapshot, incomePolicy: undefined }), /explicit tax and tip policy/);
});

test('a paired internal transfer preserves combined tracked cash and COGS is not deducted from cash', () => {
  const transfer = [
    { id: 'out', transferId: 'move-1', kind: 'transfer', accountId: 'bank', status: 'posted', currency: 'USD', amountMinor: -300, occurredAt: '2026-09-15T12:00:00Z' },
    { id: 'in', transferId: 'move-1', kind: 'transfer', accountId: 'drawer', status: 'posted', currency: 'USD', amountMinor: 300, occurredAt: '2026-09-15T12:00:00Z' },
  ];
  const cutoffs = { openingAt: '2026-09-01T00:00:00Z', observedAt: '2026-10-01T00:00:00Z' };
  const bank = reconcileAccount({ account: { id: 'bank', currency: 'USD' },
    opening: { accountId: 'bank', currency: 'USD', amountMinor: 1000, observedAt: cutoffs.openingAt },
    observed: { accountId: 'bank', currency: 'USD', amountMinor: 700, observedAt: cutoffs.observedAt }, movements: transfer });
  const drawer = reconcileAccount({ account: { id: 'drawer', currency: 'USD' },
    opening: { accountId: 'drawer', currency: 'USD', amountMinor: 100, observedAt: cutoffs.openingAt },
    observed: { accountId: 'drawer', currency: 'USD', amountMinor: 400, observedAt: cutoffs.observedAt }, movements: transfer });
  assert.equal(bank.expectedBalanceMinor + drawer.expectedBalanceMinor, 1100);
  assert.equal(bank.status, 'matched'); assert.equal(drawer.status, 'matched');
  const income = calculateIncome({ lines: [{ id: 'sale', status: 'completed', currency: 'USD', quantity: 1,
    grossMinor: 500, unitCostMinor: 200, costCurrency: 'USD' }] });
  assert.equal(income.cogsMinor, 200);
  assert.equal(bank.expectedBalanceMinor + drawer.expectedBalanceMinor, 1100);
});

test('gift card issuance changes liability but not sales or inventory COGS; redemption sale is ordinary income', () => {
  const issuance = { id: 'gift-line', status: 'completed', itemType: 'GIFT_CARD', currency: 'USD', quantity: 1, grossMinor: 5000 };
  const activation = { id: 'activate-1', status: 'completed', type: 'ACTIVATE', currency: 'USD', amountMinor: 5000 };
  const issued = calculateIncome({ lines: [issuance], giftCardActivities: [activation] });
  assert.equal(issued.netSalesMinor, 0);
  assert.equal(issued.cogsMinor, 0);
  assert.equal(issued.giftCardLiabilityChangeMinor, 5000);
  const redemption = calculateIncome({ lines: [{ id: 'item', status: 'completed', currency: 'USD', quantity: 1,
    grossMinor: 5000, unitCostMinor: 1800, costCurrency: 'USD' }],
    giftCardActivities: [{ id: 'redeem-1', status: 'completed', type: 'REDEEM', currency: 'USD', amountMinor: 5000 }] });
  assert.equal(redemption.netSalesMinor, 5000);
  assert.equal(redemption.cogsMinor, 1800);
  assert.equal(redemption.giftCardLiabilityChangeMinor, -5000);
  assert.equal(calculateIncome({ lines: [issuance] }).status, 'incomplete');
});
