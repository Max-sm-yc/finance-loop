import { createHash } from 'node:crypto';
import { replayAccounting } from '../engine/index.mjs';
import { backfillSquare, normalizeOrder, normalizePayment, normalizeRefund, normalizeCatalog, normalizePayout, normalizePayoutEntry, normalizeGiftCardActivity } from '../square/sync.mjs';
import { refreshAccessToken } from '../square/client.mjs';
import { diagnoseIssue } from '../agent/diagnosis.mjs';
import { extractPurchaseReceipt } from '../agent/purchase-receipt.mjs';
import { extractDocumentText } from './purchase-receipt-document.mjs';

const JOBS = new Set(['square.webhook', 'square.sync', 'projection.replay', 'issue.investigate', 'receipt.process']);
const EVENT_KIND = new Map([['order', 'order'], ['payment', 'payment'], ['refund', 'refund'], ['catalog', 'catalog'], ['payout', 'payout']]);
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function requireInterface(dependencies) {
  const { queue, db, tokenVault, config } = dependencies ?? {};
  if (!queue || !db || !tokenVault || !config) throw new TypeError('durable queue, database, encrypted token vault, and config adapters are required');
  for (const name of ['claim', 'ack', 'retry', 'deadLetter']) if (typeof queue[name] !== 'function') throw new TypeError(`queue.${name} is required`);
  for (const name of ['getWebhookNotification', 'upsertSquareFacts', 'recordSourceHealth', 'upsertSourceIssue', 'resolveSourceIssueRefs', 'getProjectionSnapshot', 'saveProjectionRunSystem', 'syncProjectionIssues', 'getSyncHealth']) if (typeof db[name] !== 'function') throw new TypeError(`db.${name} is required`);
  if (typeof tokenVault.getDecrypted !== 'function') throw new TypeError('tokenVault.getDecrypted is required');
  return { ...dependencies, queue, db, tokenVault, config };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function errorMessage(error) { return error?.status ? `Square/API failure (${error.status})` : 'Worker job failed'; }
function failureMetadata(error) {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(error.code) ? error.code : null;
  return { status: Number.isInteger(error?.status) ? error.status : null, code };
}
function safeFailureDescription(error) {
  const { status, code } = failureMetadata(error);
  return [status === null ? null : `status=${status}`, code ? `code=${code}` : null].filter(Boolean).join(' ') || 'unclassified error';
}
function zonedMidnightUtc(year, monthIndex, day, timeZone) {
  const target = Date.UTC(year, monthIndex, day);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    instant += target - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  }
  return new Date(instant).toISOString();
}
function monthWindow(value, timeZone = 'America/New_York', fallback = new Date()) {
  const parsed = Date.parse(value ?? '');
  const anchor = new Date(Number.isFinite(parsed) ? parsed : fallback.getTime());
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(anchor).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return {
    startAt: zonedMidnightUtc(parts.year, parts.month - 1, 1, timeZone),
    endAt: zonedMidnightUtc(parts.year, parts.month, 1, timeZone),
  };
}
function eventObject(payload) {
  const root = payload?.data?.object ?? {};
  const key = (payload?.type ?? '').split('.')[0];
  const candidates = [root[key], root.order, root.payment, root.refund, root.catalog_object, root.payout, root.gift_card_activity, payload?.data];
  return candidates.find(x => x && typeof x === 'object' && (x.id || x.object_id)) ?? null;
}
function eventId(payload) { return eventObject(payload)?.id ?? eventObject(payload)?.object_id ?? payload?.data?.id ?? null; }
function eventResource(payload) {
  const type = payload?.type ?? '';
  if (type.startsWith('gift_card.activity.')) return 'gift_card_activity';
  return EVENT_KIND.get(type.split('.')[0]) ?? null;
}
function normalizeResource(resource, value, parentId) {
  if (resource === 'order') return normalizeOrder(value);
  if (resource === 'payment') return normalizePayment(value);
  if (resource === 'refund') return normalizeRefund(value);
  if (resource === 'catalog') return [value, ...(value?.related_objects ?? [])].flatMap(normalizeCatalog);
  if (resource === 'payout') return normalizePayout(value);
  if (resource === 'payout_entry') return normalizePayoutEntry(value, parentId);
  if (resource === 'gift_card_activity') return normalizeGiftCardActivity(value);
  return [];
}

/**
 * Production worker factory. All durable state and idempotency live in `queue`/`db`.
 * The DB must atomically preserve the newest Square version and deduplicate keys;
 * the queue must atomically lease jobs and fence ack/retry/dead-letter calls with
 * the unique leaseToken returned by claim. In-memory adapters are not provided.
 */
