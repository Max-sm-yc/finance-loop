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
      if (String(url).includes('/issues?')) return response([{ id: issueId, code: 'UNKNOWN_ITEM', details: {}, source_refs: [sourceId, 'order:456'] }]);
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
