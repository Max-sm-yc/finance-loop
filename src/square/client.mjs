/** Dependency-free Square server-side primitives. Never expose tokens in browser code. */
const API_BASE = 'https://connect.squareup.com';

export function createAuthorizationUrl({ clientId, redirectUri, state, scopes, baseUrl = 'https://connect.squareup.com' }) {
  if (!clientId || !redirectUri || !state) throw new TypeError('clientId, redirectUri, and state are required');
  const url = new URL('/oauth2/authorize', baseUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  if (scopes?.length) url.searchParams.set('scope', scopes.join(' '));
  // Square's production OAuth flow requires session=false. Sandbox only
  // supports its existing session behavior, so omit the parameter there.
  if (new URL(baseUrl).hostname === 'connect.squareup.com') url.searchParams.set('session', 'false');
  return url.toString();
}

async function jsonRequest(fetchImpl, url, { method = 'GET', headers = {}, body, signal } = {}) {
  const response = await fetchImpl(url, { method, headers: { accept: 'application/json', ...headers }, body, signal });
  const text = await response.text();
  let data = {};
  if (text) { try { data = JSON.parse(text); } catch { throw new Error(`Square returned invalid JSON (${response.status})`); } }
  if (!response.ok) {
    const error = new Error(data.errors?.map(e => e.detail || e.code).join('; ') || `Square request failed (${response.status})`);
    error.status = response.status; error.retryAfter = response.headers.get('retry-after'); error.errors = data.errors;
    // OAuth token failures can use the OAuth error shape rather than Square's
    // standard `errors` array. Keep only the short code and request ID for
    // diagnostics; never attach or log the response body or submitted tokens.
    if (typeof data.error === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(data.error)) error.code = data.error;
    const requestId = response.headers.get('square-request-id') ?? response.headers.get('x-square-request-id');
    if (typeof requestId === 'string' && /^[A-Za-z0-9-]{1,120}$/.test(requestId)) error.squareRequestId = requestId;
    throw error;
  }
  return data;
}

export async function exchangeAuthorizationCode({ code, clientId, clientSecret, redirectUri, fetchImpl = fetch, baseUrl = API_BASE }) {
  if (!code || !clientId || !clientSecret) throw new TypeError('code, clientId, and clientSecret are required');
  return jsonRequest(fetchImpl, `${baseUrl}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
}

export async function refreshAccessToken({ refreshToken, clientId, clientSecret, fetchImpl = fetch, baseUrl = API_BASE }) {
  if (!refreshToken || !clientId || !clientSecret) throw new TypeError('refreshToken, clientId, and clientSecret are required');
  return jsonRequest(fetchImpl, `${baseUrl}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }) });
}

export class SquareApiClient {
  constructor({ accessToken, fetchImpl = fetch, baseUrl = API_BASE, apiVersion = '2026-09-16' }) {
    if (!accessToken) throw new TypeError('accessToken is required');
    this.accessToken = accessToken; this.fetch = fetchImpl; this.baseUrl = baseUrl; this.apiVersion = apiVersion;
  }
  request(path, options = {}) {
    return jsonRequest(this.fetch, `${this.baseUrl}${path}`, { ...options, headers: { authorization: `Bearer ${this.accessToken}`, 'square-version': this.apiVersion, ...options.headers } });
  }
}
