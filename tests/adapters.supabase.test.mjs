import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseAdapters } from '../src/adapters/supabase.mjs';

const org = '11111111-1111-4111-8111-111111111111';
const userJwt = 'signed.user.jwt';
const serviceKey = 'server-only-secret';

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

test('Auth and RLS reads use publishable key plus caller JWT, with tenant filters', async () => {
  const seen = [];
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test/', publishableKey: 'publishable', secretKey: serviceKey,
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init.headers) });
      if (String(url).includes('/auth/v1/user')) return response({ id: 'user-1' });
      if (String(url).includes('/rest/v1/memberships')) return response([{ role: 'operator' }]);
      throw new Error(`Unexpected request ${url}`);
    }
  });

  const auth = await adapters.supabase.auth.getUser(userJwt);
  assert.equal(auth.data.user.id, 'user-1');
  const membership = await adapters.db.getMembership({ organizationId: org, userId: 'user-1', accessToken: userJwt });
  assert.equal(membership.role, 'operator');
  assert.equal(seen[0].headers.get('apikey'), 'publishable');
  assert.equal(seen[0].headers.get('authorization'), `Bearer ${userJwt}`);
  assert.equal(seen[1].headers.get('apikey'), 'publishable');
  assert.equal(seen[1].headers.get('authorization'), `Bearer ${userJwt}`);
  assert.match(seen[1].url, /organization_id=eq\.[^&]+/);
  assert.match(seen[1].url, /user_id=eq\.user-1/);
  assert.ok(seen.every(call => !call.headers.get('authorization').includes(serviceKey)));
});

test('RPC uses the caller JWT and SQL p_ argument names; no service key is exposed on adapters', async () => {
  let call;
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable', secretKey: serviceKey,
    fetchImpl: async (url, init) => {
      call = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
      return response('movement-id');
    }
  });
  const result = await adapters.db.asUser(userJwt).rpc('record_cash_movement', { organization_id: org, amount_minor: -12 });
  assert.deepEqual(result, { data: 'movement-id', error: null });
  assert.equal(call.headers.get('apikey'), 'publishable');
  assert.equal(call.headers.get('authorization'), `Bearer ${userJwt}`);
  assert.deepEqual(call.body, { p_organization_id: org, p_amount_minor: -12 });
  assert.equal(JSON.stringify(adapters).includes(serviceKey), false);
  assert.equal('serviceKey' in adapters, false);
});

test('only durable queue and inbox RPCs use the server key, and lack of key fails closed', async () => {
  const seen = [];
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable', secretKey: serviceKey,
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return response({ id: 'job-id' });
    }
  });
  await adapters.queue.enqueueSquareSync({ organizationId: org, startAt: '2026-01-01T00:00:00Z', endAt: '2026-02-01T00:00:00Z', locationIds: [], idempotencyKey: 'sync:one', requestedBy: 'owner-id' });
  await adapters.queue.enqueueSquareWebhook({ notificationId: 'square-event-1' });
  await adapters.webhookInbox.putIfAbsent('square-event-1', { notificationId: 'square-event-1', signatureVerified: true, rawBodySha256: 'a'.repeat(64), receivedAt: '2026-01-01T00:00:00Z', payload: {} });
  assert.equal(seen.length, 3);
  assert.ok(seen.every(call => call.headers.get('apikey') === serviceKey && call.headers.get('authorization') === `Bearer ${serviceKey}`));
  assert.deepEqual(seen.map(call => call.url.split('/').at(-1)), ['enqueue_square_sync', 'enqueue_square_webhook', 'persist_square_webhook']);

  const noSecret = createSupabaseAdapters({ url: 'https://tenant.supabase.test', publishableKey: 'publishable', fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(noSecret.queue.enqueueSquareWebhook({ notificationId: 'x' }), /Privileged Supabase operation is unavailable/);
});

test('worker lease renewal is fenced by the queue lease token', async () => {
  let call;
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', secretKey: 'sb_secret_worker',
    fetchImpl: async (url, init) => {
      call = { url: String(url), body: JSON.parse(init.body) };
      return response(true);
    },
  });
  const extended = await adapters.queue.extendLease({ jobId: 'job-1', workerId: 'worker-1', leaseToken: 'lease-1', leaseSeconds: 120 });
  assert.equal(extended, true);
  assert.match(call.url, /rpc\/extend_durable_job_lease$/);
  assert.deepEqual(call.body, { p_job_id: 'job-1', p_worker_id: 'worker-1', p_lease_token: 'lease-1', p_lease_seconds: 120 });
});

