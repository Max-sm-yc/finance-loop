import { acceptSquareWebhook } from '../square/webhooks.mjs';
import { diagnoseIssue, DiagnosisError, SUPPORTED_DIAGNOSIS_ISSUE_TYPES } from '../agent/diagnosis.mjs';
import { extractReceipt } from '../agent/receipt.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { calculateProductAnalytics } from '../engine/analytics.mjs';
import { calculateInventory } from '../engine/inventory.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const MAX_SYNC_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const roles = new Set(['owner', 'operator', 'reviewer', 'read_only']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const response = (status, value) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
const ok = data => response(200, data);
const created = data => response(201, data);
const bad = (status, code) => response(status, { error: code, code });
function requireAdapters({ supabase, db, queue, config, squareCatalog }) {
  if (!supabase?.auth?.getUser || !db || !queue || !config) throw new TypeError('Supabase auth, durable DB/queue adapters, and config are required');
  const required = ['getMembership', 'getDashboard', 'listIssues', 'listManualMovements', 'listObservations', 'listAuditEvents', 'getSettings', 'getIssue', 'getIssueEvidence', 'recordItemDefinition', 'recordSaleLineCostOverride', 'recordRefundCostReview', 'createProposalAtomic', 'reserveModelBudget', 'recordModelUsage', 'getReplaySnapshot', 'saveProjectionRun', 'asUser'];
  for (const method of required) if (typeof db[method] !== 'function') throw new TypeError(`db.${method} durable adapter method is required`);
  for (const method of ['enqueueSquareSync', 'enqueueSquareWebhook', 'enqueueProjectionReplay']) if (typeof queue[method] !== 'function') throw new TypeError(`queue.${method} durable adapter method is required`);
  return { supabase, db, queue, config, squareCatalog };
}
function exactObject(value, keys, required = keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k)) && required.every(k => own(value, k));
}
function text(value, max = 500) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function validDate(value) { return typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)); }
const utc = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : value;
function windowCovered(windows, from, to) {
  const instantMs = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
  const intervals = (windows ?? []).filter(w => Number.isFinite(instantMs(w?.from)) && Number.isFinite(instantMs(w?.to)) && instantMs(w.to) > instantMs(w.from))
    .map(w => [Date.parse(w.from), Date.parse(w.to)]).sort((a, b) => a[0] - b[0]);
  let cursor = instantMs(from), end = instantMs(to);
  if (!Number.isFinite(cursor) || !Number.isFinite(end) || cursor >= end) return false;
  for (const [start, stop] of intervals) {
    if (start > cursor) return false;
    if (stop > cursor) cursor = stop;
    if (cursor >= end) return true;
  }
  return false;
}
function uncoveredWindows(windows, from, to) {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return [];
  const intervals = (Array.isArray(windows) ? windows : []).filter(w => Number.isFinite(Date.parse(w?.from)) && Number.isFinite(Date.parse(w?.to)) && Date.parse(w.to) > Date.parse(w.from))
    .map(w => [Math.max(start, Date.parse(w.from)), Math.min(end, Date.parse(w.to))])
    .filter(([left, right]) => left < right).sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = start;
  for (const [left, right] of intervals) {
    if (left > cursor) gaps.push({ startAt: new Date(cursor).toISOString(), endAt: new Date(left).toISOString() });
    if (right > cursor) cursor = right;
    if (cursor >= end) break;
  }
  if (cursor < end) gaps.push({ startAt: new Date(cursor).toISOString(), endAt: new Date(end).toISOString() });
  return gaps;
}
function sourceHealthIncomplete(health, requiredResources, { includeUnlisted = true } = {}) {
  const fresh = row => row?.status === 'fresh' && row.gap == null
    && Number.isFinite(Date.parse(row.lastSuccessfulSyncAt ?? ''))
    && Date.now() - Date.parse(row.lastSuccessfulSyncAt) <= 24 * 60 * 60 * 1000;
  return requiredResources.some(resource => !fresh(health.find(row => row?.resource === resource)))
    || (includeUnlisted && health.some(row => !fresh(row)));
}
function validMoney(value) { return Number.isSafeInteger(value) && value !== 0; }
function idempotency(req) {
  const key = req.headers.get('idempotency-key');
  if (!key || key.length > 200 || !/^[\w:.\-/]+$/.test(key)) throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY');
  return key;
}
async function readBytes(req, maxBytes) {
  const length = Number(req.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE');
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader(); const chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new HttpError(413, 'BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function readJson(req, maxBytes = 32_000) {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON_REQUIRED');
  const raw = new TextDecoder().decode(await readBytes(req, maxBytes));
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'INVALID_JSON'); }
}
function parseBearer(req) {
  const h = req.headers.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(h);
  if (!match) throw new HttpError(401, 'UNAUTHENTICATED');
  return match[1];
}
function safeThrown(error) {
  if (error instanceof HttpError) return bad(error.status, error.code);
  if (error instanceof DiagnosisError) {
    const status = error.code === 'INVALID_INPUT' ? 400 : 503;
    // DiagnosisError messages are generated from fixed validation checks and
    // contain no provider response bodies, credentials, or submitted evidence.
    if (error.code === 'INVALID_INPUT' || error.code === 'BUDGET_EXCEEDED') return response(status, { error: error.code, code: error.code, detail: error.message });
    return bad(status, error.code);
  }
  // Never return adapter/provider error strings or SQL details to the client.
  return bad(500, 'INTERNAL_ERROR');
}

/**
 * Next.js compatible Request/Response handlers. All write adapters must transact
 * domain write + audit + unique idempotency key. No handler stores mutable state.
 * Adapter call shapes are intentionally explicit and are suitable for Supabase RPCs.
 */
