import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createHandlers } from '../src/server/index.mjs';

const org = '11111111-1111-4111-8111-111111111111';
const account = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';

function setup({ role = 'operator', proposalFixture = false, proposalType = 'unknown_item', proposalPolicyVersion = 'policy-v1', fetchImpl, budgetAllowed = true, receiptAgentMaxOutputTokens = 900, inventoryFlag = false, analyticsFlag = false, inventoryServerFlag = false, analyticsServerFlag = false, squareLocations = [{ id: 'square-location-1' }], squareCatalog, syncCoverage } = {}) {
  const calls = [];
  const inboxIds = new Set();
  const db = {
    async getMembership(arg) { calls.push(['membership', arg]); return { role }; },
    async getDashboard(arg) { calls.push(['dashboard', arg]); return { income: { status: 'complete' }, freshness: 'fresh' }; },
    async listIssues(arg) { calls.push(['issues', arg]); return []; },
    async listManualMovements(arg) { calls.push(['movements', arg]); return []; },
    async listObservations(arg) { calls.push(['observations', arg]); return []; },
    async listAuditEvents(arg) { calls.push(['audit', arg]); return []; },
    async getSettings(arg) { calls.push(['settings', arg]); return {}; },
    async getOrganizationFeatureFlags(arg) { calls.push(['features', arg]); return { inventoryTracking: inventoryFlag, productAnalytics: analyticsFlag }; },
    async listInventoryMovements(arg) { calls.push(['inventory-list', arg]); return []; },
    async getInventorySnapshot(arg) { calls.push(['inventory-snapshot', arg]); return { from: arg.from, to: arg.to, currency: arg.currency, items: [], movements: [], lines: [] }; },
    async listProductAnalyticsFacts(arg) { calls.push(['analytics-facts', arg]); return { facts: [], sourceHealth: [], policy: {} }; },
    async recordInventoryPurchase(arg) { calls.push(['inventory-purchase', arg]); return { cashMovementId: 'cash-1', inventoryMovementIds: ['stock-1'] }; },
    async recordInventoryCorrection(arg) { calls.push(['inventory-correction', arg]); return { movementId: 'stock-2' }; },
    async hasEvidenceFile(arg) { calls.push(['evidence-exists', arg]); return arg.evidenceFileId === '44444444-4444-4444-8444-444444444444'; },
    async recordReceiptItemCosts(arg) { calls.push(['receipt-costs', arg]); return { updates: [], replayStartAt: '2026-09-01T00:00:00Z', replayEndAt: '2026-10-03T00:00:00Z' }; },
    async recordSquareCatalogItem(arg) { calls.push(['square-catalog-cost', arg]); return { id: 'item-definition-1', version: 1, squareCatalogObjectId: arg.squareCatalogObjectId }; },
    async upsertSquareFacts(arg) { calls.push(['square-facts', arg]); return { changed: true, revision: 1 }; },
    async registerSquareCatalogCreationTicket(arg) { calls.push(['square-ticket', arg]); return true; },
    async getIssue() { return proposalFixture ? { id: '44444444-4444-4444-8444-444444444444', type: proposalType, code: proposalType === 'refund_cogs_review' ? 'REFUND_COGS_REVIEW' : 'UNKNOWN_ITEM', source_refs: proposalType === 'refund_cogs_review' ? ['refund-1','order-1'] : ['order-1:line-1'], details: { message: 'Human decision needed.', period_start: '2026-07-03T04:00:00Z', period_end: '2026-10-02T04:00:00Z' }, policyVersion: proposalPolicyVersion, allowedCategories: proposalType === 'unknown_item' ? ['inventory_item'] : [] } : null; },
    async getIssueEvidence() { return proposalFixture ? [{ id: 'source-1', type: 'sale_line', catalog_object_id: null, quantity: 1.5 }] : []; },
    async recordItemDefinition(arg) { calls.push(['item-definition', arg]); return { id: 'item-definition-1', version: 1 }; },
    async recordSaleLineCostOverride(arg) { calls.push(['sale-line-cost', arg]); return { id: 'line-cost-override-1', orderId: 'order-1', lineUid: 'line-1' }; },
    async recordRefundCostReview(arg) { calls.push(['refund-review', arg]); return { id: 'refund-review-1' }; },
    async createProposalAtomic(arg) { calls.push(['proposal', arg]); return { id: 'proposal' }; },
    async reserveModelBudget() { return budgetAllowed; }, async recordModelUsage() {},
    async reserveReceiptModelBudget(arg) { calls.push(['receipt-budget', arg]); return budgetAllowed; },
    async recordReceiptModelUsage(arg) { calls.push(['receipt-usage', arg]); },
    async listReceiptCatalogCandidates(arg) { calls.push(['receipt-candidates', arg]); return []; },
    async getReplaySnapshot() { return null; }, async saveProjectionRun() { return {}; },
    asUser(token) { calls.push(['asUser', token]); return { async rpc(name, args) { calls.push(['rpc', name, args]); return { data: 'new-id', error: null }; } }; }
  };
  if (syncCoverage !== undefined) db.getSquareSyncCoverage = async args => {
    calls.push(['sync-coverage', args]);
    return typeof syncCoverage === 'function' ? syncCoverage(args) : syncCoverage;
  };
  const queue = { async enqueueSquareSync(arg) { calls.push(['sync', arg]); return { id: 'job-1' }; }, async enqueueSquareWebhook(arg) { calls.push(['webhook-job', arg]); }, async enqueueProjectionReplay(arg) { calls.push(['projection-replay', arg]); return { id: 'replay-1' }; } };
  const webhookInbox = { async putIfAbsent(id, record) { calls.push(['inbox', id]); const inserted = !inboxIds.has(id); inboxIds.add(id); return { inserted, record }; } };
  const supabase = { auth: { async getUser(token) { calls.push(['auth', token]); return { data: { user: { id: user } }, error: null }; } } };
  return { handlers: createHandlers({ supabase, db, queue, webhookInbox, fetchImpl, squareCatalog, engine: { replayAccounting: () => ({}) }, listSquareLocations: async args => { calls.push(['square-locations', args]); return squareLocations; }, config: { squareWebhookSignatureKey: 'key', squareNotificationUrl: 'https://example.test/webhook', openRouterApiKey: 'test-key', receiptAgentMaxOutputTokens, inventoryTrackingEnabled: inventoryServerFlag, productAnalyticsEnabled: analyticsServerFlag } }), calls, db, queue };
}
const auth = { authorization: 'Bearer valid.jwt.token' };
const post = (path, body, headers = {}) => new Request(`https://app.test${path}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const read = async response => response.json();

test('dashboard enforces bearer auth, organization membership, and returns no-store data envelope', async () => {
  const { handlers, calls } = setup();
  const res = await handlers.dashboard(new Request(`https://app.test/api/dashboard?organizationId=${org}&accountId=${account}&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z`, { headers: auth }));
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await read(res)).freshness, 'fresh');
  assert.ok(calls.some(x => x[0] === 'membership' && x[1].userId === user));
  assert.equal((await handlers.dashboard(new Request('https://app.test/api/dashboard'))).status, 401);
});

