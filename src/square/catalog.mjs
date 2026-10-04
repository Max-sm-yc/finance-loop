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

const READ_ONLY_CATALOG_FIELDS = ['updated_at', 'is_deleted'];

function writableObject(object) {
  const copy = structuredClone(object);
  for (const field of READ_ONLY_CATALOG_FIELDS) delete copy[field];
  return copy;
}

function responseObjects(response) {
  const roots = [response?.catalog_object, ...(Array.isArray(response?.related_objects) ? response.related_objects : [])];
  const objects = new Map();
  for (const object of roots) {
    if (object?.id) objects.set(object.id, object);
    for (const child of object?.item_data?.variations ?? []) {
      if (child?.id) objects.set(child.id, child);
    }
  }
  return [...objects.values()];
}

function normalizedCatalogFacts(objects) {
  return objects.flatMap(object => normalizeCatalog(object))
    .filter((fact, index, facts) => facts.findIndex(candidate => candidate.objectId === fact.objectId) === index);
}

async function retrieveCatalogObject(client, objectId) {
  const response = await client.request(`/v2/catalog/object/${encodeURIComponent(objectId)}?include_related_objects=true`);
  if (!response?.object?.id || response.object.is_deleted === true) {
    throw Object.assign(new Error('Square catalog item is unavailable'), { code: 'SQUARE_CATALOG_OBJECT_UNAVAILABLE' });
  }
  return response;
}

async function upsertCatalogObject(client, idempotencyKey, object) {
  return client.request('/v2/catalog/object', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idempotency_key: idempotencyKey, object }),
  });
}

function itemObjectWithChildren(response) {
  const item = response.object;
  if (item?.type !== 'ITEM' || !item.item_data) {
    throw Object.assign(new Error('Square catalog item was not found'), { code: 'SQUARE_CATALOG_OBJECT_UNAVAILABLE' });
  }
  const related = new Map((response.related_objects ?? []).filter(object => object?.id).map(object => [object.id, object]));
  const object = writableObject(item);
  object.item_data = { ...object.item_data };
  delete object.item_data.description_plaintext;
  const embeddedVariations = object.item_data.variations ?? [];
  const variations = embeddedVariations.length ? embeddedVariations : [...related.values()].filter(child =>
    child.type === 'ITEM_VARIATION' && child.item_variation_data?.item_id === item.id);
  if (!variations.length) throw Object.assign(new Error('Square item response omitted its variations'), { code: 'SQUARE_CATALOG_RESPONSE_INVALID' });
  object.item_data.variations = variations.map(child => writableObject(related.get(child.id) ?? child));
  return object;
}

/** Create a Square item with one or more fixed- or variable-price variations. */
export async function createSquareCatalogProduct({ client, idempotencyKey, name, description, variations }) {
  if (!client?.request || !idempotencyKey || !Array.isArray(variations) || variations.length < 1 || variations.length > 250) {
    throw new TypeError('Square client, request identity, and valid variations are required');
  }
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  const itemTemporaryId = temporaryId('item', digest);
  const variationIds = variations.map((_, index) => temporaryId(`variation_${index}`, digest));
  const squareVariations = variations.map((variation, index) => ({
    id: variationIds[index], type: 'ITEM_VARIATION',
    item_variation_data: {
      item_id: itemTemporaryId,
      name: variation.name,
      pricing_type: variation.pricingType,
      ...(variation.pricingType === 'FIXED_PRICING'
        ? { price_money: { amount: variation.priceMinor, currency: variation.currency } } : {}),
      ...(variation.sku ? { sku: variation.sku } : {}),
    },
  }));
  const response = await upsertCatalogObject(client, digest.slice(0, 45), {
    id: itemTemporaryId,
    type: 'ITEM',
    present_at_all_locations: true,
    item_data: {
      name,
      ...(description ? { description } : {}),
      variations: squareVariations,
    },
  });
  const mappings = new Map((response.id_mappings ?? []).map(mapping => [mapping.client_object_id, mapping.object_id]));
  const item = response.catalog_object;
  const itemId = mappings.get(itemTemporaryId) ?? item?.id;
  const returnedVariations = responseObjects(response).filter(object => object.type === 'ITEM_VARIATION');
  const variationIdsReturned = new Set(returnedVariations.map(object => object.id));
  if (!itemId || item?.type !== 'ITEM' || item.item_data?.name !== name || variations.some((variation, index) => {
    const id = mappings.get(variationIds[index]);
    const saved = returnedVariations.find(object => object.id === id)?.item_variation_data;
    return !id || !variationIdsReturned.has(id) || saved?.name !== variation.name
      || saved?.pricing_type !== variation.pricingType || (saved?.sku ?? '') !== (variation.sku ?? '')
      || (variation.pricingType === 'FIXED_PRICING'
        && (Number(saved?.price_money?.amount) !== variation.priceMinor || saved?.price_money?.currency !== variation.currency))
      || (variation.pricingType === 'VARIABLE_PRICING' && saved?.price_money != null);
  })) {
    throw Object.assign(new Error('Square did not return the created item and variations'), { code: 'SQUARE_CATALOG_RESPONSE_INVALID' });
  }
  const facts = normalizedCatalogFacts(responseObjects(response));
  if (facts.length < variations.length + 1 || facts.some(fact => !String(fact.version ?? ''))) {
    throw Object.assign(new Error('Square catalog response omitted versioned item facts'), { code: 'SQUARE_CATALOG_RESPONSE_INVALID' });
  }
  return { squareItemId: itemId, variationIds: variations.map((_, index) => mappings.get(variationIds[index])), facts };
}

