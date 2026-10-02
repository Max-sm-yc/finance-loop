import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/worker/index.mjs';

function harness({ payload, responses = {}, health = {}, now = new Date('2026-09-30T12:00:00Z'), request } = {}) {
  const events = []; const facts = new Map(); const issues = new Map(); const projectionRuns = new Set();
  let revision = 1;
  const db = {
    async getSquareConnection() { return { accessToken: 'server-only' }; },
    async getWebhookNotification({ notificationId }) { return { notificationId, signatureVerified: true, payload: typeof payload === 'function' ? payload(notificationId) : payload }; },
    async upsertSquareFacts({ facts: batch, organizationId, enforceMonotonicVersion }) {
      assert.equal(enforceMonotonicVersion, true);
      let changed = false;
      for (const f of batch) {
        const key = `${organizationId}:${f.kind}:${f.objectId}`; const current = facts.get(key);
        const ver = Number(f.version ?? 0); const currentVersion = Number(current?.version ?? -1);
        const newer = Number.isFinite(ver) && Number.isFinite(currentVersion)
          ? ver > currentVersion : String(f.version ?? '') > String(current?.version ?? '');
        if (!current || newer) { facts.set(key, f); changed = true; }
      }
      if (changed) revision++;
      events.push(['upsert', batch.map(f => f.objectId), changed]);
      return { changed, revision };
    },
    async recordSourceHealth(data) { events.push(['health', data]); },
    async upsertSourceIssue(data) { issues.set(data.code, data); events.push(['issue', data.code]); },
    async resolveSourceIssue(data) { issues.delete(data.code); events.push(['resolve', data.code]); },
    async resolveSourceIssueRefs(data) { if (issues.get(data.code)?.sourceRefs?.some(id => data.sourceRefs.includes(id))) issues.delete(data.code); events.push(['resolve-refs', data]); },
    async getProjectionSnapshot({ sourceRevision, startAt, endAt }) { events.push(['snapshot', { sourceRevision, startAt, endAt }]); return { sourceRevision, snapshot: { incomePolicy: { tax: 'exclude', tips: 'exclude' }, lines: [], fees: [], accounts: [] } }; },
    async saveProjectionRun(data) { projectionRuns.add(data.idempotencyKey); events.push(['projection', data.sourceRevision]); },
    async saveProjectionRunSystem(data) { projectionRuns.add(data.idempotencyKey); events.push(['projection', data.sourceRevision, data.result]); },
    async syncProjectionIssues(data) { events.push(['projection-issues', data.issues]); },
    async getSyncHealth() { return health; },
    async getIssueForInvestigation() { return null; }, async getIssueEvidenceForWorker() { return []; },
    async claimInvestigation() { return { acquired: false, reason: 'already_attempted' }; },
    async completeInvestigation() {}, async failInvestigation() {}, async createProposalAtomic() { return { id: 'proposal' }; },
    async reserveModelBudgetSystem() { return true; }, async recordModelUsageSystem() {}, async createProposalAtomicSystem() { return { id: 'proposal' }; }
  };
  const queue = {
    async claim() { return null; }, async ack(x) { events.push(['ack', x]); }, async retry(x) { events.push(['retry', x]); }, async deadLetter(x) { events.push(['dead', x]); },
    async enqueueSquareSync(x) { events.push(['enqueue-sync', x]); }
  };
  const tokenVault = { async getDecrypted() { return { accessToken: 'server-only', refreshToken: 'server-refresh' }; } };
  const worker = createWorker({ queue, db, tokenVault, config: { squareApiVersion: 'test', freshnessTargetMs: 60_000, maxJobAttempts: 3 }, makeSquareClient: () => ({ async request(path) { events.push(['fetch', path]); return request ? request(path) : responses[path]; } }), now: () => new Date(now), sleep: async () => {}, random: () => 0 });
  return { worker, db, queue, events, facts, issues, projectionRuns };
}

const org = 'org-1';
const webhook = (id, type, object) => ({ event_id: id, type, data: { object } });

