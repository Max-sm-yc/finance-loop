import { createHandlers } from '../../../../src/server/index.mjs';
import { createSupabaseAdapters } from '../../../../src/adapters/supabase.mjs';
import { replayAccounting } from '../../../../src/engine/index.mjs';
import { createSquareOAuthHandlers } from '../../../../src/square/oauth.mjs';
import { createSquareCatalogItem as upsertSquareCatalogItem, createSquareCatalogProduct as createSquareCatalogProductEntry,
  updateSquareCatalogItem, updateSquareCatalogVariation, addSquareCatalogVariation, setSquareCatalogItemArchived } from '../../../../src/square/catalog.mjs';
import { refreshAccessToken, SquareApiClient } from '../../../../src/square/client.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SquareTokenRefresh = {
  access_token?: string; refresh_token?: string; expires_at?: string;
  merchant_id?: string; scopes?: string[]; token_type?: string;
};
type SquareLocationsPage = { locations?: Array<{ id?: string; status?: string }>; cursor?: string | null };

function codedError(code: string) {
  return Object.assign(new Error(code), { code });
}

async function listActiveSquareLocations(organizationId: string, adapters: ReturnType<typeof createSupabaseAdapters>) {
  const squareEnvironment = process.env.SQUARE_ENVIRONMENT;
  if (squareEnvironment !== 'sandbox' && squareEnvironment !== 'production') throw codedError('SQUARE_SYNC_UNAVAILABLE');
  const squareBaseUrl = squareEnvironment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
  let connection;
  try { connection = await adapters.tokenVault.getDecrypted({ organizationId }); }
  catch { throw codedError('SQUARE_LOCATIONS_UNAVAILABLE'); }
  if (!connection?.accessToken) throw codedError('SQUARE_NOT_CONNECTED');

  const expiresAt = Date.parse(connection.expiresAt ?? '');
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 5 * 60_000) {
    const clientId = process.env.SQUARE_CLIENT_ID;
    const clientSecret = process.env.SQUARE_CLIENT_SECRET;
    if (!connection.refreshToken || !clientId || !clientSecret) throw codedError('SQUARE_RECONNECT_REQUIRED');
    let refreshed: SquareTokenRefresh;
    try {
      refreshed = await refreshAccessToken({
        refreshToken: connection.refreshToken, clientId, clientSecret, baseUrl: squareBaseUrl,
      }) as SquareTokenRefresh;
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
      if (status === 400 || status === 401) throw codedError('SQUARE_RECONNECT_REQUIRED');
      throw error;
    }
    if (!refreshed.access_token || !refreshed.refresh_token || !refreshed.expires_at) throw codedError('SQUARE_RECONNECT_REQUIRED');
    await adapters.tokenVault.storeEncrypted({
      organizationId, connectedBy: connection.connectedBy,
      merchantId: refreshed.merchant_id ?? connection.merchantId,
      accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token,
      expiresAt: refreshed.expires_at, scopes: refreshed.scopes ?? connection.scopes,
      tokenType: refreshed.token_type ?? connection.tokenType,
    });
    connection = { ...connection, accessToken: refreshed.access_token, expiresAt: refreshed.expires_at };
  }

  const client = new SquareApiClient({
    accessToken: connection.accessToken, baseUrl: squareBaseUrl,
    apiVersion: process.env.SQUARE_API_VERSION ?? '2026-09-16',
  });
  const locations = new Map<string, { id: string }>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const result = await client.request(`/v2/locations?${query.toString()}`) as SquareLocationsPage;
    if (!Array.isArray(result.locations)) throw codedError('SQUARE_LOCATIONS_UNAVAILABLE');
    for (const location of result.locations) {
      if (typeof location?.id === 'string' && location.id.trim() && location.status !== 'INACTIVE') {
        locations.set(location.id, { id: location.id });
        if (locations.size > 100) return [...locations.values()];
      }
    }
    cursor = typeof result.cursor === 'string' && result.cursor ? result.cursor : null;
    if (!cursor) return [...locations.values()];
    if (cursors.has(cursor)) throw codedError('SQUARE_LOCATIONS_UNAVAILABLE');
    cursors.add(cursor);
  }
  throw codedError('SQUARE_LOCATIONS_UNAVAILABLE');
}