export function createWorker(dependencies) {
  const { queue, db, tokenVault, config, makeSquareClient, engine = { replayAccounting }, fetchImpl = fetch,
    extractReceiptDocumentTextFn = extractDocumentText,
    sleep = defaultSleep, now = () => new Date(), random = Math.random } = requireInterface(dependencies);
  if (typeof makeSquareClient !== 'function') throw new TypeError('makeSquareClient is required');
  const retryLimit = Number.isInteger(config.maxJobAttempts) ? Math.max(1, Math.min(config.maxJobAttempts, 12)) : 5;
  const leaseSeconds = Number.isInteger(config.leaseSeconds) ? Math.max(30, Math.min(config.leaseSeconds, 900)) : 120;
  const freshnessTargetMs = Number.isFinite(config.freshnessTargetMs) ? Math.max(60_000, config.freshnessTargetMs) : 24 * 60 * 60 * 1000;
  const maxPages = Number.isInteger(config.maxBackfillPages) ? Math.max(1, Math.min(config.maxBackfillPages, 20_000)) : 10_000;
  const enabledJobTypes = config.enabledJobTypes ?? [...JOBS];
  if (!Array.isArray(enabledJobTypes) || enabledJobTypes.length === 0 || enabledJobTypes.some(type => !JOBS.has(type))) throw new TypeError('config.enabledJobTypes must contain supported job types');

  async function getClient(organizationId) {
    let connection = await tokenVault.getDecrypted({ organizationId });
    if (!connection?.accessToken) throw Object.assign(new Error('Square connection unavailable'), { permanent: true });
    const expiresAt = Date.parse(connection.expiresAt ?? '');
    if (Number.isFinite(expiresAt) && expiresAt <= now().getTime() + 5 * 60_000) {
      if (!connection.refreshToken || !config.squareClientId || !config.squareClientSecret) {
        throw Object.assign(new Error('Square authorization expired and refresh is not configured'), { permanent: true });
      }
      const refreshed = await refreshAccessToken({
        refreshToken: connection.refreshToken, clientId: config.squareClientId,
        clientSecret: config.squareClientSecret, fetchImpl,
        baseUrl: config.squareBaseUrl ?? 'https://connect.squareup.com',
      });
      await tokenVault.storeEncrypted({
        organizationId, connectedBy: connection.connectedBy, merchantId: refreshed.merchant_id ?? connection.merchantId,
        accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token,
        expiresAt: refreshed.expires_at, scopes: refreshed.scopes ?? connection.scopes,
        tokenType: refreshed.token_type ?? connection.tokenType,
      });
      connection = { ...connection, accessToken: refreshed.access_token, expiresAt: refreshed.expires_at };
    }
    // Tokens remain server-side and must be decrypted only inside the adapter.
    return makeSquareClient({ accessToken: connection.accessToken, apiVersion: config.squareApiVersion, baseUrl: config.squareBaseUrl });
  }

  async function writeFacts(organizationId, facts, cause, window = {}, options = {}) {
    if (!facts.length) return { changed: false, revision: null };
    const persistable = facts.filter(fact => fact?.objectId && fact.version !== null && fact.version !== undefined && String(fact.version) !== '');
    const result = persistable.length
      ? await db.upsertSquareFacts({ organizationId, facts: persistable, cause, enforceMonotonicVersion: true })
      : { changed: false, revision: null };
    if (!result || typeof result.changed !== 'boolean') throw new Error('upsertSquareFacts must return {changed, revision}');
    const problems = facts.flatMap(fact => {
      const missing = [];
      if (!fact.objectId || fact.version === null || fact.version === undefined || fact.version === '') missing.push('object_identity_or_version');
      if (fact.currency !== null && fact.currency !== undefined && !/^[A-Z]{3}$/.test(fact.currency)) missing.push('invalid_currency');
      if (fact.kind === 'order_line') {
        if (!fact.occurredAt || !Number.isFinite(Date.parse(fact.occurredAt))) missing.push('missing_occurred_at');
        if (!fact.currency) missing.push('missing_currency');
        if (!Number.isSafeInteger(Number(fact.quantity)) || Number(fact.quantity) <= 0) missing.push('unsupported_or_missing_quantity');
        if (fact.itemType !== 'GIFT_CARD' && (fact.grossMinor === null || fact.discountMinor === null)) missing.push('missing_square_sales_amount');
      }
      if (fact.kind === 'payment' && (!fact.currency || fact.amountMinor === null || (fact.status === 'COMPLETED' && fact.feeMinor === null && options.deferPaymentFees !== true))) missing.push('missing_square_payment_or_fee_amount');
      if ((fact.kind === 'payment' || fact.kind === 'refund' || fact.kind === 'gift_card_activity') && (!fact.occurredAt || !Number.isFinite(Date.parse(fact.occurredAt)))) missing.push('missing_occurred_at');
      if (fact.kind === 'refund' && (!fact.currency || fact.amountMinor === null)) missing.push('missing_square_refund_amount');
      if ((fact.kind === 'payout' || fact.kind === 'payout_entry') && (!fact.currency || fact.amountMinor === null)) missing.push('missing_square_payout_amount');
      if (fact.kind === 'gift_card_activity' && (!fact.currency || fact.amountMinor === null)) missing.push('missing_square_gift_card_amount');
      if (fact.kind === 'gift_card_activity' && !['ACTIVATE', 'LOAD', 'REDEEM'].includes(fact.type)) missing.push('unsupported_gift_card_activity_type');
      return missing.length ? [{ objectId: fact.objectId, fields: missing }] : [];
    });
    const sourceRefs = [...new Set(problems.map(problem => problem.objectId))];
    if (problems.length) {
      await db.recordSourceHealth({ organizationId, resource: 'square', status: 'incomplete', lastSuccessfulSyncAt: null, gap: { code: 'NORMALIZATION_MISSING_MONEY_OR_IDENTITY', problems }, sourceRevision: result.revision, checkedAt: now().toISOString() });
      const unsupported = problems.some(problem => problem.fields.includes('unsupported_gift_card_activity_type'));
      await db.upsertSourceIssue({ organizationId, code: unsupported ? 'UNSUPPORTED_ACTIVITY' : 'SOURCE_GAP', state: 'awaiting_human', revision: result.revision, details: { code: unsupported ? 'UNSUPPORTED_ACTIVITY' : 'NORMALIZATION_MISSING_MONEY_OR_IDENTITY', problems }, sourceRefs });
      return { ...result, incomplete: true, problems };
    }
    const factRefs = [...new Set(facts.map(fact => fact.objectId).filter(Boolean))];
    if (factRefs.length) {
      await db.resolveSourceIssueRefs({ organizationId, code: 'SOURCE_GAP', sourceRefs: factRefs, resolvedAt: now().toISOString() });
      await db.resolveSourceIssueRefs({ organizationId, code: 'UNSUPPORTED_ACTIVITY', sourceRefs: factRefs, resolvedAt: now().toISOString() });
    }
    if (result.changed && options.deferProjection !== true) {
      const projection = await recomputeProjection(organizationId, result.revision, cause, window);
      if (projection?.incomplete) return { ...result, incomplete: true, problems: [projection.gap] };
    }
    return result;
  }

  async function recomputeProjection(organizationId, sourceRevision, cause, window = {}) {
    if (typeof engine?.replayAccounting !== 'function') throw Object.assign(new Error('Accounting engine unavailable'), { permanent: true });
    const snapshot = await db.getProjectionSnapshot({ organizationId, sourceRevision, startAt: window.startAt, endAt: window.endAt });
    if (!snapshot || !Number.isSafeInteger(snapshot.sourceRevision) || !snapshot.snapshot) throw new Error('Projection snapshot is unavailable');
    // Another leased job may have committed while this job was fetching Square.
    // The adapter locks the org revision while assembling the snapshot, so use
    // that coherent latest revision instead of projecting a stale one.
    sourceRevision = snapshot.sourceRevision;
    const sourceSnapshot = snapshot.snapshot ?? snapshot;
    const giftCardLines = (sourceSnapshot.lines ?? []).filter(line => line.status === 'completed' && line.itemType === 'GIFT_CARD');
    const giftCardActivities = sourceSnapshot.giftCardActivities ?? [];
    const unlinkedLines = giftCardLines.filter(line => !giftCardActivities.some(activity => activity.status === 'completed' && ['ACTIVATE', 'LOAD'].includes(activity.type) && activity.orderId === line.orderId && activity.lineItemUid === line.lineItemUid));
    if (unlinkedLines.length) {
      const gap = { code: 'GIFT_CARD_ACTIVITY_LINKAGE_MISSING', sourceRefs: unlinkedLines.map(line => String(line.id)) };
      await db.recordSourceHealth({ organizationId, resource: 'square', status: 'incomplete', lastSuccessfulSyncAt: null, gap, sourceRevision, checkedAt: now().toISOString() });
      await db.upsertSourceIssue({ organizationId, code: 'SOURCE_GAP', state: 'awaiting_human', revision: sourceRevision, details: gap, sourceRefs: gap.sourceRefs });
    return { incomplete: true, projectionSaved: false, gap };
    }
    const result = engine.replayAccounting(sourceSnapshot);
    const replayableSnapshot = { ...sourceSnapshot, sourceRevision, projectionCause: cause };
    await db.saveProjectionRunSystem({ organizationId, sourceRevision, calculationVersion: result.calculationVersion, result, sourceSnapshot: replayableSnapshot, cause, idempotencyKey: `projection:${sourceRevision}:${result.calculationVersion}:${window.startAt ?? 'all'}:${window.endAt ?? 'all'}:${cause}` });
    await db.syncProjectionIssues({ organizationId, sourceRevision, calculationVersion: result.calculationVersion, periodStart: sourceSnapshot.periodStart ?? null, periodEnd: sourceSnapshot.periodEnd ?? null, issues: result.issues.map(issue => ({ code: issue.code, message: issue.message, sourceRefs: issue.sourceRefs ?? [], state: 'awaiting_human' })) });
    return { projectionSaved: true, sourceRevision };
  }

  async function recordGap(organizationId, resource, code, details = {}) {
    const revision = details.sourceRevision ?? null;
    await db.recordSourceHealth({ organizationId, resource, status: 'incomplete', lastSuccessfulSyncAt: null, gap: { code, ...details }, checkedAt: now().toISOString() });
    await db.upsertSourceIssue({ organizationId, code: 'SOURCE_GAP', state: 'awaiting_human', revision, details: { resource, code, ...details }, sourceRefs: details.sourceRefs ?? [] });
  }

  async function recordSyncResult(organizationId, result) {
    const lastSuccessfulSyncAt = result.gaps.length ? null : result.lastSuccessfulSyncAt;
    await db.recordSourceHealth({ organizationId, resource: 'square', status: result.freshness, lastSuccessfulSyncAt, syncResult: result, checkedAt: now().toISOString() });
    for (const [resource, resourceResult] of Object.entries(result.resources ?? {})) {
      const completedAt = resourceResult?.completedAt ?? resourceResult?.completed_at ?? null;
      await db.recordSourceHealth({
        organizationId, resource,
        status: resourceResult?.status === 'fresh' ? 'fresh' : 'incomplete',
        lastSuccessfulSyncAt: resourceResult?.status === 'fresh' ? completedAt : null,
        gap: resourceResult?.status === 'fresh' ? null : result.gaps.find(gap => gap.resource === resource) ?? { code: 'BACKFILL_INCOMPLETE' },
        syncResult: resourceResult, sourceRevision: result.sourceRevision ?? null,
        checkedAt: completedAt ?? now().toISOString(),
      });
    }
    for (const gap of result.gaps) {
      await db.recordSourceHealth({ organizationId, resource: gap.resource, status: 'incomplete', lastSuccessfulSyncAt: null, gap, checkedAt: now().toISOString() });
      await db.upsertSourceIssue({ organizationId, code: 'SOURCE_GAP', state: 'awaiting_human', revision: result.sourceRevision ?? null, details: gap, sourceRefs: gap.sourceRefs ?? [] });
    }
    if (!result.gaps.length) await db.resolveSourceIssue?.({ organizationId, code: 'SOURCE_GAP', resolvedAt: now().toISOString() });
    await updateFreshnessIssue(organizationId);
  }

  async function updateFreshnessIssue(organizationId) {
    const health = await db.getSyncHealth({ organizationId });
    const timestamp = Date.parse(health?.lastSuccessfulSyncAt ?? '');
    const stale = !Number.isFinite(timestamp) || now().getTime() - timestamp > freshnessTargetMs;
    if (stale) await db.upsertSourceIssue({ organizationId, code: 'SOURCE_STALE', state: 'awaiting_human', revision: health?.sourceRevision ?? null, details: { lastSuccessfulSyncAt: health?.lastSuccessfulSyncAt ?? null, freshnessTargetMs }, sourceRefs: [] });
    else await db.resolveSourceIssue?.({ organizationId, code: 'SOURCE_STALE', resolvedAt: now().toISOString() });
    return { stale, lastSuccessfulSyncAt: health?.lastSuccessfulSyncAt ?? null };
  }

  async function fetchAuthoritative(client, payload) {
    const resource = eventResource(payload); const id = eventId(payload);
    if (!resource || !id) return { resource: resource ?? 'square', id, unsupported: true };
    if (resource === 'gift_card_activity') {
      const notified = eventObject(payload);
      const giftCardId = notified?.gift_card_id ?? null;
      const createdAt = notified?.created_at ?? payload?.created_at ?? now().toISOString();
      const beginTime = new Date(Date.parse(createdAt) - 24 * 60 * 60_000).toISOString();
      const endTime = now().toISOString();
      let cursor = null; let pages = 0; const seen = new Set();
      do {
        if (++pages > maxPages) throw new Error('Gift card activity page limit exceeded');
        const query = new URLSearchParams({ begin_time: beginTime, end_time: endTime, sort_order: 'ASC', limit: '100' });
        if (giftCardId) query.set('gift_card_id', giftCardId);
        if (cursor) query.set('cursor', cursor);
        const page = await client.request(`/v2/gift-cards/activities?${query}`);
        const activity = (page.gift_card_activities ?? []).find(item => item.id === id);
        if (activity) return { resource, id, facts: normalizeGiftCardActivity(activity) };
        cursor = page.cursor ?? null;
        if (cursor && seen.has(cursor)) throw new Error('Square repeated gift card activity cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
      throw new Error('Square did not return authoritative gift card activity');
    }
    const paths = { order: `/v2/orders/${encodeURIComponent(id)}`, payment: `/v2/payments/${encodeURIComponent(id)}`, refund: `/v2/refunds/${encodeURIComponent(id)}`, catalog: `/v2/catalog/object/${encodeURIComponent(id)}?include_related_objects=true`, payout: `/v2/payouts/${encodeURIComponent(id)}` };
    const response = await client.request(paths[resource]);
    const key = { order: 'order', payment: 'payment', refund: 'refund', catalog: 'object', payout: 'payout' }[resource];
    const entity = response[key];
    if (!entity) throw new Error(`Square authoritative ${resource} response omitted object`);
    const facts = normalizeResource(resource, resource === 'catalog' ? { ...entity, related_objects: response.related_objects ?? [] } : entity);
    if (resource === 'payout') {
      let cursor = null; let pageCount = 0; const seen = new Set();
      do {
        if (++pageCount > maxPages) throw new Error('Payout entry page limit exceeded');
        const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const entriesPage = await client.request(`/v2/payouts/${encodeURIComponent(id)}/payout-entries?limit=100${suffix}`);
        facts.push(...(entriesPage.payout_entries ?? []).flatMap(entry => normalizePayoutEntry(entry, id)));
        cursor = entriesPage.cursor ?? null;
        if (cursor && seen.has(cursor)) throw new Error('Square repeated payout entry cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    return { resource, id, facts };
  }

  async function handleWebhook(job) {
    const notificationId = job.payload?.notificationId;
    if (typeof notificationId !== 'string' || !notificationId) throw Object.assign(new Error('Invalid webhook job'), { permanent: true });
    const notification = await db.getWebhookNotification({ organizationId: job.organizationId, notificationId });
    if (!notification?.signatureVerified || !notification.payload) throw Object.assign(new Error('Missing verified webhook inbox record'), { permanent: true });
    const client = await getClient(job.organizationId);
    const authoritative = await fetchAuthoritative(client, notification.payload);
    if (authoritative.unsupported) {
      await recordGap(job.organizationId, authoritative.resource, 'UNSUPPORTED_WEBHOOK_ACTIVITY', { notificationId, eventType: notification.payload.type ?? null });
      await queue.enqueueSquareSync({ organizationId: job.organizationId, reason: 'unsupported_webhook', idempotencyKey: `catchup:${notificationId}` });
      return { notificationId, outcome: 'gap_backfill_scheduled' };
    }
    if (!authoritative.facts?.length) {
      await recordGap(job.organizationId, authoritative.resource, 'AUTHORITATIVE_OBJECT_MISSING', { notificationId, objectId: authoritative.id });
      throw new Error('Authoritative Square object was not normalized');
    }
    // Each fetch is authoritative: reordered/duplicate event payloads cannot roll
    // the ledger backwards. The durable upsert adapter must reject older versions.
    const occurredAt = authoritative.facts.map(fact => fact.occurredAt).find(value => typeof value === 'string') ?? notification.payload.created_at;
    const window = monthWindow(occurredAt, config.accountingTimezone ?? 'America/New_York', now());
    const result = await writeFacts(job.organizationId, authoritative.facts, `webhook:${notificationId}`, window);
    if (result.incomplete) return { notificationId, outcome: 'normalization_gap', problems: result.problems };
    await db.recordSourceHealth({ organizationId: job.organizationId, resource: authoritative.resource, status: 'fresh', lastSuccessfulSyncAt: now().toISOString(), processedNotificationId: notificationId, sourceRevision: result.revision });
    await updateFreshnessIssue(job.organizationId);
    return { notificationId, changed: result.changed, revision: result.revision };
  }

  async function handleSync(job) {
    const { startAt, endAt, locationIds = [] } = job.payload ?? {};
    const client = await getClient(job.organizationId);
    let sourceRevision = null;
    const paymentFacts = new Map();
    const payoutEntryFacts = new Map();
    const result = await backfillSquare({ client, startAt, endAt, locationIds, maxPages, random, sleep, persist: async facts => {
      for (const fact of facts) {
        if (fact.kind === 'payment') paymentFacts.set(fact.objectId, fact);
        if (fact.kind === 'payout_entry') payoutEntryFacts.set(fact.objectId, fact);
      }
      // A payment can be returned before Square has attached its processing
      // fee. Defer projection until payouts have been fetched so a linked
      // CHARGE payout entry can provide the settled fee amount.
      const stored = await writeFacts(job.organizationId, facts, `sync:${job.id}`, { startAt, endAt }, {
        deferPaymentFees: true, deferProjection: true,
      });
      if (stored.revision !== null) sourceRevision = stored.revision;
      if (stored.incomplete) throw new Error('Square normalization has incomplete financial facts');
    } });

    const payoutFeesByPayment = new Map();
    for (const entry of payoutEntryFacts.values()) {
      if (entry.type !== 'CHARGE' || !entry.paymentId || !Number.isSafeInteger(entry.feeMinor) || entry.feeMinor < 0 || !entry.currency) continue;
      const linked = payoutFeesByPayment.get(entry.paymentId) ?? [];
      linked.push(entry);
      payoutFeesByPayment.set(entry.paymentId, linked);
    }
    const feeEnrichedPayments = [];
    const unresolvedPaymentFees = [];
    for (const payment of paymentFacts.values()) {
      if (payment.status !== 'COMPLETED' || payment.feeMinor !== null) continue;
      const evidence = payoutFeesByPayment.get(payment.objectId) ?? [];
      if (evidence.length === 1 && evidence[0].currency === payment.currency && evidence[0].feeCurrency === payment.currency) {
        feeEnrichedPayments.push({
          ...payment, version: `${payment.version}|payout-fee-1`,
          feeMinor: evidence[0].feeMinor, feeStatus: 'provided_from_payout_entry',
        });
      } else {
        unresolvedPaymentFees.push(payment.objectId);
      }
    }
    if (feeEnrichedPayments.length) {
      const stored = await writeFacts(job.organizationId, feeEnrichedPayments, `sync:${job.id}:payout-fees`, { startAt, endAt }, { deferProjection: true });
      if (stored.revision !== null) sourceRevision = stored.revision;
      if (stored.incomplete) throw new Error('Square payout fee normalization is incomplete');
    }
    if (unresolvedPaymentFees.length) {
      const gap = {
        resource: 'payments', code: 'PROCESSING_FEE_UNAVAILABLE',
        message: 'Square has not provided a processing fee in the payment or its linked payout entry.',
        sourceRefs: unresolvedPaymentFees,
      };
      result.gaps.push(gap);
      result.resources.payments = { ...result.resources.payments, status: 'incomplete', error: gap.message };
      result.freshness = 'incomplete';
      result.lastSuccessfulSyncAt = null;
      await db.recordSourceHealth({ organizationId: job.organizationId, resource: 'square', status: 'incomplete', lastSuccessfulSyncAt: null, gap, sourceRevision, checkedAt: now().toISOString() });
      await db.upsertSourceIssue({ organizationId: job.organizationId, code: 'SOURCE_GAP', state: 'awaiting_human', revision: sourceRevision, details: gap, sourceRefs: unresolvedPaymentFees });
    }
    result.sourceRevision = sourceRevision;
    if (!result.gaps.length && sourceRevision !== null) {
      await recomputeProjection(job.organizationId, sourceRevision, `sync:${job.id}`, { startAt, endAt });
    }
    await recordSyncResult(job.organizationId, result);
    if (result.gaps.length) throw Object.assign(new Error('Square backfill incomplete'), { retryableGap: true });
    return result;
  }

  async function handleReplay(job) {
    const { sourceRevision: revision, startAt, endAt } = job.payload ?? {};
    if (!Number.isSafeInteger(revision) || revision < 0) throw Object.assign(new Error('Invalid replay revision'), { permanent: true });
    let window = monthWindow(now().toISOString(), config.accountingTimezone ?? 'America/New_York', now());
    if (startAt !== undefined || endAt !== undefined) {
      if (typeof startAt !== 'string' || typeof endAt !== 'string' || !Number.isFinite(Date.parse(startAt))
          || !Number.isFinite(Date.parse(endAt)) || Date.parse(endAt) <= Date.parse(startAt)
          || Date.parse(endAt) - Date.parse(startAt) > 370 * 24 * 60 * 60 * 1000) {
        throw Object.assign(new Error('Invalid replay window'), { permanent: true });
      }
      window = { startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString() };
    }
    const projection = await recomputeProjection(job.organizationId, revision, `job:${job.id}`, window);
    if (job.payload?.receiptId && projection?.projectionSaved !== true) {
      throw Object.assign(new Error('Receipt projection could not be saved because source evidence is incomplete'), {
        code: 'RECEIPT_PROJECTION_INCOMPLETE', retryableGap: true,
      });
    }
    return { revision, ...window };
  }

  async function handleInvestigation(job) {
    const { issueId, sourceRevision } = job.payload ?? {};
    if (!issueId || !Number.isSafeInteger(sourceRevision) || sourceRevision < 0) throw Object.assign(new Error('Invalid investigation job'), { permanent: true });
    for (const method of ['getIssueForInvestigation', 'getIssueEvidenceForWorker', 'claimInvestigation', 'completeInvestigation', 'failInvestigation', 'createProposalAtomicSystem', 'reserveModelBudgetSystem', 'recordModelUsageSystem']) {
      if (typeof db[method] !== 'function') throw Object.assign(new Error(`Durable investigation adapter ${method} unavailable`), { permanent: true });
    }
    const issue = await db.getIssueForInvestigation({ organizationId: job.organizationId, issueId });
    if (!issue) return { issueId, outcome: 'issue_closed_or_missing' };
    const evidence = await db.getIssueEvidenceForWorker({ organizationId: job.organizationId, issueId });
    const evidenceHash = hash([...evidence].sort((a, b) => String(a.id).localeCompare(String(b.id))));
    const claim = await db.claimInvestigation({ organizationId: job.organizationId, issueId, sourceRevision, evidenceHash, maxProposals: 3, onePerRevision: true, stopOnUnchangedEvidence: true });
    if (!claim?.acquired) return { issueId, outcome: claim?.reason ?? 'not_claimed' };
    try {
      const diagnosis = await diagnoseIssue({ issue: { id: issue.id, type: issue.type, code: issue.code, details: issue.details }, records: evidence, policyVersion: issue.policyVersion, allowedCategories: issue.allowedCategories }, {
        apiKey: config.openRouterApiKey,
        fetchImpl,
        model: config.openRouterModel,
        maxOutputTokens: config.openRouterMaxOutputTokens,
        reserveBudget: args => db.reserveModelBudgetSystem({ ...args, organizationId: job.organizationId, issueId }),
        recordUsage: args => db.recordModelUsageSystem({ ...args, organizationId: job.organizationId, issueId })
      });
      const created = await db.createProposalAtomicSystem({ organizationId: job.organizationId, issueId, proposal: diagnosis.proposal, modelId: diagnosis.model, promptVersion: diagnosis.promptVersion, validationStatus: 'valid', decision: 'pending', createdBy: 'system', idempotencyKey: `investigation:${issueId}:${sourceRevision}:${evidenceHash}`, attempt: claim.attempt });
      await db.completeInvestigation({ organizationId: job.organizationId, issueId, sourceRevision, evidenceHash, proposalId: created.id, status: 'proposal_pending' });
      return { issueId, outcome: 'proposal_created', proposalId: created.id };
    } catch (error) {
      await db.failInvestigation({ organizationId: job.organizationId, issueId, sourceRevision, evidenceHash, code: error.code ?? 'MODEL_UNAVAILABLE' });
      throw error;
    }
  }

  async function handlePurchaseReceipt(job) {
    const receiptId = job.payload?.receiptId;
    if (typeof receiptId !== 'string' || !receiptId) throw Object.assign(new Error('Invalid purchase receipt job'), { permanent: true });
    for (const method of ['getPurchaseReceiptForProcessing','downloadPurchaseReceiptObject','reservePurchaseReceiptModelBudget','recordPurchaseReceiptModelUsage','savePurchaseReceiptDraftSystem','failPurchaseReceiptProcessing']) {
      if (typeof db[method] !== 'function') throw Object.assign(new Error('Purchase receipt worker adapter unavailable'), { permanent: true });
    }
    let receipt;
    try {
      receipt = await db.getPurchaseReceiptForProcessing({ organizationId: job.organizationId, receiptId });
      if (!receipt) return { receiptId, outcome: 'missing_or_already_processed' };
      const objectKey = receipt.objectKey ?? receipt.object_key;
      const mimeType = receipt.mimeType ?? receipt.mime_type;
      const bytes = await db.downloadPurchaseReceiptObject({ objectKey });
      const actualHash=createHash('sha256').update(bytes).digest('hex');
      const expectedHash=receipt.sha256Hex ?? receipt.sha256_hex;
      if(typeof expectedHash!=='string'||actualHash!==expectedHash) throw Object.assign(new Error('Receipt evidence checksum mismatch'),{code:'RECEIPT_CHECKSUM_MISMATCH',permanent:true});
      const text = await extractReceiptDocumentTextFn({ bytes, mimeType });
      if (!config.openRouterApiKey) throw Object.assign(new Error('Receipt model is not configured'), { code: 'RECEIPT_MODEL_UNAVAILABLE', permanent: true });
      const expectedVersion = Number(receipt.activeDraftVersion ?? receipt.active_draft_version ?? 0);
      const draft = await extractPurchaseReceipt({ text }, {
        apiKey: config.openRouterApiKey, fetchImpl, model: config.openRouterModel,
        maxOutputTokens: config.openRouterMaxOutputTokens ?? 1400,
        reserveBudget: args => db.reservePurchaseReceiptModelBudget({ organizationId: job.organizationId, receiptId, jobId: job.id, ...args }),
        recordUsage: args => db.recordPurchaseReceiptModelUsage({ organizationId: job.organizationId, receiptId, jobId: job.id, ...args }),
      });
      const result = await db.savePurchaseReceiptDraftSystem({ organizationId: job.organizationId, receiptId, expectedVersion, draft });
      return { receiptId, outcome: 'needs_review', draftVersion: result?.version ?? result?.draftVersion ?? expectedVersion + 1 };
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_.-]{1,80}$/.test(error.code) ? error.code : 'RECEIPT_PROCESSING_FAILED';
      if (receipt && (error.permanent || code === 'BUDGET_EXCEEDED' || code === 'MODEL_UNAVAILABLE')) {
        await db.failPurchaseReceiptProcessing({ organizationId: job.organizationId, receiptId, code });
        error.permanent = true;
      }
      throw error;
    }
  }

  async function processJob(job) {
    if (!job || !job.id || !job.organizationId || !JOBS.has(job.type)) throw Object.assign(new Error('Invalid or unsupported job'), { permanent: true });
    if (job.type === 'square.webhook') return handleWebhook(job);
    if (job.type === 'square.sync') return handleSync(job);
    if (job.type === 'projection.replay') return handleReplay(job);
    if (job.type === 'receipt.process') return handlePurchaseReceipt(job);
    return handleInvestigation(job);
  }

  async function runOne({ workerId }) {
    if (!workerId) throw new TypeError('workerId is required');
    const job = await queue.claim({ workerId, leaseSeconds, types: enabledJobTypes });
    if (!job) return { status: 'idle' };
    if (typeof job.leaseToken !== 'string' || !job.leaseToken) throw new Error('queue.claim must return a fencing leaseToken');
    let ownsLease = true;
    let renewing = false;
    let renewal = Promise.resolve();
    const heartbeat = typeof queue.extendLease === 'function' ? setInterval(() => {
      if (renewing || !ownsLease) return;
      renewing = true;
      renewal = queue.extendLease({ jobId: job.id, workerId, leaseToken: job.leaseToken, leaseSeconds })
        .then(extended => { if (extended === false) ownsLease = false; })
        .catch(() => {}) // The fenced ack/retry path remains authoritative if a transient heartbeat fails.
        .finally(() => { renewing = false; });
    }, Math.max(1000, Math.floor(leaseSeconds * 1000 / 3))) : null;
    heartbeat?.unref?.();
    try {
      const result = await processJob(job);
      if (heartbeat) { clearInterval(heartbeat); await renewal; }
      if (!ownsLease) return { status: 'lease_lost', jobId: job.id };
      const acknowledged = await queue.ack({ jobId: job.id, workerId, leaseToken: job.leaseToken });
      if (acknowledged === false) return { status: 'lease_lost', jobId: job.id };
      let receiptFinalizationPending=false;
      const receiptId=job.type==='projection.replay'?job.payload?.receiptId:null;
      const decisionId=job.type==='projection.replay'?job.payload?.decisionId:null;
      if(receiptId&&decisionId&&typeof db.finalizePurchaseReceiptProjection==='function') {
        try { await db.finalizePurchaseReceiptProjection({organizationId:job.organizationId,receiptId,decisionId,succeeded:true}); }
        catch { receiptFinalizationPending=true; }
      }
      return { status: 'completed', jobId: job.id, result, receiptFinalizationPending };
    } catch (error) {
      if (heartbeat) { clearInterval(heartbeat); await renewal; }
      if (!ownsLease) return { status: 'lease_lost', jobId: job.id };
      const attempts = Number(job.attempts ?? 1);
      if (error.permanent || attempts >= retryLimit || attempts >= Number(job.maxAttempts ?? retryLimit)) {
        if (job.type === 'receipt.process') {
          try { await db.failPurchaseReceiptProcessing({ organizationId: job.organizationId, receiptId: job.payload?.receiptId, code: error.code ?? 'RECEIPT_PROCESSING_FAILED' }); }
          catch { /* Dead-letter remains authoritative if status metadata cannot be updated. */ }
        }
        if (job.type === 'square.webhook' || job.type === 'square.sync') {
          try { await recordGap(job.organizationId, job.type, 'SOURCE_GAP', { jobId: job.id, reason: errorMessage(error) }); }
          catch (gapError) {
            const failed = await queue.deadLetter({
              jobId: job.id, workerId, leaseToken: job.leaseToken, code: 'SOURCE_GAP_WRITE_FAILED',
              message: `Source-gap write failed (${safeFailureDescription(gapError)}); job failed (${safeFailureDescription(error)})`,
            });
            if (failed === false) return { status: 'lease_lost', jobId: job.id };
            const failure = failureMetadata(error); const gapWrite = failureMetadata(gapError);
            return {
              status: 'dead_lettered', jobId: job.id, code: 'SOURCE_GAP_WRITE_FAILED',
              failureStatus: failure.status, failureCode: failure.code,
              gapWriteStatus: gapWrite.status, gapWriteCode: gapWrite.code,
            };
          }
        }
        const failed = await queue.deadLetter({ jobId: job.id, workerId, leaseToken: job.leaseToken, code: error.code ?? 'WORKER_JOB_FAILED', message: errorMessage(error) });
        if (failed === false) return { status: 'lease_lost', jobId: job.id };
        if(job.type==='projection.replay'&&job.payload?.receiptId&&job.payload?.decisionId&&typeof db.finalizePurchaseReceiptProjection==='function') {
          try { await db.finalizePurchaseReceiptProjection({organizationId:job.organizationId,receiptId:job.payload.receiptId,decisionId:job.payload.decisionId,succeeded:false,errorCode:error.code??'PROJECTION_REPLAY_FAILED'}); }
          catch { /* The receipt remains visibly projection-pending. */ }
        }
        const failure = failureMetadata(error);
        return { status: 'dead_lettered', jobId: job.id, code: error.code ?? 'WORKER_JOB_FAILED', failureStatus: failure.status, failureCode: failure.code };
      }
      const retryAfterMs = Math.min(15 * 60_000, 1000 * 2 ** Math.min(attempts - 1, 10)) * (0.75 + random() * 0.5);
      await queue.retry({ jobId: job.id, workerId, leaseToken: job.leaseToken, delayMs: Math.round(retryAfterMs), code: error.code ?? 'WORKER_JOB_FAILED' });
      const failure = failureMetadata(error);
      return { status: 'retrying', jobId: job.id, code: error.code ?? 'WORKER_JOB_FAILED', failureStatus: failure.status, failureCode: failure.code };
    }
  }

  return Object.freeze({ runOne, processJob, updateFreshnessIssue });
}