test('duplicate Square webhook jobs fetch authoritative state and produce only one changed fact/projection', async () => {
  const payload = webhook('evt-1', 'payment.updated', { payment: { id: 'p1', amount_money: { amount: 10, currency: 'USD' } } });
  const path = '/v2/payments/p1';
  const { worker, events, facts, projectionRuns } = harness({ payload, responses: { [path]: { payment: { id: 'p1', created_at: '2026-09-30T10:55:00Z', updated_at: '2026-09-30T11:00:00Z', amount_money: { amount: 1000, currency: 'USD' }, processing_fee: [], status: 'COMPLETED' } } } });
  const job = { id: 'j1', type: 'square.webhook', organizationId: org, payload: { notificationId: 'evt-1' } };
  await worker.processJob(job); await worker.processJob(job);
  assert.equal(facts.size, 1);
  assert.equal([...facts.values()][0].amountMinor, 1000);
  assert.equal(events.filter(e => e[0] === 'projection').length, 1);
  assert.equal(projectionRuns.size, 1);
  assert.equal(events.filter(e => e[0] === 'fetch').length, 2);
});

test('completed cash payments normalize with no processing fee instead of raising a source gap', async () => {
  const payload = webhook('evt-cash', 'payment.updated', { payment: { id: 'cash-1' } });
  const { worker, facts, events } = harness({ payload, responses: {
    '/v2/payments/cash-1': { payment: { id: 'cash-1', created_at: '2026-09-30T10:55:00Z', updated_at: '2026-09-30T11:00:00Z', source_type: 'CASH', amount_money: { amount: 100, currency: 'USD' }, status: 'COMPLETED' } }
  } });
  const outcome = await worker.processJob({ id: 'cash-job', type: 'square.webhook', organizationId: org, payload: { notificationId: 'evt-cash' } });
  const fact = [...facts.values()][0];
  assert.equal(fact.version, '2026-09-30T11:00:00Z|normalization-3');
  assert.equal(fact.feeMinor, 0);
  assert.equal(fact.feeStatus, 'not_applicable_cash');
  assert.equal(outcome.changed, true);
  assert.equal(events.some(event => event[0] === 'issue' && event[1] === 'SOURCE_GAP'), false);
});

test('sync uses a linked Square CHARGE payout entry to fill a delayed payment processing fee', async () => {
  const state = harness({ request: async path => {
    if (path.includes('/orders/search')) return { orders: [] };
    if (path.includes('/payments?')) return { payments: [
      {
        id: 'pay-delayed-fee', status: 'COMPLETED', source_type: 'CARD',
        created_at: '2026-09-30T10:00:00Z', updated_at: '2026-09-30T10:00:01Z',
        amount_money: { amount: 1000, currency: 'USD' },
      },
      {
        id: 'external-no-sale', status: 'COMPLETED', source_type: 'EXTERNAL',
        created_at: '2026-09-30T10:01:00Z', updated_at: '2026-09-30T10:01:01Z',
        amount_money: { amount: 0, currency: 'USD' },
        external_details: { type: 'OTHER', source: 'NO_SALE' },
      },
    ] };
    if (path.includes('/refunds?')) return { refunds: [] };
    if (path.includes('/catalog/list')) return { objects: [] };
    if (path.includes('/gift-cards/activities?')) return { gift_card_activities: [] };
    if (path.includes('/payouts?')) return { payouts: [{
      id: 'po-delayed-fee', status: 'PAID', arrival_date: '2026-09-30',
      amount_money: { amount: 970, currency_code: 'USD' },
    }] };
    if (path.includes('/payout-entries?')) return { payout_entries: [{
      id: 'entry-delayed-fee', payout_id: 'po-delayed-fee', type: 'CHARGE',
      effective_at: '2026-09-30T10:00:02Z',
      gross_amount_money: { amount: 1000, currency_code: 'USD' },
      fee_amount_money: { amount: 30, currency_code: 'USD' },
      net_amount_money: { amount: 970, currency_code: 'USD' },
      type_charge_details: { payment_id: 'pay-delayed-fee' },
    }] };
    throw new Error(`Unexpected request ${path}`);
  } });
  const result = await state.worker.processJob({
    id: 'sync-delayed-fee', type: 'square.sync', organizationId: org,
    payload: { startAt: '2026-09-01T00:00:00Z', endAt: '2026-10-01T00:00:00Z', locationIds: ['loc-1'] },
  });
  const payment = state.facts.get(`${org}:payment:pay-delayed-fee`);
  const noSale = state.facts.get(`${org}:payment:external-no-sale`);
  assert.equal(result.freshness, 'fresh');
  assert.equal(payment.feeMinor, 30);
  assert.equal(payment.feeStatus, 'provided_from_payout_entry');
  assert.match(payment.version, /\|payout-fee-1$/);
  assert.equal(noSale.sourceType, 'EXTERNAL');
  assert.equal(noSale.feeMinor, 0);
  assert.equal(noSale.feeStatus, 'not_applicable_no_sale');
  assert.equal(state.events.filter(event => event[0] === 'projection').length, 1);
  assert.equal(state.issues.has('SOURCE_GAP'), false);
});

