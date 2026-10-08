import { createHash } from 'node:crypto';

const STATES = new Set(['IN_STOCK', 'SOLD', 'RETURNED_BY_CUSTOMER', 'RESERVED_FOR_SALE', 'WASTE', 'UNLINKED_RETURN', 'NONE']);

function quantity(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,5})?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed <= 1_000_000_000_000 ? parsed : null;
}

export function normalizeInventoryCount(count) {
  const objectId = typeof count?.catalog_object_id === 'string' ? count.catalog_object_id : '';
  const locationId = typeof count?.location_id === 'string' ? count.location_id : '';
  const state = typeof count?.state === 'string' ? count.state : '';
  const amount = quantity(count?.quantity);
  const calculatedAt = typeof count?.calculated_at === 'string' && Number.isFinite(Date.parse(count.calculated_at))
    ? count.calculated_at : null;
  if (!objectId || !locationId || !STATES.has(state) || amount === null || !calculatedAt) return null;
  const sourceId = `${objectId}:${locationId}:${state}`;
  const sourceHash = createHash('sha256').update(JSON.stringify([objectId, locationId, state, count.quantity, calculatedAt])).digest('hex');
  return {
    catalogObjectId: objectId,
    catalogObjectType: count.catalog_object_type ?? null,
    locationId,
    state,
    quantity: amount,
    calculatedAt,
    sourceId,
    sourceVersion: `${calculatedAt}|${sourceHash}`,
    sourceHash,
  };
}

function chunks(values, size) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

async function requestWithRetry(client, path, options, { retries, sleep, random }) {
  for (let attempt = 0;; attempt += 1) {
    try { return await client.request(path, options); } catch (error) {
      if (!(error?.status === 429 || error?.status >= 500 || error?.status == null) || attempt >= retries) throw error;
      const retryAfterMs = Number(error.retryAfter) * 1000;
      const delay = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs : Math.min(30_000, 500 * 2 ** attempt) * (0.75 + random() * 0.5);
      await sleep(delay);
    }
  }
}

export async function retrieveSquareInventoryCounts({ client, catalogObjectIds, locationIds, persist, maxPages = 10_000,
  retries = 4, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random }) {
  if (!client?.request || typeof persist !== 'function' || !Array.isArray(catalogObjectIds) || !Array.isArray(locationIds)) {
    throw new TypeError('client.request, catalogObjectIds, locationIds, and persist are required');
  }
  const objects = [...new Set(catalogObjectIds.filter(value => typeof value === 'string' && value))];
  const locations = [...new Set(locationIds.filter(value => typeof value === 'string' && value))];
  if (!objects.length || !locations.length) return { count: 0, pages: 0 };
  let count = 0;
  let pages = 0;
  for (const objectBatch of chunks(objects, 1000)) {
    for (const locationBatch of chunks(locations, 1000)) {
      const seenCursors = new Set();
      let cursor = null;
      do {
        if (++pages > maxPages) throw Object.assign(new Error('Square inventory count page limit exceeded'), { permanent: true });
        const response = await requestWithRetry(client, '/v2/inventory/counts/batch-retrieve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ catalog_object_ids: objectBatch, location_ids: locationBatch, limit: 1000, ...(cursor ? { cursor } : {}) }),
        }, { retries, sleep, random });
        if (!Array.isArray(response?.counts)) throw Object.assign(new Error('Square inventory count response is invalid'), { permanent: true });
        const normalized = response.counts.map(normalizeInventoryCount);
        if (normalized.some(item => item === null)) throw Object.assign(new Error('Square returned an invalid inventory count'), { permanent: true });
        if (normalized.length) await persist(normalized);
        count += normalized.length;
        cursor = typeof response.cursor === 'string' && response.cursor ? response.cursor : null;
        if (cursor && seenCursors.has(cursor)) throw Object.assign(new Error('Square repeated an inventory count cursor'), { permanent: true });
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
    }
  }
  return { count, pages };
}
