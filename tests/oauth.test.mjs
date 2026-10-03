import test from 'node:test';
import assert from 'node:assert/strict';
import { createSquareOAuthHandlers } from '../src/square/index.mjs';

const organizationId = '11111111-1111-4111-8111-111111111111';
const config = { squareClientId: 'square-client', squareClientSecret: 'server-secret', squareRedirectUri: 'https://app.test/api/square/oauth/callback', squareBaseUrl: 'https://connect.squareup.com' };
const scopes = ['ORDERS_READ', 'PAYMENTS_READ', 'ITEMS_READ', 'PAYOUTS_READ', 'MERCHANT_PROFILE_READ', 'GIFTCARDS_READ'];
const catalogWriteScopes = [...scopes, 'ITEMS_WRITE'];

function setup({ role = 'owner', expired = false, tokenScopes = scopes } = {}) {
  const pending = new Map(); const persisted = []; const calls = [];
  let currentTime = new Date('2026-09-30T12:00:00Z');
  const stateStore = {
    async save(record) { pending.set(record.state, record); calls.push(['state-saved', record]); },
    async consume({ state }) { const record = pending.get(state); pending.delete(state); return expired && record ? { ...record, expiresAt: '2020-01-01T00:00:00Z' } : record; }
  };
  const tokenVault = { async storeEncrypted(record) { persisted.push(record); } };
  const fetchImpl = async (_url, init) => {
    calls.push(['token-request', JSON.parse(init.body)]);
    return new Response(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: '2026-10-01T12:00:00Z', merchant_id: 'merchant-1', scopes: tokenScopes }), { status: 200 });
  };
  const handlers = createSquareOAuthHandlers({ authenticateOwner: async (_req, org) => ({ organizationId: org, userId: 'user-1', role }), stateStore, tokenVault, config, fetchImpl, now: () => currentTime });
  const startRequest = (body = { organizationId }) => new Request('https://app.test/api/square/oauth/start', { method: 'POST', headers: { authorization: 'Bearer valid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { handlers, pending, persisted, calls, startRequest, setNow: d => { currentTime = new Date(d); } };
}

test('OAuth start is owner-only, requests required read and catalog-write scopes, and uses durable unpredictable state', async () => {
  const denied = setup({ role: 'operator' });
  assert.equal((await denied.handlers.start(denied.startRequest())).status, 403);
  const stateful = setup();
  const response = await stateful.handlers.start(stateful.startRequest());
  assert.equal(response.status, 200);
  const { authorizationUrl } = await response.json(); const url = new URL(authorizationUrl);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), scopes.join(' '));
  const state = url.searchParams.get('state');
  assert.equal(state.length, 43);
  assert.equal(stateful.pending.get(state).organizationId, organizationId);
  assert.equal(stateful.pending.get(state).userId, 'user-1');
});

test('OAuth callback exchanges code, stores tokens encrypted, and returns no credentials to browser', async () => {
  const stateful = setup();
  const started = await stateful.handlers.start(stateful.startRequest());
  const { authorizationUrl } = await started.json();
  const state = new URL(authorizationUrl).searchParams.get('state');
  const callback = () => new Request(`https://app.test/api/square/oauth/callback?code=authorization-code&state=${encodeURIComponent(state)}`);
  const response = await stateful.handlers.callback(callback());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, { connected: true, organizationId, merchantId: 'merchant-1', scopes, expiresAt: '2026-10-01T12:00:00Z' });
  assert.equal(JSON.stringify(result).includes('access-secret'), false);
  assert.equal(stateful.persisted.length, 1);
  assert.equal(stateful.persisted[0].accessToken, 'access-secret');
  assert.equal(stateful.calls.find(x => x[0] === 'token-request')[1].grant_type, 'authorization_code');
  assert.equal((await stateful.handlers.callback(callback())).status, 400, 'state is single-use');
});

test('OAuth callback rejects expired state and constructor refuses write scopes', async () => {
  const expired = setup({ expired: true });
  const started = await expired.handlers.start(expired.startRequest());
  const { authorizationUrl } = await started.json();
  const state = new URL(authorizationUrl).searchParams.get('state');
  const response = await expired.handlers.callback(new Request(`https://app.test/callback?code=x&state=${state}`));
  assert.equal(response.status, 400);
  assert.equal(expired.persisted.length, 0);
  assert.throws(() => createSquareOAuthHandlers({ authenticateOwner: async () => ({}), stateStore: { save() {}, consume() {} }, tokenVault: { storeEncrypted() {} }, config: { ...config, squareReadScopes: ['PAYMENTS_WRITE'] } }), /read-only Square scopes/);
});

test('catalog write permission is requested only for an owner-authorized catalog setup', async () => {
  const stateful = setup({ tokenScopes: catalogWriteScopes });
  const response = await stateful.handlers.start(stateful.startRequest({ organizationId, catalogWrite: true }));
  assert.equal(response.status, 200);
  const { authorizationUrl } = await response.json();
  assert.equal(new URL(authorizationUrl).searchParams.get('scope'), catalogWriteScopes.join(' '));
  const state = new URL(authorizationUrl).searchParams.get('state');
  const callback = await stateful.handlers.callback(new Request(`https://app.test/api/square/oauth/callback?code=authorization-code&state=${encodeURIComponent(state)}`));
  assert.equal(callback.status, 200);
  assert.deepEqual(stateful.persisted[0].scopes, catalogWriteScopes);
  const readOnly = setup();
  const readResponse = await readOnly.handlers.start(readOnly.startRequest());
  assert.equal(new URL((await readResponse.json()).authorizationUrl).searchParams.get('scope'), scopes.join(' '));
});
