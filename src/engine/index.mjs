/**
 * Deterministic operational accounting projections.
 * Inputs are normalized immutable facts; all money is safe integer minor units.
 */
export const CALCULATION_VERSION = 'finance-loop-accounting-v1';

const CURRENCY = /^[A-Z]{3}$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function money(value, field) {
  assert(Number.isSafeInteger(value), `${field} must be a safe integer in minor units`);
  return value;
}

function currency(value, field = 'currency') {
  assert(typeof value === 'string' && CURRENCY.test(value), `${field} must be an uppercase ISO currency code`);
  return value;
}

function add(total, value, field) {
  const result = total + value;
  assert(Number.isSafeInteger(result), `${field} exceeds safe integer range`);
  return result;
}

function instant(value, field) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  assert(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19),
  `${field} must be a valid ISO UTC timestamp`);
  return parsed;
}

function issue(code, message, refs = []) {
  return { code, message, sourceRefs: [...new Set(refs)].sort() };
}

/** Collapse exact redeliveries, but report conflicting versions instead of choosing one. */
export function deduplicateFacts(facts, identity = f => `${f.id}@${f.version ?? '1'}`) {
  assert(Array.isArray(facts), 'facts must be an array');
  const seen = new Map();
  const unique = [];
  const issues = [];
  for (const fact of facts) {
    assert(fact && typeof fact === 'object', 'each fact must be an object');
    const key = identity(fact);
    assert(typeof key === 'string' && key.length, 'fact identity must be a nonempty string');
    const serialized = JSON.stringify(fact);
    if (!seen.has(key)) { seen.set(key, serialized); unique.push(fact); }
    else if (seen.get(key) !== serialized) issues.push(issue('SOURCE_CONFLICT', `Conflicting facts share identity ${key}.`, [String(fact.id ?? key)]));
  }
  return { facts: unique, issues };
}

function resolveCurrency(currencyValues, issues, ref) {
  const values = [...new Set(currencyValues.filter(Boolean))];
  for (const value of values) {
    try { currency(value); } catch { issues.push(issue('INVALID_CURRENCY', `Invalid currency ${String(value)}.`, [ref])); }
  }
  if (values.length > 1) issues.push(issue('CURRENCY_MISMATCH', `Mixed currencies: ${values.join(', ')}.`, [ref]));
  return values.length === 1 && CURRENCY.test(values[0]) ? values[0] : null;
}

/**
 * Calculate cash-basis operational income from normalized completed sale lines,
 * approved effective costs, completed refunds and actual processing fees.
 * `tax` and `tips` inclusion is explicit per policy; discounts/refunds always
 * reduce recognized sales. Refund COGS is reversed only when explicitly approved.
 */
