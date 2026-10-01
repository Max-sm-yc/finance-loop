import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createAuthorizationUrl, exchangeAuthorizationCode, refreshAccessToken, verifyWebhookSignature, acceptSquareWebhook, MemoryWebhookInbox, backfillSquare, normalizeOrder, normalizePayment, normalizeRefund, normalizeCatalog, normalizePayout, normalizePayoutEntry, normalizeGiftCardActivity } from '../src/square/index.mjs';

test('OAuth URL and server-side code/refresh exchange use least-privilege caller scopes', async () => {
  const url = new URL(createAuthorizationUrl({ clientId: 'app', redirectUri: 'https://host/cb', state: 'csrf', scopes: ['ORDERS_READ', 'PAYMENTS_READ'] }));
  assert.equal(url.searchParams.get('state'), 'csrf');
  assert.equal(url.searchParams.get('scope'), 'ORDERS_READ PAYMENTS_READ');
  assert.equal(url.searchParams.get('session'), 'false');
  const sandboxUrl = new URL(createAuthorizationUrl({ clientId: 'sandbox-app', redirectUri: 'https://host/cb', state: 'csrf', scopes: ['ORDERS_READ'], baseUrl: 'https://connect.squareupsandbox.com' }));
  assert.equal(sandboxUrl.searchParams.has('session'), false);
  const calls = [];
  const fetchImpl = async (u, init) => { calls.push([u, JSON.parse(init.body)]); return new Response(JSON.stringify({ access_token: 'secret' }), { status: 200 }); };
  await exchangeAuthorizationCode({ code: 'auth-code', clientId: 'app', clientSecret: 'secret', redirectUri: 'https://host/cb', fetchImpl });
  await refreshAccessToken({ refreshToken: 'refresh', clientId: 'app', clientSecret: 'secret', fetchImpl });
  assert.equal(calls[0][1].grant_type, 'authorization_code');
  assert.equal(calls[1][1].grant_type, 'refresh_token');
  assert.equal(calls[1][1].refresh_token, 'refresh');
});

test('Square OAuth token errors expose only sanitized provider diagnostics', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ message: 'Not Authorized', type: 'service.not_authorized', error_description: 'sensitive details are omitted' }), {
    status: 401,
    headers: { 'square-request-id': 'req-123-safe' }
  });
  await assert.rejects(
    () => exchangeAuthorizationCode({ code: 'one-time-code', clientId: 'app', clientSecret: 'secret', redirectUri: 'https://host/cb', fetchImpl }),
    error => {
      assert.equal(error.status, 401);
      assert.equal(error.code, undefined);
      assert.equal(error.providerType, 'service.not_authorized');
      assert.equal(error.squareRequestId, 'req-123-safe');
      assert.equal(error.message, 'Square request failed (401)');
      assert.equal(error.message.includes('sensitive details'), false);
      return true;
    }
  );
});

test('webhook verifies exact raw body and atomically deduplicates notification IDs', async () => {
  const rawBody = Buffer.from('{"event_id":"evt-1","type":"payment.updated","merchant_id":"m1","data":{"id":"p1"}}');
  const notificationUrl = 'https://example.test/api/square/webhook';
  const signatureKey = 'test-only-key';
  const signature = createHmac('sha256', signatureKey).update(notificationUrl).update(rawBody).digest('base64');
  assert.equal(verifyWebhookSignature({ rawBody, signature, signatureKey, notificationUrl }), true);
  assert.equal(verifyWebhookSignature({ rawBody: Buffer.from(`${rawBody} `), signature, signatureKey, notificationUrl }), false);
  const inbox = new MemoryWebhookInbox();
  const first = await acceptSquareWebhook({ rawBody, signature, signatureKey, notificationUrl, inbox });
  const duplicate = await acceptSquareWebhook({ rawBody, signature, signatureKey, notificationUrl, inbox });
  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(inbox.values().length, 1);
  await assert.rejects(acceptSquareWebhook({ rawBody, signature: 'bad', signatureKey, notificationUrl, inbox }), { code: 'INVALID_SIGNATURE' });
});

test('verified webhook payload redacts gift card account numbers while retaining raw-body digest', async () => {
  const rawBody = Buffer.from('{"event_id":"evt-gift","type":"gift_card.activity.created","data":{"object":{"gift_card_activity":{"id":"act1","gift_card_gan":"sensitive-number"}}}}');
  const notificationUrl = 'https://example.test/api/square/webhook'; const signatureKey = 'test-only-key';
  const signature = createHmac('sha256', signatureKey).update(notificationUrl).update(rawBody).digest('base64');
  const inbox = new MemoryWebhookInbox();
  const result = await acceptSquareWebhook({ rawBody, signature, signatureKey, notificationUrl, inbox });
  assert.equal(result.record.payload.data.object.gift_card_activity.gift_card_gan, '[redacted]');
  assert.equal(result.record.rawBodySha256.length, 64);
});