async function createSquareCatalogItemForOrganization(args: {
  organizationId: string; idempotencyKey: string; name: string; variationName: string;
  description: string; sku: string; priceMinor: number; currency: string;
}, adapters: ReturnType<typeof createSupabaseAdapters>) {
  const squareEnvironment = process.env.SQUARE_ENVIRONMENT;
  if (squareEnvironment !== 'sandbox' && squareEnvironment !== 'production') throw codedError('SQUARE_ENVIRONMENT_UNCONFIGURED');
  const squareBaseUrl = squareEnvironment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
  let connection;
  try { connection = await adapters.tokenVault.getDecrypted({ organizationId: args.organizationId }); }
  catch { throw codedError('SQUARE_CATALOG_UNAVAILABLE'); }
  if (!connection?.accessToken) throw codedError('SQUARE_NOT_CONNECTED');
  if (!Array.isArray(connection.scopes) || !connection.scopes.includes('ITEMS_WRITE')) {
    throw codedError('SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED');
  }

  const expiresAt = Date.parse(connection.expiresAt ?? '');
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 5 * 60_000) {
    const clientId = process.env.SQUARE_CLIENT_ID;
    const clientSecret = process.env.SQUARE_CLIENT_SECRET;
    if (!connection.refreshToken || !clientId || !clientSecret) throw codedError('SQUARE_RECONNECT_REQUIRED');
    let refreshed: SquareTokenRefresh;
    try {
      refreshed = await refreshAccessToken({ refreshToken: connection.refreshToken, clientId, clientSecret, baseUrl: squareBaseUrl }) as SquareTokenRefresh;
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
      if (status === 400 || status === 401) throw codedError('SQUARE_RECONNECT_REQUIRED');
      throw codedError('SQUARE_CATALOG_UNAVAILABLE');
    }
    if (!refreshed.access_token || !refreshed.refresh_token || !refreshed.expires_at) throw codedError('SQUARE_RECONNECT_REQUIRED');
    await adapters.tokenVault.storeEncrypted({
      organizationId: args.organizationId, connectedBy: connection.connectedBy,
      merchantId: refreshed.merchant_id ?? connection.merchantId,
      accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token,
      expiresAt: refreshed.expires_at, scopes: refreshed.scopes ?? connection.scopes,
      tokenType: refreshed.token_type ?? connection.tokenType,
    });
    connection = { ...connection, accessToken: refreshed.access_token, expiresAt: refreshed.expires_at };
  }

  const client = new SquareApiClient({
    accessToken: connection.accessToken, baseUrl: squareBaseUrl,
    apiVersion: process.env.SQUARE_API_VERSION ?? '2026-09-16',
  });
  let squareItem;
  try {
    squareItem = await upsertSquareCatalogItem({ client, organizationId: args.organizationId,
      idempotencyKey: args.idempotencyKey, name: args.name, variationName: args.variationName,
      description: args.description, sku: args.sku, priceMinor: args.priceMinor, currency: args.currency });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
    const providerCodes = Array.isArray((error as { errors?: Array<{ code?: unknown }> } | null)?.errors)
      ? (error as { errors: Array<{ code?: unknown }> }).errors.map(item => item?.code)
        .filter((code): code is string => typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code)).slice(0, 8)
      : [];
    console.error('Square catalog item write failed', {
      status,
      code: typeof (error as { code?: unknown } | null)?.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(String((error as { code: string }).code))
        ? (error as { code: string }).code : undefined,
      squareRequestId: typeof (error as { squareRequestId?: unknown } | null)?.squareRequestId === 'string'
        && /^[A-Za-z0-9-]{1,120}$/.test(String((error as { squareRequestId: string }).squareRequestId))
        ? (error as { squareRequestId: string }).squareRequestId : undefined,
      providerCodes,
    });
    if (status === 401) throw codedError('SQUARE_RECONNECT_REQUIRED');
    if (status === 403) throw codedError('SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED');
    throw codedError('SQUARE_CATALOG_WRITE_FAILED');
  }

  await adapters.db.upsertSquareFacts({ organizationId: args.organizationId, facts: squareItem.facts,
    cause: `catalog-create:${args.idempotencyKey}` });
  await adapters.db.registerSquareCatalogCreationTicket({
    organizationId: args.organizationId, idempotencyKey: args.idempotencyKey,
    squareItemId: squareItem.squareItemId, squareCatalogObjectId: squareItem.squareCatalogObjectId,
    name: args.name, variationName: args.variationName, sku: args.sku || null,
    currency: args.currency, priceMinor: args.priceMinor,
  });
  return squareItem;
}