export function calculateIncome({ lines = [], fees = [], refundFacts = [], giftCardActivities = [], policy = {} } = {}) {
  assert(Array.isArray(lines) && Array.isArray(fees) && Array.isArray(refundFacts) && Array.isArray(giftCardActivities), 'lines, fees, refunds and giftCardActivities must be arrays');
  const p = { tax: 'exclude', tips: 'exclude', ...policy };
  assert(['include', 'exclude'].includes(p.tax), 'policy.tax must be include or exclude');
  assert(['include', 'exclude'].includes(p.tips), 'policy.tips must be include or exclude');
  const ld = deduplicateFacts(lines, x => `${x.id}@${x.version ?? '1'}`);
  const fd = deduplicateFacts(fees, x => `${x.id}@${x.version ?? '1'}`);
  const rd = deduplicateFacts(refundFacts, x => `${x.id}@${x.version ?? '1'}`);
  const gd = deduplicateFacts(giftCardActivities, x => `${x.id}@${x.version ?? '1'}`);
  const issues = [...ld.issues, ...fd.issues, ...rd.issues, ...gd.issues];
  let gross = 0, discounts = 0, refunds = 0, tax = 0, tips = 0, recognized = 0;
  let unitsSold = 0, unitsSoldGross = 0, unitsReturned = 0, cogs = 0, feesMinor = 0;
  let marginComplete = true;
  let giftCardLines = 0, giftCardActivations = 0, giftCardLoads = 0, giftCardRedemptions = 0;
  const currencies = [];
  for (const line of ld.facts) {
    const ref = String(line.id);
    assert(typeof line.id === 'string' && line.id.length, 'sale line id is required');
    if (line.status !== 'completed') continue;
    currencies.push(line.currency);
    if (line.itemType === 'GIFT_CARD') { giftCardLines++; continue; }
    const qty = money(line.quantity, `${ref}.quantity`);
    assert(qty > 0, `${ref}.quantity must be positive`);
    const amounts = {};
    for (const k of ['grossMinor', 'discountMinor', 'refundMinor', 'taxMinor', 'tipMinor']) {
      amounts[k] = line[k] ?? 0;
      money(amounts[k], `${ref}.${k}`);
      assert(amounts[k] >= 0, `${ref}.${k} cannot be negative`);
    }
    const lineSales = amounts.grossMinor - amounts.discountMinor - amounts.refundMinor +
      (p.tax === 'include' ? amounts.taxMinor : 0) + (p.tips === 'include' ? amounts.tipMinor : 0);
    assert(lineSales >= 0, `${ref} discounts/refunds exceed gross sales`);
    gross = add(gross, amounts.grossMinor, 'gross sales');
    discounts = add(discounts, amounts.discountMinor, 'discounts');
    refunds = add(refunds, amounts.refundMinor, 'refunds');
    tax = add(tax, amounts.taxMinor, 'tax');
    tips = add(tips, amounts.tipMinor, 'tips');
    recognized = add(recognized, lineSales, 'recognized sales');
    unitsSoldGross = add(unitsSoldGross, qty, 'gross units sold');
    const returned = money(line.returnedQuantity ?? 0, `${ref}.returnedQuantity`);
    assert(returned >= 0 && returned <= qty, `${ref}.returnedQuantity must be between zero and quantity`);
    unitsReturned = add(unitsReturned, returned, 'units returned');
    unitsSold = add(unitsSold, qty - returned, 'net units sold');
    if (line.unitCostMinor === null || line.unitCostMinor === undefined || line.currency !== line.costCurrency) {
      marginComplete = false;
      issues.push(issue('UNKNOWN_ITEM', `Approved cost or matching cost currency is missing for ${ref}.`, [ref]));
    } else {
      const unitCost = money(line.unitCostMinor, `${ref}.unitCostMinor`);
      assert(unitCost >= 0, `${ref}.unitCostMinor cannot be negative`);
      const soldCogs = unitCost * qty;
      assert(Number.isSafeInteger(soldCogs), `${ref} COGS exceeds safe integer range`);
      const reversal = line.approvedReturnReversalMinor ?? 0;
      money(reversal, `${ref}.approvedReturnReversalMinor`);
      assert(reversal >= 0 && reversal <= soldCogs, `${ref} return reversal exceeds COGS`);
      cogs = add(cogs, soldCogs - reversal, 'COGS');
    }
  }
  for (const fee of fd.facts) {
    assert(typeof fee.id === 'string' && fee.id.length, 'fee id is required');
    if (fee.status !== 'completed') continue;
    currencies.push(fee.currency);
    const amount = money(fee.amountMinor, `${fee.id}.amountMinor`);
    assert(amount >= 0, `${fee.id}.amountMinor cannot be negative`);
    feesMinor = add(feesMinor, amount, 'fees');
  }
  for (const refund of rd.facts) {
    assert(typeof refund.id === 'string' && refund.id.length, 'refund id is required');
    if (refund.status !== 'completed') continue;
    currencies.push(refund.currency);
    const amount = money(refund.amountMinor, `${refund.id}.amountMinor`);
    assert(amount >= 0, `${refund.id}.amountMinor cannot be negative`);
    refunds = add(refunds, amount, 'refunds');
    recognized -= amount;
    assert(Number.isSafeInteger(recognized), 'recognized sales exceeds safe integer range');
    if (amount > 0) {
      marginComplete = false;
      issues.push(issue('REFUND_COGS_REVIEW', `Refund ${refund.id} needs a human decision about returned inventory and any approved COGS reversal.`, [refund.id, refund.orderId].filter(Boolean)));
    }
  }
  for (const activity of gd.facts) {
    assert(typeof activity.id === 'string' && activity.id.length, 'gift card activity id is required');
    if (activity.status !== 'completed') continue;
    currencies.push(activity.currency);
    const amount = money(activity.amountMinor, `${activity.id}.amountMinor`);
    assert(amount >= 0, `${activity.id}.amountMinor cannot be negative`);
    if (activity.type === 'ACTIVATE') giftCardActivations = add(giftCardActivations, amount, 'gift card activations');
    else if (activity.type === 'LOAD') giftCardLoads = add(giftCardLoads, amount, 'gift card loads');
    else if (activity.type === 'REDEEM') giftCardRedemptions = add(giftCardRedemptions, amount, 'gift card redemptions');
    else issues.push(issue('UNSUPPORTED_ACTIVITY', `Gift card activity ${activity.id} requires a policy rule.`, [activity.id]));
  }
  if (giftCardLines > 0 && giftCardActivations + giftCardLoads === 0) {
    issues.push(issue('GIFT_CARD_ACTIVITY_MISSING', 'Gift card order lines have no linked activation or load activity.', []));
  }
  const reportCurrency = resolveCurrency(currencies, issues, 'income');
  if (!reportCurrency && currencies.length) issues.push(issue('CURRENCY_MISMATCH', 'Income projection has no single usable currency.', currencies.map(String)));
  const status = issues.some(x => ['CURRENCY_MISMATCH', 'INVALID_CURRENCY', 'SOURCE_CONFLICT'].includes(x.code)) ? 'failed' : marginComplete && !issues.some(x => ['GIFT_CARD_ACTIVITY_MISSING', 'UNSUPPORTED_ACTIVITY'].includes(x.code)) ? 'complete' : 'incomplete';
  return {
    calculationVersion: CALCULATION_VERSION,
    basis: 'cash_operational', status, currency: reportCurrency,
    policy: { tax: p.tax, tips: p.tips },
    grossItemSalesMinor: gross, discountsMinor: discounts, refundsMinor: refunds,
    taxMinor: tax, tipsMinor: tips, netSalesMinor: recognized,
    unitsSold, unitsSoldGross, unitsReturned, cogsMinor: marginComplete ? cogs : null,
    squareFeesMinor: feesMinor,
    giftCardLiabilityChangeMinor: giftCardLines > 0 && giftCardActivations + giftCardLoads === 0 ? null : giftCardActivations + giftCardLoads - giftCardRedemptions,
    giftCardActivationsMinor: giftCardActivations, giftCardLoadsMinor: giftCardLoads, giftCardRedemptionsMinor: giftCardRedemptions,
    operationalMarginMinor: marginComplete && status !== 'failed' ? recognized - cogs - feesMinor : null,
    issues,
  };
}

