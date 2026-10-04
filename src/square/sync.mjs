const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));
const cursorPage = data => ({ items: data.orders ?? data.payments ?? data.refunds ?? data.objects ?? data.payouts ?? data.payout_entries ?? data.gift_card_activities ?? [], cursor: data.cursor ?? null });

async function withRetry(fn, { retries, sleep, random, onRetry }) {
  for (let attempt = 0;; attempt++) {
    try { return await fn(); } catch (error) {
      const retryable = error.status === 429 || error.status >= 500 || error.status == null;
      if (!retryable || attempt >= retries) throw error;
      const retryAfterMs = Number(error.retryAfter) * 1000;
      const delay = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : Math.min(30_000, 500 * 2 ** attempt) * (0.75 + random() * 0.5);
      onRetry?.({ attempt: attempt + 1, delayMs: Math.round(delay), status: error.status });
      await sleep(delay);
    }
  }
}

async function paginate({ name, fetchPage, onPage, state, retries, sleep, random, onRetry, maxPages }) {
  let cursor = null; let pages = 0; const seen = new Set();
  try {
    do {
      if (++pages > maxPages) throw new Error(`${name}: page limit exceeded`);
      const data = await withRetry(() => fetchPage(cursor), { retries, sleep, random, onRetry: e => onRetry?.({ resource: name, ...e }) });
      const page = cursorPage(data);
      await onPage(page.items);
      cursor = page.cursor;
      if (cursor && seen.has(cursor)) throw new Error(`${name}: Square repeated a pagination cursor`);
      if (cursor) seen.add(cursor);
    } while (cursor);
    state.resources[name] = { status: 'fresh', pages, completedAt: new Date().toISOString() };
  } catch (error) {
    const providerCode = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(error.code)
      ? error.code
      : Array.isArray(error?.errors) ? error.errors.find(item => typeof item?.code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(item.code))?.code : undefined;
    state.gaps.push({
      resource: name,
      code: error.status === 403 ? 'PERMISSION_LOST' : error.status === 429 ? 'RATE_LIMITED' : 'BACKFILL_INCOMPLETE',
      message: error.message,
      ...(Number.isInteger(error?.status) ? { providerStatus: error.status } : {}),
      ...(providerCode ? { providerCode } : {}),
      cursor,
    });
    state.resources[name] = { status: 'incomplete', pages, cursor, error: error.message };
  }
}