export function createHandlers(adapters) {
  const { supabase, db, queue, config, squareCatalog } = requireAdapters(adapters);
  const authorize = async (req, organizationId, allowedRoles) => {
    const { data, error } = await supabase.auth.getUser(parseBearer(req));
    const user = data?.user;
    if (error || !user?.id) throw new HttpError(401, 'UNAUTHENTICATED');
    if (!UUID.test(organizationId ?? '')) throw new HttpError(400, 'INVALID_ORGANIZATION_ID');
    const token = parseBearer(req);
    const membership = await db.getMembership({ organizationId, userId: user.id, accessToken: token });
    if (!membership || !roles.has(membership.role)) throw new HttpError(403, 'FORBIDDEN');
    if (allowedRoles && !allowedRoles.includes(membership.role)) throw new HttpError(403, 'FORBIDDEN');
    return { userId: user.id, role: membership.role, accessToken: token };
  };
  const featureAvailability = async (organizationId, accessToken) => {
    // Each capability needs both an explicit server-only deployment opt-in and
    // an organization row. Missing flags/adapters always fail closed.
    const serverInventory = config.inventoryTrackingEnabled === true;
    const serverAnalytics = config.productAnalyticsEnabled === true;
    let organizationFlags = {};
    if ((serverInventory || serverAnalytics) && typeof db.getOrganizationFeatureFlags === 'function') {
      organizationFlags = await db.getOrganizationFeatureFlags({ organizationId, accessToken }) ?? {};
    }
    return {
      inventoryTracking: serverInventory && organizationFlags.inventoryTracking === true,
      productAnalytics: serverAnalytics && organizationFlags.productAnalytics === true,
    };
  };
  const requireFeature = async (organizationId, accessToken, feature) => {
    const available = await featureAvailability(organizationId, accessToken);
    if (!available[feature]) throw new HttpError(404, 'FEATURE_UNAVAILABLE');
  };
  const run = handler => async req => { try { return await handler(req); } catch (error) { return safeThrown(error); } };

  const dashboard = run(async req => {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const u = new URL(req.url); const organizationId = u.searchParams.get('organizationId');
    const accountId = u.searchParams.get('accountId'); const from = u.searchParams.get('from'); const to = u.searchParams.get('to');
    const actor = await authorize(req, organizationId);
    if ((accountId && !UUID.test(accountId)) || !validDate(from) || !validDate(to) || Date.parse(from) >= Date.parse(to)) throw new HttpError(400, 'INVALID_QUERY');
    return ok(await db.getDashboard({ organizationId, accountId, from, to, actorUserId: actor.userId, accessToken: actor.accessToken }));
  });

  const manualMovement = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req); const key = idempotency(req);
    const fields = ['organizationId','accountId','kind','amountMinor','currency','occurredAt','description','evidenceRef'];
    const supportedKinds = ['cash_deposit','purchase','pay','misc_spend','other_inflow'];
    const signedAsExpected = ['cash_deposit','other_inflow'].includes(body.kind) ? body.amountMinor > 0 : ['purchase','pay','misc_spend'].includes(body.kind) ? body.amountMinor < 0 : true;
    if (!exactObject(body, fields, fields) || !UUID.test(body.organizationId) || !UUID.test(body.accountId) || !supportedKinds.includes(body.kind) || !validMoney(body.amountMinor) || !signedAsExpected || !/^[A-Z]{3}$/.test(body.currency) || !validDate(body.occurredAt) || !text(body.description, 500) || !text(body.evidenceRef, 1000)) throw new HttpError(400, 'INVALID_MOVEMENT');
    const actor = await authorize(req, body.organizationId, ['owner','operator']);
    const userDb = db.asUser(actor.accessToken);
    if (typeof userDb?.rpc !== 'function') throw new HttpError(503, 'DATABASE_UNAVAILABLE');
    const { data, error } = await userDb.rpc('record_cash_movement', { organization_id: body.organizationId, account_id: body.accountId, kind: body.kind, amount_minor: body.amountMinor, currency: body.currency, occurred_at: body.occurredAt, description: body.description, evidence_file_id: body.evidenceRef, idempotency_key: key, approved_by: null });
    if (error) throw new Error('Cash movement RPC failed');
    return created({ id: data });
  });

  const observation = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req); const key = idempotency(req);
    const fields = ['organizationId','accountId','amountMinor','currency','observedAt','evidenceRef'];
    if (!exactObject(body, fields, fields) || !UUID.test(body.organizationId) || !UUID.test(body.accountId) || !Number.isSafeInteger(body.amountMinor) || !/^[A-Z]{3}$/.test(body.currency) || !validDate(body.observedAt) || !text(body.evidenceRef, 1000)) throw new HttpError(400, 'INVALID_OBSERVATION');
    const actor = await authorize(req, body.organizationId, ['owner','operator']);
    const userDb = db.asUser(actor.accessToken);
    if (typeof userDb?.rpc !== 'function') throw new HttpError(503, 'DATABASE_UNAVAILABLE');
    const { data, error } = await userDb.rpc('record_balance_observation', { organization_id: body.organizationId, account_id: body.accountId, amount_minor: body.amountMinor, currency: body.currency, observed_at: body.observedAt, evidence_file_id: body.evidenceRef, idempotency_key: key });
    if (error) throw new Error('Balance observation RPC failed');
    return created({ id: data, idempotencyKey: key });
  });

  const proposal = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req); const key = idempotency(req);
    if (!exactObject(body, ['organizationId','issueId']) || !UUID.test(body.organizationId) || !UUID.test(body.issueId)) throw new HttpError(400, 'INVALID_PROPOSAL_REQUEST');
    const actor = await authorize(req, body.organizationId, ['owner','operator']);
    const issue = await db.getIssue({ organizationId: body.organizationId, issueId: body.issueId, accessToken: actor.accessToken });
    if (!issue) throw new HttpError(404, 'ISSUE_NOT_FOUND');
    if (!SUPPORTED_DIAGNOSIS_ISSUE_TYPES.includes(issue.type)) throw new HttpError(422, 'PROPOSAL_UNAVAILABLE');
    const evidence = await db.getIssueEvidence({ organizationId: body.organizationId, issueId: body.issueId, accessToken: actor.accessToken });
    const draft = await diagnoseIssue({ issue: { id: issue.id, type: issue.type, code: issue.code, details: issue.details }, records: evidence, policyVersion: issue.policyVersion, allowedCategories: issue.allowedCategories }, {
      apiKey: config.openRouterApiKey,
      fetchImpl: adapters.fetchImpl ?? fetch,
      model: config.openRouterModel,
      maxOutputTokens: config.openRouterMaxOutputTokens,
      reserveBudget: args => db.reserveModelBudget({ ...args, organizationId: body.organizationId, accessToken: actor.accessToken }),
      recordUsage: args => db.recordModelUsage({ ...args, organizationId: body.organizationId, accessToken: actor.accessToken })
    });
    return created(await db.createProposalAtomic({ organizationId: body.organizationId, issueId: body.issueId, proposal: draft.proposal, modelId: draft.model, promptVersion: draft.promptVersion, validationStatus: 'valid', decision: 'pending', idempotencyKey: key, actorUserId: actor.userId, accessToken: actor.accessToken, correlationId: req.headers.get('x-correlation-id') ?? randomUUID() }));
  });

  const correctionWindow = issue => {
    const startAt = Date.parse(issue.details?.period_start ?? '');
    const endAt = Date.parse(issue.details?.period_end ?? '');
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt || endAt - startAt > 370 * 24 * 60 * 60 * 1000) {
      throw new HttpError(409, 'ISSUE_PERIOD_UNAVAILABLE');
    }
    return { startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString() };
  };
  const itemCost = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req); const key = idempotency(req);
    if (!exactObject(body, ['organizationId','squareCatalogObjectId','name','unitCostMinor','currency','effectiveFrom','reason'])
        || !UUID.test(body.organizationId) || !text(body.squareCatalogObjectId, 200) || !text(body.name, 200)
        || !Number.isSafeInteger(body.unitCostMinor) || body.unitCostMinor < 0 || body.unitCostMinor >= 1_000_000_000_000
        || !/^[A-Z]{3}$/.test(body.currency) || !validDate(body.effectiveFrom)
        || !text(body.reason, 1000) || body.reason.trim().length < 10) throw new HttpError(400, 'INVALID_ITEM_COST');
    const actor = await authorize(req, body.organizationId, ['owner','reviewer']);
    const issueId = new URL(req.url).pathname.split('/').at(-2) ?? '';
    if (!UUID.test(issueId)) throw new HttpError(400, 'INVALID_ISSUE_ID');
    const issue = await db.getIssue({ organizationId: body.organizationId, issueId, accessToken: actor.accessToken });
    if (!issue || issue.code !== 'UNKNOWN_ITEM' || issue.state === 'resolved') throw new HttpError(404, 'UNKNOWN_ITEM_ISSUE_NOT_FOUND');
    const window = correctionWindow(issue);
    const definition = await db.recordItemDefinition({ organizationId: body.organizationId, issueId: issue.id,
      squareCatalogObjectId: body.squareCatalogObjectId.trim(), name: body.name.trim(), unitCostMinor: body.unitCostMinor,
      currency: body.currency, effectiveFrom: body.effectiveFrom, reason: body.reason.trim(), idempotencyKey: key,
      accessToken: actor.accessToken });
    const replay = await queue.enqueueProjectionReplay({ organizationId: body.organizationId, ...window,
      idempotencyKey: `item-cost:${issue.id}:${key}`, requestedBy: actor.userId });
    return created({ ...definition, projectionJobId: replay.id, projectionQueued: true });
  });
  const saleLineCost = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req); const key = idempotency(req);
    if (!exactObject(body, ['organizationId','squareOrderId','squareLineUid','unitCostMinor','currency','reason'])
        || !UUID.test(body.organizationId) || !text(body.squareOrderId, 200) || !text(body.squareLineUid, 200)
        || !/^[A-Za-z0-9_-]{1,200}$/.test(body.squareOrderId) || !/^[A-Za-z0-9_-]{1,200}$/.test(body.squareLineUid)
        || !Number.isSafeInteger(body.unitCostMinor) || body.unitCostMinor < 0 || body.unitCostMinor >= 1_000_000_000_000
        || !/^[A-Z]{3}$/.test(body.currency) || !text(body.reason, 1000) || body.reason.trim().length < 10) {
      throw new HttpError(400, 'INVALID_SALE_LINE_COST');
    }
    const actor = await authorize(req, body.organizationId, ['owner','reviewer']);
    const issueId = new URL(req.url).pathname.split('/').at(-2) ?? '';
    if (!UUID.test(issueId)) throw new HttpError(400, 'INVALID_ISSUE_ID');
    const issue = await db.getIssue({ organizationId: body.organizationId, issueId, accessToken: actor.accessToken });
    if (!issue || issue.code !== 'UNKNOWN_ITEM' || issue.state === 'resolved') throw new HttpError(404, 'UNKNOWN_ITEM_ISSUE_NOT_FOUND');
    const window = correctionWindow(issue);
    const override = await db.recordSaleLineCostOverride({ organizationId: body.organizationId, issueId: issue.id,
      squareOrderId: body.squareOrderId.trim(), squareLineUid: body.squareLineUid.trim(),
      unitCostMinor: body.unitCostMinor, currency: body.currency,
      reason: body.reason.trim(), idempotencyKey: key, accessToken: actor.accessToken });
    const replay = await queue.enqueueProjectionReplay({ organizationId: body.organizationId, ...window,
      idempotencyKey: `line-cost:${issue.id}:${key}`, requestedBy: actor.userId });
    return created({ ...override, projectionJobId: replay.id, projectionQueued: true });
  });
  const refundReview = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req); const key = idempotency(req);
    if (!exactObject(body, ['organizationId','squareRefundId','squareOrderId','disposition','approvedCogsReversalMinor','currency','reason'])
        || !UUID.test(body.organizationId) || !text(body.squareRefundId, 200) || !text(body.squareOrderId, 200)
        || !['returned_to_inventory','not_returned_to_inventory'].includes(body.disposition)
        || !Number.isSafeInteger(body.approvedCogsReversalMinor) || body.approvedCogsReversalMinor < 0
        || !/^[A-Z]{3}$/.test(body.currency) || !text(body.reason, 1000) || body.reason.trim().length < 10
        || (body.disposition === 'not_returned_to_inventory' && body.approvedCogsReversalMinor !== 0)) throw new HttpError(400, 'INVALID_REFUND_REVIEW');
    const actor = await authorize(req, body.organizationId, ['owner','reviewer']);
    const issueId = new URL(req.url).pathname.split('/').at(-2) ?? '';
    if (!UUID.test(issueId)) throw new HttpError(400, 'INVALID_ISSUE_ID');
    const issue = await db.getIssue({ organizationId: body.organizationId, issueId, accessToken: actor.accessToken });
    if (!issue || issue.code !== 'REFUND_COGS_REVIEW' || issue.state === 'resolved') throw new HttpError(404, 'REFUND_REVIEW_ISSUE_NOT_FOUND');
    const window = correctionWindow(issue);
    const review = await db.recordRefundCostReview({ organizationId: body.organizationId, issueId: issue.id,
      squareRefundId: body.squareRefundId.trim(), squareOrderId: body.squareOrderId.trim(), disposition: body.disposition,
      approvedCogsReversalMinor: body.approvedCogsReversalMinor, currency: body.currency,
      reason: body.reason.trim(), idempotencyKey: key, accessToken: actor.accessToken });
    const replay = await queue.enqueueProjectionReplay({ organizationId: body.organizationId, ...window,
      idempotencyKey: `refund-review:${issue.id}:${key}`, requestedBy: actor.userId });
    return created({ ...review, projectionJobId: replay.id, projectionQueued: true });
  });

  const decision = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req); const key = idempotency(req);
    if (!exactObject(body, ['organizationId','issueId','proposalId','decision','reason','expectedRevision']) || !UUID.test(body.organizationId) || !UUID.test(body.issueId) || !UUID.test(body.proposalId) || !['approve','reject'].includes(body.decision) || !text(body.reason, 1000) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) throw new HttpError(400, 'INVALID_DECISION');
    const actor = await authorize(req, body.organizationId, ['owner','reviewer']);
    const userDb = db.asUser(actor.accessToken);
    if (typeof userDb?.rpc !== 'function') throw new HttpError(503, 'DATABASE_UNAVAILABLE');
    const { data, error } = await userDb.rpc('decide_proposal', { organization_id: body.organizationId, proposal_id: body.proposalId, decision: body.decision === 'approve' ? 'approved' : 'rejected', reason: body.reason, expected_revision: body.expectedRevision, idempotency_key: key });
    if (error) throw new Error('Proposal decision RPC failed');
    return ok({ id: data });
  });

  const replay = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req); const key = idempotency(req);
    if (!exactObject(body, ['organizationId','runId','calculationVersion']) || !UUID.test(body.organizationId) || !UUID.test(body.runId) || !text(body.calculationVersion, 100)) throw new HttpError(400, 'INVALID_REPLAY');
    const actor = await authorize(req, body.organizationId, ['owner','reviewer']);
    const snapshot = await db.getReplaySnapshot({ organizationId: body.organizationId, runId: body.runId, accessToken: actor.accessToken });
    if (!snapshot) throw new HttpError(404, 'RUN_NOT_FOUND');
    // engine is injected so policy/version selection is controlled server-side.
    if (typeof adapters.engine?.replayAccounting !== 'function') throw new HttpError(503, 'ENGINE_UNAVAILABLE');
    const result = adapters.engine.replayAccounting(snapshot);
    return created(await db.saveProjectionRun({ organizationId: body.organizationId, sourceRunId: body.runId, calculationVersion: body.calculationVersion, result, idempotencyKey: key, actorUserId: actor.userId, accessToken: actor.accessToken, correlationId: req.headers.get('x-correlation-id') ?? randomUUID() }));
  });

  const sync = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req); const key = idempotency(req);
    if (!exactObject(body, ['organizationId','startAt','endAt']) || !UUID.test(body.organizationId) || !validDate(body.startAt) || !validDate(body.endAt) || Date.parse(body.startAt) >= Date.parse(body.endAt)) throw new HttpError(400, 'INVALID_SYNC');
    if (Date.parse(body.endAt) - Date.parse(body.startAt) > MAX_SYNC_WINDOW_MS) throw new HttpError(400, 'SYNC_WINDOW_TOO_LARGE');
    const actor = await authorize(req, body.organizationId, ['owner']);
    let coverage = null;
    if (typeof db.getSquareSyncCoverage === 'function') {
      try {
        coverage = await db.getSquareSyncCoverage({ organizationId: body.organizationId, startAt: body.startAt, endAt: body.endAt, accessToken: actor.accessToken });
      } catch (error) {
        // Keep existing deployments working until the small coverage RPC is applied.
        if (error?.code !== 'PGRST202') throw new HttpError(503, 'SQUARE_SYNC_STATUS_UNAVAILABLE');
      }
    }
    const gaps = uncoveredWindows(coverage?.windows, body.startAt, body.endAt);
    const pendingWindows = Array.isArray(coverage?.pendingWindows) ? coverage.pendingWindows : [];
    const sourceGaps = coverage?.sourceGaps ?? {};
    const hasSourceGaps = !Number.isSafeInteger(sourceGaps.missingParentOrderLineCount)
      || !Number.isSafeInteger(sourceGaps.missingPayoutEntryHealthCount)
      || sourceGaps.missingParentOrderLineCount > 0 || sourceGaps.missingPayoutEntryHealthCount > 0;
    const canTrustCoverage = coverage && typeof coverage.sourceHealthFresh === 'boolean' && Array.isArray(coverage.windows)
      && Array.isArray(coverage.pendingWindows)
      && Number.isSafeInteger(sourceGaps.missingParentOrderLineCount) && Number.isSafeInteger(sourceGaps.missingPayoutEntryHealthCount);
    if (canTrustCoverage && coverage.sourceHealthFresh && !hasSourceGaps && gaps.length === 0) {
      return ok({ skipped: true, reason: 'PERIOD_CURRENT', startAt: body.startAt, endAt: body.endAt });
    }
    const refreshWholeWindow = !canTrustCoverage || !coverage.sourceHealthFresh || hasSourceGaps;
    const plannedWindows = refreshWholeWindow ? [{ startAt: body.startAt, endAt: body.endAt }] : gaps;
    const windowsToSync = plannedWindows.flatMap(window => uncoveredWindows(pendingWindows, window.startAt, window.endAt));
    if (!windowsToSync.length) return ok({ skipped: true, reason: 'SYNC_IN_PROGRESS', startAt: body.startAt, endAt: body.endAt });
    if (typeof adapters.listSquareLocations !== 'function') throw new HttpError(503, 'SQUARE_SYNC_UNAVAILABLE');
    let locations;
    try { locations = await adapters.listSquareLocations({ organizationId: body.organizationId }); }
    catch (error) {
      if (error?.code === 'SQUARE_NOT_CONNECTED') throw new HttpError(409, 'SQUARE_NOT_CONNECTED');
      if (error?.code === 'SQUARE_RECONNECT_REQUIRED' || error?.status === 401) throw new HttpError(409, 'SQUARE_RECONNECT_REQUIRED');
      if (error?.status === 403) throw new HttpError(403, 'SQUARE_PERMISSION_REQUIRED');
      if (error?.code === 'SQUARE_SYNC_UNAVAILABLE') throw new HttpError(503, 'SQUARE_SYNC_UNAVAILABLE');
      throw new HttpError(502, 'SQUARE_LOCATIONS_UNAVAILABLE');
    }
    if (!Array.isArray(locations) || locations.some(location => !text(location?.id, 200))) throw new HttpError(502, 'SQUARE_LOCATIONS_UNAVAILABLE');
    const locationIds = [...new Set(locations.map(location => location.id))];
    if (!locationIds.length) throw new HttpError(409, 'SQUARE_NO_ACTIVE_LOCATIONS');
    if (locationIds.length > 100) throw new HttpError(409, 'SQUARE_LOCATION_LIMIT_EXCEEDED');
    const jobs = [];
    for (const window of windowsToSync) {
      const isWholeWindow = Date.parse(window.startAt) === Date.parse(body.startAt) && Date.parse(window.endAt) === Date.parse(body.endAt);
      const windowKey = isWholeWindow ? key : `square-sync:${createHash('sha256').update(`${key}:${window.startAt}:${window.endAt}`).digest('hex').slice(0, 48)}`;
      const startAt = isWholeWindow ? body.startAt : window.startAt;
      const endAt = isWholeWindow ? body.endAt : window.endAt;
      const job = await queue.enqueueSquareSync({
        organizationId: body.organizationId, startAt, endAt,
        locationIds, idempotencyKey: windowKey, requestedBy: actor.userId,
      });
      jobs.push({ ...job, startAt, endAt });
    }
    return created({
      ...(jobs.length === 1 ? jobs[0] : { jobs }),
      queuedWindows: jobs.length,
      syncScope: refreshWholeWindow ? 'period' : 'uncovered',
    });
  });

  const webhook = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const rawBody = Buffer.from(await readBytes(req, 1_000_000));
    const result = await acceptSquareWebhook({ rawBody, signature: req.headers.get('x-square-hmacsha256-signature'), signatureKey: config.squareWebhookSignatureKey, notificationUrl: config.squareNotificationUrl, inbox: adapters.webhookInbox });
    // Queueing must be durable and idempotent by notificationId; enqueue duplicates
    // too so a failed enqueue can be recovered when Square retries delivery.
    await queue.enqueueSquareWebhook({ notificationId: result.record.notificationId });
    return ok({ accepted: true, duplicate: !result.inserted });
  });

  const issues = run(async req => {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const u = new URL(req.url); const organizationId = u.searchParams.get('organizationId');
    const actor = await authorize(req, organizationId);
    const records = await db.listIssues({ organizationId, state: u.searchParams.get('state') ?? undefined, accessToken: actor.accessToken });
    return ok({ issues: records });
  });
  const issueEvidence = run(async req => {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const u = new URL(req.url); const organizationId = u.searchParams.get('organizationId');
    const issueId = u.pathname.split('/').at(-2) ?? '';
    if (!UUID.test(organizationId ?? '') || !UUID.test(issueId)) throw new HttpError(400, 'INVALID_ISSUE_EVIDENCE_REQUEST');
    const actor = await authorize(req, organizationId, ['owner','operator','reviewer','read_only']);
    const issue = await db.getIssue({ organizationId, issueId, accessToken: actor.accessToken });
    if (!issue) throw new HttpError(404, 'ISSUE_NOT_FOUND');
    const result = await db.getIssueEvidence({ organizationId, issueId, accessToken: actor.accessToken });
    return ok(Array.isArray(result) ? { evidence: result, correctionReady: result.correctionReady ?? true } : result);
  });
  const manualMovements = run(async req => {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const u = new URL(req.url); const organizationId = u.searchParams.get('organizationId');
    const actor = await authorize(req, organizationId);
    const accountId = u.searchParams.get('accountId') ?? undefined, from = u.searchParams.get('from') ?? undefined, to = u.searchParams.get('to') ?? undefined;
    if ((accountId && !UUID.test(accountId)) || (from && !validDate(from)) || (to && !validDate(to)) || (from && to && Date.parse(from) >= Date.parse(to))) throw new HttpError(400, 'INVALID_QUERY');
    return ok({ movements: await db.listManualMovements({ organizationId, accountId, from, to, accessToken: actor.accessToken }) });
  });
  const observations = run(async req => {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const u = new URL(req.url); const organizationId = u.searchParams.get('organizationId');
    const actor = await authorize(req, organizationId);
    const accountId = u.searchParams.get('accountId') ?? undefined;
    if (accountId && !UUID.test(accountId)) throw new HttpError(400, 'INVALID_QUERY');
    return ok({ observations: await db.listObservations({ organizationId, accountId, accessToken: actor.accessToken }) });
  });
  const audit = run(async req => {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const u = new URL(req.url); const organizationId = u.searchParams.get('organizationId');
    const actor = await authorize(req, organizationId);
    const limit = Number(u.searchParams.get('limit') ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, 'INVALID_QUERY');
    return ok({ events: await db.listAuditEvents({ organizationId, limit, accessToken: actor.accessToken }) });
  });
  const settings = run(async req => {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const u = new URL(req.url); const organizationId = u.searchParams.get('organizationId');
    const actor = await authorize(req, organizationId);
    const settingsData = await db.getSettings({ organizationId, accessToken: actor.accessToken });
    const availability = await featureAvailability(organizationId, actor.accessToken);
    return ok({ settings: { ...settingsData, features: availability } });
  });

  const inventory = run(async req => {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const u = new URL(req.url), organizationId = u.searchParams.get('organizationId');
    const from = u.searchParams.get('from'), to = u.searchParams.get('to');
    if (!validDate(from) || !validDate(to) || Date.parse(from) >= Date.parse(to) || Date.parse(to) - Date.parse(from) > 366 * 86400000) throw new HttpError(400, 'INVALID_QUERY');
    const actor = await authorize(req, organizationId);
    await requireFeature(organizationId, actor.accessToken, 'inventoryTracking');
    if (typeof db.listInventoryMovements !== 'function' || typeof db.getInventorySnapshot !== 'function') throw new HttpError(503, 'INVENTORY_UNAVAILABLE');
    const currency = u.searchParams.get('currency');
    if (!/^[A-Z]{3}$/.test(currency ?? '')) throw new HttpError(400, 'INVALID_QUERY');
    const [movements, snapshot] = await Promise.all([
      db.listInventoryMovements({ organizationId, from, to, accessToken: actor.accessToken }),
      db.getInventorySnapshot({ organizationId, from, to, currency, accessToken: actor.accessToken }),
    ]);
    const normalizedMovements = (snapshot.movements ?? []).map(m => ({ id: m.id, version: m.version ?? 1,
      itemId: m.item_definition_id ?? m.inventory_item_id ?? m.itemId, squareCatalogObjectId: m.square_catalog_object_id ?? null,
      itemName: m.item_name ?? m.itemName, quantityDelta: Number(m.quantity_delta ?? m.quantityDelta),
      currency: m.currency, occurredAt: utc(m.occurred_at ?? m.occurredAt),
      kind: ['opening_balance','opening'].includes(m.movement_type ?? m.kind) ? 'opening' : ['purchase','purchase_receipt'].includes(m.movement_type ?? m.kind) ? 'purchase' : 'adjustment',
      evidenceId: m.evidence_file_id ?? m.evidenceId, reason: m.reason }));
    const normalizedLines = (snapshot.lines ?? []).map(line => ({ ...line, id: line.id ?? line.objectId,
      version: line.version ?? 1, occurredAt: utc(line.occurredAt ?? line.occurred_at),
      itemName: line.itemName ?? line.name, status: line.status ?? 'completed' }));
    const report = calculateInventory({ movements: normalizedMovements, lines: normalizedLines, from, to, currency,
      itemDefinitions: (snapshot.items ?? []).map(item => ({ id: item.id, squareCatalogObjectId: item.square_catalog_object_id ?? item.squareCatalogObjectId, name: item.name })) });
    const coverageFrom = snapshot.sourceCoverage?.requiredFrom ?? from;
    const snapshotHealth = snapshot.sourceHealth ?? [];
    const inventoryHealthIncomplete = sourceHealthIncomplete(snapshotHealth, ['square', 'orders', 'catalog']);
    const missingInventoryParents = (snapshot.sourceGaps?.missingParentOrderLineCount ?? 0) > 0;
    if (!windowCovered(snapshot.sourceCoverage?.windows, coverageFrom, to) || inventoryHealthIncomplete || missingInventoryParents) {
      if (report.status !== 'failed') report.status = 'incomplete';
      report.issues.push({ code: missingInventoryParents ? 'SOURCE_PARENT_MISSING' : inventoryHealthIncomplete ? 'SOURCE_HEALTH_INCOMPLETE' : 'SOURCE_WINDOW_UNVERIFIED', sourceRefs: [] });
      for (const item of report.items) item.onHandQuantity = null;
    }
    const currentItems = (snapshot.items ?? []).map(item => ({ id: item.id, name: item.name, currency: item.currency }));
    const displayMovements = (movements ?? []).map(m => ({ id: m.id, item_id: m.item_definition_id ?? m.inventory_item_id, item_name: m.item_name,
      quantity_delta: Number(m.quantity_delta), occurred_at: m.occurred_at, movement_type: m.movement_type,
      reason: m.reason, evidence_file_id: m.evidence_file_id, currency: m.currency }));
    return ok({ movements: displayMovements, snapshot: { asOf: to, items: currentItems,
      balances: report.items.map(item => ({ itemDefinitionId: item.itemId, itemName: item.itemName, currency, quantity: item.onHandQuantity })),
      status: report.status, issues: report.issues, sourceCoverage: snapshot.sourceCoverage ?? null, sourceHealth: snapshot.sourceHealth ?? [] }, inventory: report });
  });
  const inventoryPurchase = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req), key = idempotency(req);
    const fields = ['organizationId','accountId','amountMinor','occurredAt','currency','description','evidenceRef','lines'];
    if (!exactObject(body, fields) || !UUID.test(body.organizationId) || !UUID.test(body.accountId) || !validDate(body.occurredAt)
        || !/^[A-Z]{3}$/.test(body.currency) || !text(body.description, 500) || !UUID.test(body.evidenceRef ?? '')
        || !Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 100) throw new HttpError(400, 'INVALID_INVENTORY_PURCHASE');
    let totalMinor = 0;
    for (const line of body.lines) {
      if (!exactObject(line, ['itemId','itemName','quantity','unitCostMinor']) || !UUID.test(line.itemId ?? '') || !text(line.itemName, 200)
          || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 1_000_000
          || !Number.isSafeInteger(line.unitCostMinor) || line.unitCostMinor < 0 || line.unitCostMinor >= 1_000_000_000_000) throw new HttpError(400, 'INVALID_INVENTORY_PURCHASE');
      const lineTotal = line.quantity * line.unitCostMinor;
      if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(totalMinor + lineTotal)) throw new HttpError(400, 'INVALID_INVENTORY_PURCHASE');
      totalMinor += lineTotal;
    }
    if (!Number.isSafeInteger(body.amountMinor) || body.amountMinor >= 0 || Math.abs(body.amountMinor) >= 1_000_000_000_000 || Math.abs(body.amountMinor) < totalMinor) throw new HttpError(400, 'INVALID_INVENTORY_PURCHASE');
    const actor = await authorize(req, body.organizationId, ['owner','operator']);
    await requireFeature(body.organizationId, actor.accessToken, 'inventoryTracking');
    if (typeof db.recordInventoryPurchase !== 'function') throw new HttpError(503, 'INVENTORY_UNAVAILABLE');
    const result = await db.recordInventoryPurchase({ organizationId: body.organizationId, accountId: body.accountId,
      amountMinor: body.amountMinor, currency: body.currency, occurredAt: body.occurredAt, description: body.description.trim(),
      evidenceFileId: body.evidenceRef, idempotencyKey: key, lines: body.lines.map(line => ({ ...line, itemId: line.itemId.trim(), itemName: line.itemName.trim() })) , accessToken: actor.accessToken });
    return created(result);
  });
  const receiptDraft = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req, 40_000);
    if (!exactObject(body, ['organizationId','currency','text']) || !UUID.test(body.organizationId ?? '')
        || !/^[A-Z]{3}$/.test(body.currency ?? '') || typeof body.text !== 'string'
        || !body.text.trim() || body.text.length > 8_000) throw new HttpError(400, 'INVALID_RECEIPT_TEXT');
    const actor = await authorize(req, body.organizationId, ['owner','operator','reviewer']);
    await requireFeature(body.organizationId, actor.accessToken, 'inventoryTracking');
    if (typeof db.reserveReceiptModelBudget !== 'function' || typeof db.recordReceiptModelUsage !== 'function'
        || typeof db.listReceiptCatalogCandidates !== 'function') throw new HttpError(503, 'RECEIPT_AGENT_UNAVAILABLE');
    const candidates = await db.listReceiptCatalogCandidates({ organizationId: body.organizationId, currency: body.currency, accessToken: actor.accessToken });
    const runId = randomUUID();
    const draft = await extractReceipt({ text: body.text, currency: body.currency }, {
      apiKey: config.openRouterApiKey,
      reserveBudget: args => db.reserveReceiptModelBudget({ organizationId: body.organizationId, runId, ...args, accessToken: actor.accessToken }),
      recordUsage: args => db.recordReceiptModelUsage({ organizationId: body.organizationId, runId, ...args, accessToken: actor.accessToken })
    });
    return ok({ draft, candidates });
  });
  const receiptItemCosts = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req), key = idempotency(req);
    if (!exactObject(body, ['organizationId','evidenceRef','reason','updates']) || !UUID.test(body.organizationId ?? '')
        || !UUID.test(body.evidenceRef ?? '') || !text(body.reason, 1000) || body.reason.trim().length < 10
        || !Array.isArray(body.updates) || body.updates.length < 1 || body.updates.length > 50) throw new HttpError(400, 'INVALID_RECEIPT_COST_APPROVAL');
    const itemIds = new Set();
    for (const update of body.updates) {
      if (!exactObject(update, ['catalogObjectId','name','unitCostMinor','currency','effectiveFrom']) || !text(update.catalogObjectId, 200)
          || !text(update.name, 200)
          || !Number.isSafeInteger(update.unitCostMinor) || update.unitCostMinor < 0 || update.unitCostMinor >= 1_000_000_000_000
          || !/^[A-Z]{3}$/.test(update.currency ?? '') || !validDate(update.effectiveFrom)) throw new HttpError(400, 'INVALID_RECEIPT_COST_APPROVAL');
      if (itemIds.has(update.catalogObjectId)) throw new HttpError(400, 'DUPLICATE_RECEIPT_COST_ITEM');
      itemIds.add(update.catalogObjectId);
    }
    const actor = await authorize(req, body.organizationId, ['owner','reviewer']);
    await requireFeature(body.organizationId, actor.accessToken, 'inventoryTracking');
    const replayEndMs = Date.now() + 1_000;
    if (body.updates.some(update => Date.parse(update.effectiveFrom) <= Date.now() && replayEndMs - Date.parse(update.effectiveFrom) > 370 * 24 * 60 * 60 * 1000)) {
      throw new HttpError(400, 'RECEIPT_COST_DATE_OUTSIDE_REPLAY_WINDOW');
    }
    if (typeof db.recordReceiptItemCosts !== 'function') throw new HttpError(503, 'RECEIPT_COST_APPROVAL_UNAVAILABLE');
    const result = await db.recordReceiptItemCosts({ organizationId: body.organizationId, evidenceFileId: body.evidenceRef,
      reason: body.reason.trim(), idempotencyKey: key,
      updates: body.updates.map(update => ({ ...update, catalogObjectId: update.catalogObjectId.trim(), name: update.name.trim(), effectiveFrom: new Date(update.effectiveFrom).toISOString() })),
      accessToken: actor.accessToken });
    let replay = null;
    if (result?.replayStartAt && result?.replayEndAt) {
      replay = await queue.enqueueProjectionReplay({ organizationId: body.organizationId,
        startAt: result.replayStartAt, endAt: result.replayEndAt,
        idempotencyKey: `receipt-cost:${key}`, requestedBy: actor.userId });
    }
    return created({ updates: result?.updates ?? [], projectionJobId: replay?.id ?? null, projectionQueued: Boolean(replay) });
  });
  const inventoryCorrection = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req), key = idempotency(req);
    if (!exactObject(body, ['organizationId','itemId','quantityDelta','occurredAt','reason','evidenceRef'])
        || !UUID.test(body.organizationId) || !UUID.test(body.itemId ?? '') || !Number.isSafeInteger(body.quantityDelta)
        || body.quantityDelta === 0 || Math.abs(body.quantityDelta) > 1_000_000 || !validDate(body.occurredAt)
        || !text(body.reason, 1000) || body.reason.trim().length < 10 || !UUID.test(body.evidenceRef ?? '')) throw new HttpError(400, 'INVALID_INVENTORY_CORRECTION');
    const actor = await authorize(req, body.organizationId, ['owner','reviewer']);
    await requireFeature(body.organizationId, actor.accessToken, 'inventoryTracking');
    if (typeof db.recordInventoryCorrection !== 'function') throw new HttpError(503, 'INVENTORY_UNAVAILABLE');
    return created(await db.recordInventoryCorrection({ organizationId: body.organizationId, itemId: body.itemId.trim(),
      quantityDelta: body.quantityDelta, occurredAt: body.occurredAt, reason: body.reason.trim(),
      evidenceFileId: body.evidenceRef, idempotencyKey: key, accessToken: actor.accessToken }));
  });
  const inventoryOpening = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req), key = idempotency(req);
    if (!exactObject(body, ['organizationId','itemId','quantity','occurredAt','reason','evidenceRef'])
        || !UUID.test(body.organizationId) || !UUID.test(body.itemId ?? '') || !Number.isSafeInteger(body.quantity)
        || body.quantity < 0 || body.quantity > 1_000_000 || !validDate(body.occurredAt)
        || !text(body.reason, 1000) || body.reason.trim().length < 10 || !UUID.test(body.evidenceRef ?? '')) throw new HttpError(400, 'INVALID_INVENTORY_OPENING');
    const actor = await authorize(req, body.organizationId, ['owner','reviewer']);
    await requireFeature(body.organizationId, actor.accessToken, 'inventoryTracking');
    if (typeof db.recordInventoryOpening !== 'function') throw new HttpError(503, 'INVENTORY_UNAVAILABLE');
    return created(await db.recordInventoryOpening({ organizationId: body.organizationId, itemId: body.itemId.trim(),
      quantity: body.quantity, occurredAt: body.occurredAt, reason: body.reason.trim(),
      evidenceFileId: body.evidenceRef, idempotencyKey: key, accessToken: actor.accessToken }));
  });
  const inventoryItem = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req), key = idempotency(req);
    if (!exactObject(body, ['organizationId','sku','name','currency','evidenceRef','reason'])
        || !UUID.test(body.organizationId) || !text(body.sku, 100) || !text(body.name, 200)
        || !/^[A-Z]{3}$/.test(body.currency) || !UUID.test(body.evidenceRef ?? '')
        || !text(body.reason, 1000) || body.reason.trim().length < 10) throw new HttpError(400, 'INVALID_INVENTORY_ITEM');
    const actor = await authorize(req, body.organizationId, ['owner','reviewer']);
    await requireFeature(body.organizationId, actor.accessToken, 'inventoryTracking');
    if (typeof db.recordInventoryItem !== 'function') throw new HttpError(503, 'INVENTORY_UNAVAILABLE');
    return created(await db.recordInventoryItem({ organizationId: body.organizationId, sku: body.sku.trim(), name: body.name.trim(),
      currency: body.currency, evidenceFileId: body.evidenceRef, reason: body.reason.trim(),
      idempotencyKey: key, accessToken: actor.accessToken }));
  });
  const squareCatalogItem = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req), key = idempotency(req);
    const allowed = ['organizationId','name','variationName','description','sku','priceMinor','unitCostMinor','currency','effectiveFrom','evidenceRef','reason','projectionStartAt','projectionEndAt'];
    const required = ['organizationId','name','variationName','priceMinor','unitCostMinor','currency','effectiveFrom','evidenceRef','reason','projectionStartAt','projectionEndAt'];
    if (!exactObject(body, allowed, required) || !UUID.test(body.organizationId ?? '')
        || !text(body.name, 200) || !text(body.variationName, 200)
        || (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 4096))
        || (body.sku !== undefined && (typeof body.sku !== 'string' || body.sku.length > 100))
        || !Number.isSafeInteger(body.priceMinor) || body.priceMinor <= 0 || body.priceMinor >= 1_000_000_000_000
        || !Number.isSafeInteger(body.unitCostMinor) || body.unitCostMinor < 0 || body.unitCostMinor >= 1_000_000_000_000
        || !/^[A-Z]{3}$/.test(body.currency) || !validDate(body.effectiveFrom)
        || !validDate(body.projectionStartAt) || !validDate(body.projectionEndAt)
        || Date.parse(body.projectionStartAt) >= Date.parse(body.projectionEndAt)
        || Date.parse(body.projectionEndAt) - Date.parse(body.projectionStartAt) > MAX_SYNC_WINDOW_MS
        || !UUID.test(body.evidenceRef ?? '') || !text(body.reason, 1000) || body.reason.trim().length < 10) {
      throw new HttpError(400, 'INVALID_SQUARE_CATALOG_ITEM');
    }
    const actor = await authorize(req, body.organizationId, ['owner']);
    await requireFeature(body.organizationId, actor.accessToken, 'inventoryTracking');
    if (typeof db.hasEvidenceFile !== 'function' || typeof db.recordSquareCatalogItem !== 'function'
        || typeof db.upsertSquareFacts !== 'function' || typeof db.registerSquareCatalogCreationTicket !== 'function'
        || typeof squareCatalog?.createItem !== 'function') throw new HttpError(503, 'SQUARE_CATALOG_UNAVAILABLE');
    if (!await db.hasEvidenceFile({ organizationId: body.organizationId, evidenceFileId: body.evidenceRef, accessToken: actor.accessToken })) {
      throw new HttpError(400, 'INVALID_EVIDENCE_REF');
    }

    let squareItem;
    try {
      squareItem = await squareCatalog.createItem({ organizationId: body.organizationId, idempotencyKey: key,
        name: body.name.trim(), variationName: body.variationName.trim(), description: body.description?.trim() || '',
        sku: body.sku?.trim() || '', priceMinor: body.priceMinor, currency: body.currency });
    } catch (error) {
      const code = error?.code;
      const expected = {
        SQUARE_ENVIRONMENT_UNCONFIGURED: [503, 'SQUARE_CATALOG_UNAVAILABLE'],
        SQUARE_CATALOG_UNAVAILABLE: [503, 'SQUARE_CATALOG_UNAVAILABLE'],
        SQUARE_NOT_CONNECTED: [409, 'SQUARE_NOT_CONNECTED'],
        SQUARE_RECONNECT_REQUIRED: [409, 'SQUARE_RECONNECT_REQUIRED'],
        SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED: [403, 'SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED'],
        SQUARE_CATALOG_WRITE_FAILED: [502, 'SQUARE_CATALOG_WRITE_FAILED'],
        SQUARE_CATALOG_RESPONSE_INVALID: [502, 'SQUARE_CATALOG_WRITE_FAILED'],
      }[code];
      if (expected) throw new HttpError(expected[0], expected[1]);
      throw error;
    }

    const definition = await db.recordSquareCatalogItem({ organizationId: body.organizationId,
      idempotencyKey: key, squareCatalogObjectId: squareItem.squareCatalogObjectId,
      name: body.name.trim(), sku: body.sku?.trim() || null, unitCostMinor: body.unitCostMinor,
      currency: body.currency, effectiveFrom: body.effectiveFrom, evidenceFileId: body.evidenceRef,
      reason: body.reason.trim(), squarePriceMinor: body.priceMinor, accessToken: actor.accessToken });
    const replay = await queue.enqueueProjectionReplay({ organizationId: body.organizationId,
      startAt: body.projectionStartAt, endAt: body.projectionEndAt,
      idempotencyKey: `square-catalog-item:${createHash('sha256').update(`${body.organizationId}:${key}`).digest('hex')}`, requestedBy: actor.userId });
    return created({ ...definition, projectionJobId: replay.id, projectionQueued: true });
  });
  const squareCatalogCreate = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req), key = idempotency(req);
    if (!exactObject(body, ['organizationId','name','description','variations','reason'])
        || !UUID.test(body.organizationId ?? '') || !text(body.name, 200)
        || (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 4096))
        || !text(body.reason, 1000) || body.reason.trim().length < 10
        || !Array.isArray(body.variations) || body.variations.length < 1 || body.variations.length > 250) {
      throw new HttpError(400, 'INVALID_SQUARE_CATALOG_ITEM');
    }
    for (const variation of body.variations) {
      if (!exactObject(variation, ['name','sku','pricingType','priceMinor','currency'], ['name','pricingType'])
          || !text(variation.name, 200)
          || (variation.sku !== undefined && (typeof variation.sku !== 'string' || variation.sku.length > 100))
          || !['FIXED_PRICING','VARIABLE_PRICING'].includes(variation.pricingType)
          || (variation.pricingType === 'FIXED_PRICING'
            ? !Number.isSafeInteger(variation.priceMinor) || variation.priceMinor < 0 || variation.priceMinor >= 1_000_000_000_000 || !/^[A-Z]{3}$/.test(variation.currency ?? '')
            : variation.priceMinor !== undefined && variation.priceMinor !== null)) {
        throw new HttpError(400, 'INVALID_SQUARE_CATALOG_VARIATION');
      }
    }
    const actor = await authorize(req, body.organizationId, ['owner']);
    await requireFeature(body.organizationId, actor.accessToken, 'inventoryTracking');
    if (typeof squareCatalog?.createProduct !== 'function' || typeof db.upsertSquareFacts !== 'function'
        || typeof db.recordSquareCatalogManagementEvent !== 'function') throw new HttpError(503, 'SQUARE_CATALOG_UNAVAILABLE');

    let result;
    try {
      result = await squareCatalog.createProduct({ organizationId: body.organizationId, idempotencyKey: key,
        name: body.name.trim(), description: body.description?.trim() ?? '',
        variations: body.variations.map(variation => ({ name: variation.name.trim(), sku: variation.sku?.trim() ?? '',
          pricingType: variation.pricingType, priceMinor: variation.priceMinor ?? null, currency: variation.currency ?? null })) });
    } catch (error) {
      throw catalogSquareError(error);
    }
    await persistSquareCatalogChange({ organizationId: body.organizationId, accessToken: actor.accessToken,
      idempotencyKey: key, cause: 'create', action: 'create', squareObjectId: result.squareItemId,
      beforeState: {},
      facts: result.facts, afterState: { squareItemId: result.squareItemId, variationCount: result.variationIds.length,
        name: body.name.trim(), description: body.description?.trim() ?? '' }, reason: body.reason.trim() });
    return created({ squareItemId: result.squareItemId, variationIds: result.variationIds });
  });
  const squareCatalogManage = run(async req => {
    if (req.method !== 'PATCH') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(req), key = idempotency(req);
    const fields = ['organizationId','action','squareItemId','squareCatalogObjectId','name','description',
      'variationName','sku','pricingType','priceMinor','currency','reason'];
    if (!exactObject(body, fields, ['organizationId','action','squareItemId','reason']) || !UUID.test(body.organizationId ?? '')
        || !['update_item','update_variation','add_variation','archive','restore'].includes(body.action)
        || !text(body.squareItemId, 200) || !text(body.reason, 1000) || body.reason.trim().length < 10) {
      throw new HttpError(400, 'INVALID_SQUARE_CATALOG_CHANGE');
    }
    const validVariation = needsId => text(body.variationName, 200)
      && (body.sku === undefined || typeof body.sku === 'string' && body.sku.length <= 100)
      && ['FIXED_PRICING','VARIABLE_PRICING'].includes(body.pricingType)
      && (body.pricingType === 'FIXED_PRICING'
        ? Number.isSafeInteger(body.priceMinor) && body.priceMinor >= 0 && body.priceMinor < 1_000_000_000_000 && /^[A-Z]{3}$/.test(body.currency ?? '')
        : body.priceMinor === null || body.priceMinor === undefined)
      && (!needsId || text(body.squareCatalogObjectId, 200));
    if ((body.action === 'update_item' && (!text(body.name, 200)
          || body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 4096)))
        || ((body.action === 'update_variation' || body.action === 'add_variation') && !validVariation(body.action === 'update_variation'))
        || ((body.action === 'archive' || body.action === 'restore')
          && (body.squareCatalogObjectId !== undefined || body.name !== undefined || body.description !== undefined
            || body.variationName !== undefined || body.sku !== undefined || body.pricingType !== undefined
            || body.priceMinor !== undefined || body.currency !== undefined))) {
      throw new HttpError(400, 'INVALID_SQUARE_CATALOG_CHANGE');
    }
    const actor = await authorize(req, body.organizationId, ['owner']);
    await requireFeature(body.organizationId, actor.accessToken, 'inventoryTracking');
    if (typeof squareCatalog?.manageItem !== 'function' || typeof db.upsertSquareFacts !== 'function'
        || typeof db.recordSquareCatalogManagementEvent !== 'function') throw new HttpError(503, 'SQUARE_CATALOG_UNAVAILABLE');
    let result;
    try {
      result = await squareCatalog.manageItem({ organizationId: body.organizationId, idempotencyKey: key,
        action: body.action, squareItemId: body.squareItemId.trim(), squareCatalogObjectId: body.squareCatalogObjectId?.trim(),
        name: body.name?.trim(), description: body.description?.trim() ?? '', variationName: body.variationName?.trim(),
        sku: body.sku?.trim() ?? '', pricingType: body.pricingType, priceMinor: body.priceMinor ?? null, currency: body.currency });
    } catch (error) {
      throw catalogSquareError(error);
    }
    const auditAction = body.action === 'update_item' || body.action === 'update_variation' ? 'update'
      : body.action === 'add_variation' ? 'add_variation' : body.action;
    await persistSquareCatalogChange({ organizationId: body.organizationId, accessToken: actor.accessToken,
      idempotencyKey: key, cause: auditAction, action: auditAction,
      squareObjectId: result.squareCatalogObjectId ?? result.squareItemId,
      beforeState: result.before ?? {},
      facts: result.facts, afterState: { squareItemId: result.squareItemId,
        ...(result.squareCatalogObjectId ? { squareCatalogObjectId: result.squareCatalogObjectId } : {}),
        ...(result.after ?? {}) }, reason: body.reason.trim() });
    return ok({ squareItemId: result.squareItemId, squareCatalogObjectId: result.squareCatalogObjectId ?? null });
  });

  async function persistSquareCatalogChange({ organizationId, accessToken, idempotencyKey, cause, action,
    squareObjectId, beforeState, facts, afterState, reason }) {
    try {
      await db.upsertSquareFacts({ organizationId, facts, cause: `catalog-${cause}:${idempotencyKey}` });
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z0-9]{1,10}$/.test(error.code) ? error.code : 'UNKNOWN';
      console.error(JSON.stringify({ event: 'square_catalog_change_failed', stage: 'fact_write', code }));
      throw new HttpError(503, 'SQUARE_CATALOG_SAVED_REFRESH_PENDING');
    }
    try {
      await db.recordSquareCatalogManagementEvent({ organizationId, accessToken, idempotencyKey,
        action, squareObjectId, beforeState: beforeState ?? {}, afterState, reason });
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z0-9]{1,10}$/.test(error.code) ? error.code : 'UNKNOWN';
      console.error(JSON.stringify({ event: 'square_catalog_change_failed', stage: 'audit_write', code }));
      throw new HttpError(503, 'SQUARE_CATALOG_SAVED_AUDIT_PENDING');
    }
  }

  function catalogSquareError(error) {
    const code = error?.code;
    const status = Number(error?.status);
    const mapped = {
      SQUARE_ENVIRONMENT_UNCONFIGURED: [503, 'SQUARE_CATALOG_UNAVAILABLE'],
      SQUARE_CATALOG_UNAVAILABLE: [503, 'SQUARE_CATALOG_UNAVAILABLE'],
      SQUARE_NOT_CONNECTED: [409, 'SQUARE_NOT_CONNECTED'],
      SQUARE_RECONNECT_REQUIRED: [409, 'SQUARE_RECONNECT_REQUIRED'],
      SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED: [403, 'SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED'],
      SQUARE_CATALOG_OBJECT_UNAVAILABLE: [404, 'SQUARE_CATALOG_OBJECT_UNAVAILABLE'],
      SQUARE_CATALOG_VARIATION_LIMIT: [400, 'SQUARE_CATALOG_VARIATION_LIMIT'],
      SQUARE_CATALOG_RESPONSE_INVALID: [502, 'SQUARE_CATALOG_WRITE_FAILED'],
      SQUARE_CATALOG_WRITE_FAILED: [502, 'SQUARE_CATALOG_WRITE_FAILED'],
      SQUARE_CATALOG_CONFLICT: [409, 'SQUARE_CATALOG_CONFLICT'],
      SQUARE_CATALOG_BUSY: [503, 'SQUARE_CATALOG_BUSY'],
    }[code];
    if (mapped) throw new HttpError(mapped[0], mapped[1]);
    if (status === 401) throw new HttpError(409, 'SQUARE_RECONNECT_REQUIRED');
    if (status === 403) throw new HttpError(403, 'SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED');
    if (status === 404) throw new HttpError(404, 'SQUARE_CATALOG_OBJECT_UNAVAILABLE');
    if (status === 409) throw new HttpError(409, 'SQUARE_CATALOG_CONFLICT');
    if (status === 429) throw new HttpError(503, 'SQUARE_CATALOG_BUSY');
    if (Number.isInteger(status)) throw new HttpError(502, 'SQUARE_CATALOG_WRITE_FAILED');
    throw error;
  }
  const analytics = run(async req => {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const u = new URL(req.url), organizationId = u.searchParams.get('organizationId');
    const from = u.searchParams.get('from'), to = u.searchParams.get('to'), currency = u.searchParams.get('currency');
    if (!validDate(from) || !validDate(to) || Date.parse(from) >= Date.parse(to) || Date.parse(to) - Date.parse(from) > 366 * 86400000 || !/^[A-Z]{3}$/.test(currency ?? '')) throw new HttpError(400, 'INVALID_QUERY');
    const actor = await authorize(req, organizationId);
    await requireFeature(organizationId, actor.accessToken, 'productAnalytics');
    if (typeof db.listProductAnalyticsFacts !== 'function') throw new HttpError(503, 'ANALYTICS_UNAVAILABLE');
    const sourceData = await db.listProductAnalyticsFacts({ organizationId, from, to, currency, accessToken: actor.accessToken });
    let catalogItems = [], catalogStatus = 'available';
    if (typeof db.listProductCatalogItems === 'function') {
      try {
        catalogItems = await db.listProductCatalogItems({ organizationId, accessToken: actor.accessToken });
        if (!Array.isArray(catalogItems)) catalogItems = [];
      } catch (error) {
        catalogStatus = 'unavailable';
        const code = typeof error?.code === 'string' && /^[A-Z0-9]{1,10}$/.test(error.code) ? error.code : 'UNKNOWN';
        console.error(JSON.stringify({ event: 'product_catalog_listing_failed', code }));
      }
    } else catalogStatus = 'unavailable';
    const rows = Array.isArray(sourceData) ? sourceData : Array.isArray(sourceData?.facts) ? sourceData.facts : [];
    const lines = [], refunds = [], fees = [];
    const orderStatuses = new Map(rows.filter(row => row?.kind === 'order').map(row => [row.objectId, row.fact?.status]));
    let missingFee = false;
    for (const row of rows) {
      const fact = row?.fact ?? row;
      if (!fact) continue;
      const normalized = { ...fact, id: fact.id ?? fact.objectId ?? row.objectId, version: fact.version ?? row.version };
      if (row.kind === 'order_line' || row.kind === 'sale_line') {
        normalized.status = String(normalized.status ?? orderStatuses.get(fact.orderId) ?? fact.orderStatus ?? '').toLowerCase();
        normalized.itemName ??= fact.name;
        lines.push(normalized);
      } else if (row.kind === 'refund') {
        normalized.reviewDisposition ??= fact.disposition;
        normalized.status = String(normalized.status ?? '').toLowerCase();
        refunds.push(normalized);
      } else if (row.kind === 'payment') {
        if (String(fact.status).toLowerCase() !== 'completed') continue;
        const invalidFeeStatus = ['missing_processing_fee', 'invalid_processing_fee_amount', 'processing_fee_currency_mismatch', 'processing_fee_out_of_range'].includes(fact.feeStatus);
        // Older normalized payment facts can have a valid Square fee amount
        // without the later-added feeStatus marker. The amount is still source
        // evidence; only explicit invalid statuses or an invalid amount fail.
        if (!Number.isSafeInteger(fact.feeMinor) || fact.feeMinor < 0 || invalidFeeStatus) { missingFee = true; continue; }
        fees.push({ id: normalized.id, version: normalized.version, orderId: fact.orderId, occurredAt: fact.occurredAt, currency: fact.currency, amountMinor: fact.feeMinor, status: 'completed' });
      } else if (row.kind === 'fee' || row.kind === 'payment_fee' || row.kind === 'payout_entry') fees.push(normalized);
    }
    const rawPolicy = sourceData?.policy ?? {};
    const incomePolicy = { tax: rawPolicy.taxTreatment === 'include' ? 'include' : 'exclude', tips: rawPolicy.tipTreatment === 'include' ? 'include' : 'exclude' };
    const report = calculateProductAnalytics({ lines, refunds, fees, from, to, currency, incomePolicy });
    const health = sourceData?.sourceHealth ?? sourceData?.health ?? [];
    const incompleteHealth = sourceHealthIncomplete(health, ['square', 'orders', 'payments', 'refunds', 'catalog', 'payouts'])
      || (sourceData?.sourceGaps?.missingPayoutEntryHealthCount ?? 0) > 0;
    // Product revenue is supported by completed order lines and refunds. A
    // payment/payout fee gap can make net incomplete, but must not erase known
    // item revenue. Keep each completeness gate tied to the facts it governs.
    const incompleteRevenueHealth = sourceHealthIncomplete(health, ['orders', 'refunds'], { includeUnlisted: false });
    const feeHealth = health.filter(row => ['payments', 'payouts'].includes(row?.resource)
      || (typeof row?.resource === 'string' && row.resource.startsWith('payout_entries:')));
    const incompleteFeeHealth = sourceHealthIncomplete(feeHealth, ['payments', 'payouts'])
      || (sourceData?.sourceGaps?.missingPayoutEntryHealthCount ?? 0) > 0;
    const incompleteCoverage = !windowCovered(sourceData?.sourceCoverage?.windows, from, to);
    const missingParents = (sourceData?.sourceGaps?.missingParentOrderLineCount ?? 0) > 0;
    const openIssues = (sourceData?.openIssueCount ?? 0) > 0;
    if (missingFee || incompleteHealth || incompleteCoverage || missingParents || openIssues) {
      if (report.status !== 'failed') report.status = 'incomplete';
    }
    if (incompleteCoverage || missingParents || incompleteRevenueHealth) {
      report.totals.revenueMinor = null; report.totals.costMinor = null; report.totals.netMinor = null;
      if (report.status !== 'failed') for (const product of report.products) {
        product.revenueMinor = null; product.grossMinor = null; product.discountMinor = null; product.refundsMinor = null;
        product.revenueRank = null; product.revenueShareBps = null; product.costMinor = null;
        product.netMinor = null; product.netRank = null; product.marginBps = null;
        product.dailySales = product.dailySales.map(day => ({ ...day, revenueMinor: null }));
      }
      for (const series of [...(report.daily ?? []), ...(report.monthly ?? [])]) {
        series.revenueMinor = null; series.costMinor = null; series.netMinor = null;
      }
    }
    if (incompleteCoverage) {
      report.totals.feesMinor = null; report.unallocated.feesMinor = null;
      for (const series of [...(report.daily ?? []), ...(report.monthly ?? [])]) series.feesMinor = null;
    }
    // Fee-source health can mean the aggregate misses unsettled fees even when
    // some known amounts are present. Keep product contribution before fees.
    if (missingFee || incompleteFeeHealth) {
      report.totals.netMinor = null;
      for (const series of [...(report.daily ?? []), ...(report.monthly ?? [])]) series.netMinor = null;
    }
    if (missingFee) {
      report.totals.feesMinor = null; report.unallocated.feesMinor = null;
      for (const series of [...(report.daily ?? []), ...(report.monthly ?? [])]) series.feesMinor = null;
    }
    if (openIssues) {
      report.totals.costMinor = null; report.totals.netMinor = null;
      for (const product of report.products) { product.costMinor = null; product.netMinor = null; product.netRank = null; product.marginBps = null; }
      for (const series of [...(report.daily ?? []), ...(report.monthly ?? [])]) { series.costMinor = null; series.netMinor = null; }
    }
    if (missingFee || incompleteFeeHealth) report.issues.push({ code: 'PROCESSING_FEE_INCOMPLETE', sourceRefs: [] });
    if (incompleteHealth) report.issues.push({ code: 'SOURCE_HEALTH_INCOMPLETE', sourceRefs: [] });
    if (incompleteCoverage) report.issues.push({ code: 'SOURCE_WINDOW_UNVERIFIED', sourceRefs: [] });
    if (missingParents) report.issues.push({ code: 'SOURCE_PARENT_MISSING', sourceRefs: [] });
    if (openIssues) report.issues.push({ code: 'OPEN_SOURCE_ISSUES', sourceRefs: [] });
    return ok({ analytics: { ...report, catalogItems, catalogStatus, sourceRevision: sourceData?.sourceRevision ?? null,
      sourceCoverage: sourceData?.sourceCoverage ?? null, sourceHealth: health, incomePolicy } });
  });

  const evidence = run(async req => {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    if (typeof db.uploadEvidence !== 'function') throw new HttpError(503, 'EVIDENCE_STORAGE_UNAVAILABLE');
    const contentType = req.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data;')) throw new HttpError(415, 'MULTIPART_REQUIRED');
    const body = await readBytes(req, 10 * 1024 * 1024 + 65_536);
    let form;
    try { form = await new Response(body, { headers: { 'content-type': contentType } }).formData(); }
    catch { throw new HttpError(400, 'INVALID_EVIDENCE_FORM'); }
    const organizationId = form.get('organizationId');
    const file = form.get('file');
    if (typeof organizationId !== 'string' || !UUID.test(organizationId) || !file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
      throw new HttpError(400, 'INVALID_EVIDENCE_FORM');
    }
    if (file.size < 1 || file.size > 10 * 1024 * 1024) throw new HttpError(413, 'EVIDENCE_SIZE_LIMIT');
    const allowedTypes = new Set(['application/pdf', 'image/jpeg', 'image/png']);
    if (!allowedTypes.has(file.type)) throw new HttpError(415, 'UNSUPPORTED_EVIDENCE_TYPE');
    const bytes = Buffer.from(await file.arrayBuffer());
    const isPdf = file.type === 'application/pdf' && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
    const isJpeg = file.type === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = file.type === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!isPdf && !isJpeg && !isPng) throw new HttpError(415, 'EVIDENCE_TYPE_MISMATCH');
    const actor = await authorize(req, organizationId, ['owner', 'operator', 'reviewer']);
    const filename = String(file.name ?? 'evidence').split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160) || 'evidence';
    const stored = await db.uploadEvidence({
      organizationId, uploadedBy: actor.userId, bytes, mimeType: file.type,
      byteSize: bytes.byteLength, sha256Hex: createHash('sha256').update(bytes).digest('hex'), originalFilename: filename
    });
    return created({ evidence: stored });
  });
  const evidenceUrl = run(async req => {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    if (typeof db.getEvidenceSignedUrl !== 'function') throw new HttpError(503, 'EVIDENCE_STORAGE_UNAVAILABLE');
    const u = new URL(req.url);
    const organizationId = u.searchParams.get('organizationId');
    const evidenceId = u.searchParams.get('evidenceId');
    const actor = await authorize(req, organizationId);
    if (!UUID.test(evidenceId ?? '')) throw new HttpError(400, 'INVALID_EVIDENCE_ID');
    const result = await db.getEvidenceSignedUrl({ organizationId, evidenceId, accessToken: actor.accessToken });
    if (!result) throw new HttpError(404, 'EVIDENCE_NOT_FOUND');
    return ok(result);
  });

  return Object.freeze({ dashboard, issues, issueEvidence, audit, settings, inventory, inventoryPurchase, receiptDraft, receiptItemCosts, inventoryCorrection, inventoryOpening, inventoryItem, squareCatalogItem, squareCatalogCreate, squareCatalogManage, analytics, evidence, evidenceUrl, manualMovement, manualMovements, observation, observations, proposal, itemCost, saleLineCost, refundReview, decision, replay, sync, webhook });
}