/** Validate paired tracked-account transfer legs. Positive amounts are inflows. */
export function validateTransfers(movements) {
  assert(Array.isArray(movements), 'movements must be an array');
  const groups = new Map();
  for (const m of movements) if (m.kind === 'transfer') {
    assert(typeof m.transferId === 'string' && m.transferId.length, `transfer movement ${m.id} requires transferId`);
    const list = groups.get(m.transferId) ?? [];
    list.push(m); groups.set(m.transferId, list);
  }
  const issues = [];
  for (const [id, legs] of groups) {
    const refs = legs.map(x => String(x.id));
    if (legs.length !== 2) { issues.push(issue('TRANSFER_UNPAIRED', `Transfer ${id} must have exactly two account legs.`, refs)); continue; }
    if (legs[0].accountId === legs[1].accountId || legs[0].amountMinor !== -legs[1].amountMinor || legs[0].amountMinor === 0 || legs[0].currency !== legs[1].currency || legs[0].status !== legs[1].status) {
      issues.push(issue('TRANSFER_INVALID_PAIR', `Transfer ${id} must link distinct accounts with equal opposite amounts and currency.`, refs));
    }
  }
  return issues;
}

/** Reconcile one named account. Movement amounts are signed; only posted facts count. */
export function reconcileAccount({ account, opening, observed, movements = [], toleranceMinor = 0 } = {}) {
  assert(account && typeof account.id === 'string', 'account.id is required');
  assert(opening && observed, 'opening and observed balance observations are required');
  assert(Array.isArray(movements), 'movements must be an array');
  money(opening.amountMinor, 'opening.amountMinor');
  money(observed.amountMinor, 'observed.amountMinor');
  money(toleranceMinor, 'toleranceMinor');
  assert(toleranceMinor >= 0, 'toleranceMinor cannot be negative');
  const accountCurrency = currency(account.currency, 'account.currency');
  const openingAt = instant(opening.observedAt, 'opening.observedAt');
  const observedAt = instant(observed.observedAt, 'observed.observedAt');
  assert(observedAt > openingAt, 'observed cutoff must be after opening cutoff');
  const issues = [];
  if (opening.accountId !== account.id || observed.accountId !== account.id) issues.push(issue('ACCOUNT_MISMATCH', 'Balance observation belongs to a different account.', [String(opening.id ?? 'opening'), String(observed.id ?? 'observed')]));
  if (opening.currency !== accountCurrency || observed.currency !== accountCurrency) issues.push(issue('CURRENCY_MISMATCH', 'Balance observation currency does not match the account.', [String(opening.id ?? 'opening'), String(observed.id ?? 'observed')]));
  const inWindow = movements.filter(m => {
    if (m.status !== 'posted') return false;
    const occurredAt = instant(m.occurredAt, `${m.id}.occurredAt`);
    return occurredAt > openingAt && occurredAt <= observedAt;
  });
  issues.push(...validateTransfers(inWindow));
  const dedup = deduplicateFacts(inWindow, m => String(m.idempotencyKey ?? m.id));
  issues.push(...dedup.issues);
  let expected = opening.amountMinor;
  const includedRefs = [];
  for (const m of dedup.facts) {
    if (m.accountId !== account.id || m.status !== 'posted') continue;
    assert(typeof m.id === 'string' && m.id.length, 'movement id is required');
    money(m.amountMinor, `${m.id}.amountMinor`);
    if (m.currency !== accountCurrency) { issues.push(issue('CURRENCY_MISMATCH', `Movement ${m.id} currency differs from account currency.`, [m.id])); continue; }
    if (m.kind === 'transfer' && !m.transferId) continue;
    expected = add(expected, m.amountMinor, 'expected balance');
    includedRefs.push(m.id);
  }
  const discrepancy = observed.amountMinor - expected;
  const failed = issues.some(x => ['CURRENCY_MISMATCH', 'ACCOUNT_MISMATCH', 'TRANSFER_UNPAIRED', 'TRANSFER_INVALID_PAIR', 'SOURCE_CONFLICT'].includes(x.code));
  return {
    calculationVersion: CALCULATION_VERSION, accountId: account.id, currency: accountCurrency,
    status: failed ? 'failed' : Math.abs(discrepancy) <= toleranceMinor ? 'matched' : 'mismatch',
    openingBalanceMinor: opening.amountMinor, expectedBalanceMinor: expected,
    observedBalanceMinor: observed.amountMinor, discrepancyMinor: discrepancy,
    toleranceMinor, includedMovementIds: includedRefs.sort(), issues,
  };
}

