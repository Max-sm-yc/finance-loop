import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createHandlers } from '../src/server/index.mjs';

const org = '11111111-1111-4111-8111-111111111111';
const account = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';

function setup({ role = 'operator', proposalFixture = false, fetchImpl } = {}) {
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
    async getIssue() { return proposalFixture ? { id: '44444444-4444-4444-8444-444444444444', type: 'unknown_item', code: 'UNKNOWN_ITEM', details: {}, policyVersion: 'policy-v1', allowedCategories: ['inventory_item'] } : null; },
    async getIssueEvidence() { return proposalFixture ? [{ id: 'source-1', type: 'catalog', catalog_object_id: 'v1' }] : []; },
    async createProposalAtomic(arg) { calls.push(['proposal', arg]); return { id: 'proposal' }; },
    async reserveModelBudget() { return true; }, async recordModelUsage() {},
    async getReplaySnapshot() { return null; }, async saveProjectionRun() { return {}; },
    asUser(token) { calls.push(['asUser', token]); return { async rpc(name, args) { calls.push(['rpc', name, args]); return { data: 'new-id', error: null }; } }; }
  };
  const queue = { async enqueueSquareSync(arg) { calls.push(['sync', arg]); return { id: 'job-1' }; }, async enqueueSquareWebhook(arg) { calls.push(['webhook-job', arg]); } };
  const webhookInbox = { async putIfAbsent(id, record) { calls.push(['inbox', id]); const inserted = !inboxIds.has(id); inboxIds.add(id); return { inserted, record }; } };
  const supabase = { auth: { async getUser(token) { calls.push(['auth', token]); return { data: { user: { id: user } }, error: null }; } } };
  return { handlers: createHandlers({ supabase, db, queue, webhookInbox, fetchImpl, engine: { replayAccounting: () => ({}) }, config: { squareWebhookSignatureKey: 'key', squareNotificationUrl: 'https://example.test/webhook', openRouterApiKey: 'test-key' } }), calls };
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
  const body = { organizationId: org, startAt: '2026-01-01T00:00:00Z', endAt: '2026-02-01T00:00:00Z', locationIds: [] };
  assert.equal((await handlers.sync(post('/api/sync', body, { 'idempotency-key': 'sync:1' }))).status, 403);
  const owner = setup({ role: 'owner' });
  assert.equal((await owner.handlers.sync(post('/api/sync', body, { 'idempotency-key': 'sync:1' }))).status, 201);
  assert.equal(owner.calls.find(x => x[0] === 'sync')[1].idempotencyKey, 'sync:1');
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