test('reordered webhook notifications cannot overwrite newer authoritative Square versions', async () => {
  const getPayload = notificationId => notificationId === 'evt-old'
    ? webhook('evt-old', 'order.updated', { order: { id: 'order-1', version: 2 } })
    : webhook('evt-new', 'order.updated', { order: { id: 'order-1', version: 8 } });
  const currentOrder = { order: { id: 'order-1', version: 8, updated_at: '2026-09-30T11:59:00Z', total_money: { amount: 500, currency: 'USD' }, line_items: [] } };
  const { worker, facts } = harness({ payload: getPayload, responses: { '/v2/orders/order-1': currentOrder } });
  await worker.processJob({ id: 'old', type: 'square.webhook', organizationId: org, payload: { notificationId: 'evt-old' } });
  await worker.processJob({ id: 'new', type: 'square.webhook', organizationId: org, payload: { notificationId: 'evt-new' } });
  assert.equal([...facts.values()][0].version, '8');
});

test('unsupported webhook records SOURCE_GAP and schedules bounded catch-up sync', async () => {
  const payload = webhook('evt-catalog-version', 'catalog.version.updated', { catalog_version: { updated_at: '2026-09-30T11:00:00Z' } });
  const { worker, events, issues } = harness({ payload });
  const result = await worker.processJob({ id: 'j2', type: 'square.webhook', organizationId: org, payload: { notificationId: 'evt-catalog-version' } });
  assert.equal(result.outcome, 'gap_backfill_scheduled');
  assert.equal(issues.get('SOURCE_GAP').details.code, 'UNSUPPORTED_WEBHOOK_ACTIVITY');
  assert.equal(events.filter(e => e[0] === 'enqueue-sync').length, 1);
});

test('payout webhook fetches payout entries as authoritative linked facts', async () => {
  const payload = webhook('evt-payout', 'payout.updated', { payout: { id: 'po-1', status: 'PAID' } });
  const responses = {
    '/v2/payouts/po-1': { payout: { id: 'po-1', status: 'PAID', arrival_date: '2026-09-30', amount_money: { amount: 980, currency: 'USD' } } },
    '/v2/payouts/po-1/payout-entries?limit=100': { payout_entries: [{ id: 'entry-1', payment_id: 'pay-1', type: 'CHARGE', amount_money: { amount: 1000, currency: 'USD' } }, { id: 'fee-1', type: 'FEE', amount_money: { amount: -20, currency: 'USD' } }] }
  };
  const { worker, facts } = harness({ payload, responses });
  await worker.processJob({ id: 'payout-job', type: 'square.webhook', organizationId: org, payload: { notificationId: 'evt-payout' } });
  const rows = [...facts.values()];
  assert.ok(rows.some(row => row.kind === 'payout' && row.objectId === 'po-1'));
  assert.ok(rows.some(row => row.kind === 'payout_entry' && row.paymentId === 'pay-1' && row.payoutId === 'po-1'));
  assert.equal(rows.length, 3);
});