test('staged inventory and analytics routes stay unavailable and settings hide both capabilities by default', async () => {
  const { handlers, calls } = setup();
  const settings = await handlers.settings(new Request(`https://app.test/api/settings?organizationId=${org}`, { headers: auth }));
  assert.deepEqual((await read(settings)).settings.features, { inventoryTracking: false, productAnalytics: false });
  const inventory = await handlers.inventory(new Request(`https://app.test/api/inventory?organizationId=${org}&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z&currency=USD`, { headers: auth }));
  const analytics = await handlers.analytics(new Request(`https://app.test/api/analytics?organizationId=${org}&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z&currency=USD`, { headers: auth }));
  assert.equal(inventory.status, 404); assert.equal(analytics.status, 404);
  assert.equal(calls.some(x => x[0] === 'features'), false);
  assert.equal(calls.some(x => x[0] === 'inventory-list' || x[0] === 'analytics-facts'), false);
});

test('inventory purchase requires both deployment and organization opt-in and records actual cash outflow atomically', async () => {
  const disabled = setup({ inventoryFlag: true });
  const body = { organizationId: org, accountId: account, amountMinor: -2500, currency: 'USD', occurredAt: '2026-01-05T10:00:00Z', description: 'Supply invoice', evidenceRef: '44444444-4444-4444-8444-444444444444', lines: [{ itemId: '55555555-5555-4555-8555-555555555555', itemName: 'Coffee', quantity: 2, unitCostMinor: 1000 }] };
  assert.equal((await disabled.handlers.inventoryPurchase(post('/api/inventory/purchases', body, { 'idempotency-key': 'inventory:disabled' }))).status, 404);
  const enabled = setup({ role: 'owner', inventoryFlag: true, inventoryServerFlag: true });
  const res = await enabled.handlers.inventoryPurchase(post('/api/inventory/purchases', body, { 'idempotency-key': 'inventory:purchase' }));
  assert.equal(res.status, 201); assert.deepEqual(await read(res), { cashMovementId: 'cash-1', inventoryMovementIds: ['stock-1'] });
  const recorded = enabled.calls.find(x => x[0] === 'inventory-purchase')[1];
  assert.equal(recorded.amountMinor, -2500); assert.equal(recorded.lines[0].quantity, 2); assert.equal(recorded.accessToken, 'valid.jwt.token');
  const invalid = await enabled.handlers.inventoryPurchase(post('/api/inventory/purchases', { ...body, amountMinor: -1000 }, { 'idempotency-key': 'inventory:too-small' }));
  assert.equal(invalid.status, 400);
});