test('normalizers preserve source facts, identifiers, money, catalog IDs and payout links', () => {
  const order = normalizeOrder({ id: 'o1', version: 2, created_at: '2026-01-01T00:00:00Z', total_money: { amount: 550, currency: 'USD' }, line_items: [{ uid: 'line1', catalog_object_id: 'variation1', name: 'Tea', quantity: '2', base_price_money: { amount: 300, currency: 'USD' }, gross_sales_money: { amount: 600, currency: 'USD' }, total_money: { amount: 550, currency: 'USD' }, applied_discounts: [{ applied_money: { amount: 50 } }] }] });
  assert.equal(order[0].totals.totalMinor, 550);
  assert.equal(order[1].catalogObjectId, 'variation1');
  assert.equal(order[1].grossMinor, 600);
  assert.equal(order[1].grossStatus, 'provided');
  assert.equal(order[1].discountMinor, 50);
  const absentGross = normalizeOrder({ id: 'o2', line_items: [{ uid: 'l2', quantity: '1', base_price_money: { amount: 999, currency: 'USD' }, total_money: { amount: 999, currency: 'USD' } }] })[1];
  assert.equal(absentGross.grossMinor, null);
  assert.equal(absentGross.grossStatus, 'missing_square_gross_sales_money');
  assert.equal(normalizePayment({ id: 'p-null', amount_money: { amount: null, currency: 'USD' } })[0].amountMinor, null);
  assert.equal(normalizeOrder({ id: 'o-no-discounts', line_items: [{ uid: 'l1', quantity: '1', gross_sales_money: { amount: 100, currency: 'USD' } }] })[1].discountMinor, null);
  const giftLine = normalizeOrder({ id: 'gift-order', version: 1, line_items: [{ uid: 'gift-line', item_type: 'GIFT_CARD', quantity: '1', total_money: { amount: 2500, currency: 'USD' } }] })[1];
  assert.equal(giftLine.itemType, 'GIFT_CARD'); assert.equal(giftLine.orderId, 'gift-order'); assert.equal(giftLine.lineItemUid, 'gift-line');
  const activation = normalizeGiftCardActivity({ id: 'activation-1', type: 'ACTIVATE', created_at: '2026-01-01T00:00:00Z', gift_card_gan: 'sensitive-number', gift_card_id: 'gift-1', activate_activity_details: { amount_money: { amount: 2500, currency: 'USD' }, order_id: 'gift-order', line_item_uid: 'gift-line' } })[0];
  assert.equal(activation.status, 'completed'); assert.equal(activation.sourceStatus, 'COMPLETED'); assert.equal(activation.amountMinor, 2500); assert.equal(activation.orderId, 'gift-order');
  assert.equal(JSON.stringify(activation).includes('sensitive-number'), false);
  const redemption = normalizeGiftCardActivity({ id: 'redeem-1', type: 'REDEEM', status: 'COMPLETED', payment_id: 'payment-1', redeem_activity_details: { amount_money: { amount: 500, currency: 'USD' } } })[0];
  assert.equal(redemption.liabilityChangeMinor, -500); assert.equal(redemption.paymentId, 'payment-1');
  assert.equal(normalizePayment({ id: 'p1', order_id: 'o1', amount_money: { amount: 500, currency: 'USD' }, processing_fee: [{ amount_money: { amount: 15, currency: 'USD' } }] })[0].feeMinor, 15);
  const cashPayment = normalizePayment({ id: 'cash-1', source_type: 'CASH', status: 'COMPLETED', created_at: '2026-10-01T13:12:25.076Z', updated_at: '2026-10-01T13:12:25.184Z', amount_money: { amount: 1, currency: 'USD' } })[0];
  assert.equal(cashPayment.version, '2026-10-01T13:12:25.184Z|normalization-2');
  assert.equal(cashPayment.feeMinor, 0);
  assert.equal(cashPayment.feeStatus, 'not_applicable_cash');
  const mixedFee = normalizePayment({ id: 'p-mixed', amount_money: { amount: 500, currency: 'USD' }, processing_fee: [{ amount_money: { amount: 15, currency: 'CAD' } }] })[0];
  assert.equal(mixedFee.feeMinor, null);
  assert.equal(mixedFee.feeStatus, 'processing_fee_currency_mismatch');
  assert.equal(normalizeRefund({ id: 'r1', payment_id: 'p1', amount_money: { amount: 100, currency: 'USD' } })[0].paymentId, 'p1');
  assert.equal(normalizeCatalog({ id: 'v1', type: 'ITEM_VARIATION', item_variation_data: { item_id: 'i1', sku: 'SKU' } })[0].itemId, 'i1');
  assert.equal(normalizePayout({ id: 'po1', amount_money: { amount: 485, currency: 'USD' } })[0].amountMinor, 485);
  assert.equal(normalizePayoutEntry({ id: 'pe1', payment_id: 'p1', amount_money: { amount: 500, currency: 'USD' } }, 'po1')[0].payoutId, 'po1');
});