test('gift card sale and activity webhook ingestion links liability issuance and redemption without treating issuance as revenue', async () => {
  const giftOrder = { id: 'gift-order', version: 1, total_money: { amount: 3000, currency: 'USD' }, line_items: [
    { uid: 'gift-line', name: 'Gift Card', item_type: 'GIFT_CARD', quantity: '1', gross_sales_money: { amount: 2500, currency: 'USD' }, total_discount_money: { amount: 0, currency: 'USD' }, total_money: { amount: 2500, currency: 'USD' } },
    { uid: 'item-line', name: 'Mug', item_type: 'ITEM', quantity: '1', gross_sales_money: { amount: 500, currency: 'USD' }, total_discount_money: { amount: 0, currency: 'USD' }, total_money: { amount: 500, currency: 'USD' } }
  ] };
  const activities = {
    'act-activate': { id: 'act-activate', type: 'ACTIVATE', created_at: '2026-09-30T10:00:00Z', gift_card_id: 'gift-1', gift_card_gan: 'never-store-this', activate_activity_details: { amount_money: { amount: 2500, currency: 'USD' }, order_id: 'gift-order', line_item_uid: 'gift-line' } },
    'act-redeem': { id: 'act-redeem', type: 'REDEEM', status: 'COMPLETED', created_at: '2026-09-30T11:00:00Z', gift_card_id: 'gift-1', payment_id: 'pay-redemption', redeem_activity_details: { amount_money: { amount: 500, currency: 'USD' } } }
  };
  const payload = notificationId => webhook(notificationId, 'gift_card.activity.created', { gift_card_activity: { id: notificationId, gift_card_id: 'gift-1', created_at: '2026-09-30T11:00:00Z' } });
  const { worker, db, facts, events } = harness({ payload, request: async path => {
    if (path === '/v2/orders/gift-order') return { order: giftOrder };
    if (path.startsWith('/v2/gift-cards/activities?')) {
      // The endpoint is paginated and filters by gift card/time, not activity ID.
      // Return both source activities so the worker can locate the notification ID.
      return { gift_card_activities: Object.values(activities) };
    }
    throw new Error(`Unexpected request ${path}`);
  } });
  db.getWebhookNotification = async ({ notificationId }) => ({ signatureVerified: true, payload: notificationId === 'gift-order-event' ? webhook(notificationId, 'order.updated', { order: { id: 'gift-order' } }) : payload(notificationId) });
  db.getProjectionSnapshot = async ({ sourceRevision }) => {
    const stored = [...facts.values()];
    const lines = stored.filter(f => f.kind === 'order_line').map(f => ({ id: f.objectId, version: f.version, status: 'completed', currency: f.currency, itemType: f.itemType, orderId: f.orderId, lineItemUid: f.lineItemUid, quantity: Number(f.quantity), grossMinor: f.grossMinor, discountMinor: f.discountMinor, refundMinor: 0, taxMinor: 0, tipMinor: 0, unitCostMinor: f.itemType === 'GIFT_CARD' ? null : 200, costCurrency: f.currency }));
    const giftCardActivities = stored.filter(f => f.kind === 'gift_card_activity').map(f => ({ id: f.objectId, version: f.version, status: f.status, type: f.type, currency: f.currency, amountMinor: f.amountMinor, orderId: f.orderId, lineItemUid: f.lineItemUid, paymentId: f.paymentId }));
    return { sourceRevision, snapshot: { incomePolicy: { tax: 'exclude', tips: 'exclude' }, lines, fees: [], giftCardActivities, accounts: [] } };
  };
  await worker.processJob({ id: 'order-job', type: 'square.webhook', organizationId: org, payload: { notificationId: 'gift-order-event' } });
  const gapIssue = events.find(e => e[0] === 'issue' && e[1] === 'SOURCE_GAP');
  assert.ok(gapIssue, 'order line without activation is held as a gap');
  // Fetch ACTIVATE by ID from Square's authoritative list, then the activity is linked by order/line UID.
  await worker.processJob({ id: 'activation-job', type: 'square.webhook', organizationId: org, payload: { notificationId: 'act-activate' } });
  let run = events.filter(e => e[0] === 'projection').at(-1)?.[2];
  assert.equal(run.income.giftCardLiabilityChangeMinor, 2500);
  assert.equal(run.income.netSalesMinor, 500);
  await worker.processJob({ id: 'redemption-job', type: 'square.webhook', organizationId: org, payload: { notificationId: 'act-redeem' } });
  run = events.filter(e => e[0] === 'projection').at(-1)?.[2];
  assert.equal(run.income.giftCardLiabilityChangeMinor, 2000);
  assert.equal(run.income.netSalesMinor, 500);
  assert.equal(JSON.stringify([...facts.values()]).includes('never-store-this'), false);
});

test('missing source gross or discount values create a gap and block deterministic replay', async () => {
  const payload = webhook('evt-incomplete-order', 'order.updated', { order: { id: 'order-incomplete' } });
  const order = { order: { id: 'order-incomplete', version: 3, total_money: { amount: 500, currency: 'USD' }, line_items: [{ uid: 'line-1', quantity: '1', total_money: { amount: 500, currency: 'USD' } }] } };
  const { worker, events, issues } = harness({ payload, responses: { '/v2/orders/order-incomplete': order } });
  const outcome = await worker.processJob({ id: 'incomplete', type: 'square.webhook', organizationId: org, payload: { notificationId: 'evt-incomplete-order' } });
  assert.equal(outcome.outcome, 'normalization_gap');
  assert.equal(issues.get('SOURCE_GAP').details.code, 'NORMALIZATION_MISSING_MONEY_OR_IDENTITY');
  assert.equal(events.some(event => event[0] === 'projection'), false);
});