test('inventory correction and analytics routes enforce feature flags, bounds, and correction roles', async () => {
  const operator = setup({ role: 'operator', inventoryFlag: true, analyticsFlag: true, inventoryServerFlag: true, analyticsServerFlag: true });
  const correction = { organizationId: org, itemId: '55555555-5555-4555-8555-555555555555', quantityDelta: -2, occurredAt: '2026-01-05T10:00:00Z', reason: 'Physical count variance', evidenceRef: '44444444-4444-4444-8444-444444444444' };
  assert.equal((await operator.handlers.inventoryCorrection(post('/api/inventory/corrections', correction, { 'idempotency-key': 'inventory:correction' }))).status, 403);
  const reviewer = setup({ role: 'reviewer', inventoryFlag: true, analyticsFlag: true, inventoryServerFlag: true, analyticsServerFlag: true });
  const corrected = await reviewer.handlers.inventoryCorrection(post('/api/inventory/corrections', correction, { 'idempotency-key': 'inventory:correction' }));
  assert.equal(corrected.status, 201); assert.deepEqual((await read(corrected)), { movementId: 'stock-2' });
  const report = await reviewer.handlers.analytics(new Request(`https://app.test/api/analytics?organizationId=${org}&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z&currency=USD`, { headers: auth }));
  assert.equal(report.status, 200); assert.equal((await read(report)).analytics.status, 'incomplete');
  const tooLong = await reviewer.handlers.analytics(new Request(`https://app.test/api/analytics?organizationId=${org}&from=2025-01-01T00:00:00Z&to=2026-02-01T00:00:00Z&currency=USD`, { headers: auth }));
  assert.equal(tooLong.status, 400);
});

test('receipt cost approval hides cost-write errors and logs only a sanitized code', async () => {
  const app = setup({ role: 'reviewer', inventoryFlag: true, inventoryServerFlag: true });
  app.db.recordReceiptItemCosts = async () => { throw Object.assign(new Error('private provider detail'), { code: '42501' }); };
  const approval = { organizationId: org, evidenceRef: '44444444-4444-4444-8444-444444444444', reason: 'Supplier invoice confirms item cost.',
    updates: [{ catalogObjectId: 'variation-1', name: 'Tea', unitCostMinor: 425, currency: 'USD', effectiveFrom: '2026-09-01T00:00:00Z' }] };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const response = await app.handlers.receiptItemCosts(post('/api/inventory/receipt-costs', approval, { 'idempotency-key': 'receipt-test-key' }));
    assert.equal(response.status, 503);
    assert.deepEqual(await read(response), { error: 'RECEIPT_COST_APPROVAL_FAILED', code: 'RECEIPT_COST_APPROVAL_FAILED' });
    assert.equal(errors.length, 1);
    assert.deepEqual(JSON.parse(errors[0]), { event: 'receipt_cost_approval_failed', stage: 'cost_write', code: '42501' });
    assert.equal(errors[0].includes('private provider detail'), false);
  } finally { console.error = originalError; }
});

test('receipt cost approval reports saved costs when projection replay enqueue fails', async () => {
  const app = setup({ role: 'reviewer', inventoryFlag: true, inventoryServerFlag: true });
  app.queue.enqueueProjectionReplay = async arg => { app.calls.push(['projection-replay', arg]); throw Object.assign(new Error('private queue detail'), { code: '08006' }); };
  const approval = { organizationId: org, evidenceRef: '44444444-4444-4444-8444-444444444444', reason: 'Supplier invoice confirms item cost.',
    updates: [{ catalogObjectId: 'variation-1', name: 'Tea', unitCostMinor: 425, currency: 'USD', effectiveFrom: '2026-09-01T00:00:00Z' }] };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const response = await app.handlers.receiptItemCosts(post('/api/inventory/receipt-costs', approval, { 'idempotency-key': 'receipt-test-key' }));
    assert.equal(response.status, 503);
    assert.deepEqual(await read(response), { error: 'RECEIPT_COST_SAVED_REPLAY_PENDING', code: 'RECEIPT_COST_SAVED_REPLAY_PENDING' });
    assert.equal(app.calls.filter(call => call[0] === 'receipt-costs').length, 1);
    assert.deepEqual(JSON.parse(errors[0]), { event: 'receipt_cost_approval_failed', stage: 'projection_replay_queue', code: '08006' });
    assert.equal(errors[0].includes('private queue detail'), false);
  } finally { console.error = originalError; }
});