test('Supabase sb_secret keys are sent as apikey values, not Bearer tokens', async () => {
  const secretKey = 'sb_secret_test';
  const seen = [];
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable', secretKey,
    fetchImpl: async (_url, init) => {
      seen.push(new Headers(init.headers));
      return response({ id: 'job-id' });
    }
  });
  await adapters.queue.enqueueSquareWebhook({ notificationId: 'square-event-1' });
  assert.equal(seen[0].get('apikey'), secretKey);
  assert.equal(seen[0].get('authorization'), null);
});

test('worker fact upserts use the service key, preserve version ordering, and omit Square raw payloads', async () => {
  let call;
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', secretKey: 'sb_secret_worker',
    fetchImpl: async (url, init) => {
      call = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
      return response({ changed: true, revision: 7 });
    }
  });
  const result = await adapters.db.upsertSquareFacts({
    organizationId: org, cause: 'sync:job-1', enforceMonotonicVersion: true,
    facts: [
      { kind: 'payment', objectId: 'payment-1', version: '2026-09-30T12:00:00Z', status: 'COMPLETED', amountMinor: 100, raw: { card_details: { card: { last_4: '1234' } } } },
      { kind: 'payment', objectId: 'cash-1', version: '2026-09-30T12:00:00Z|normalization-2', status: 'COMPLETED', amountMinor: 100, feeMinor: 0, feeStatus: 'not_applicable_cash' },
    ],
  });
  assert.deepEqual(result, { changed: true, revision: 7 });
  assert.match(call.url, /rpc\/upsert_square_facts$/);
  assert.equal(call.headers.get('apikey'), 'sb_secret_worker');
  assert.equal(call.headers.get('authorization'), null);
  const fact = call.body.p_facts[0];
  assert.equal(fact.kind, 'payment');
  assert.match(fact.versionSort, /^t:\d{16}$/);
  assert.deepEqual(fact.fact, { kind: 'payment', objectId: 'payment-1', version: '2026-09-30T12:00:00Z', status: 'COMPLETED', amountMinor: 100 });
  const cashCorrection = call.body.p_facts.find(row => row.objectId === 'cash-1');
  assert.match(cashCorrection.versionSort, /^t:\d{16}\|normalization-2$/);
  assert.ok(cashCorrection.versionSort > fact.versionSort, 'normalization correction sorts after its original Square version');
});

test('worker fact upserts split large Square pages below the database RPC limit', async () => {
  const batches = [];
  let revision = 0;
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', secretKey: 'sb_secret_worker',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      batches.push(body.p_facts);
      revision += 1;
      return response({ changed: true, revision });
    }
  });
  const facts = Array.from({ length: 1001 }, (_, index) => ({
    kind: 'payment', objectId: `payment-${index}`, version: '2026-09-30T12:00:00Z', amountMinor: 100,
  }));
  const result = await adapters.db.upsertSquareFacts({ organizationId: org, cause: 'sync:large-page', facts });
  assert.deepEqual(batches.map(batch => batch.length), [500, 500, 1]);
  assert.deepEqual(result, { changed: true, revision: 3 });
});

