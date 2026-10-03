/** Product-level operational revenue and cost analytics, with explicit unallocated amounts. */
export const PRODUCT_ANALYTICS_CALCULATION_VERSION = 'finance-loop-product-analytics-v2';

const assert = (ok, message) => { if (!ok) throw new TypeError(message); };
const validCurrency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const sum = (a, b, field) => { const value = a + b; assert(Number.isSafeInteger(value), `${field} exceeds safe integer range`); return value; };
const instant = (value, field) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  assert(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(parsed)
    && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19), `${field} must be a valid ISO UTC timestamp`);
  return parsed;
};
const refs = values => [...new Set(values.filter(Boolean).map(String))].sort();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function dedupe(facts, kind, issues) {
  const seen = new Map(), result = [];
  for (const fact of facts) {
    assert(fact && typeof fact === 'object' && typeof fact.id === 'string' && fact.id.length, `${kind} id is required`);
    const key = `${fact.id}@${fact.version ?? '1'}`, json = JSON.stringify(canonical(fact));
    if (!seen.has(key)) { seen.set(key, json); result.push(fact); }
    else if (seen.get(key) !== json) issues.push({ code: 'SOURCE_CONFLICT', sourceRefs: [fact.id] });
  }
  return result;
}
const productKey = line => line.catalogObjectId ?? line.squareCatalogObjectId ?? line.itemId ?? (line.orderId && line.lineItemUid ? `line:${line.orderId}:${line.lineItemUid}` : null);
const factProductKey = fact => fact.catalogObjectId ?? fact.squareCatalogObjectId ?? fact.itemId ?? (fact.orderId && fact.lineItemUid ? `line:${fact.orderId}:${fact.lineItemUid}` : null);

/**
 * Calculate product revenue, COGS and net for [from,to). Refunds and fees are
 * assigned only when they identify an exact product or exact order line.
 */