test('Square item creation is owner-only and records Square identity, evidenced COGS, and a replay', async () => {
  const evidenceRef = '44444444-4444-4444-8444-444444444444';
  const body = {
    organizationId: org, name: 'Canvas Tote', variationName: 'Regular', description: '', sku: 'TOTE-01',
    priceMinor: 1299, unitCostMinor: 525, currency: 'USD', effectiveFrom: '2026-10-01T04:00:00Z',
    evidenceRef, reason: 'Supplier invoice shows unit acquisition cost.',
    projectionStartAt: '2026-09-01T00:00:00Z', projectionEndAt: '2026-10-02T00:00:00Z',
  };
  const squareCalls = [];
  const squareCatalog = { async createItem(args) {
    squareCalls.push(['square-create', args]);
    return { squareItemId: 'square-item-1', squareCatalogObjectId: 'square-variation-1', facts: [] };
  } };
  const reviewer = setup({ role: 'reviewer', inventoryFlag: true, inventoryServerFlag: true, squareCatalog });
  assert.equal((await reviewer.handlers.squareCatalogItem(post('/api/inventory/catalog-items', body, { 'idempotency-key': 'square-item:denied' }))).status, 403);
  assert.equal(squareCalls.length, 0);

  const owner = setup({ role: 'owner', inventoryFlag: true, inventoryServerFlag: true, squareCatalog });
  const response = await owner.handlers.squareCatalogItem(post('/api/inventory/catalog-items', body, { 'idempotency-key': 'square-item:create-1' }));
  assert.equal(response.status, 201);
  assert.equal((await read(response)).projectionQueued, true);
  const createdItem = squareCalls[0][1];
  assert.equal(createdItem.priceMinor, 1299);
  assert.equal(createdItem.currency, 'USD');
  assert.equal(createdItem.accessToken, undefined);
  const savedCost = owner.calls.find(call => call[0] === 'square-catalog-cost')[1];
  assert.equal(savedCost.squareCatalogObjectId, 'square-variation-1');
  assert.equal(savedCost.unitCostMinor, 525);
  assert.equal(savedCost.accessToken, 'valid.jwt.token');
  assert.equal(owner.calls.find(call => call[0] === 'projection-replay')[1].startAt, body.projectionStartAt);
});

test('manual movement validates strict shape/idempotency and calls authenticated transactional RPC', async () => {
  const { handlers, calls } = setup();
  const body = { organizationId: org, accountId: account, kind: 'purchase', amountMinor: -2500, currency: 'USD', occurredAt: '2026-01-05T10:00:00Z', description: 'Stock', evidenceRef: 'file-1' };
  let res = await handlers.manualMovement(post('/api/manual-movements', body, { 'idempotency-key': 'purchase:1' }));
  assert.equal(res.status, 201); assert.equal((await read(res)).id, 'new-id');
  const rpc = calls.find(x => x[0] === 'rpc');
  assert.equal(rpc[1], 'record_cash_movement'); assert.equal(rpc[2].amount_minor, -2500); assert.equal(rpc[2].idempotency_key, 'purchase:1');
  assert.equal(calls.find(x => x[0] === 'asUser')[1], 'valid.jwt.token');
  res = await handlers.manualMovement(post('/api/manual-movements', { ...body, surprise: true }, { 'idempotency-key': 'purchase:2' }));
  assert.equal(res.status, 400);
  assert.deepEqual(await read(res), { error: 'INVALID_MOVEMENT', code: 'INVALID_MOVEMENT' });
  assert.equal((await handlers.manualMovement(post('/api/manual-movements', body))).status, 400);
});

test('read-only member cannot write, and observation uses idempotent observation RPC', async () => {
  const view = setup({ role: 'read_only' });
  const movement = { organizationId: org, accountId: account, kind: 'purchase', amountMinor: -25, currency: 'USD', occurredAt: '2026-01-05T10:00:00Z', description: 'x', evidenceRef: 'f' };
  assert.equal((await view.handlers.manualMovement(post('/api/manual-movements', movement, { 'idempotency-key': 'x' }))).status, 403);
  const { handlers, calls } = setup();
  const observation = { organizationId: org, accountId: account, amountMinor: 5000, currency: 'USD', observedAt: '2026-01-05T10:00:00Z', evidenceRef: 'bank-statement-1' };
  const res = await handlers.observation(post('/api/observations', observation, { 'idempotency-key': 'balance:1' }));
  assert.equal(res.status, 201);
  const rpc = calls.find(x => x[0] === 'rpc');
  assert.equal(rpc[1], 'record_balance_observation'); assert.equal(rpc[2].idempotency_key, 'balance:1');
});

test('proposal decisions pass expected revision and idempotency to the atomic RPC', async () => {
  const { handlers, calls } = setup({ role: 'reviewer' });
  const body = { organizationId: org, issueId: '44444444-4444-4444-8444-444444444444', proposalId: '55555555-5555-4555-8555-555555555555', decision: 'approve', reason: 'Evidence reviewed', expectedRevision: 4 };
  const res = await handlers.decision(post('/api/proposals/decision', body, { 'idempotency-key': 'decision:1' }));
  assert.equal(res.status, 200);
  const rpc = calls.find(x => x[0] === 'rpc');
  assert.equal(rpc[1], 'decide_proposal'); assert.equal(rpc[2].decision, 'approved');
  assert.equal(rpc[2].expected_revision, 4); assert.equal(rpc[2].idempotency_key, 'decision:1');
});