test('worker projection snapshot maps Square income, refunds, approved costs, and configured reconciliations', async () => {
  const startAt = '2026-09-01T00:00:00.000Z'; const endAt = '2026-10-01T00:00:00.000Z';
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', secretKey: 'sb_secret_worker',
    fetchImpl: async url => {
      assert.match(String(url), /rpc\/get_square_projection_snapshot$/);
      return response({ sourceRevision: 9, periodStart: startAt, periodEnd: endAt,
        policy: { tax_treatment: 'exclude', currency: 'USD', reconciliation_tolerance_minor: 50 },
        facts: [
          { kind: 'order', objectId: 'order-1', version: '1', status: 'COMPLETED', occurredAt: '2026-09-15T12:00:00Z' },
          { kind: 'order_line', objectId: 'order-1:line-1', version: '1', orderId: 'order-1', lineItemUid: 'line-1', occurredAt: '2026-09-15T12:00:00Z', itemType: 'ITEM', currency: 'USD', quantity: '2', grossMinor: 2000, discountMinor: 100, taxMinor: 0, tipMinor: 0, catalogObjectId: 'variation-1' },
          { kind: 'payment', objectId: 'payment-1', version: '1', status: 'COMPLETED', currency: 'USD', feeMinor: 60, occurredAt: '2026-09-15T12:00:00Z' },
          { kind: 'refund', objectId: 'refund-1', version: '1', status: 'COMPLETED', currency: 'USD', amountMinor: 250, occurredAt: '2026-09-20T12:00:00Z' },
        ],
        itemDefinitions: [{ square_catalog_object_id: 'variation-1', unit_cost_minor: '400', currency: 'USD', effective_from: '2026-01-01T00:00:00Z', effective_until: null }],
        accounts: [{ id: 'bank-1', currency: 'USD', opening_balance_minor: 10000, opening_balance_at: '2026-09-01T00:00:00Z' }],
        observations: [{ id: 'obs-1', account_id: 'bank-1', amount_minor: 12000, currency: 'USD', observed_at: '2026-09-30T00:00:00Z' }],
        movements: [{ id: 'movement-1', account_id: 'bank-1', kind: 'other_inflow', amount_minor: 1000, currency: 'USD', occurred_at: '2026-09-10T00:00:00Z', approval_status: 'approved', idempotency_key: 'inflow:1' }],
      });
    }
  });
  const { sourceRevision, snapshot } = await adapters.db.getProjectionSnapshot({ organizationId: org, sourceRevision: 9, startAt, endAt });
  assert.equal(sourceRevision, 9);
  assert.equal(snapshot.lines[0].status, 'completed');
  assert.equal(snapshot.lines[0].unitCostMinor, 400);
  assert.equal(snapshot.fees[0].amountMinor, 60);
  assert.equal(snapshot.refunds[0].amountMinor, 250);
  assert.equal(snapshot.accounts[0].toleranceMinor, 50);
  assert.equal(snapshot.reconciliations['bank-1'].movements[0].status, 'posted');
});

test('dashboard returns actual projection or explicit unavailable values and tenant-scoped accounts', async () => {
  const calls = [];
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init.headers) });
      if (String(url).includes('/organizations?')) return response([{ id: org, name: 'Merchant', base_currency: 'USD', timezone: 'America/New_York' }]);
      if (String(url).includes('/accounts?')) return response([{ id: 'account-1', currency: 'USD' }]);
      if (String(url).includes('/organization_accounting_policies?')) return response([{ currency: 'USD', reconciliation_tolerance_minor: 0 }]);
      if (String(url).includes('/projection_runs?')) return response([]);
      throw new Error(`Unexpected request ${url}`);
    }
  });
  const dashboard = await adapters.db.getDashboard({ organizationId: org, from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z', accessToken: userJwt });
  assert.equal(dashboard.organization.id, org);
  assert.equal(dashboard.period.from, '2026-01-01T00:00:00Z');
  assert.equal(dashboard.projectionVersion, null);
  assert.equal(dashboard.income, null);
  assert.equal(dashboard.cash, null);
  assert.equal(dashboard.accounts.length, 1);
  assert.ok(dashboard.flags.some(flag => flag.code === 'PROJECTION_UNAVAILABLE'));
  assert.ok(calls.every(call => {
    const url = new URL(call.url);
    return url.searchParams.get(url.pathname.endsWith('/organizations') ? 'id' : 'organization_id') === `eq.${org}`;
  }));
  assert.ok(calls.every(call => call.headers.get('authorization') === `Bearer ${userJwt}`));
});

