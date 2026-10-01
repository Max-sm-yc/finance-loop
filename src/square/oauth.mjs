import { randomBytes } from 'node:crypto';
import { createAuthorizationUrl, exchangeAuthorizationCode } from './client.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const READ_SCOPES = Object.freeze(['ORDERS_READ', 'PAYMENTS_READ', 'ITEMS_READ', 'PAYOUTS_READ', 'MERCHANT_PROFILE_READ', 'GIFTCARDS_READ']);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const fail = (status, code) => json(status, { error: code, code });
class OAuthHandlerError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function boundedText(request, limit) {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) throw new OAuthHandlerError(413, 'BODY_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new OAuthHandlerError(413, 'BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/**
 * Next-compatible Square OAuth routes. stateStore must persist and atomically
 * consume single-use, expiring state. tokenVault.storeEncrypted must encrypt both
 * Square tokens at rest; no plaintext token storage implementation is provided.
 * @param {{
 *   authenticateOwner?: (request: Request, organizationId: string) => Promise<{userId: string, organizationId: string, role: string} | null>,
 *   stateStore?: {save: (value: {state: string, organizationId: string, userId: string, redirectUri: string, expiresAt: string}) => Promise<unknown>, consume: (value: {state: string}) => Promise<any>},
 *   tokenVault?: {storeEncrypted: (value: {organizationId: string, connectedBy: string, merchantId: string, accessToken: string, refreshToken: string, expiresAt: string, scopes: string[], tokenType: string}) => Promise<unknown>},
 *   config?: {squareClientId: string, squareClientSecret: string, squareRedirectUri: string, squareBaseUrl?: string, squareReadScopes?: string[], oauthStateTtlMs?: number},
 *   fetchImpl?: typeof fetch,
 *   now?: () => Date
 * }} options
 */
export function createSquareOAuthHandlers({ authenticateOwner, stateStore, tokenVault, config, fetchImpl = fetch, now = () => new Date() } = {}) {
  if (typeof authenticateOwner !== 'function') throw new TypeError('authenticateOwner is required');
  if (typeof stateStore?.save !== 'function' || typeof stateStore?.consume !== 'function') throw new TypeError('durable single-use stateStore.save/consume are required');
  if (typeof tokenVault?.storeEncrypted !== 'function') throw new TypeError('encrypted tokenVault.storeEncrypted is required');
  for (const key of ['squareClientId', 'squareClientSecret', 'squareRedirectUri']) if (!config?.[key]) throw new TypeError(`${key} is required`);
  const scopes = config.squareReadScopes ?? READ_SCOPES;
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some(scope => !READ_SCOPES.includes(scope)) || new Set(scopes).size !== scopes.length) throw new TypeError('squareReadScopes must contain only unique read-only Square scopes');
  const baseUrl = config.squareBaseUrl ?? 'https://connect.squareup.com';
  const stateTtlMs = Number.isInteger(config.oauthStateTtlMs) ? Math.max(60_000, Math.min(config.oauthStateTtlMs, 15 * 60_000)) : 10 * 60_000;

  const run = (route, handler) => async request => {
    try { return await handler(request); }
    catch (error) {
      if (error instanceof OAuthHandlerError) return fail(error.status, error.code);
      // Keep browser errors generic, but leave enough sanitized context in the
      // server logs to distinguish Square token exchange from Supabase storage.
      const details = {
        route,
        status: Number.isInteger(error?.status) ? error.status : undefined,
        code: typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(error.code) ? error.code : undefined,
        providerType: typeof error?.providerType === 'string' && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(error.providerType) && error.providerType.length <= 120 ? error.providerType : undefined,
        squareRequestId: typeof error?.squareRequestId === 'string' && /^[A-Za-z0-9-]{1,120}$/.test(error.squareRequestId) ? error.squareRequestId : undefined,
        providerErrors: Array.isArray(error?.errors) ? error.errors.map(item => ({
          category: typeof item?.category === 'string' ? item.category : undefined,
          code: typeof item?.code === 'string' ? item.code : undefined
        })) : undefined
      };
      console.error('Square OAuth handler failed', details);
      return fail(500, 'INTERNAL_ERROR');
    }
  };

  const start = run('start', async request => {
    if (request.method !== 'POST') throw new OAuthHandlerError(405, 'METHOD_NOT_ALLOWED');
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new OAuthHandlerError(415, 'JSON_REQUIRED');
    const raw = await boundedText(request, 4_000);
    let body;
    try { body = JSON.parse(raw); } catch { throw new OAuthHandlerError(400, 'INVALID_JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !UUID.test(body.organizationId ?? '')) throw new OAuthHandlerError(400, 'INVALID_INPUT');
    const actor = await authenticateOwner(request, body.organizationId);
    if (!actor?.userId || actor.organizationId !== body.organizationId || actor.role !== 'owner') throw new OAuthHandlerError(403, 'FORBIDDEN');
    const state = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now().getTime() + stateTtlMs).toISOString();
    await stateStore.save({ state, organizationId: body.organizationId, userId: actor.userId, redirectUri: config.squareRedirectUri, expiresAt });
    const authorizationUrl = createAuthorizationUrl({ clientId: config.squareClientId, redirectUri: config.squareRedirectUri, state, scopes, baseUrl });
    return json(200, { authorizationUrl });
  });

  const callback = run('callback', async request => {
    if (request.method !== 'GET') throw new OAuthHandlerError(405, 'METHOD_NOT_ALLOWED');
    const url = new URL(request.url); const state = url.searchParams.get('state'); const code = url.searchParams.get('code');
    // Consume before exchanging so a callback cannot be replayed, even if exchange fails.
    if (!state || state.length > 256) throw new OAuthHandlerError(400, 'INVALID_OAUTH_STATE');
    const pending = await stateStore.consume({ state });
    const expiry = Date.parse(pending?.expiresAt ?? '');
    if (!pending || pending.state !== state || !Number.isFinite(expiry) || expiry <= now().getTime() || pending.redirectUri !== config.squareRedirectUri || !UUID.test(pending.organizationId ?? '') || !pending.userId) throw new OAuthHandlerError(400, 'INVALID_OAUTH_STATE');
    const providerError = url.searchParams.get('error');
    if (providerError || !code || code.length > 4_000) throw new OAuthHandlerError(400, providerError === 'access_denied' ? 'OAUTH_DENIED' : 'INVALID_OAUTH_CALLBACK');
    const tokenResponse = await exchangeAuthorizationCode({ code, clientId: config.squareClientId, clientSecret: config.squareClientSecret, redirectUri: config.squareRedirectUri, fetchImpl, baseUrl });
    if (!tokenResponse.access_token || !tokenResponse.refresh_token || !tokenResponse.merchant_id || !tokenResponse.expires_at) throw new OAuthHandlerError(502, 'INVALID_TOKEN_RESPONSE');
    // ObtainToken doesn't include scopes in the normal code-flow response. We
    // requested only this read-only set in the authorization URL; use returned
    // scopes when present (for providers/API versions that include them).
    const returnedScopes = tokenResponse.scopes ?? scopes;
    if (returnedScopes.some(scope => !scopes.includes(scope))) throw new OAuthHandlerError(502, 'UNEXPECTED_OAUTH_SCOPE');
    await tokenVault.storeEncrypted({
      organizationId: pending.organizationId,
      connectedBy: pending.userId,
      merchantId: tokenResponse.merchant_id,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: tokenResponse.expires_at,
      scopes: returnedScopes,
      tokenType: tokenResponse.token_type ?? 'bearer'
    });
    return json(200, { connected: true, organizationId: pending.organizationId, merchantId: tokenResponse.merchant_id, scopes: returnedScopes, expiresAt: tokenResponse.expires_at });
  });

  return Object.freeze({ start, callback, readScopes: scopes });
}
