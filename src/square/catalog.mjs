import { createHash } from 'node:crypto';
import { normalizeCatalog } from './sync.mjs';

const temporaryId = (kind, digest) => `#finance_${kind}_${digest.slice(0, 24)}`;

/** Create one fixed-price Square item and its required sale variation. */
export async function createSquareCatalogItem({ client, organizationId, idempotencyKey, name, variationName,
  description, sku, priceMinor, currency }) {
  if (!client?.request || !organizationId || !idempotencyKey) throw new TypeError('Square client and request identity are required');
  const digest = createHash('sha256').update(`${organizationId}:${idempotencyKey}`).digest('hex');
  const itemTemporaryId = temporaryId('item', digest);
  const variationTemporaryId = temporaryId('variation', digest);
  const variation = {
    id: variationTemporaryId,
    type: 'ITEM_VARIATION',
    item_variation_data: {
      item_id: itemTemporaryId,
      name: variationName,
      pricing_type: 'FIXED_PRICING',
      price_money: { amount: priceMinor, currency },
      ...(sku ? { sku } : {}),
    },
  };
  const response = await client.request('/v2/catalog/object', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // Square limits idempotency keys to 45 characters. The 180-bit prefix
      // remains collision resistant while staying within that provider limit.
      idempotency_key: digest.slice(0, 45),
      object: {
        id: itemTemporaryId,
        type: 'ITEM',
        present_at_all_locations: true,
        item_data: {
          name,
          ...(description ? { description } : {}),
          variations: [variation],
        },
      },
    }),
  });

  const idMappings = new Map((response.id_mappings ?? []).map(mapping => [mapping.client_object_id, mapping.object_id]));
  const resolveId = id => idMappings.get(id) ?? id;
  let itemObject = response.catalog_object;
  const relatedObjects = Array.isArray(response.related_objects) ? response.related_objects : [];
  let variationObject = itemObject?.item_data?.variations?.find(object => object.type === 'ITEM_VARIATION')
    ?? relatedObjects.find(object => object.type === 'ITEM_VARIATION');
  const itemId = resolveId(itemObject?.id ?? itemTemporaryId);

  if (!variationObject) {
    const fetched = await client.request(`/v2/catalog/object/${encodeURIComponent(itemId)}?include_related_objects=true`);
    itemObject = fetched.object ?? itemObject;
    const fetchedRelated = Array.isArray(fetched.related_objects) ? fetched.related_objects : [];
    variationObject = itemObject?.item_data?.variations?.find(object => object.type === 'ITEM_VARIATION')
      ?? fetchedRelated.find(object => object.type === 'ITEM_VARIATION');
    relatedObjects.push(...fetchedRelated);
  }

  if (!itemObject?.id || itemObject.type !== 'ITEM' || !variationObject?.id || variationObject.type !== 'ITEM_VARIATION') {
    throw Object.assign(new Error('Square did not return the created item and variation'), { code: 'SQUARE_CATALOG_RESPONSE_INVALID' });
  }
  const catalogItemId = resolveId(itemObject.id);
  const catalogVariationId = resolveId(variationObject.id);
  const actualPriceMinor = Number(variationObject.item_variation_data?.price_money?.amount);
  const actualCurrency = variationObject.item_variation_data?.price_money?.currency;
  if (itemObject.item_data?.name !== name
      || variationObject.item_variation_data?.name !== variationName
      || resolveId(variationObject.item_variation_data?.item_id) !== catalogItemId
      || !Number.isSafeInteger(actualPriceMinor) || actualPriceMinor !== priceMinor || actualCurrency !== currency
      || (variationObject.item_variation_data?.sku ?? '') !== (sku ?? '')) {
    throw Object.assign(new Error('Square catalog response did not match the requested item'), { code: 'SQUARE_CATALOG_RESPONSE_INVALID' });
  }
  const itemData = { ...itemObject, id: catalogItemId };
  const variationData = {
    ...variationObject,
    id: catalogVariationId,
    item_variation_data: {
      ...variationObject.item_variation_data,
      item_id: resolveId(variationObject.item_variation_data?.item_id ?? itemTemporaryId),
    },
  };
  const facts = [itemData, variationData, ...relatedObjects]
    .filter((object, index, rows) => object?.id && rows.findIndex(candidate => candidate.id === object.id) === index)
    .flatMap(object => normalizeCatalog(object));
  if (facts.length < 2 || facts.some(fact => !String(fact.version ?? ''))) {
    throw Object.assign(new Error('Square catalog response omitted versioned item facts'), { code: 'SQUARE_CATALOG_RESPONSE_INVALID' });
  }

  return {
    squareItemId: catalogItemId,
    squareCatalogObjectId: catalogVariationId,
    priceMinor: actualPriceMinor,
    currency: actualCurrency,
    facts,
  };
}
