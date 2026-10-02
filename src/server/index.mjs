import { acceptSquareWebhook } from '../square/webhooks.mjs';
import { diagnoseIssue, DiagnosisError, SUPPORTED_DIAGNOSIS_ISSUE_TYPES } from '../agent/diagnosis.mjs';
import { createHash, randomUUID } from 'node:crypto';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const roles = new Set(['owner', 'operator', 'reviewer', 'read_only']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const response = (status, value) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
const ok = data => response(200, data);
const created = data => response(201, data);
const bad = (status, code) => response(status, { error: code, code });
function requireAdapters({ supabase, db, queue, config }) {
  if (!supabase?.auth?.getUser || !db || !queue || !config) throw new TypeError('Supabase auth, durable DB/queue adapters, and config are required');
  const required = ['getMembership', 'getDashboard', 'listIssues', 'listManualMovements', 'listObservations', 'listAuditEvents', 'getSettings', 'getIssue', 'getIssueEvidence', 'createProposalAtomic', 'reserveModelBudget', 'recordModelUsage', 'getReplaySnapshot', 'saveProjectionRun', 'asUser'];
  for (const method of required) if (typeof db[method] !== 'function') throw new TypeError(`db.${method} durable adapter method is required`);
  for (const method of ['enqueueSquareSync', 'enqueueSquareWebhook']) if (typeof queue[method] !== 'function') throw new TypeError(`queue.${method} durable adapter method is required`);
  return { supabase, db, queue, config };
}
function exactObject(value, keys, required = keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k)) && required.every(k => own(value, k));
}
function text(value, max = 500) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function validDate(value) { return typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)); }
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
    if (error.code === 'INVALID_INPUT') return response(status, { error: error.code, code: error.code, detail: error.message });
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
  const { supabase, db, queue, config } = requireAdapters(adapters);
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
    if (!exactObject(body, ['organizationId','startAt','endAt','locationIds']) || !UUID.test(body.organizationId) || !validDate(body.startAt) || !validDate(body.endAt) || Date.parse(body.startAt) >= Date.parse(body.endAt) || !Array.isArray(body.locationIds) || body.locationIds.length > 100 || body.locationIds.some(x => !text(x, 200))) throw new HttpError(400, 'INVALID_SYNC');
    const actor = await authorize(req, body.organizationId, ['owner']);
    return created(await queue.enqueueSquareSync({ ...body, idempotencyKey: key, requestedBy: actor.userId }));
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
    return ok({ settings: await db.getSettings({ organizationId, accessToken: actor.accessToken }) });
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
    const actor = await authorize(req, organizationId, ['owner', 'operator']);
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

  return Object.freeze({ dashboard, issues, audit, settings, evidence, evidenceUrl, manualMovement, manualMovements, observation, observations, proposal, decision, replay, sync, webhook });
}