/** Fetch bounded historical data using Square's cursor APIs. `persist` should be an idempotent durable upsert. */
export async function backfillSquare({ client, startAt, endAt, locationIds = [], persist, sleep = sleepDefault, random = Math.random, retries = 4, maxPages = 10_000, onRetry }) {
  if (!client?.request || typeof persist !== 'function') throw new TypeError('client.request and persist are required');
  if (!startAt || !endAt || Date.parse(startAt) >= Date.parse(endAt)) throw new TypeError('valid startAt and endAt are required');
  const state = { startedAt: new Date().toISOString(), window: { startAt, endAt }, resources: {}, gaps: [] };
  await paginate({ name: 'orders', state, retries, sleep, random, onRetry, maxPages, fetchPage: cursor => client.request('/v2/orders/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: 500, cursor, location_ids: locationIds.length ? locationIds : undefined, query: { filter: { date_time_filter: { created_at: { start_at: startAt, end_at: endAt } } }, sort: { sort_field: 'CREATED_AT', sort_order: 'ASC' } } }) }), onPage: rows => persist(rows.flatMap(normalizeOrder)) });
  const timeQuery = `begin_time=${encodeURIComponent(startAt)}&end_time=${encodeURIComponent(endAt)}&limit=100`;
  const simple = [
    ['payments', `/v2/payments?${timeQuery}`, 'payments', normalizePayment],
    ['refunds', `/v2/refunds?${timeQuery}`, 'refunds', normalizeRefund],
    ['catalog', '/v2/catalog/list?types=ITEM,ITEM_VARIATION,CATEGORY&limit=100', 'objects', normalizeCatalog]
  ];
  for (const [name, path, key, normalize] of simple) await paginate({ name, state, retries, sleep, random, onRetry, maxPages, fetchPage: cursor => client.request(`${path}${path.includes('?') ? '&' : '?'}${cursor ? `cursor=${encodeURIComponent(cursor)}` : ''}`), onPage: rows => persist(rows.flatMap(row => normalize(row))) });
  await paginate({ name: 'gift_card_activities', state, retries, sleep, random, onRetry, maxPages, fetchPage: cursor => client.request(`/v2/gift-cards/activities?begin_time=${encodeURIComponent(startAt)}&end_time=${encodeURIComponent(endAt)}&sort_order=ASC&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), onPage: rows => persist(rows.flatMap(normalizeGiftCardActivity)) });
  // Payout entries have their own cursor per payout; both levels are checkpointed.
  const payouts = [];
  await paginate({ name: 'payouts', state, retries, sleep, random, onRetry, maxPages, fetchPage: cursor => client.request(`/v2/payouts?${timeQuery}&sort_order=ASC${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), onPage: async rows => { payouts.push(...rows); await persist(rows.flatMap(normalizePayout)); } });
  for (const payout of payouts) {
    if (!payout.id) continue;
    await paginate({ name: `payout_entries:${payout.id}`, state, retries, sleep, random, onRetry, maxPages, fetchPage: cursor => client.request(`/v2/payouts/${encodeURIComponent(payout.id)}/payout-entries?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), onPage: rows => persist(rows.flatMap(entry => normalizePayoutEntry(entry, payout.id))) });
  }
  state.finishedAt = new Date().toISOString();
  state.freshness = state.gaps.length ? 'incomplete' : 'fresh';
  state.lastSuccessfulSyncAt = state.gaps.length ? null : state.finishedAt;
  return state;
}

const minor = money => {
  const amount = money?.amount;
  if (amount === null || amount === undefined || !['number', 'string'].includes(typeof amount)) return null;
  if (typeof amount === 'string' && !/^-?\d+$/.test(amount)) return null;
  const parsed = Number(amount);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const moneyCurrency = money => money?.currency ?? money?.currency_code ?? null;
const idOf = o => o?.id ?? null;
export function normalizeOrder(o) {
  const id = idOf(o); if (!id) return [];
  const orderVersion = String(o.version ?? o.updated_at ?? o.created_at ?? '');
  const currency = o.total_money?.currency ?? o.line_items?.find(x => x.base_price_money?.currency)?.base_price_money.currency ?? null;
  const facts = [{ kind: 'order', objectId: id, version: orderVersion, occurredAt: o.created_at ?? null, updatedAt: o.updated_at ?? null, status: o.state ?? null, currency, raw: o, totals: { totalMinor: minor(o.total_money), taxMinor: minor(o.total_tax_money), discountMinor: minor(o.total_discount_money), serviceChargeMinor: minor(o.total_service_charge_money) } }];
  for (const line of o.line_items ?? []) {
    const appliedDiscounts = Array.isArray(line.applied_discounts) ? line.applied_discounts : null;
    const discountMinor = minor(line.total_discount_money) ?? (appliedDiscounts && appliedDiscounts.every(discount => minor(discount.applied_money) !== null) ? appliedDiscounts.reduce((sum, discount) => sum + minor(discount.applied_money), 0) : null);
    facts.push({ kind: 'order_line', objectId: `${id}:${line.uid ?? line.catalog_object_id ?? facts.length}`, version: orderVersion, parentId: id, orderId: id, occurredAt: o.created_at ?? null, lineItemUid: line.uid ?? null, itemType: line.item_type ?? null, catalogObjectId: line.catalog_object_id ?? null, name: line.name ?? null, quantity: line.quantity ?? null, currency: line.gross_sales_money?.currency ?? line.total_money?.currency ?? currency, grossMinor: minor(line.gross_sales_money), grossStatus: line.gross_sales_money ? 'provided' : 'missing_square_gross_sales_money', totalMinor: minor(line.total_money), taxMinor: minor(line.total_tax_money), tipMinor: minor(line.total_tip_money) ?? 0, discountMinor, discountStatus: discountMinor === null ? 'missing_square_discount_total' : 'provided_or_no_applied_discounts', raw: line });
  }
  return facts;
}
export function normalizePayment(p) {
  if (!p?.id) return [];
  const currency = moneyCurrency(p.amount_money);
  const sourceType = p.source_type ?? null;
  const amountMinor = minor(p.amount_money);
  const noSale = sourceType === 'EXTERNAL' && amountMinor === 0 && p.external_details?.source === 'NO_SALE';
  const squareVersion = String(p.updated_at ?? p.created_at ?? '');
  // This revision adds sourceType and explicit fee handling for zero-value
  // Square POS no-sale records. Version it to replace earlier normalized facts.
  const version = `${squareVersion}|normalization-3`;
  const feesPresent = Array.isArray(p.processing_fee);
  let feeMinor = null; let feeStatus = 'missing_processing_fee';
  if (feesPresent && p.processing_fee.length > 0) {
    const feeAmounts = p.processing_fee.map(fee => ({ amount: minor(fee.amount_money), currency: moneyCurrency(fee.amount_money) }));
    if (feeAmounts.some(fee => fee.amount === null)) feeStatus = 'invalid_processing_fee_amount';
    else if (feeAmounts.some(fee => fee.currency !== currency)) feeStatus = 'processing_fee_currency_mismatch';
    else {
      const sum = feeAmounts.reduce((total, fee) => total + fee.amount, 0);
      if (Number.isSafeInteger(sum)) { feeMinor = sum; feeStatus = 'provided'; }
      else feeStatus = 'processing_fee_out_of_range';
    }
  } else if (sourceType === 'CASH') {
    // Cash tender has no Square card-processing fee. Record the explicit zero
    // without inventing a fee for other payment types whose fee is unavailable.
    feeMinor = 0; feeStatus = 'not_applicable_cash';
  } else if (noSale) {
    // Square POS can record an explicit zero-value EXTERNAL/NO_SALE event.
    // It did not process a sale, so no Square processing fee applies.
    feeMinor = 0; feeStatus = 'not_applicable_no_sale';
  } else if (feesPresent) {
    feeMinor = 0; feeStatus = 'provided';
  }
  return [{ kind: 'payment', objectId: p.id, version, orderId: p.order_id ?? null, locationId: p.location_id ?? null, sourceType, status: p.status ?? null, occurredAt: p.created_at ?? null, updatedAt: p.updated_at ?? null, currency, amountMinor, feeMinor, feeStatus, raw: p }];
}
export function normalizeRefund(r) { return r?.id ? [{ kind: 'refund', objectId: r.id, version: String(r.updated_at ?? r.created_at ?? ''), paymentId: r.payment_id ?? null, orderId: r.order_id ?? null, status: r.status ?? null, occurredAt: r.created_at ?? null, currency: r.amount_money?.currency ?? null, amountMinor: minor(r.amount_money), raw: r }] : []; }
export function normalizeCatalog(obj) {
  if (!obj?.id) return [];
  const sourceVersion = String(obj.version ?? obj.updated_at ?? '');
  const variation = obj.type === 'ITEM_VARIATION' ? obj.item_variation_data : null;
  const priceMoney = variation?.price_money;
  return [{ kind: 'catalog', objectId: obj.id,
    version: sourceVersion ? `${sourceVersion}|normalization-2` : '',
    objectType: obj.type ?? null,
    name: obj.item_data?.name ?? variation?.name ?? obj.category_data?.name ?? null,
    itemId: variation?.item_id ?? null,
    sku: variation?.sku ?? null,
    priceMinor: variation ? minor(priceMoney) : null,
    currency: variation ? moneyCurrency(priceMoney) : null,
    pricingType: variation?.pricing_type ?? null,
    isDeleted: obj.is_deleted === true,
    raw: obj }];
}
export function normalizePayout(p) {
  if (!p?.id) return [];
  return [{
    kind: 'payout', objectId: p.id,
    version: `${String(p.updated_at ?? p.arrival_date ?? p.version ?? '')}|normalization-2`,
    status: p.status ?? null, destinationId: p.destination?.id ?? null,
    destinationType: p.destination?.type ?? null, arrivalDate: p.arrival_date ?? null,
    currency: moneyCurrency(p.amount_money), amountMinor: minor(p.amount_money), raw: p,
  }];
}
export function normalizePayoutEntry(e, payoutId) {
  if (!e?.id) return [];
  const grossMoney = e.gross_amount_money ?? e.amount_money ?? null;
  const feeMoney = e.fee_amount_money ?? null;
  const netMoney = e.net_amount_money ?? e.amount_money ?? null;
  // Square payout entries have separate gross, fee and net Money fields. The
  // net is the payout balance impact; amount_money remains a legacy fallback.
  return [{
    kind: 'payout_entry', objectId: e.id,
    version: `${String(e.effective_at ?? e.type ?? '')}|normalization-2`,
    payoutId: e.payout_id ?? payoutId ?? null, type: e.type ?? null,
    paymentId: e.payment_id ?? e.type_charge_details?.payment_id ?? e.type_refund_details?.payment_id ?? null,
    refundId: e.refund_id ?? e.type_refund_details?.refund_id ?? null,
    orderId: e.order_id ?? e.type_charge_details?.order_id ?? e.type_refund_details?.order_id ?? null,
    currency: moneyCurrency(netMoney) ?? moneyCurrency(grossMoney) ?? moneyCurrency(feeMoney),
    amountMinor: minor(netMoney), grossAmountMinor: minor(grossMoney),
    feeMinor: minor(feeMoney), feeCurrency: moneyCurrency(feeMoney),
    netAmountMinor: minor(netMoney), raw: e,
  }];
}
export function normalizeGiftCardActivity(activity) {
  if (!activity?.id) return [];
  const type = activity.type ?? null;
  const details = type ? activity[`${type.toLowerCase()}_activity_details`] : null;
  const amountMoney = details?.amount_money ?? null;
  const amountMinor = minor(amountMoney);
  const liabilityChangeMinor = ['ACTIVATE', 'LOAD'].includes(type) ? amountMinor : type === 'REDEEM' && amountMinor !== null ? -amountMinor : null;
  const { gift_card_gan: _sensitiveGan, ...safeRaw } = activity;
  const sourceStatus = activity.status ?? 'COMPLETED';
  return [{ kind: 'gift_card_activity', objectId: activity.id, version: String(activity.updated_at ?? activity.created_at ?? ''), type, status: String(sourceStatus).toLowerCase(), sourceStatus, occurredAt: activity.created_at ?? null, giftCardId: activity.gift_card_id ?? null, orderId: details?.order_id ?? null, lineItemUid: details?.line_item_uid ?? null, paymentId: activity.payment_id ?? null, locationId: activity.location_id ?? null, currency: amountMoney?.currency ?? activity.gift_card_balance_money?.currency ?? null, amountMinor, liabilityChangeMinor, raw: safeRaw }];
}