/** Update the item name and description without replacing its variation IDs. */
export async function updateSquareCatalogItem({ client, idempotencyKey, itemId, name, description }) {
  const current = await retrieveCatalogObject(client, itemId);
  const object = itemObjectWithChildren(current);
  const before = { name: object.item_data.name ?? '',
    description: object.item_data.description_plaintext ?? object.item_data.description ?? '' };
  if (before.name === name && before.description === (description || '')) {
    return { squareItemId: itemId, before, after: { name, description: description || '' }, facts: normalizedCatalogFacts(responseObjects({ catalog_object: current.object, related_objects: current.related_objects })) };
  }
  object.item_data.name = name;
  delete object.item_data.description_plaintext;
  delete object.item_data.description_html;
  if (description) object.item_data.description = description;
  else delete object.item_data.description;
  const response = await upsertCatalogObject(client, idempotencyKey, object);
  const saved = response.catalog_object;
  if (!saved?.id || saved.id !== itemId || saved.item_data?.name !== name) {
    throw Object.assign(new Error('Square did not confirm the item update'), { code: 'SQUARE_CATALOG_RESPONSE_INVALID' });
  }
  return { squareItemId: itemId, before, after: { name, description: description || '' }, facts: normalizedCatalogFacts(responseObjects(response)) };
}

/** Update variation fields while preserving Square's other variation settings. */
export async function updateSquareCatalogVariation({ client, idempotencyKey, itemId, variationId,
  variationName, sku, pricingType, priceMinor, currency }) {
  const current = await retrieveCatalogObject(client, variationId);
  const variation = current.object;
  if (variation.type !== 'ITEM_VARIATION' || variation.item_variation_data?.item_id !== itemId) {
    throw Object.assign(new Error('Square catalog variation does not belong to the item'), { code: 'SQUARE_CATALOG_OBJECT_UNAVAILABLE' });
  }
  const data = structuredClone(variation.item_variation_data ?? {});
  const before = {
    variationName: data.name ?? '', sku: data.sku ?? '', pricingType: data.pricing_type,
    priceMinor: data.price_money?.amount ?? null, currency: data.price_money?.currency ?? null,
  };
  data.name = variationName;
  data.pricing_type = pricingType;
  if (sku) data.sku = sku;
  else delete data.sku;
  if (pricingType === 'FIXED_PRICING') data.price_money = { amount: priceMinor, currency };
  else delete data.price_money;
  if (before.variationName === variationName && before.sku === (sku || '') && before.pricingType === pricingType
      && before.priceMinor === (pricingType === 'FIXED_PRICING' ? priceMinor : null)
      && before.currency === (pricingType === 'FIXED_PRICING' ? currency : null)) {
    return { squareItemId: itemId, squareCatalogObjectId: variationId, before,
      after: { variationName, sku: sku || '', pricingType, priceMinor: pricingType === 'FIXED_PRICING' ? priceMinor : null,
        currency: pricingType === 'FIXED_PRICING' ? currency : null },
      facts: normalizedCatalogFacts(responseObjects(current)) };
  }
  const response = await upsertCatalogObject(client, idempotencyKey, {
    ...writableObject(variation), item_variation_data: data,
  });
  const saved = response.catalog_object;
  const savedData = saved?.item_variation_data;
  if (!saved?.id || saved.id !== variationId || saved.item_variation_data?.name !== variationName
      || savedData?.pricing_type !== pricingType || (savedData?.sku ?? '') !== (sku || '')
      || (pricingType === 'FIXED_PRICING'
        && (Number(savedData?.price_money?.amount) !== priceMinor || savedData?.price_money?.currency !== currency))
      || (pricingType === 'VARIABLE_PRICING' && savedData?.price_money != null)) {
    throw Object.assign(new Error('Square did not confirm the variation update'), { code: 'SQUARE_CATALOG_RESPONSE_INVALID' });
  }
  const itemResponse = await retrieveCatalogObject(client, itemId);
  return {
    squareItemId: itemId, squareCatalogObjectId: variationId, before,
    after: { variationName, sku: sku || '', pricingType,
      priceMinor: pricingType === 'FIXED_PRICING' ? priceMinor : null,
      currency: pricingType === 'FIXED_PRICING' ? currency : null },
    facts: normalizedCatalogFacts([...responseObjects(response), ...responseObjects({
      catalog_object: itemResponse.object, related_objects: itemResponse.related_objects,
    })]),
  };
}