test('issue evidence uses stable unique sale-line ids and organization-scoped Square/order lookups', async () => {
  const calls = [];
  const issueId = '44444444-4444-4444-8444-444444444444';
  const sourceId = '55555555-5555-4555-8555-555555555555';
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable',
    fetchImpl: async url => {
      calls.push(String(url));
      if (String(url).includes('/issues?')) return response([{ id: issueId, code: 'UNKNOWN_ITEM', details: {}, source_refs: [sourceId, 'order:456', 'another-order'] }]);
      if (String(url).includes('/sale_lines?')) return response([
        { id: 'line-1', source_event_id: sourceId, square_order_id: 'order:456', item_name: 'A', sold_at: '2026-01-01T00:00:00Z' },
        { id: 'line-2', source_event_id: sourceId, square_order_id: 'order:456', item_name: 'B', sold_at: '2026-01-01T00:00:00Z' }
      ]);
      throw new Error(`Unexpected request ${url}`);
    }
  });
  const records = await adapters.db.getIssueEvidence({ organizationId: org, issueId, accessToken: userJwt });
  assert.deepEqual(records.map(record => record.id), ['line-1', 'line-2']);
  const query = new URL(calls.find(url => url.includes('/sale_lines?')));
  assert.equal(query.searchParams.get('organization_id'), `eq.${org}`);
  assert.match(query.searchParams.get('or'), /source_event_id\.in\./);
  assert.match(query.searchParams.get('or'), /square_order_id\.in\./);
  assert.match(query.searchParams.get('or'), /and\(square_order_id\.eq\.order,square_line_uid\.eq\.456\)/);
});

test('projection issues use their calculation version for proposal context and support refund review drafts', async () => {
  const issueId = '44444444-4444-4444-8444-444444444444';
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable',
    fetchImpl: async url => {
      if (String(url).includes('/issues?')) return response([{
        id: issueId,
        code: 'REFUND_COGS_REVIEW',
        details: { origin: 'projection', calculation_version: 'finance-loop-accounting-v1', message: 'Confirm returned inventory.' },
        source_refs: ['refund-1', 'order-1'],
      }]);
      throw new Error(`Unexpected request ${url}`);
    }
  });
  const issue = await adapters.db.getIssue({ organizationId: org, issueId, accessToken: userJwt });
  assert.equal(issue.type, 'refund_cogs_review');
  assert.equal(issue.policyVersion, 'finance-loop-accounting-v1');
  assert.deepEqual(issue.allowedCategories, []);
});

test('issue list carries pending review id/revision and only the bounded proposal summary', async () => {
  let requestUrl;
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable',
    fetchImpl: async url => {
      requestUrl = String(url);
      return response([{ id: 'issue-1', organization_id: org, code: 'UNKNOWN_ITEM', state: 'awaiting_human', details: { message: 'Unknown cost', secretDebug: 'omit' }, proposals: [{ id: 'proposal-1', issue_id: 'issue-1', decision: 'pending', revision: 7, created_at: '2026-01-01T00:00:00Z', model_id: 'internal-model', prompt_version: 'internal-prompt', payload: { rationale: 'Source does not include approved cost.', proposed_category: 'inventory_item', confidence: 0.7, candidate_source_ids: ['line-1'], missing_evidence: ['unit cost'], question: 'What was the cost?', secret: 'omit' } }] }]);
    }
  });
  const [issue] = await adapters.db.listIssues({ organizationId: org, accessToken: userJwt });
  assert.equal(issue.proposals[0].id, 'proposal-1');
  assert.equal(issue.proposals[0].revision, 7);
  assert.equal(issue.proposals[0].decision, 'pending');
  assert.equal(issue.proposals[0].payload.rationale, 'Source does not include approved cost.');
  assert.equal(issue.proposals[0].payload.secret, undefined);
  assert.equal(issue.proposals[0].modelId, undefined);
  assert.equal(issue.proposal_supported, true);
  assert.equal(issue.details.secretDebug, undefined);
  const url = new URL(requestUrl);
  assert.equal(url.searchParams.get('organization_id'), `eq.${org}`);
});

test('replay source is unavailable unless the row stores an actual source snapshot', async () => {
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable',
    fetchImpl: async () => response([{ id: 'run-1', source_snapshot: null }])
  });
  const snapshot = await adapters.db.getReplaySnapshot({ organizationId: org, runId: 'run-1', accessToken: userJwt });
  assert.equal(snapshot, null);
});

