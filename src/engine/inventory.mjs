/** Deterministic inventory quantity projection. No source fact is mutated. */
export const INVENTORY_CALCULATION_VERSION = 'finance-loop-inventory-v1';
const assert = (ok, message) => { if (!ok) throw new TypeError(message); };
const validCurrency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const instant = (value, field) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  assert(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(parsed)
    && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19), `${field} must be a valid ISO UTC timestamp`);
  return parsed;
};
const refs = values => [...new Set(values.filter(Boolean).map(String))].sort();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const add = (a, b, field) => { const value = a + b; assert(Number.isSafeInteger(value), `${field} exceeds safe integer range`); return value; };
function dedupe(records, type, issues) {
  const byId = new Map();
  for (const record of records) {
    assert(record && typeof record === 'object' && typeof record.id === 'string' && record.id.length, `${type} id is required`);
    const key = `${record.id}@${record.version ?? '1'}`, json = JSON.stringify(canonical(record));
    if (!byId.has(key)) byId.set(key, { record, json });
    else if (byId.get(key).json !== json) issues.push({ code: 'SOURCE_CONFLICT', sourceRefs: [record.id] });
  }
  return [...byId.values()].map(x => x.record);
}
const itemKey = line => line.catalogObjectId ?? line.squareCatalogObjectId ?? line.itemId ?? null;

/**
 * Opening movements are physical baseline counts. Purchases, corrections and
 * completed sales from that baseline onward roll forward as integer deltas.
 * Refund records never restore stock without a separate evidenced movement.
 */