test('Square webhook accepts exact signed bytes once and idempotently re-enqueues duplicate delivery', async () => {
  const { handlers, calls } = setup();
  const raw = Buffer.from('{"event_id":"e1","type":"payment.updated","merchant_id":"m","data":{"id":"p"}}');
  const signature = createHmac('sha256', 'key').update('https://example.test/webhook').update(raw).digest('base64');
  const req = () => new Request('https://app.test/api/square/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature }, body: raw });
  const res = await handlers.webhook(req());
  assert.equal(res.status, 200); assert.equal((await read(res)).accepted, true);
  const duplicate = await handlers.webhook(req());
  assert.equal((await read(duplicate)).duplicate, true);
  assert.equal(calls.filter(x => x[0] === 'webhook-job').length, 2);
});

test('sync is owner-only, bounded, and enqueued with idempotency key', async () => {
  const { handlers, calls } = setup();
  const body = { organizationId: org, startAt: '2026-01-01T00:00:00Z', endAt: '2026-02-01T00:00:00Z' };
  assert.equal((await handlers.sync(post('/api/sync', body, { 'idempotency-key': 'sync:1' }))).status, 403);
  assert.equal(calls.some(x => x[0] === 'square-locations'), false);
  const owner = setup({ role: 'owner' });
  assert.equal((await owner.handlers.sync(post('/api/sync', body, { 'idempotency-key': 'sync:1' }))).status, 201);
  assert.equal(owner.calls.find(x => x[0] === 'sync')[1].idempotencyKey, 'sync:1');
  assert.deepEqual(owner.calls.find(x => x[0] === 'sync')[1].locationIds, ['square-location-1']);
  assert.deepEqual(owner.calls.find(x => x[0] === 'square-locations')[1], { organizationId: org });
  const noLocations = setup({ role: 'owner', squareLocations: [] });
  const unavailable = await noLocations.handlers.sync(post('/api/sync', body, { 'idempotency-key': 'sync:empty' }));
  assert.equal(unavailable.status, 409);
  assert.equal((await read(unavailable)).code, 'SQUARE_NO_ACTIVE_LOCATIONS');
  assert.equal(noLocations.calls.some(x => x[0] === 'sync'), false);
  const tooWide = setup({ role: 'owner' });
  const oversized = await tooWide.handlers.sync(post('/api/sync', { ...body, endAt: '2028-01-01T00:00:00Z' }, { 'idempotency-key': 'sync:wide' }));
  assert.equal(oversized.status, 400);
  assert.equal((await read(oversized)).code, 'SYNC_WINDOW_TOO_LARGE');
  assert.equal(tooWide.calls.some(x => x[0] === 'square-locations'), false);
});

test('sync skips a fully covered period when source health is fresh', async () => {
  const { handlers, calls } = setup({ role: 'owner', syncCoverage: {
    windows: [
      { from: '2026-01-01T00:00:00Z', to: '2026-01-15T00:00:00Z' },
      { from: '2026-01-15T00:00:00Z', to: '2026-02-01T00:00:00Z' },
    ], pendingWindows: [], sourceHealthFresh: true,
    sourceGaps: { missingParentOrderLineCount: 0, missingPayoutEntryHealthCount: 0 },
  } });
  const body = { organizationId: org, startAt: '2026-01-01T00:00:00Z', endAt: '2026-02-01T00:00:00Z' };
  const response = await handlers.sync(post('/api/sync', body, { 'idempotency-key': 'sync:covered' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await read(response), { skipped: true, reason: 'PERIOD_CURRENT', startAt: body.startAt, endAt: body.endAt });
  assert.equal(calls.some(call => call[0] === 'square-locations'), false);
  assert.equal(calls.some(call => call[0] === 'sync'), false);
});

test('sync queues only uncovered gaps when existing coverage and source health are fresh', async () => {
  const { handlers, calls } = setup({ role: 'owner', syncCoverage: {
    windows: [
      { from: '2026-01-01T00:00:00Z', to: '2026-01-10T00:00:00Z' },
      { from: '2026-01-20T00:00:00Z', to: '2026-01-31T00:00:00Z' },
    ], pendingWindows: [], sourceHealthFresh: true,
    sourceGaps: { missingParentOrderLineCount: 0, missingPayoutEntryHealthCount: 0 },
  } });
  const body = { organizationId: org, startAt: '2026-01-01T00:00:00Z', endAt: '2026-02-01T00:00:00Z' };
  const response = await handlers.sync(post('/api/sync', body, { 'idempotency-key': 'sync:gaps' }));
  assert.equal(response.status, 201);
  const queued = calls.filter(call => call[0] === 'sync').map(call => call[1]);
  assert.deepEqual(queued.map(({ startAt, endAt }) => ({ startAt, endAt })), [
    { startAt: '2026-01-10T00:00:00.000Z', endAt: '2026-01-20T00:00:00.000Z' },
    { startAt: '2026-01-31T00:00:00.000Z', endAt: '2026-02-01T00:00:00.000Z' },
  ]);
  assert.ok(queued.every(job => job.idempotencyKey.startsWith('square-sync:')));
  assert.equal(new Set(queued.map(job => job.idempotencyKey)).size, 2);
  assert.deepEqual((await read(response)).jobs.map(({ startAt, endAt }) => ({ startAt, endAt })), [
    { startAt: '2026-01-10T00:00:00.000Z', endAt: '2026-01-20T00:00:00.000Z' },
    { startAt: '2026-01-31T00:00:00.000Z', endAt: '2026-02-01T00:00:00.000Z' },
  ]);
});

test('sync refreshes the complete selected period when source health is stale or incomplete', async () => {
  const body = { organizationId: org, startAt: '2026-01-01T00:00:00Z', endAt: '2026-02-01T00:00:00Z' };
  const stale = setup({ role: 'owner', syncCoverage: {
    windows: [{ from: body.startAt, to: body.endAt }], pendingWindows: [], sourceHealthFresh: false,
    sourceGaps: { missingParentOrderLineCount: 0, missingPayoutEntryHealthCount: 0 },
  } });
  const staleResponse = await stale.handlers.sync(post('/api/sync', body, { 'idempotency-key': 'sync:stale' }));
  assert.equal(staleResponse.status, 201);
  assert.deepEqual(stale.calls.find(call => call[0] === 'sync')[1], {
    organizationId: org, startAt: body.startAt, endAt: body.endAt,
    locationIds: ['square-location-1'], idempotencyKey: 'sync:stale', requestedBy: user,
  });

  const incomplete = setup({ role: 'owner', syncCoverage: {
    windows: [], pendingWindows: [], sourceHealthFresh: true,
    sourceGaps: { missingParentOrderLineCount: 1, missingPayoutEntryHealthCount: 0 },
  } });
  const incompleteResponse = await incomplete.handlers.sync(post('/api/sync', body, { 'idempotency-key': 'sync:gap' }));
  assert.equal(incompleteResponse.status, 201);
  assert.deepEqual(incomplete.calls.find(call => call[0] === 'sync')[1], {
    organizationId: org, startAt: body.startAt, endAt: body.endAt,
    locationIds: ['square-location-1'], idempotencyKey: 'sync:gap', requestedBy: user,
  });
});

test('sync avoids duplicate enqueue when another durable sync already covers the requested period', async () => {
  const { handlers, calls } = setup({ role: 'owner', syncCoverage: {
    windows: [], pendingWindows: [{ from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }],
    sourceHealthFresh: false, sourceGaps: { missingParentOrderLineCount: 0, missingPayoutEntryHealthCount: 0 },
  } });
  const body = { organizationId: org, startAt: '2026-01-01T00:00:00Z', endAt: '2026-02-01T00:00:00Z' };
  const response = await handlers.sync(post('/api/sync', body, { 'idempotency-key': 'sync:pending' }));
  assert.equal(response.status, 200);
  assert.equal((await read(response)).reason, 'SYNC_IN_PROGRESS');
  assert.equal(calls.some(call => call[0] === 'square-locations'), false);
  assert.equal(calls.some(call => call[0] === 'sync'), false);
});

test('sync keeps working with a full-window backfill while the coverage migration is unapplied', async () => {
  const { handlers, calls } = setup({ role: 'owner', syncCoverage: async () => {
    throw Object.assign(new Error('coverage RPC is not installed'), { code: 'PGRST202' });
  } });
  const body = { organizationId: org, startAt: '2026-01-01T00:00:00Z', endAt: '2026-02-01T00:00:00Z' };
  const response = await handlers.sync(post('/api/sync', body, { 'idempotency-key': 'sync:legacy' }));
  assert.equal(response.status, 201);
  assert.deepEqual(calls.find(call => call[0] === 'sync')[1], {
    organizationId: org, startAt: body.startAt, endAt: body.endAt,
    locationIds: ['square-location-1'], idempotencyKey: 'sync:legacy', requestedBy: user,
  });
});

test('issue proposal runs a budgeted model draft, persists only the validated proposal, and never posts a ledger fact', async () => {
  const proposal = { issue_type: 'unknown_item', candidate_source_ids: ['source-1'], proposed_category: 'inventory_item', confidence: 0.7, rationale: 'Exact catalog evidence is present.', missing_evidence: ['Approved unit cost'], question: 'What is the approved unit cost?', policy_version: 'policy-v1' };
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.model, 'openai/gpt-6-luna');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }], usage: { total_tokens: 12 } }), { status: 200 });
  };
  const { handlers, calls } = setup({ proposalFixture: true, fetchImpl });
  const issueId = '44444444-4444-4444-8444-444444444444';
  const res = await handlers.proposal(post('/api/issues/proposals', { organizationId: org, issueId }, { 'idempotency-key': 'proposal:1' }));
  assert.equal(res.status, 201);
  assert.equal((await read(res)).id, 'proposal');
  const persisted = calls.find(x => x[0] === 'proposal')[1];
  assert.deepEqual(persisted.proposal, proposal);
  assert.equal(persisted.decision, 'pending');
  assert.equal(calls.some(x => x[0] === 'rpc'), false);
});

