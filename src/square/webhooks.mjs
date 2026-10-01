import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Square signs notification_url + the exact, unparsed request bytes with HMAC-SHA256. */
export function verifyWebhookSignature({ rawBody, signature, signatureKey, notificationUrl }) {
  if (rawBody == null || !signature || !signatureKey || !notificationUrl) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const expected = createHmac('sha256', signatureKey).update(notificationUrl).update(body).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64'); } catch { return false; }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function redactSensitiveWebhookFields(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveWebhookFields);
  if (!value || typeof value !== 'object') return value;
  const sensitive = new Set(['gift_card_gan', 'gan', 'pan', 'card_number', 'cardholder_number', 'cvv', 'cvc']);
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, sensitive.has(key.toLowerCase()) ? '[redacted]' : redactSensitiveWebhookFields(nested)]));
}

/**
 * Inbox storage contract: putIfAbsent(notificationId, record) must be atomic/durable
 * and return { inserted, record }. Supply a database-backed implementation in production.
 */
export async function acceptSquareWebhook({ rawBody, signature, signatureKey, notificationUrl, inbox, receivedAt = new Date().toISOString() }) {
  if (!verifyWebhookSignature({ rawBody, signature, signatureKey, notificationUrl })) {
    const error = new Error('Square webhook signature verification failed'); error.code = 'INVALID_SIGNATURE'; throw error;
  }
  const payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody);
  if (!payload.event_id) throw new TypeError('Square notification is missing event_id');
  if (!inbox || typeof inbox.putIfAbsent !== 'function') throw new TypeError('inbox.putIfAbsent is required');
  const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const record = { notificationId: payload.event_id, eventType: payload.type ?? null, merchantId: payload.merchant_id ?? null, locationId: payload.data?.location_id ?? null, receivedAt, signatureVerified: true, rawBodySha256: createHash('sha256').update(bytes).digest('hex'), payload: redactSensitiveWebhookFields(payload) };
  return inbox.putIfAbsent(record.notificationId, record);
}

/** Test/local adapter only. Production must implement putIfAbsent with a durable unique key. */
export class MemoryWebhookInbox {
  #records = new Map();
  async putIfAbsent(id, record) {
    if (this.#records.has(id)) return { inserted: false, record: this.#records.get(id) };
    this.#records.set(id, structuredClone(record)); return { inserted: true, record: structuredClone(record) };
  }
  values() { return [...this.#records.values()].map(record => structuredClone(record)); }
}