async function withSquareCatalogWrite<T>(organizationId: string, adapters: ReturnType<typeof createSupabaseAdapters>,
  operation: (client: SquareApiClient) => Promise<T>): Promise<T> {
  const squareEnvironment = process.env.SQUARE_ENVIRONMENT;
  if (squareEnvironment !== 'sandbox' && squareEnvironment !== 'production') throw codedError('SQUARE_ENVIRONMENT_UNCONFIGURED');
  const squareBaseUrl = squareEnvironment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
  let connection;
  try { connection = await adapters.tokenVault.getDecrypted({ organizationId }); }
  catch { throw codedError('SQUARE_CATALOG_UNAVAILABLE'); }
  if (!connection?.accessToken) throw codedError('SQUARE_NOT_CONNECTED');
  if (!Array.isArray(connection.scopes) || !connection.scopes.includes('ITEMS_WRITE')) throw codedError('SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED');

  const expiresAt = Date.parse(connection.expiresAt ?? '');
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 5 * 60_000) {
    const clientId = process.env.SQUARE_CLIENT_ID, clientSecret = process.env.SQUARE_CLIENT_SECRET;
    if (!connection.refreshToken || !clientId || !clientSecret) throw codedError('SQUARE_RECONNECT_REQUIRED');
    let refreshed: SquareTokenRefresh;
    try {
      refreshed = await refreshAccessToken({ refreshToken: connection.refreshToken, clientId, clientSecret, baseUrl: squareBaseUrl }) as SquareTokenRefresh;
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
      if (status === 400 || status === 401) throw codedError('SQUARE_RECONNECT_REQUIRED');
      throw codedError('SQUARE_CATALOG_UNAVAILABLE');
    }
    if (!refreshed.access_token || !refreshed.refresh_token || !refreshed.expires_at) throw codedError('SQUARE_RECONNECT_REQUIRED');
    await adapters.tokenVault.storeEncrypted({
      organizationId, connectedBy: connection.connectedBy,
      merchantId: refreshed.merchant_id ?? connection.merchantId,
      accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token,
      expiresAt: refreshed.expires_at, scopes: refreshed.scopes ?? connection.scopes,
      tokenType: refreshed.token_type ?? connection.tokenType,
    });
    connection = { ...connection, accessToken: refreshed.access_token, expiresAt: refreshed.expires_at };
  }

  const client = new SquareApiClient({ accessToken: connection.accessToken, baseUrl: squareBaseUrl,
    apiVersion: process.env.SQUARE_API_VERSION ?? '2026-09-16' });
  try { return await operation(client); }
  catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
    const code = typeof (error as { code?: unknown } | null)?.code === 'string'
      && /^[A-Z0-9_-]{1,80}$/.test(String((error as { code: string }).code))
      ? String((error as { code: string }).code) : undefined;
    if (['SQUARE_CATALOG_OBJECT_UNAVAILABLE','SQUARE_CATALOG_RESPONSE_INVALID'].includes(code ?? '')) throw error;
    const requestId = typeof (error as { squareRequestId?: unknown } | null)?.squareRequestId === 'string'
      && /^[A-Za-z0-9-]{1,120}$/.test(String((error as { squareRequestId: string }).squareRequestId))
      ? String((error as { squareRequestId: string }).squareRequestId) : undefined;
    console.error('Square catalog management failed', { status, code, squareRequestId: requestId });
    if (status === 401) throw codedError('SQUARE_RECONNECT_REQUIRED');
    if (status === 403) throw codedError('SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED');
    if (status === 404) throw codedError('SQUARE_CATALOG_OBJECT_UNAVAILABLE');
    if (status === 409) throw codedError('SQUARE_CATALOG_CONFLICT');
    if (status === 429) throw codedError('SQUARE_CATALOG_BUSY');
    throw codedError('SQUARE_CATALOG_WRITE_FAILED');
  }
}

async function createSquareCatalogProductForOrganization(args: {
  organizationId: string; idempotencyKey: string; name: string; description: string;
  variations: Array<{ name: string; sku: string; pricingType: string; priceMinor: number | null; currency: string | null }>;
}, adapters: ReturnType<typeof createSupabaseAdapters>) {
  return withSquareCatalogWrite(args.organizationId, adapters, client => createSquareCatalogProductEntry({ client,
    idempotencyKey: args.idempotencyKey, name: args.name, description: args.description, variations: args.variations }));
}