export function calculateInventory({ movements = [], lines = [], refunds = [], itemDefinitions = [], from, to, currency } = {}) {
  assert(Array.isArray(movements) && Array.isArray(lines) && Array.isArray(refunds) && Array.isArray(itemDefinitions), 'movements, lines, refunds and itemDefinitions must be arrays');
  assert(typeof from === 'string' && typeof to === 'string', 'from and to are required ISO UTC timestamps');
  const lower = instant(from, 'from'), upper = instant(to, 'to');
  assert(lower < upper, 'to must be after from');
  if (currency !== undefined) assert(validCurrency(currency), 'currency must be an uppercase ISO currency code');
  const issues = [], facts = dedupe(movements, 'movement', issues), sales = dedupe(lines, 'line', issues);
  dedupe(refunds, 'refund', issues);
  const itemIds = new Map();
  for (const definition of itemDefinitions) {
    if (definition?.id && (definition.squareCatalogObjectId ?? definition.catalogObjectId)) {
      const key = definition.squareCatalogObjectId ?? definition.catalogObjectId;
      if (itemIds.has(definition.id) && itemIds.get(definition.id) !== key) issues.push({ code: 'SOURCE_CONFLICT', sourceRefs: [String(definition.id)] });
      itemIds.set(definition.id, key);
    }
  }
  const products = new Map(), currencies = new Set();
  const ensure = (id, name) => {
    if (!id) return null;
    if (!products.has(id)) products.set(id, { itemId: id, itemName: name ?? null, openingQuantity: 0, purchasedQuantity: 0, soldQuantity: 0, adjustmentQuantity: 0, onHandQuantity: 0, sourceRefs: [], _events: [], _openings: [] });
    const p = products.get(id); if (name && (!p.itemName || name.localeCompare(p.itemName) < 0)) p.itemName = name;
    return p;
  };
  for (const definition of itemDefinitions) {
    const id = definition?.squareCatalogObjectId ?? definition?.catalogObjectId ?? definition?.id;
    if (id) ensure(id, definition.name ?? null);
  }
  for (const movement of facts) {
    const at = instant(movement.occurredAt, `${movement.id}.occurredAt`);
    if (at >= upper) continue;
    assert(Number.isSafeInteger(movement.quantityDelta), `${movement.id}.quantityDelta must be an integer`);
    if (movement.kind === 'opening') assert(movement.quantityDelta >= 0, `${movement.id} opening quantity cannot be negative`);
    if (movement.kind === 'purchase') assert(movement.quantityDelta > 0, `${movement.id} purchase quantity must be positive`);
    if (movement.kind === 'adjustment') assert(movement.quantityDelta !== 0, `${movement.id} adjustment quantity cannot be zero`);
    assert(validCurrency(movement.currency), `${movement.id}.currency must be an uppercase ISO currency code`); currencies.add(movement.currency);
    if (!movement.itemId) { issues.push({ code: 'UNKNOWN_ITEM', sourceRefs: [movement.id] }); continue; }
    const resolvedId = movement.catalogObjectId ?? movement.squareCatalogObjectId ?? itemIds.get(movement.itemId) ?? movement.itemId;
    const definition = itemDefinitions.find(x => x?.id === movement.itemId);
    const p = ensure(resolvedId, movement.itemName ?? definition?.name ?? null);
    if (typeof movement.evidenceId !== 'string' || !movement.evidenceId.length) issues.push({ code: 'SOURCE_GAP', sourceRefs: [movement.id] });
    if (movement.kind === 'adjustment' && (typeof movement.reason !== 'string' || !movement.reason.trim())) issues.push({ code: 'SOURCE_GAP', sourceRefs: [movement.id] });
    p.sourceRefs.push(movement.evidenceId ?? movement.id);
    if (movement.kind === 'opening') p._openings.push({ at, quantity: movement.quantityDelta, source: movement.evidenceId ?? movement.id, id: movement.id });
    else if (!['purchase', 'adjustment'].includes(movement.kind)) issues.push({ code: 'SOURCE_GAP', sourceRefs: [movement.id] });
    else p._events.push({ at, kind: movement.kind, quantity: movement.quantityDelta, source: movement.evidenceId ?? movement.id });
  }
  for (const line of sales) {
    if (line.status !== 'completed' || line.itemType === 'GIFT_CARD') continue;
    const at = instant(line.occurredAt, `${line.id}.occurredAt`);
    if (at >= upper) continue;
    assert(validCurrency(line.currency), `${line.id}.currency must be an uppercase ISO currency code`); currencies.add(line.currency);
    const id = itemKey(line);
    if (!id) { if (at >= lower) issues.push({ code: 'UNKNOWN_ITEM', sourceRefs: [line.id] }); continue; }
    assert(Number.isSafeInteger(line.quantity) && line.quantity > 0, `${line.id}.quantity must be a positive integer`);
    const p = ensure(id, line.itemName ?? line.name ?? null);
    p._events.push({ at, kind: 'sale', quantity: -line.quantity, source: line.id });
  }
  if (currency) currencies.add(currency);
  if (currencies.size > 1) issues.push({ code: 'CURRENCY_MISMATCH', sourceRefs: [] });
  for (const p of products.values()) {
    p._openings.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const baseline = p._openings.filter(o => o.at <= upper).at(-1) ?? null;
    if (!baseline) issues.push({ code: 'OPENING_BALANCE_MISSING', sourceRefs: refs(p.sourceRefs) });
    if (p._openings.filter(o => o.at <= upper).length > 1) issues.push({ code: 'SOURCE_CONFLICT', sourceRefs: refs(p._openings.map(o => o.id)) });
    if (baseline && lower < baseline.at) issues.push({ code: 'SOURCE_GAP', sourceRefs: [baseline.source] });
    if (baseline) p.openingQuantity = baseline.quantity;
    for (const event of p._events.sort((a, b) => a.at - b.at || a.source.localeCompare(b.source))) {
      if (baseline && event.at < baseline.at) continue;
      if (event.at < lower) p.openingQuantity = add(p.openingQuantity, event.quantity, `${p.itemId} opening stock`);
      else if (event.kind === 'purchase') p.purchasedQuantity = add(p.purchasedQuantity, event.quantity, `${p.itemId} purchases`);
      else if (event.kind === 'adjustment') p.adjustmentQuantity = add(p.adjustmentQuantity, event.quantity, `${p.itemId} adjustments`);
      else p.soldQuantity = add(p.soldQuantity, -event.quantity, `${p.itemId} sales`);
      p.sourceRefs.push(event.source);
    }
    if (!baseline) issues.push({ code: 'SOURCE_GAP', sourceRefs: refs(p.sourceRefs) });
    p.onHandQuantity = !baseline || lower < baseline.at ? null : p.openingQuantity + p.purchasedQuantity + p.adjustmentQuantity - p.soldQuantity;
    assert(p.onHandQuantity === null || Number.isSafeInteger(p.onHandQuantity), `${p.itemId} on-hand quantity exceeds safe integer range`);
    if (p.onHandQuantity !== null && p.onHandQuantity < 0) issues.push({ code: 'NEGATIVE_STOCK', sourceRefs: refs(p.sourceRefs) });
    p.sourceRefs = refs(p.sourceRefs);
    delete p._events; delete p._openings;
  }
  const fatal = issues.some(i => ['SOURCE_CONFLICT', 'CURRENCY_MISMATCH', 'INVALID_CURRENCY'].includes(i.code));
  if (fatal) for (const item of products.values()) item.onHandQuantity = null;
  return { calculationVersion: INVENTORY_CALCULATION_VERSION, status: fatal ? 'failed' : issues.length ? 'incomplete' : 'complete', currency: currencies.size === 1 ? [...currencies][0] : null, from, to,
    items: [...products.values()].sort((a, b) => a.itemId.localeCompare(b.itemId)), issues: issues.sort((a, b) => a.code.localeCompare(b.code) || (a.sourceRefs?.[0] ?? '').localeCompare(b.sourceRefs?.[0] ?? '')) };
}