/** Add a variation without changing existing variation IDs or cost definitions. */
export async function addSquareCatalogVariation({ client, idempotencyKey, itemId,
  variationName, sku, pricingType, priceMinor, currency }) {
  const current = await retrieveCatalogObject(client, itemId);
  if (current.object.type !== 'ITEM') throw Object.assign(new Error('Square catalog item was not found'), { code: 'SQUARE_CATALOG_OBJECT_UNAVAILABLE' });
  const object = itemObjectWithChildren(current);
  const existingVariations = object.item_data.variations ?? [];
  if (existingVariations.length >= 250) {
    throw Object.assign(new Error('Square items support up to 250 variations'), { code: 'SQUARE_CATALOG_VARIATION_LIMIT' });
  }
  const matchesRequestedVariation = variation => {
    const data = variation?.item_variation_data ?? {};
    return data.name === variationName && (data.sku ?? '') === (sku ?? '')
      && data.pricing_type === pricingType
      && (data.price_money?.amount ?? null) === (pricingType === 'FIXED_PRICING' ? priceMinor : null)
      && (data.price_money?.currency ?? null) === (pricingType === 'FIXED_PRICING' ? currency : null);
  };
  const existing = existingVariations.find(matchesRequestedVariation);
  const after = { variationName, sku: sku || '', pricingType,
    priceMinor: pricingType === 'FIXED_PRICING' ? priceMinor : null,
    currency: pricingType === 'FIXED_PRICING' ? currency : null };
  if (existing) {
    return { squareItemId: itemId, squareCatalogObjectId: existing.id, after,
      facts: normalizedCatalogFacts(responseObjects({ catalog_object: current.object, related_objects: current.related_objects })) };
  }
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  const temporaryVariationId = temporaryId('variation', digest);
  const data = {
    item_id: itemId, name: variationName, pricing_type: pricingType,
    ...(pricingType === 'FIXED_PRICING' ? { price_money: { amount: priceMinor, currency } } : {}),
    ...(sku ? { sku } : {}),
  };
  object.item_data.variations.push({ id: temporaryVariationId, type: 'ITEM_VARIATION', item_variation_data: data });
  const response = await upsertCatalogObject(client, digest.slice(0, 45), object);
  const variationId = response.id_mappings?.find(mapping => mapping.client_object_id === temporaryVariationId)?.object_id
    ?? responseObjects(response).find(matchesRequestedVariation)?.id;
  if (!variationId || response.catalog_object?.type !== 'ITEM') {
    throw Object.assign(new Error('Square did not confirm the new variation'), { code: 'SQUARE_CATALOG_RESPONSE_INVALID' });
  }
  return {
    squareItemId: itemId, squareCatalogObjectId: variationId,
    after, facts: normalizedCatalogFacts(responseObjects(response)),
  };
}

/** Archive or restore a Square item while retaining its original IDs. */
export async function setSquareCatalogItemArchived({ client, idempotencyKey, itemId, archived }) {
  const current = await retrieveCatalogObject(client, itemId);
  const object = itemObjectWithChildren(current);
  const before = { name: object.item_data.name ?? '', archived: object.item_data.is_archived === true };
  if (before.archived === archived) {
    return { squareItemId: itemId, before, after: { name: before.name, archived },
      facts: normalizedCatalogFacts(responseObjects({ catalog_object: current.object, related_objects: current.related_objects })) };
  }
  object.item_data.is_archived = archived;
  const response = await upsertCatalogObject(client, idempotencyKey, object);
  const saved = response.catalog_object;
  if (!saved?.id || saved.id !== itemId || Boolean(saved.item_data?.is_archived) !== archived) {
    throw Object.assign(new Error('Square did not confirm the archive change'), { code: 'SQUARE_CATALOG_RESPONSE_INVALID' });
  }
  return { squareItemId: itemId, before, after: { name: before.name, archived }, facts: normalizedCatalogFacts(responseObjects(response)) };
}