async function manageSquareCatalogItemForOrganization(args: {
  organizationId: string; idempotencyKey: string; action: string; squareItemId: string;
  squareCatalogObjectId?: string; name?: string; description?: string; variationName?: string;
  sku?: string; pricingType?: string; priceMinor?: number | null; currency?: string;
}, adapters: ReturnType<typeof createSupabaseAdapters>) {
  return withSquareCatalogWrite(args.organizationId, adapters, async client => {
    const variation = { client, idempotencyKey: args.idempotencyKey, itemId: args.squareItemId,
      variationName: args.variationName ?? '', sku: args.sku ?? '', pricingType: args.pricingType ?? '',
      priceMinor: args.priceMinor ?? null, currency: args.currency ?? '' };
    if (args.action === 'update_item') return updateSquareCatalogItem({ client, idempotencyKey: args.idempotencyKey,
      itemId: args.squareItemId, name: args.name ?? '', description: args.description ?? '' });
    if (args.action === 'update_variation') return updateSquareCatalogVariation({ ...variation,
      variationId: args.squareCatalogObjectId ?? '' });
    if (args.action === 'add_variation') return addSquareCatalogVariation(variation);
    if (args.action === 'archive' || args.action === 'restore') return setSquareCatalogItemArchived({ client,
      idempotencyKey: args.idempotencyKey, itemId: args.squareItemId, archived: args.action === 'archive' });
    throw codedError('SQUARE_CATALOG_WRITE_FAILED');
  });
}

function handlers() {
  const squareEnvironment = process.env.SQUARE_ENVIRONMENT;
  const adapters = createSupabaseAdapters({
    url: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    secretKey: process.env.SUPABASE_SECRET_KEY,
    tokenEncryptionKey: process.env.SQUARE_TOKEN_ENCRYPTION_KEY,
    squareBaseUrl: squareEnvironment === 'sandbox' ? 'https://connect.squareupsandbox.com' : squareEnvironment === 'production' ? 'https://connect.squareup.com' : '',
    squareApiVersion: process.env.SQUARE_API_VERSION ?? '2026-09-16',
  });
  const route = createHandlers({
    ...adapters,
    squareCatalog: {
      createItem: (args: Parameters<typeof createSquareCatalogItemForOrganization>[0]) => createSquareCatalogItemForOrganization(args, adapters),
      createProduct: (args: Parameters<typeof createSquareCatalogProductForOrganization>[0]) => createSquareCatalogProductForOrganization(args, adapters),
      manageItem: (args: Parameters<typeof manageSquareCatalogItemForOrganization>[0]) => manageSquareCatalogItemForOrganization(args, adapters),
    },
    listSquareLocations: ({ organizationId }: { organizationId: string }) => listActiveSquareLocations(organizationId, adapters),
    engine: { replayAccounting },
    config: {
      squareWebhookSignatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY ?? '',
      squareNotificationUrl: process.env.SQUARE_WEBHOOK_NOTIFICATION_URL ?? '',
      openRouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
      openRouterModel: process.env.OPENROUTER_MODEL ?? 'openai/gpt-6-luna',
      openRouterMaxOutputTokens: Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS ?? 700),
      receiptAgentMaxOutputTokens: Number(process.env.RECEIPT_AGENT_MAX_OUTPUT_TOKENS ?? 900),
      inventoryTrackingEnabled: process.env.INVENTORY_TRACKING_ENABLED === 'true',
      productAnalyticsEnabled: process.env.PRODUCT_ANALYTICS_ENABLED === 'true',
    },
  });
  return { route, adapters };
}

