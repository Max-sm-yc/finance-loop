import { createHandlers } from '../../../../src/server/index.mjs';
import { createSupabaseAdapters } from '../../../../src/adapters/supabase.mjs';
import { replayAccounting } from '../../../../src/engine/index.mjs';
import { createSquareOAuthHandlers } from '../../../../src/square/oauth.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handlers() {
  const adapters = createSupabaseAdapters({
    url: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    secretKey: process.env.SUPABASE_SECRET_KEY,
    tokenEncryptionKey: process.env.SQUARE_TOKEN_ENCRYPTION_KEY,
  });
  const route = createHandlers({
    ...adapters,
    engine: { replayAccounting },
    config: {
      squareWebhookSignatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY ?? '',
      squareNotificationUrl: process.env.SQUARE_WEBHOOK_NOTIFICATION_URL ?? '',
      openRouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
      openRouterModel: process.env.OPENROUTER_MODEL ?? 'openai/gpt-6-luna',
      openRouterMaxOutputTokens: Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS ?? 700),
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
  if (resource === 'evidence' && !id && method === 'POST') return route.evidence(request);
  if (resource === 'evidence' && !id && method === 'GET') return route.evidenceUrl(request);
  if (resource === 'runs' && id && action === 'replay' && method === 'POST') return route.replay(request);
  if (resource === 'sync' && method === 'POST') return route.sync(request);
  if (resource === 'square' && id === 'webhook' && method === 'POST') return route.webhook(request);
  return Response.json({ error: 'NOT_FOUND', code: 'NOT_FOUND' }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

export const GET = dispatch;
export const POST = dispatch;