/** Replay a complete normalized snapshot without mutating caller-owned facts. */
export function replayAccounting(snapshot) {
  assert(snapshot && typeof snapshot === 'object', 'snapshot is required');
  assert(snapshot.incomePolicy && own(snapshot.incomePolicy, 'tax') && own(snapshot.incomePolicy, 'tips'),
    'replay requires explicit tax and tip policy');
  const income = calculateIncome({ lines: structuredClone(snapshot.lines ?? []), fees: structuredClone(snapshot.fees ?? []), refundFacts: structuredClone(snapshot.refunds ?? []), giftCardActivities: structuredClone(snapshot.giftCardActivities ?? []), policy: snapshot.incomePolicy });
  const accounts = (snapshot.accounts ?? []).map(a => {
    const args = snapshot.reconciliations?.[a.id];
    assert(args, `missing reconciliation inputs for account ${a.id}`);
    return reconcileAccount({ ...args, account: a, movements: structuredClone(args.movements ?? []) });
  });
  const issues = [...income.issues, ...accounts.flatMap(x => x.issues)];
  const failed = income.status === 'failed' || accounts.some(account => account.status === 'failed');
  const incomplete = income.status !== 'complete' || accounts.some(account => account.status !== 'matched');
  return { calculationVersion: CALCULATION_VERSION, status: failed ? 'failed' : incomplete ? 'incomplete' : 'complete', income, accounts, issues };
}