async function dispatch(request: Request) {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') return Response.json({ error: 'NOT_FOUND', code: 'NOT_FOUND' }, { status: 404 });
  const { route, adapters } = handlers();
  const method = request.method.toUpperCase();
  const [resource, id, action] = parts.slice(1);
  if (resource === 'square' && id === 'oauth' && (action === 'start' || action === 'callback')) {
    const squareEnvironment = process.env.SQUARE_ENVIRONMENT;
    if (squareEnvironment !== 'sandbox' && squareEnvironment !== 'production') {
      return Response.json({ error: 'SQUARE_ENVIRONMENT_UNCONFIGURED', code: 'SQUARE_ENVIRONMENT_UNCONFIGURED' }, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    const oauth = createSquareOAuthHandlers({
      authenticateOwner: async (req: Request, organizationId: string) => {
        const match = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
        if (!match) return null;
        const { data, error } = await adapters.supabase.auth.getUser(match[1]);
        const userId = data?.user?.id;
        if (error || !userId) return null;
        const membership = await adapters.db.getMembership({ organizationId, userId, accessToken: match[1] });
        return membership ? { userId, organizationId, role: membership.role } : null;
      },
      stateStore: adapters.stateStore,
      tokenVault: adapters.tokenVault,
      config: {
        squareClientId: process.env.SQUARE_CLIENT_ID ?? '',
        squareClientSecret: process.env.SQUARE_CLIENT_SECRET ?? '',
        squareRedirectUri: process.env.SQUARE_OAUTH_REDIRECT_URI ?? '',
        squareBaseUrl: squareEnvironment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com',
      },
    });
    if (action === 'start' && method === 'POST') return oauth.start(request);
    if (action === 'callback' && method === 'GET') return oauth.callback(request);
  }
  if (resource === 'dashboard' && method === 'GET') return route.dashboard(request);
  if (resource === 'purchase-receipt-integrations' && ['GET', 'POST', 'DELETE'].includes(method)) return route.receiptIntegration(request);
  if (resource === 'purchase-receipts' && !id && method === 'GET') return route.purchaseReceipts(request);
  if (resource === 'purchase-receipts' && !id && method === 'POST') return route.purchaseReceipts(request);
  if (resource === 'purchase-receipts' && id === 'intake' && method === 'POST') return route.manualPurchaseReceiptIntake(request);
  if (resource === 'purchase-receipts' && id && !['intake'].includes(id) && ['GET', 'POST', 'DELETE'].includes(method)) return route.purchaseReceipts(request);
  if (resource === 'integrations' && id === 'purchase-receipts') {
    const receiptId = parts[3];
    const integrationAction = parts[4];
    if (!receiptId && method === 'POST') return route.purchaseReceiptIntake(request);
    if (receiptId && integrationAction === 'complete' && method === 'POST') return route.purchaseReceiptComplete(request);
    if (receiptId && !integrationAction && method === 'GET') return route.purchaseReceiptStatus(request);
  }
  if (resource === 'issues' && !id && method === 'GET') return route.issues(request);
  if (resource === 'issues' && id && action === 'evidence' && method === 'GET') return route.issueEvidence(request);
  if (resource === 'issues' && id && action === 'item-cost' && method === 'POST') return route.itemCost(request);
  if (resource === 'issues' && id && action === 'line-cost' && method === 'POST') return route.saleLineCost(request);
  if (resource === 'issues' && id && action === 'refund-review' && method === 'POST') return route.refundReview(request);
  if (resource === 'proposals' && !id && method === 'POST') return route.proposal(request);
  if (resource === 'proposals' && id && action === 'decision' && method === 'POST') return route.decision(request);
  if (resource === 'manual-movements' && method === 'GET') return route.manualMovements(request);
  if (resource === 'manual-movements' && method === 'POST') return route.manualMovement(request);
  if (resource === 'observations' && method === 'GET') return route.observations(request);
  if (resource === 'observations' && method === 'POST') return route.observation(request);
  if (resource === 'audit' && method === 'GET') return route.audit(request);
  if (resource === 'settings' && method === 'GET') return route.settings(request);
  if (resource === 'inventory' && !id && method === 'GET') return route.inventory(request);
  if (resource === 'inventory' && id === 'purchases' && method === 'POST') return route.inventoryPurchase(request);
  if (resource === 'inventory' && id === 'receipt-drafts' && method === 'POST') return route.receiptDraft(request);
  if (resource === 'inventory' && id === 'receipt-costs' && method === 'POST') return route.receiptItemCosts(request);
  if (resource === 'inventory' && id === 'corrections' && method === 'POST') return route.inventoryCorrection(request);
  if (resource === 'inventory' && id === 'openings' && method === 'POST') return route.inventoryOpening(request);
  if (resource === 'inventory' && id === 'items' && method === 'POST') return route.inventoryItem(request);
  if (resource === 'inventory' && id === 'catalog-items' && method === 'POST') return route.squareCatalogItem(request);
  if (resource === 'square' && id === 'catalog-items' && method === 'POST') return route.squareCatalogCreate(request);
  if (resource === 'square' && id === 'catalog-items' && method === 'PATCH') return route.squareCatalogManage(request);
  if (resource === 'analytics' && method === 'GET') return route.analytics(request);
  if (resource === 'evidence' && !id && method === 'POST') return route.evidence(request);
  if (resource === 'evidence' && !id && method === 'GET') return route.evidenceUrl(request);
  if (resource === 'runs' && id && action === 'replay' && method === 'POST') return route.replay(request);
  if (resource === 'sync' && method === 'POST') return route.sync(request);
  if (resource === 'square' && id === 'webhook' && method === 'POST') return route.webhook(request);
  return Response.json({ error: 'NOT_FOUND', code: 'NOT_FOUND' }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

export const GET = dispatch;
export const POST = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