export function calculateProductAnalytics({ lines = [], fees = [], refunds = [], incomePolicy = {}, from, to, currency } = {}) {
  assert(Array.isArray(lines) && Array.isArray(fees) && Array.isArray(refunds), 'lines, fees and refunds must be arrays');
  assert(typeof from === 'string' && typeof to === 'string', 'from and to are required ISO UTC timestamps');
  const start = instant(from, 'from'), end = instant(to, 'to');
  assert(start < end, 'to must be after from');
  const policy = { tax: 'exclude', tips: 'exclude', ...incomePolicy };
  assert(['include', 'exclude'].includes(policy.tax) && ['include', 'exclude'].includes(policy.tips), 'incomePolicy tax and tips must be include or exclude');
  if (currency !== undefined) assert(validCurrency(currency), 'currency must be an uppercase ISO currency code');
  const issues = [];
  const cleanLines = dedupe(lines, 'line', issues), cleanFees = dedupe(fees, 'fee', issues), cleanRefunds = dedupe(refunds, 'refund', issues);
  const inPeriod = fact => { const at = instant(fact.occurredAt, `${fact.id}.occurredAt`); return at >= start && at < end; };
  const products = new Map(), lineToProduct = new Map(), orderProducts = new Map(), feeOrderProducts = new Map(), feeOrderAmbiguousOrders = new Set(), orderCogs = new Map(), orderLineCount = new Map(), orderReversals = new Map(), currencies = new Set();
  const seriesRecords = [];
  const feeAllocationRefs = [];
  const ensure = (key, name) => {
    if (!key) return null;
    if (!products.has(key)) products.set(key, { productId: key, productName: name ?? null, revenueMinor: 0, costMinor: 0, feesMinor: 0, netMinor: 0, grossMinor: 0, discountMinor: 0, refundsMinor: 0, unitsSold: 0, sourceRefs: [], costComplete: true, revenueComplete: true, feesAllocationComplete: true });
    const p = products.get(key); if (name && (!p.productName || name.localeCompare(p.productName) < 0)) p.productName = name;
    return p;
  };
  let unallocatedRevenueMinor = 0, unallocatedRefundsMinor = 0, unallocatedFeesMinor = 0;
  let revenueComplete = true, refundsComplete = true, feesComplete = true, unallocatedCostIncomplete = false;
  let unallocatedCogsReversalMinor = 0, refundReviewIncomplete = false, unboundedCogsReversal = false;
  for (const line of cleanLines) {
    if (line.status !== 'completed' || !inPeriod(line)) continue;
    if (line.itemType === 'GIFT_CARD') continue;
    const key = productKey(line), p = ensure(key, line.itemName ?? line.name ?? null);
    assert(validCurrency(line.currency), `${line.id}.currency must be an uppercase ISO currency code`); currencies.add(line.currency);
    if (line.orderId) {
      const orderId = String(line.orderId);
      if (!p) feeOrderAmbiguousOrders.add(orderId);
      else {
        const orderSet = feeOrderProducts.get(orderId) ?? new Set();
        orderSet.add(p); feeOrderProducts.set(orderId, orderSet);
      }
    }
    const quantity = line.quantity;
    assert(Number.isSafeInteger(quantity) && quantity > 0, `${line.id}.quantity must be a positive integer`);
    const value = (field, required = false) => {
      const n = line[field];
      if ((n === null || n === undefined) && required) return null;
      const resolved = n ?? 0;
      assert(Number.isSafeInteger(resolved) && resolved >= 0, `${line.id}.${field} must be a nonnegative integer`);
      return resolved;
    };
    const lineRefund = value('refundMinor');
    const gross = value('grossMinor', true), discount = value('discountMinor', true);
    const tax = policy.tax === 'include' ? value('taxMinor', true) : 0;
    const tips = policy.tips === 'include' ? value('tipMinor', true) : 0;
    if (gross === null || discount === null || tax === null || tips === null) {
      revenueComplete = false; issues.push({ code: 'SOURCE_GAP', sourceRefs: [line.id] });
      if (p) { p.costComplete = false; p.revenueComplete = false; p.sourceRefs.push(line.id); }
      seriesRecords.push({ at: line.occurredAt, type: 'sale', revenue: null, cost: null, fees: 0, units: 0 });
      continue;
    }
    const revenue = gross - discount - lineRefund + tax + tips;
    assert(revenue >= 0, `${line.id} discounts/refunds exceed gross sales`);
    if (!p) {
      issues.push({ code: 'UNKNOWN_ITEM', sourceRefs: [line.id] });
      unallocatedRevenueMinor = sum(unallocatedRevenueMinor, revenue, 'unallocated revenue');
      unallocatedCostIncomplete = true;
      seriesRecords.push({ at: line.occurredAt, type: 'sale', revenue, cost: null, fees: 0, units: quantity });
      continue;
    }
    p.revenueMinor = sum(p.revenueMinor, revenue, 'product revenue'); p.unitsSold = sum(p.unitsSold, quantity, 'product units'); p.sourceRefs.push(line.id);
    p.grossMinor = sum(p.grossMinor, gross, 'product gross sales');
    p.discountMinor = sum(p.discountMinor, discount, 'product discounts');
    p.refundsMinor = sum(p.refundsMinor, lineRefund, 'product refunds');
    if (line.orderId) {
      const orderId = String(line.orderId), orderSet = orderProducts.get(orderId) ?? new Set();
      orderSet.add(p); orderProducts.set(orderId, orderSet);
      orderLineCount.set(orderId, (orderLineCount.get(orderId) ?? 0) + 1);
    }
    if (line.orderId && line.lineItemUid) lineToProduct.set(`${line.orderId}:${line.lineItemUid}`, p);
    const unitCost = line.unitCostMinor;
    if (!Number.isSafeInteger(unitCost) || unitCost < 0 || line.costCurrency !== line.currency) {
      p.costComplete = false;
      issues.push({ code: 'UNKNOWN_ITEM', sourceRefs: [line.id] });
    }
    else {
      const cost = unitCost * quantity - (line.approvedReturnReversalMinor ?? 0);
      assert(Number.isSafeInteger(cost) && cost >= 0, `${line.id} cost exceeds safe range or has invalid reversal`);
      p.costMinor = sum(p.costMinor, cost, 'product COGS');
      if (line.orderId) orderCogs.set(String(line.orderId), sum(orderCogs.get(String(line.orderId)) ?? 0, cost, 'order COGS'));
    }
    seriesRecords.push({ at: line.occurredAt, type: 'sale', revenue, cost: Number.isSafeInteger(unitCost) && unitCost >= 0 && line.costCurrency === line.currency ? unitCost * quantity - (line.approvedReturnReversalMinor ?? 0) : null, fees: 0, units: quantity });
  }
  const allocate = (fact, amount, field) => {
    const key = factProductKey(fact);
    let p = key ? products.get(key) : null;
    if (!p && fact.orderId && fact.lineItemUid) p = lineToProduct.get(`${fact.orderId}:${fact.lineItemUid}`) ?? null;
    if (!p && field === 'fee' && fact.orderId) {
      const orderId = String(fact.orderId), orderSet = feeOrderProducts.get(orderId);
      if (!feeOrderAmbiguousOrders.has(orderId) && orderSet?.size === 1) p = [...orderSet][0];
      else if (feeOrderAmbiguousOrders.has(orderId) || orderSet?.size > 1) {
        feeAllocationRefs.push(fact.id);
        for (const product of orderSet ?? []) { product.feesAllocationComplete = false; product.sourceRefs.push(fact.id); }
      }
    }
    if (!p) {
      if (field === 'refund') unallocatedRefundsMinor = sum(unallocatedRefundsMinor, amount, 'unallocated refunds');
      else unallocatedFeesMinor = sum(unallocatedFeesMinor, amount, 'unallocated fees');
      return;
    }
    if (field === 'refund') { p.revenueMinor -= amount; p.refundsMinor = sum(p.refundsMinor, amount, 'product refunds'); }
    else p.feesMinor = sum(p.feesMinor, amount, 'product fees');
    p.sourceRefs.push(fact.id);
  };
  for (const refund of cleanRefunds) {
    if (refund.status !== 'completed' || !inPeriod(refund)) continue;
    assert(validCurrency(refund.currency), `${refund.id}.currency must be an uppercase ISO currency code`); currencies.add(refund.currency);
    if (!Number.isSafeInteger(refund.amountMinor) || refund.amountMinor < 0) {
      refundsComplete = false; revenueComplete = false; issues.push({ code: 'SOURCE_GAP', sourceRefs: [refund.id] });
      for (const product of orderProducts.get(String(refund.orderId)) ?? []) { product.costComplete = false; product.revenueComplete = false; }
      seriesRecords.push({ at: refund.occurredAt, type: 'refund', amount: null, reviewIncomplete: true });
      continue;
    }
    allocate(refund, refund.amountMinor, 'refund');
    if (refund.amountMinor > 0) {
      if (!['returned_to_inventory', 'not_returned_to_inventory'].includes(refund.reviewDisposition)) {
        refundReviewIncomplete = true;
        issues.push({ code: 'REFUND_COGS_REVIEW', sourceRefs: [refund.id, refund.orderId].filter(Boolean).map(String) });
        for (const product of orderProducts.get(String(refund.orderId)) ?? []) product.costComplete = false;
      } else {
        assert(refund.reviewCurrency === refund.currency, `${refund.id} reviewCurrency must match currency`);
        const reversal = refund.approvedCogsReversalMinor;
        assert(Number.isSafeInteger(reversal) && reversal >= 0, `${refund.id}.approvedCogsReversalMinor must be a nonnegative integer`);
        if (refund.reviewDisposition === 'not_returned_to_inventory') assert(reversal === 0, `${refund.id} non-returned goods cannot reverse COGS`);
        let reversalBounded = true;
        const orderId = String(refund.orderId ?? ''), prior = orderReversals.get(orderId) ?? 0, available = orderCogs.get(orderId) ?? 0;
        if (!orderLineCount.has(orderId) && reversal > 0) {
          reversalBounded = false;
          unboundedCogsReversal = true;
          issues.push({ code: 'SOURCE_GAP', sourceRefs: [refund.id, orderId].filter(Boolean) });
        } else {
          assert(reversal <= available - prior, `${refund.id} COGS reversal exceeds known order COGS`);
          orderReversals.set(orderId, sum(prior, reversal, 'order COGS reversals'));
        }
        const key = factProductKey(refund), p = key ? products.get(key) : (refund.orderId && refund.lineItemUid ? lineToProduct.get(`${refund.orderId}:${refund.lineItemUid}`) : null);
        if (p && reversalBounded) { p.costMinor -= reversal; assert(Number.isSafeInteger(p.costMinor) && p.costMinor >= 0, `${refund.id} COGS reversal exceeds exact product COGS`); }
        else unallocatedCogsReversalMinor = sum(unallocatedCogsReversalMinor, reversal, 'unallocated COGS reversals');
        seriesRecords.push({ at: refund.occurredAt, type: 'cogs_reversal', amount: reversal, bounded: reversalBounded });
      }
    }
    seriesRecords.push({ at: refund.occurredAt, type: 'refund', amount: refund.amountMinor, reviewIncomplete: refund.amountMinor > 0 && !['returned_to_inventory', 'not_returned_to_inventory'].includes(refund.reviewDisposition) });
  }
  for (const fee of cleanFees) {
    if (fee.status !== 'completed' || !inPeriod(fee)) continue;
    assert(validCurrency(fee.currency), `${fee.id}.currency must be an uppercase ISO currency code`); currencies.add(fee.currency);
    if (!Number.isSafeInteger(fee.amountMinor) || fee.amountMinor < 0) { feesComplete = false; issues.push({ code: 'FEE_MISSING', sourceRefs: [fee.id] }); seriesRecords.push({ at: fee.occurredAt, type: 'fee', amount: null }); continue; }
    allocate(fee, fee.amountMinor, 'fee');
    seriesRecords.push({ at: fee.occurredAt, type: 'fee', amount: fee.amountMinor });
  }
  if (feeAllocationRefs.length) issues.push({ code: 'FEE_ALLOCATION_INCOMPLETE', sourceRefs: refs(feeAllocationRefs) });
  if (currency) currencies.add(currency);
  if (currencies.size > 1) issues.push({ code: 'CURRENCY_MISMATCH', sourceRefs: [] });
  let revenueMinor = unallocatedRevenueMinor, costMinor = 0, allCostsKnown = !unallocatedCostIncomplete && !refundReviewIncomplete && !unboundedCogsReversal;
  for (const p of products.values()) {
    if (!p.costComplete) issues.push({ code: 'UNKNOWN_ITEM', sourceRefs: refs(p.sourceRefs) });
    p.costMinor = p.costComplete ? p.costMinor : null;
    p.netMinor = p.costMinor === null || !p.revenueComplete || !p.feesAllocationComplete || !feesComplete ? null : sum(sum(p.revenueMinor, -p.costMinor, 'product net'), -p.feesMinor, 'product net');
    revenueMinor = sum(revenueMinor, p.revenueMinor, 'revenue total');
    if (p.costMinor === null) allCostsKnown = false; else costMinor = sum(costMinor, p.costMinor, 'COGS total');
    if (!p.revenueComplete) p.revenueMinor = null;
    if (!p.feesAllocationComplete || !feesComplete) p.feesMinor = null;
    p.sourceRefs = refs(p.sourceRefs); delete p.costComplete; delete p.revenueComplete;
  }
  const refundFactsInPeriod = cleanRefunds.filter(f => f.status === 'completed' && inPeriod(f));
  const feeFactsInPeriod = cleanFees.filter(f => f.status === 'completed' && inPeriod(f));
  if (refundFactsInPeriod.some(f => !Number.isSafeInteger(f.amountMinor) || f.amountMinor < 0)) refundsComplete = false;
  if (feeFactsInPeriod.some(f => !Number.isSafeInteger(f.amountMinor) || f.amountMinor < 0)) feesComplete = false;
  const totalRefunds = refundsComplete ? [...cleanLines.filter(l => l.status === 'completed' && inPeriod(l) && l.itemType !== 'GIFT_CARD').map(l => l.refundMinor ?? 0), ...refundFactsInPeriod.map(f => f.amountMinor)].reduce((a, b) => sum(a, b, 'refunds total'), 0) : null;
  const totalFees = feesComplete ? feeFactsInPeriod.reduce((n, f) => sum(n, f.amountMinor, 'fees total'), 0) : null;
  revenueMinor -= unallocatedRefundsMinor;
  if (![revenueMinor, costMinor].every(Number.isSafeInteger)) throw new TypeError('analytics totals exceed safe integer range');
  const adjustedCostMinor = allCostsKnown ? sum(costMinor, -unallocatedCogsReversalMinor, 'adjusted COGS') : null;
  const calculationFailed = issues.some(i => ['SOURCE_CONFLICT', 'CURRENCY_MISMATCH'].includes(i.code));
  const status = calculationFailed ? 'failed' : allCostsKnown ? (issues.length ? 'incomplete' : 'complete') : 'incomplete';
  const buildSeries = monthly => {
    const buckets = new Map();
    for (const record of seriesRecords) {
      const date = String(record.at).slice(0, monthly ? 7 : 10);
      const bucket = buckets.get(date) ?? { period: date, revenueMinor: 0, costMinor: 0, feesMinor: 0, unitsSold: 0, revenueComplete: true, costComplete: true, feesComplete: true };
      if (record.type === 'sale') {
        if (record.revenue === null) bucket.revenueComplete = false;
        else bucket.revenueMinor = sum(bucket.revenueMinor, record.revenue, 'period revenue');
        if (record.cost === null) bucket.costComplete = false;
        else bucket.costMinor = sum(bucket.costMinor, record.cost, 'period COGS');
        bucket.unitsSold = sum(bucket.unitsSold, record.units, 'period units');
      } else if (record.type === 'refund') {
        if (record.amount === null) bucket.revenueComplete = false;
        else bucket.revenueMinor = sum(bucket.revenueMinor, -record.amount, 'period revenue');
        if (record.reviewIncomplete) bucket.costComplete = false;
      } else if (record.type === 'fee') {
        if (record.amount === null) bucket.feesComplete = false;
        else bucket.feesMinor = sum(bucket.feesMinor, record.amount, 'period fees');
      } else if (record.type === 'cogs_reversal') {
        if (record.bounded) bucket.costMinor = sum(bucket.costMinor, -record.amount, 'period COGS');
        else bucket.costComplete = false;
      }
      buckets.set(date, bucket);
    }
    return [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period)).map(bucket => ({ period: bucket.period,
      revenueMinor: bucket.revenueComplete && !calculationFailed ? bucket.revenueMinor : null, costMinor: bucket.costComplete && !calculationFailed ? bucket.costMinor : null,
      feesMinor: bucket.feesComplete && !calculationFailed ? bucket.feesMinor : null, netMinor: bucket.revenueComplete && bucket.costComplete && bucket.feesComplete && !calculationFailed ? sum(sum(bucket.revenueMinor, -bucket.costMinor, 'period net'), -bucket.feesMinor, 'period net') : null,
      unitsSold: bucket.unitsSold }));
  };
  const productRows = [...products.values()].sort((a, b) => a.productId.localeCompare(b.productId));
  const ratio = (n, d) => {
    if (n === null || d === 0 || d === null) return null;
    const numerator = BigInt(n) * 10000n, denominator = BigInt(d), sign = numerator * denominator < 0n ? -1n : 1n;
    const absNumerator = numerator < 0n ? -numerator : numerator, absDenominator = denominator < 0n ? -denominator : denominator;
    const result = sign * ((absNumerator + absDenominator / 2n) / absDenominator);
    return result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER) ? null : Number(result);
  };
  const revenueRank = productRows.filter(p => p.revenueMinor !== null).sort((a, b) => (a.revenueMinor === b.revenueMinor ? a.productId.localeCompare(b.productId) : a.revenueMinor > b.revenueMinor ? -1 : 1));
  const netRank = [...productRows].filter(p => p.netMinor !== null).sort((a, b) => (a.netMinor === b.netMinor ? a.productId.localeCompare(b.productId) : a.netMinor > b.netMinor ? -1 : 1));
  revenueRank.forEach((p, i) => { p.revenueRank = i + 1; });
  netRank.forEach((p, i) => { p.netRank = i + 1; });
  for (const p of productRows) {
    p.revenueShareBps = revenueComplete ? ratio(p.revenueMinor, revenueMinor) : null;
    p.marginBps = p.netMinor === null ? null : ratio(p.netMinor, p.revenueMinor);
    if (p.netRank === undefined) p.netRank = null;
    if (p.revenueRank === undefined) p.revenueRank = null;
    if (!feesComplete) { p.feesMinor = null; p.netMinor = null; }
    if (calculationFailed) {
      p.revenueMinor = null; p.costMinor = null; p.feesMinor = null; p.netMinor = null;
      p.grossMinor = null; p.discountMinor = null; p.refundsMinor = null; p.revenueShareBps = null; p.marginBps = null;
      p.revenueRank = null; p.netRank = null;
    }
  }
  return { calculationVersion: PRODUCT_ANALYTICS_CALCULATION_VERSION, status, currency: currencies.size === 1 ? [...currencies][0] : null, from, to,
    products: productRows, daily: buildSeries(false), monthly: buildSeries(true),
    unallocated: { revenueMinor: calculationFailed ? null : unallocatedRevenueMinor, refundsMinor: calculationFailed || !refundsComplete ? null : unallocatedRefundsMinor,
      feesMinor: calculationFailed || !feesComplete ? null : unallocatedFeesMinor, cogsReversalMinor: calculationFailed || unboundedCogsReversal ? null : unallocatedCogsReversalMinor },
    totals: { revenueMinor: revenueComplete && !calculationFailed ? revenueMinor : null,
      costMinor: calculationFailed ? null : adjustedCostMinor,
      netMinor: allCostsKnown && revenueComplete && feesComplete && !calculationFailed ? sum(sum(revenueMinor, -adjustedCostMinor, 'net total'), -totalFees, 'net total') : null,
      feesMinor: calculationFailed || !feesComplete ? null : totalFees, refundsMinor: calculationFailed || !refundsComplete ? null : totalRefunds },
    issues: issues.sort((a, b) => a.code.localeCompare(b.code) || (a.sourceRefs?.[0] ?? '').localeCompare(b.sourceRefs?.[0] ?? '')) };
}
