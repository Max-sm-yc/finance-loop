const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

export class DomainCommandInputError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function exactObject(value, keys, required) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key))
    && required.every(key => Object.hasOwn(value, key));
}

function text(value, max, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return null;
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function normalizeDraftCatalogItem(value) {
  if (!exactObject(value, ['name', 'description', 'categoryId', 'variations'], ['name', 'variations'])
      || !text(value.name, 200) || (value.description != null && (typeof value.description !== 'string' || value.description.length > 4096))
      || (value.categoryId != null && !UUID.test(value.categoryId))
      || !Array.isArray(value.variations) || value.variations.length < 1 || value.variations.length > 250) {
    throw new DomainCommandInputError('INVALID_DRAFT_CATALOG_ITEM');
  }
  const variations = value.variations.map(variation => {
    if (!exactObject(variation, ['name', 'sku', 'barcode', 'unitOfMeasure', 'priceMinor', 'currency'], ['name'])
        || !text(variation.name, 200)
        || (variation.sku != null && variation.sku !== '' && !text(variation.sku, 100))
        || (variation.barcode != null && variation.barcode !== '' && !text(variation.barcode, 200))
        || (variation.unitOfMeasure != null && !text(variation.unitOfMeasure, 40))
        || (variation.priceMinor != null && (!Number.isSafeInteger(variation.priceMinor) || variation.priceMinor < 0))
        || (variation.currency != null && !/^[A-Z]{3}$/.test(variation.currency))
        || ((variation.priceMinor == null) !== (variation.currency == null))) {
      throw new DomainCommandInputError('INVALID_DRAFT_CATALOG_VARIATION');
    }
    return {
      name: variation.name.trim(),
      sku: typeof variation.sku === 'string' && variation.sku.trim() ? variation.sku.trim() : null,
      barcode: typeof variation.barcode === 'string' && variation.barcode.trim() ? variation.barcode.trim() : null,
      unitOfMeasure: variation.unitOfMeasure == null ? 'each' : variation.unitOfMeasure.trim(),
      priceMinor: variation.priceMinor ?? null,
      currency: variation.currency ?? null,
    };
  });
  return {
    name: value.name.trim(),
    description: value.description?.trim() ?? '',
    categoryId: value.categoryId ?? null,
    variations,
  };
}

export function normalizePurchaseOrder(value) {
  if (!exactObject(value, ['supplierId', 'locationId', 'currency', 'expectedAt', 'lines'], ['currency', 'lines'])
      || (value.supplierId != null && !UUID.test(value.supplierId))
      || (value.locationId != null && !UUID.test(value.locationId))
      || !/^[A-Z]{3}$/.test(value.currency)
      || (value.expectedAt != null && (!ISO_UTC.test(value.expectedAt) || !Number.isFinite(Date.parse(value.expectedAt))))
      || !Array.isArray(value.lines) || value.lines.length < 1 || value.lines.length > 500) {
    throw new DomainCommandInputError('INVALID_PURCHASE_ORDER');
  }
  const lines = value.lines.map(line => {
    if (!exactObject(line, ['variationId', 'description', 'quantity', 'unitCostMinor'], ['description', 'quantity'])
        || (line.variationId != null && !UUID.test(line.variationId))
        || !text(line.description, 500)
        || typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0
        || line.quantity > 999_999_999_999.999999
        || !Number.isSafeInteger(Math.round(line.quantity * 1_000_000))
        || Math.abs(line.quantity * 1_000_000 - Math.round(line.quantity * 1_000_000)) > 1e-7
        || (line.unitCostMinor != null && (!Number.isSafeInteger(line.unitCostMinor) || line.unitCostMinor < 0))) {
      throw new DomainCommandInputError('INVALID_PURCHASE_ORDER_LINE');
    }
    return {
      variationId: line.variationId ?? null,
      description: line.description.trim(),
      quantity: line.quantity,
      unitCostMinor: line.unitCostMinor ?? null,
    };
  });
  return {
    supplierId: value.supplierId ?? null,
    locationId: value.locationId ?? null,
    currency: value.currency,
    expectedAt: value.expectedAt ?? null,
    lines,
  };
}