test('stale sync health raises SOURCE_STALE and fresh health resolves it', async () => {
  const state = harness({ health: { lastSuccessfulSyncAt: '2026-09-30T11:00:00Z', sourceRevision: 4 } });
  const stale = await state.worker.updateFreshnessIssue(org);
  assert.equal(stale.stale, true);
  assert.equal(state.issues.get('SOURCE_STALE').details.lastSuccessfulSyncAt, '2026-09-30T11:00:00Z');
  state.db.getSyncHealth = async () => ({ lastSuccessfulSyncAt: '2026-09-30T11:59:30Z', sourceRevision: 5 });
  const fresh = await state.worker.updateFreshnessIssue(org);
  assert.equal(fresh.stale, false);
  assert.equal(state.issues.has('SOURCE_STALE'), false);
});

test('incomplete backfill persists explicit resource gaps and retries instead of claiming freshness', async () => {
  const state = harness({ request: async path => {
    if (path.includes('/orders/search')) { const error = new Error('permission'); error.status = 403; throw error; }
    if (path.includes('/payments')) return { payments: [] };
    if (path.includes('/refunds')) return { refunds: [] };
    if (path.includes('/catalog/list')) return { objects: [] };
    if (path.includes('/payouts')) return { payouts: [] };
    return {};
  } });
  const job = { id: 'sync-1', type: 'square.sync', organizationId: org, attempts: 1, payload: { startAt: '2026-09-01T00:00:00Z', endAt: '2026-09-30T00:00:00Z' } };
  await assert.rejects(state.worker.processJob(job), /incomplete/);
  assert.equal(state.issues.get('SOURCE_GAP').details.code, 'PERMISSION_LOST');
  assert.equal(state.events.some(e => e[0] === 'health' && e[1].status === 'incomplete'), true);
});

test('durable queue claims are fenced with a lease token for acknowledgement', async () => {
  const state = harness(); const leasedJob = { id: 'lease-job', type: 'projection.replay', organizationId: org, payload: { sourceRevision: 1 }, workerId: 'worker-1', leaseToken: 'lease-abc' };
  state.queue.claim = async args => { assert.equal(args.leaseSeconds, 120); return leasedJob; };
  const result = await state.worker.runOne({ workerId: 'worker-1' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(state.events.find(x => x[0] === 'ack')[1], { jobId: 'lease-job', workerId: 'worker-1', leaseToken: 'lease-abc' });
});

test('projection replay honors a correction job historical window', async () => {
  const { worker, events } = harness();
  const result = await worker.processJob({ id: 'correction-replay', type: 'projection.replay', organizationId: org,
    payload: { sourceRevision: 1, startAt: '2026-07-03T04:00:00Z', endAt: '2026-10-02T04:00:00Z' } });
  assert.equal(result.startAt, '2026-07-03T04:00:00.000Z');
  assert.deepEqual(events.find(event => event[0] === 'snapshot')[1], {
    sourceRevision: 1, startAt: '2026-07-03T04:00:00.000Z', endAt: '2026-10-02T04:00:00.000Z'
  });
});

test('worker fails closed when queue cannot provide a fencing token', async () => {
  const state = harness();
  state.queue.claim = async () => ({ id: 'lease-job', type: 'projection.replay', organizationId: org, payload: { sourceRevision: 1 } });
  await assert.rejects(state.worker.runOne({ workerId: 'worker-1' }), /fencing leaseToken/);
  assert.equal(state.events.some(x => x[0] === 'ack'), false);
});

test('terminal job gap-write failure dead-letters instead of retrying beyond the attempt limit', async () => {
  const state = harness();
  state.queue.claim = async () => ({
    id: 'failed-webhook', type: 'square.webhook', organizationId: org,
    payload: { notificationId: 'missing-event' }, attempts: 3, maxAttempts: 3, leaseToken: 'lease-1',
  });
  state.db.recordSourceHealth = async () => {
    throw Object.assign(new Error('private response details'), { status: 503, code: 'PGRST202' });
  };

  const result = await state.worker.runOne({ workerId: 'worker-1' });
  const dead = state.events.find(event => event[0] === 'dead')?.[1];

  assert.equal(result.status, 'dead_lettered');
  assert.equal(result.code, 'SOURCE_GAP_WRITE_FAILED');
  assert.equal(result.gapWriteStatus, 503);
  assert.equal(result.gapWriteCode, 'PGRST202');
  assert.equal(state.events.some(event => event[0] === 'retry'), false);
  assert.equal(dead.code, 'SOURCE_GAP_WRITE_FAILED');
  assert.match(dead.message, /status=503 code=PGRST202/);
  assert.equal(dead.message.includes('private response details'), false);
});