test('payout normalizers accept Square payout Money fields and preserve gross, fee, net, and payment links', () => {
  const payout = normalizePayout({
    id: 'po-square', version: 3, amount_money: { amount: 810, currency_code: 'USD' },
  })[0];
  assert.equal(payout.currency, 'USD');
  assert.equal(payout.amountMinor, 810);
  assert.equal(payout.version, '3|normalization-2');

  const entry = normalizePayoutEntry({
    id: 'poe-square', payout_id: 'po-square', effective_at: '2026-09-30T12:00:00Z', type: 'CHARGE',
    gross_amount_money: { amount: 1000, currency_code: 'USD' },
    fee_amount_money: { amount: 30, currency_code: 'USD' },
    net_amount_money: { amount: 970, currency_code: 'USD' },
    type_charge_details: { payment_id: 'payment-square' },
  }, 'fallback-payout')[0];
  assert.equal(entry.payoutId, 'po-square');
  assert.equal(entry.paymentId, 'payment-square');
  assert.equal(entry.currency, 'USD');
  assert.equal(entry.amountMinor, 970);
  assert.equal(entry.grossAmountMinor, 1000);
  assert.equal(entry.feeMinor, 30);
  assert.equal(entry.feeCurrency, 'USD');
  assert.equal(entry.netAmountMinor, 970);
  assert.equal(entry.version, '2026-09-30T12:00:00Z|normalization-2');
});

test('backfill paginates, retries transient failures, persists normalized payout entries and records sync freshness', async () => {
  const calls = new Map(); const saved = []; let naps = 0;
  const client = { async request(path, options = {}) {
    calls.set(path, (calls.get(path) ?? 0) + 1);
    const orderCursor = options.body ? JSON.parse(options.body).cursor : null;
    if (path.includes('/orders/search') && !orderCursor && calls.get(`${path}:first`) == null) { calls.set(`${path}:first`, 1); const error = new Error('busy'); error.status = 503; throw error; }
    if (path.includes('/orders/search')) return orderCursor ? { orders: [{ id: 'o2', line_items: [] }] } : { orders: [{ id: 'o1', line_items: [] }], cursor: 'next' };
    if (path.includes('/payments')) return { payments: [{ id: 'p1', amount_money: { amount: 300, currency: 'USD' } }] };
    if (path.includes('/refunds')) return { refunds: [{ id: 'r1', amount_money: { amount: 10, currency: 'USD' } }] };
    if (path.includes('/catalog/list')) return { objects: [{ id: 'c1', type: 'ITEM' }] };
    if (path.includes('/gift-cards/activities')) return { gift_card_activities: [] };
    if (path.includes('/payout-entries')) return { payout_entries: [{ id: 'pe1', payment_id: 'p1', amount_money: { amount: 290, currency: 'USD' } }] };
    if (path.includes('/payouts')) return { payouts: [{ id: 'po1', amount_money: { amount: 290, currency: 'USD' } }] };
    throw new Error(`Unexpected request ${path}`);
  } };
  const result = await backfillSquare({ client, startAt: '2026-01-01T00:00:00Z', endAt: '2026-02-01T00:00:00Z', persist: async facts => saved.push(...facts), sleep: async () => { naps++; }, random: () => 0 });
  assert.equal(naps, 1);
  assert.equal(result.freshness, 'fresh');
  assert.ok(result.lastSuccessfulSyncAt);
  assert.ok(saved.some(x => x.objectId === 'o2'));
  assert.ok(saved.some(x => x.kind === 'payout_entry' && x.paymentId === 'p1'));
  assert.ok(Object.values(result.resources).every(x => x.status === 'fresh'));
});

test('backfill exposes a durable gap marker and withholds last-success marker after exhausted pagination', async () => {
  const client = { async request(path) { if (path.includes('/orders/search')) { const e = new Error('no permission'); e.status = 403; e.code = 'INSUFFICIENT_SCOPES'; throw e; } return {}; } };
  const result = await backfillSquare({ client, startAt: '2026-01-01T00:00:00Z', endAt: '2026-02-01T00:00:00Z', persist: async () => {} });
  assert.equal(result.freshness, 'incomplete');
  assert.equal(result.lastSuccessfulSyncAt, null);
  assert.equal(result.gaps[0].code, 'PERMISSION_LOST');
  assert.equal(result.gaps[0].providerStatus, 403);
  assert.equal(result.gaps[0].providerCode, 'INSUFFICIENT_SCOPES');
  assert.equal(result.resources.orders.status, 'incomplete');
});