test('receipt draft uses the configured output ceiling and reserves that amount', async () => {
  let requestBody;
  const fetchImpl = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        supplier: null, invoice_date: null,
        lines: [{ description: 'Tea', quantity: '1', unit_price: '1.00', line_amount: '1.00' }]
      }) } }], usage: { total_tokens: 12 }
    }), { status: 200 });
  };
  const { handlers, calls } = setup({ role: 'owner', inventoryFlag: true, inventoryServerFlag: true, receiptAgentMaxOutputTokens: 3000, fetchImpl });
  const response = await handlers.receiptDraft(post('/api/receipt-draft', {
    organizationId: org, currency: 'USD', text: 'Tea\nQty 1\n$1.00'
  }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(requestBody.max_tokens, 3000);
  assert.equal(calls.find(call => call[0] === 'receipt-budget')[1].maxOutputTokens, 3000);
});

test('refund COGS review proposal can ask for a human decision while unsupported issue types are rejected clearly', async () => {
  const proposal = {
    issue_type: 'refund_cogs_review', candidate_source_ids: ['source-1'], proposed_category: null,
    confidence: 0.8, rationale: 'Evidence does not establish whether the returned goods were restocked.',
    missing_evidence: ['Return and restock disposition'],
    question: 'Were the refunded goods returned to inventory, and should COGS be reversed?',
    policy_version: 'policy-v1'
  };
  const fetchImpl = async (_url, init) => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(proposal) } }], usage: { total_tokens: 12 }
  }), { status: 200 });
  const refund = setup({ proposalFixture: true, proposalType: 'refund_cogs_review', fetchImpl });
  const issueId = '44444444-4444-4444-8444-444444444444';
  const response = await refund.handlers.proposal(post('/api/proposals', { organizationId: org, issueId }, { 'idempotency-key': 'refund-proposal:1' }));
  assert.equal(response.status, 201);
  assert.equal((await read(response)).id, 'proposal');
  assert.equal(refund.calls.find(x => x[0] === 'proposal')[1].proposal.issue_type, 'refund_cogs_review');

  const unsupported = setup({ proposalFixture: true, proposalType: 'source_gap' });
  const rejected = await unsupported.handlers.proposal(post('/api/proposals', { organizationId: org, issueId }, { 'idempotency-key': 'unsupported-proposal:1' }));
  assert.equal(rejected.status, 422);
  assert.deepEqual(await read(rejected), { error: 'PROPOSAL_UNAVAILABLE', code: 'PROPOSAL_UNAVAILABLE' });
});