test('Square OAuth state is hashed at rest and token vault encrypts/decrypts with a distinct AES key', async () => {
  const encryptionKey = Buffer.alloc(32, 0x5a).toString('base64');
  const requests = [];
  let storedEncrypted;
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable', secretKey: serviceKey, tokenEncryptionKey: encryptionKey,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url: String(url), body, headers: new Headers(init.headers) });
      if (String(url).endsWith('/save_square_oauth_state')) return response(true);
      if (String(url).endsWith('/consume_square_oauth_state')) return response({ organizationId: org, userId: 'owner-1', redirectUri: 'https://app.test/callback', expiresAt: '2026-01-01T00:10:00Z' });
      if (String(url).endsWith('/store_square_tokens')) { storedEncrypted = body.p_record; return response(true); }
      if (String(url).endsWith('/get_square_tokens')) return response(storedEncrypted);
      throw new Error(`Unexpected request ${url}`);
    }
  });
  await adapters.stateStore.save({ state: 'random-one-time-state', organizationId: org, userId: 'owner-1', redirectUri: 'https://app.test/callback', expiresAt: '2026-01-01T00:10:00Z' });
  const stateBody = requests[0].body.p_state_sha256;
  assert.match(stateBody, /^[a-f0-9]{64}$/);
  assert.notEqual(stateBody, 'random-one-time-state');
  const consumed = await adapters.stateStore.consume({ state: 'random-one-time-state' });
  assert.equal(consumed.state, 'random-one-time-state');
  assert.equal(requests[1].body.p_state_sha256, stateBody);

  const record = { organizationId: org, connectedBy: 'owner-1', merchantId: 'merchant-1', accessToken: 'square-access-secret', refreshToken: 'square-refresh-secret', expiresAt: '2026-02-01T00:00:00Z', scopes: ['ORDERS_READ'], tokenType: 'bearer' };
  await adapters.tokenVault.storeEncrypted(record);
  assert.equal(JSON.stringify(storedEncrypted).includes(record.accessToken), false);
  assert.equal(JSON.stringify(storedEncrypted).includes(record.refreshToken), false);
  assert.notEqual(serviceKey, encryptionKey);
  const decrypted = await adapters.tokenVault.getDecrypted({ organizationId: org });
  assert.equal(decrypted.accessToken, record.accessToken);
  assert.equal(decrypted.refreshToken, record.refreshToken);
  assert.ok(requests.every(call => call.headers.get('authorization') === `Bearer ${serviceKey}`));
});

test('worker queue maps durable jobs and performs lease-owned ack/retry/dead-letter calls', async () => {
  const calls = [];
  const adapters = createSupabaseAdapters({
    url: 'https://tenant.supabase.test', publishableKey: 'publishable', secretKey: serviceKey,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      const rpc = String(url).split('/').at(-1);
      if (rpc === 'claim_durable_jobs') return response([{ id: 'job-1', organization_id: org, job_type: 'square.sync', payload: { startAt: 'a', endAt: 'b' }, attempts: 1, max_attempts: 5, lease_token: 'fence-1' }]);
      return response(true);
    }
  });
  const job = await adapters.queue.claim({ workerId: 'worker-1', leaseSeconds: 120, types: ['square.sync'] });
  assert.deepEqual(job, { id: 'job-1', organizationId: org, type: 'square.sync', payload: { startAt: 'a', endAt: 'b' }, attempts: 1, maxAttempts: 5, leaseToken: 'fence-1' });
  await adapters.queue.ack({ jobId: job.id, workerId: 'worker-1', leaseToken: job.leaseToken });
  await adapters.queue.retry({ jobId: job.id, workerId: 'worker-1', leaseToken: job.leaseToken, delayMs: 1000, code: 'RETRY' });
  await adapters.queue.deadLetter({ jobId: job.id, workerId: 'worker-1', leaseToken: job.leaseToken, code: 'FAILED', message: 'safe message' });
  assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), ['claim_durable_jobs', 'ack_durable_job', 'retry_durable_job', 'dead_letter_durable_job']);
  assert.ok(calls.every(call => Object.keys(call.body).every(key => key.startsWith('p_'))));
  assert.equal(calls[1].body.p_lease_token, 'fence-1');
  assert.equal(calls[2].body.p_lease_token, 'fence-1');
  assert.equal(calls[3].body.p_lease_token, 'fence-1');
});