test('proposal input failures return a safe validation detail for diagnosis', async () => {
  const { handlers } = setup({ proposalFixture: true, proposalPolicyVersion: null });
  const issueId = '44444444-4444-4444-8444-444444444444';
  const response = await handlers.proposal(post('/api/proposals', { organizationId: org, issueId }, { 'idempotency-key': 'proposal-invalid-context:1' }));
  assert.equal(response.status, 400);
  assert.deepEqual(await read(response), {
    error: 'INVALID_INPUT', code: 'INVALID_INPUT', detail: 'Invalid issue or policy version'
  });
});

test('proposal budget failures explain the organization budget and per-issue daily reservation', async () => {
  const { handlers } = setup({ proposalFixture: true, budgetAllowed: false });
  const issueId = '44444444-4444-4444-8444-444444444444';
  const response = await handlers.proposal(post('/api/proposals', { organizationId: org, issueId }, { 'idempotency-key': 'proposal-budget-denied:1' }));
  assert.equal(response.status, 503);
  assert.deepEqual(await read(response), {
    error: 'BUDGET_EXCEEDED', code: 'BUDGET_EXCEEDED',
    detail: 'The organization daily token budget is exhausted, or this issue already has a reservation today'
  });
});

test('issue evidence endpoint returns only organization-scoped sale lines', async () => {
  const { handlers } = setup({ proposalFixture: true });
  const issueId = '44444444-4444-4444-8444-444444444444';
  const response = await handlers.issueEvidence(new Request(`https://app.test/api/issues/${issueId}/evidence?organizationId=${org}`, { headers: auth }));
  assert.equal(response.status, 200);
  const data = await read(response);
  assert.equal(data.evidence[0].id, 'source-1');
  assert.equal(data.evidence[0].type, 'sale_line');
});

test('approved item cost is recorded against issue evidence and queues historical recalculation', async () => {
  const { handlers, calls } = setup({ role: 'owner', proposalFixture: true });
  const issueId = '44444444-4444-4444-8444-444444444444';
  const body = { organizationId: org, squareCatalogObjectId: 'variation-1', name: 'Tea', unitCostMinor: 425,
    currency: 'USD', effectiveFrom: '2026-07-03T04:00:00Z', reason: 'Approved from the supplier invoice.' };
  const response = await handlers.itemCost(post(`/api/issues/${issueId}/item-cost`, body, { 'idempotency-key': 'item-cost:1' }));
  assert.equal(response.status, 201);
  assert.deepEqual(await read(response), { id: 'item-definition-1', version: 1, projectionJobId: 'replay-1', projectionQueued: true });
  const correction = calls.find(x => x[0] === 'item-definition')[1];
  assert.equal(correction.squareCatalogObjectId, 'variation-1');
  assert.equal(correction.unitCostMinor, 425);
  assert.deepEqual(calls.find(x => x[0] === 'projection-replay')[1], {
    organizationId: org, startAt: '2026-07-03T04:00:00.000Z', endAt: '2026-10-02T04:00:00.000Z',
    idempotencyKey: `item-cost:${issueId}:item-cost:1`, requestedBy: user
  });
});

test('catalog-less Square lines receive a source-linked one-line cost override and historical replay', async () => {
  const { handlers, calls } = setup({ role: 'reviewer', proposalFixture: true });
  const issueId = '44444444-4444-4444-8444-444444444444';
  const body = { organizationId: org, squareOrderId: 'order-1', squareLineUid: 'line-1', unitCostMinor: 425, currency: 'USD',
    reason: 'Supplier invoice confirms the cost of this line.' };
  const response = await handlers.saleLineCost(post(`/api/issues/${issueId}/line-cost`, body, { 'idempotency-key': 'line-cost:1' }));
  assert.equal(response.status, 201);
  assert.deepEqual(await read(response), { id: 'line-cost-override-1', orderId: 'order-1', lineUid: 'line-1', projectionJobId: 'replay-1', projectionQueued: true });
  const correction = calls.find(x => x[0] === 'sale-line-cost')[1];
  assert.equal(correction.squareOrderId, 'order-1');
  assert.equal(correction.squareLineUid, 'line-1');
  assert.equal(correction.unitCostMinor, 425);
  assert.deepEqual(calls.find(x => x[0] === 'projection-replay')[1], {
    organizationId: org, startAt: '2026-07-03T04:00:00.000Z', endAt: '2026-10-02T04:00:00.000Z',
    idempotencyKey: `line-cost:${issueId}:line-cost:1`, requestedBy: user
  });
});

test('refund COGS review validates disposition and queues historical recalculation', async () => {
  const { handlers, calls } = setup({ role: 'owner', proposalFixture: true, proposalType: 'refund_cogs_review' });
  const issueId = '44444444-4444-4444-8444-444444444444';
  const body = { organizationId: org, squareRefundId: 'refund-1', squareOrderId: 'order-1',
    disposition: 'not_returned_to_inventory', approvedCogsReversalMinor: 0, currency: 'USD',
    reason: 'Merchant confirmed goods were not returned.' };
  const response = await handlers.refundReview(post(`/api/issues/${issueId}/refund-review`, body, { 'idempotency-key': 'refund-review:1' }));
  assert.equal(response.status, 201);
  assert.equal((await read(response)).projectionQueued, true);
  assert.equal(calls.find(x => x[0] === 'refund-review')[1].disposition, 'not_returned_to_inventory');
  const invalid = await handlers.refundReview(post(`/api/issues/${issueId}/refund-review`, {
    ...body, disposition: 'not_returned_to_inventory', approvedCogsReversalMinor: 1
  }, { 'idempotency-key': 'refund-review:2' }));
  assert.equal(invalid.status, 400);
  assert.equal((await read(invalid)).code, 'INVALID_REFUND_REVIEW');
});

test('read endpoints expose issues, audit, and settings in a data envelope', async () => {
  const { handlers } = setup();
  for (const [handler, url, key] of [[handlers.issues, `https://app.test/api/issues?organizationId=${org}`, 'issues'], [handlers.manualMovements, `https://app.test/api/manual-movements?organizationId=${org}`, 'movements'], [handlers.observations, `https://app.test/api/observations?organizationId=${org}`, 'observations'], [handlers.audit, `https://app.test/api/audit?organizationId=${org}`, 'events'], [handlers.settings, `https://app.test/api/settings?organizationId=${org}`, 'settings']]) {
    const res = await handler(new Request(url, { headers: auth })); assert.equal(res.status, 200); assert.ok(key in await read(res));
  }
});

test('oversized request bodies are rejected before JSON parsing', async () => {
  const { handlers } = setup();
  const req = new Request('https://app.test/api/manual-movements', { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'large:1', 'content-length': '40000' }, body: '{}' });
  const res = await handlers.manualMovement(req);
  assert.equal(res.status, 413);
  assert.equal((await read(res)).code, 'BODY_TOO_LARGE');
});
