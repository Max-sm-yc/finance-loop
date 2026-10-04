import { SUPPORTED_DIAGNOSIS_ISSUE_TYPES } from '../agent/diagnosis.mjs';
import { SquareApiClient } from '../square/client.mjs';
import { normalizeCatalog, normalizeOrder, normalizeRefund } from '../square/sync.mjs';

const requiredString = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value.replace(/\/$/, '');
};
const SQUARE_FACT_BATCH_SIZE = 500;
const ISSUE_TYPE_BY_CODE = Object.freeze({
  UNKNOWN_ITEM: 'unknown_item',
  AMBIGUOUS_CLASSIFICATION: 'ambiguous_transaction',
  BALANCE_MISMATCH: 'balance_mismatch',
  UNSUPPORTED_ACTIVITY: 'unsupported_activity',
  REFUND_COGS_REVIEW: 'refund_cogs_review',
});

function safeError(payload, status) {
  const error = new Error(`Supabase request failed (${status})`);
  error.status = status;
  error.code = payload?.code ?? 'SUPABASE_ERROR';
  return error;
}

function createRest({ baseUrl, apiKey, authorization, fetchImpl }) {
  const headers = extra => ({ apikey: apiKey, ...(authorization ? { Authorization: authorization } : {}), ...extra });
  async function request(path, { method = 'GET', body, prefer, accept } = {}) {
    const response = await fetchImpl(`${baseUrl}/rest/v1/${path}`, {
      method,
      headers: headers({
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(prefer ? { prefer } : {}),
        ...(accept ? { accept } : {})
      }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (!response.ok) throw safeError(data, response.status);
    return data;
  }
  return {
    request,
    rpc(name, args = {}) {
      // SQL RPC arguments use explicit p_ names. The handlers use concise names.
      const params = Object.fromEntries(Object.entries(args).map(([key, value]) => [key.startsWith('p_') ? key : `p_${key}`, value]));
      return request(`rpc/${encodeURIComponent(name)}`, { method: 'POST', body: params })
        .then(data => ({ data, error: null })).catch(error => ({ data: null, error }));
    }
  };
}

const eq = value => `eq.${value}`;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const sha256 = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function squareVersionSort(version) {
  const value = String(version ?? '');
  const revisionAt = value.indexOf('|');
  const sourceVersion = revisionAt < 0 ? value : value.slice(0, revisionAt);
  const normalizationRevision = revisionAt < 0 ? '' : value.slice(revisionAt);
  if (/^\d+$/.test(sourceVersion)) return `n:${sourceVersion.padStart(40, '0')}${normalizationRevision}`;
  const epoch = Date.parse(sourceVersion);
  if (Number.isFinite(epoch) && /^\d{4}-\d\d-\d\d(?:T|$)/.test(sourceVersion)) return `t:${String(epoch).padStart(16, '0')}${normalizationRevision}`;
  return `s:${value}`;
}
const safeMinor = value => value !== null && value !== undefined && value !== '' && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const statusText = value => String(value ?? '').toLowerCase();

function makeProjectionSnapshot(data, { startAt, endAt }) {
  const facts = Array.isArray(data?.facts) ? data.facts : [];
  const orders = new Map(facts.filter(x => x.kind === 'order').map(x => [x.objectId, x]));
  const inWindow = value => {
    if (!startAt || !endAt) return true;
    const at = Date.parse(value ?? '');
    return Number.isFinite(at) && at >= Date.parse(startAt) && at < Date.parse(endAt);
  };
  const definitions = Array.isArray(data?.itemDefinitions) ? data.itemDefinitions : [];
  const lineCostOverrides = new Map((Array.isArray(data?.lineCostOverrides) ? data.lineCostOverrides : [])
    .map(override => [`${override.square_order_id}:${override.square_line_uid}`, override]));
  const refundReviews = new Map((Array.isArray(data?.refundReviews) ? data.refundReviews : [])
    .map(review => [review.square_refund_id, review]));
  const definitionAt = (catalogId, soldAt) => definitions.filter(d => d.square_catalog_object_id === catalogId
    && Date.parse(d.effective_from) <= Date.parse(soldAt ?? '')
    && (!d.effective_until || Date.parse(d.effective_until) > Date.parse(soldAt ?? '')))
    .sort((a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from))[0] ?? null;
  const lines = facts.filter(x => x.kind === 'order_line' && inWindow(x.occurredAt)).map(fact => {
    const order = orders.get(fact.orderId);
    const lineOverride = lineCostOverrides.get(`${fact.orderId}:${fact.lineItemUid}`);
    const definition = definitionAt(fact.catalogObjectId, fact.occurredAt);
    const cost = safeMinor(lineOverride?.unit_cost_minor ?? definition?.unit_cost_minor);
    return {
      id: fact.objectId, version: fact.version, orderId: fact.orderId, lineItemUid: fact.lineItemUid,
      status: statusText(order?.status), itemType: fact.itemType, currency: fact.currency,
      quantity: Number(fact.quantity), grossMinor: safeMinor(fact.grossMinor),
      discountMinor: safeMinor(fact.discountMinor), refundMinor: 0,
      taxMinor: safeMinor(fact.taxMinor) ?? 0, tipMinor: safeMinor(fact.tipMinor) ?? 0,
      unitCostMinor: Number.isSafeInteger(cost) && cost >= 0 ? cost : null,
      costCurrency: lineOverride?.currency ?? definition?.currency ?? null,
    };
  });
  const fees = facts.filter(x => x.kind === 'payment' && inWindow(x.occurredAt)).map(fact => ({
    id: fact.objectId, version: fact.version, status: statusText(fact.status), currency: fact.currency,
    amountMinor: safeMinor(fact.feeMinor),
  }));
  const refunds = facts.filter(x => x.kind === 'refund' && inWindow(x.occurredAt)).map(fact => {
    const review = refundReviews.get(fact.objectId);
    return {
      id: fact.objectId, version: fact.version, status: statusText(fact.status), currency: fact.currency,
      amountMinor: safeMinor(fact.amountMinor), orderId: fact.orderId,
      reviewDisposition: review?.disposition ?? null,
      approvedCogsReversalMinor: review ? safeMinor(review.approved_cogs_reversal_minor) : null,
      reviewCurrency: review?.currency ?? null,
    };
  });
  const giftCardActivities = facts.filter(x => x.kind === 'gift_card_activity' && inWindow(x.occurredAt)).map(fact => ({
    id: fact.objectId, version: fact.version, type: fact.type, status: statusText(fact.status),
    currency: fact.currency, amountMinor: safeMinor(fact.amountMinor), orderId: fact.orderId,
    lineItemUid: fact.lineItemUid,
  }));
  const observations = Array.isArray(data?.observations) ? data.observations : [];
  const movements = Array.isArray(data?.movements) ? data.movements : [];
  const accounts = (Array.isArray(data?.accounts) ? data.accounts : []).map(account => {
    const accountObservations = observations.filter(row => row.account_id === account.id)
      .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
    const latest = accountObservations.at(-1);
    const openingAt = account.opening_balance_at;
    const openingMinor = safeMinor(account.opening_balance_minor);
    if (!openingAt || openingMinor === null || !latest || Date.parse(latest.observed_at) <= Date.parse(openingAt)) return null;
    return {
      id: account.id, currency: account.currency,
      opening: { id: `opening:${account.id}`, accountId: account.id, amountMinor: openingMinor, currency: account.currency, observedAt: openingAt },
      observed: { id: latest.id, accountId: account.id, amountMinor: safeMinor(latest.amount_minor), currency: latest.currency, observedAt: latest.observed_at },
      toleranceMinor: safeMinor(data?.policy?.reconciliation_tolerance_minor) ?? 0,
      movements: movements.filter(m => m.account_id === account.id).map(m => ({
        id: m.id, kind: m.kind, transferId: m.linked_transfer_id, amountMinor: safeMinor(m.amount_minor),
        currency: m.currency, occurredAt: m.occurred_at,
        status: m.approval_status === 'approved' ? 'posted' : 'pending', idempotencyKey: m.idempotency_key,
        accountId: m.account_id,
      })),
    };
  }).filter(Boolean);
  const currencies = facts.map(x => x.currency).filter(x => typeof x === 'string');
  const policyCurrency = data?.policy?.currency ?? currencies[0] ?? 'USD';
  return {
    incomePolicy: { tax: data?.policy?.tax_treatment === 'include' ? 'include' : 'exclude', tips: 'exclude' },
    lines, fees, refunds, giftCardActivities, accounts,
    reconciliations: Object.fromEntries(accounts.map(account => [account.id, {
      opening: account.opening, observed: account.observed, movements: account.movements,
      toleranceMinor: account.toleranceMinor,
    }])),
    currency: policyCurrency,
    periodStart: startAt ?? null, periodEnd: endAt ?? null,
  };
}

function issueEvidenceRefs(issue) {
  const refs = [...new Set(Array.isArray(issue.source_refs) ? issue.source_refs.filter(x => typeof x === 'string' && x.length) : [])];
  const message = String(issue.details?.message ?? '');
  if (issue.code === 'UNKNOWN_ITEM') {
    const messageRef = /missing for (.+?)\.\s*$/i.exec(message)?.[1];
    if (messageRef && !refs.includes(messageRef)) refs.push(messageRef);
  }
  if (issue.code === 'REFUND_COGS_REVIEW') {
    const refundIdFromMessage = /^Refund ([A-Za-z0-9_-]+)/.exec(message)?.[1];
    if (refundIdFromMessage && !refs.includes(refundIdFromMessage)) refs.push(refundIdFromMessage);
  }
  return refs;
}

function issueEvidenceFromFacts(issue, facts) {
  const refs = issueEvidenceRefs(issue);
  const message = String(issue.details?.message ?? '');
  const catalog = new Map(facts.filter(fact => fact.kind === 'catalog' && fact.objectId).map(fact => [fact.objectId, fact]));
  const itemNameFor = fact => {
    const lineName = typeof fact.name === 'string' ? fact.name.trim() : '';
    const variation = catalog.get(fact.catalogObjectId);
    const variationName = typeof variation?.name === 'string' ? variation.name.trim() : '';
    const item = variation?.itemId ? catalog.get(variation.itemId) : null;
    const itemName = typeof item?.name === 'string' ? item.name.trim() : '';
    if (lineName) return (itemName && !lineName.toLocaleLowerCase().includes(itemName.toLocaleLowerCase())
      ? `${itemName} — ${lineName}` : lineName).slice(0, 256);
    if (itemName && variationName && itemName !== variationName) return `${itemName} — ${variationName}`.slice(0, 256);
    return (itemName || variationName).slice(0, 256);
  };
  const lineEvidence = fact => {
    const basePrice = fact.raw?.base_price_money;
    const unitPriceMinor = basePrice?.currency === fact.currency ? safeMinor(basePrice.amount) : null;
    return {
      id: String(fact.objectId), type: 'sale_line', occurred_at: fact.occurredAt ?? undefined,
      currency: fact.currency ?? undefined, quantity: fact.quantity ?? undefined,
      amount_minor: fact.grossMinor ?? fact.totalMinor ?? undefined,
      gross_minor: fact.grossMinor ?? undefined,
      unit_price_minor: unitPriceMinor ?? undefined, discount_minor: fact.discountMinor ?? undefined,
      catalog_object_id: fact.catalogObjectId ?? null, item_name: itemNameFor(fact) || null,
      provider_object_id: fact.orderId ?? undefined, line_id: fact.lineItemUid ?? undefined,
    };
  };
  const lineFacts = facts.filter(fact => fact.kind === 'order_line' && fact.objectId && fact.orderId);

  if (issue.code === 'REFUND_COGS_REVIEW') {
    const refundIdFromMessage = /^Refund ([A-Za-z0-9_-]+)/.exec(message)?.[1];
    const refund = facts.find(fact => fact.kind === 'refund' && refs.includes(String(fact.objectId)))
      ?? facts.find(fact => fact.kind === 'refund' && fact.objectId === refundIdFromMessage);
    const refundId = refund?.objectId ?? refundIdFromMessage;
    const orderId = refund?.orderId ?? refs.find(ref => ref !== refundId && /^[A-Za-z0-9_-]{1,200}$/.test(ref));
    const summary = refund && {
      id: `refund:${refund.objectId}`, type: 'refund', occurred_at: refund.occurredAt ?? undefined,
      currency: refund.currency ?? undefined, amount_minor: refund.amountMinor ?? undefined,
      status: refund.status ?? undefined, refund_id: String(refund.objectId), order_id: orderId ?? undefined,
    };
    const orderLines = orderId ? lineFacts.filter(fact => fact.orderId === orderId).map(lineEvidence) : [];
    return [...(summary ? [summary] : []), ...orderLines].slice(0, 21);
  }

  const refsWithLine = refs.map(ref => {
    const separator = ref.indexOf(':');
    return separator > 0 ? { ref, orderId: ref.slice(0, separator), lineRef: ref.slice(separator + 1) } : null;
  }).filter(Boolean);
  const selected = lineFacts.filter(fact => refs.includes(String(fact.objectId)) || refsWithLine.some(ref =>
    fact.orderId === ref.orderId && (fact.lineItemUid === ref.lineRef || fact.catalogObjectId === ref.lineRef))
    || refs.includes(String(fact.orderId)));
  return selected.slice(0, 20).map(lineEvidence);
}

async function refreshIssueSquareEvidence({ issue, facts, tokenVault, squareBaseUrl, squareApiVersion, fetchImpl }) {
  if (!tokenVault || !squareBaseUrl) return facts;
  try {
    const connection = await tokenVault.getDecrypted({ organizationId: issue.organization_id });
    const expiry = Date.parse(connection?.expiresAt ?? '');
    if (!connection?.accessToken || (Number.isFinite(expiry) && expiry <= Date.now() + 5 * 60_000)) return facts;

    const client = new SquareApiClient({ accessToken: connection.accessToken, baseUrl: squareBaseUrl, apiVersion: squareApiVersion, fetchImpl });
    const refs = issueEvidenceRefs(issue).filter(ref => /^[A-Za-z0-9_:-]{1,400}$/.test(ref));
    const refreshed = [];
    const cachedRefund = facts.find(fact => fact.kind === 'refund' && refs.includes(String(fact.objectId)));

    if (issue.code === 'REFUND_COGS_REVIEW') {
      const refundId = cachedRefund?.objectId ?? /^Refund ([A-Za-z0-9_-]+)/.exec(String(issue.details?.message ?? ''))?.[1];
      const orderId = cachedRefund?.orderId ?? refs.find(ref => ref !== refundId && /^[A-Za-z0-9_-]{1,200}$/.test(ref));
      const reads = await Promise.allSettled([
        refundId ? client.request(`/v2/refunds/${encodeURIComponent(refundId)}`) : Promise.resolve(null),
        orderId ? client.request(`/v2/orders/${encodeURIComponent(orderId)}`) : Promise.resolve(null),
      ]);
      const liveRefund = reads[0].status === 'fulfilled' ? reads[0].value?.refund : null;
      const liveOrder = reads[1].status === 'fulfilled' ? reads[1].value?.order : null;
      if (liveRefund?.id === refundId && (!orderId || liveRefund.order_id === orderId)) refreshed.push(...normalizeRefund(liveRefund));
      if (liveOrder?.id === orderId) refreshed.push(...normalizeOrder(liveOrder));
    } else if (issue.code === 'UNKNOWN_ITEM') {
      const orderRefs = refs.map(ref => {
        const separator = ref.indexOf(':');
        return separator > 0 ? { ref, orderId: ref.slice(0, separator) } : null;
      }).filter(Boolean);
      const orderIds = [...new Set(orderRefs.map(ref => ref.orderId))].slice(0, 5);
      const orders = await Promise.allSettled(orderIds.map(orderId => client.request(`/v2/orders/${encodeURIComponent(orderId)}`)));
      for (const result of orders) {
        if (result.status === 'fulfilled' && result.value?.order?.id && orderIds.includes(result.value.order.id)) {
          refreshed.push(...normalizeOrder(result.value.order));
        }
      }
    }

    const combined = new Map(facts.map(fact => [`${fact.kind}:${fact.objectId}`, fact]));
    for (const fact of refreshed) combined.set(`${fact.kind}:${fact.objectId}`, fact);
    const refreshedLines = refreshed.filter(fact => fact.kind === 'order_line');
    const catalogIds = [...new Set(refreshedLines.filter(line => !String(line.name ?? '').trim() && line.catalogObjectId)
      .map(line => line.catalogObjectId))].slice(0, 10);
    const catalogReads = await Promise.allSettled(catalogIds.map(id => client.request(`/v2/catalog/object/${encodeURIComponent(id)}?include_related_objects=true`)));
    for (const result of catalogReads) {
      if (result.status !== 'fulfilled' || !result.value?.object?.id) continue;
      const objects = [result.value.object, ...(Array.isArray(result.value.related_objects) ? result.value.related_objects : [])];
      for (const object of objects) for (const fact of normalizeCatalog(object)) combined.set(`${fact.kind}:${fact.objectId}`, fact);
    }
    return [...combined.values()];
  } catch {
    // The saved versioned Square facts remain the fallback when a live lookup is unavailable.
    return facts;
  }
}

/** Server-only Supabase adapters. Do not import this module into browser bundles. */
export function createSupabaseAdapters({ url, publishableKey, secretKey, tokenEncryptionKey, squareBaseUrl = 'https://connect.squareup.com', squareApiVersion, fetchImpl = fetch }) {
  const baseUrl = requiredString(url, 'Supabase URL');
  const publicKey = typeof publishableKey === 'string' && publishableKey.trim() ? requiredString(publishableKey, 'Supabase publishable key') : null;
  const serviceKey = secretKey ? requiredString(secretKey, 'Supabase secret key') : null;
  // Supabase's current sb_secret keys are API keys, not JWTs. They belong in
  // apikey only; legacy service_role JWTs still need the Bearer header.
  const serviceAuthorization = serviceKey && !serviceKey.startsWith('sb_secret_') ? `Bearer ${serviceKey}` : undefined;
  const encryptionKey = tokenEncryptionKey ? Buffer.from(tokenEncryptionKey, 'base64') : null;
  if (tokenEncryptionKey && encryptionKey.byteLength !== 32) throw new TypeError('tokenEncryptionKey must be a base64 encoded 32-byte AES key');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  const userRest = accessToken => {
    if (!publicKey) throw new Error('Supabase publishable key is unavailable');
    return createRest({ baseUrl, apiKey: publicKey, authorization: `Bearer ${requiredString(accessToken, 'accessToken')}`, fetchImpl });
  };
  const serviceRest = () => {
    if (!serviceKey) throw new Error('Privileged Supabase operation is unavailable');
    return createRest({ baseUrl, apiKey: serviceKey, authorization: serviceAuthorization, fetchImpl });
  };
  const table = (rest, name, query = '') => rest.request(`${name}${query ? `?${query}` : ''}`);
  const one = (rows, context) => {
    if (!Array.isArray(rows) || rows.length > 1) throw new Error(`Unexpected ${context} response`);
    return rows[0] ?? null;
  };
  const getWorkerHealth = async organizationId => {
    try {
      const { data, error } = await serviceRest().rpc('get_square_worker_health', { organization_id: organizationId });
      if (error) return null; // Keep the dashboard usable while an older migration set is deployed.
      return data;
    } catch { return null; }
  };

  const db = {
    asUser: accessToken => userRest(accessToken),
    async uploadEvidence({ organizationId, uploadedBy, bytes, mimeType, byteSize, sha256Hex, originalFilename }) {
      const id = randomUUID();
      const objectKey = `${organizationId}/${id}`;
      const objectPath = objectKey.split('/').map(encodeURIComponent).join('/');
      if (!serviceKey) throw new Error('Privileged evidence storage is unavailable');
      const headers = { apikey: serviceKey, ...(serviceAuthorization ? { Authorization: serviceAuthorization } : {}), 'content-type': mimeType, 'x-upsert': 'false' };
      const uploaded = await fetchImpl(`${baseUrl}/storage/v1/object/finance-evidence/${objectPath}`, {
        method: 'POST', headers, body: bytes
      });
      if (!uploaded.ok) throw safeError(null, uploaded.status);
      try {
        const rows = await serviceRest().request('evidence_files', {
          method: 'POST', prefer: 'return=representation',
          body: [{ id, organization_id: organizationId, object_key: objectKey, sha256_hex: sha256Hex,
            mime_type: mimeType, byte_size: byteSize, original_filename: originalFilename, uploaded_by: uploadedBy }]
        });
        if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Evidence metadata was not persisted');
        return { id: rows[0].id, mimeType: rows[0].mime_type, byteSize: rows[0].byte_size, sha256Hex: rows[0].sha256_hex, originalFilename: rows[0].original_filename, uploadedAt: rows[0].uploaded_at };
      } catch (error) {
        // Avoid leaving orphaned bytes if metadata validation or insertion fails.
        await fetchImpl(`${baseUrl}/storage/v1/object/finance-evidence/${objectPath}`, { method: 'DELETE', headers }).catch(() => {});
        throw error;
      }
    },
    async getEvidenceSignedUrl({ organizationId, evidenceId, accessToken }) {
      const query = new URLSearchParams({ select: 'object_key', organization_id: eq(organizationId), id: eq(evidenceId), limit: '2' });
      const evidence = one(await table(userRest(accessToken), 'evidence_files', query), 'evidence file');
      if (!evidence) return null;
      if (!serviceKey) throw new Error('Privileged evidence storage is unavailable');
      const objectPath = evidence.object_key.split('/').map(encodeURIComponent).join('/');
      const response = await fetchImpl(`${baseUrl}/storage/v1/object/sign/finance-evidence/${objectPath}`, {
        method: 'POST',
        headers: { apikey: serviceKey, ...(serviceAuthorization ? { Authorization: serviceAuthorization } : {}), 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn: 60 })
      });
      let payload = null; try { payload = await response.json(); } catch {}
      if (!response.ok || typeof payload?.signedURL !== 'string') throw safeError(payload, response.status);
      const url = /^https?:\/\//i.test(payload.signedURL) ? payload.signedURL : `${baseUrl}/storage/v1${payload.signedURL.startsWith('/') ? '' : '/'}${payload.signedURL}`;
      return { url };
    },
    async getSquareConnection({ organizationId }) {
      const connection = await tokenVault.getDecrypted({ organizationId });
      return connection ? { accessToken: connection.accessToken, refreshToken: connection.refreshToken, expiresAt: connection.expiresAt, merchantId: connection.merchantId } : null;
    },
    async getWebhookNotification({ organizationId, notificationId }) {
      const { data, error } = await serviceRest().rpc('get_square_webhook_notification', { organization_id: organizationId, notification_id: notificationId });
      if (error) throw error;
      return data;
    },
    async upsertSquareFacts({ organizationId, facts, cause }) {
      const normalized = facts.map(fact => {
        const { raw: _rawSquareObject, ...safeFact } = fact;
        return { kind: fact.kind, objectId: fact.objectId, version: String(fact.version), versionSort: squareVersionSort(fact.version), fact: safeFact };
      });
      const batches = normalized.length
        ? Array.from({ length: Math.ceil(normalized.length / SQUARE_FACT_BATCH_SIZE) }, (_, index) => normalized.slice(index * SQUARE_FACT_BATCH_SIZE, (index + 1) * SQUARE_FACT_BATCH_SIZE))
        : [normalized];
      let changed = false;
      let revision = null;
      for (const batch of batches) {
        const { data, error } = await serviceRest().rpc('upsert_square_facts', {
          organization_id: organizationId, facts: batch, cause: String(cause ?? 'worker').slice(0, 300),
        });
        if (error) throw error;
        changed ||= data?.changed === true;
        if (Number.isSafeInteger(data?.revision)) revision = data.revision;
      }
      return { changed, revision };
    },
    async recordSourceHealth(record) {
      const { data, error } = await serviceRest().rpc('record_square_worker_health', {
        organization_id: record.organizationId,
        record: {
          resource: record.resource, status: record.status,
          lastSuccessfulSyncAt: record.lastSuccessfulSyncAt ?? null,
          gap: record.gap ?? null, syncResult: record.syncResult ?? null,
          processedNotificationId: record.processedNotificationId ?? null,
          sourceRevision: record.sourceRevision ?? null, checkedAt: record.checkedAt ?? new Date().toISOString(),
        },
      });
      if (error) throw error;
      return data;
    },
    async upsertSourceIssue(issue) {
      const { data, error } = await serviceRest().rpc('upsert_square_worker_issue', {
        organization_id: issue.organizationId, code: issue.code, state: issue.state,
        revision: issue.revision ?? null, details: issue.details ?? {}, source_refs: issue.sourceRefs ?? [],
      });
      if (error) throw error;
      return data;
    },
    async resolveSourceIssue({ organizationId, code, resolvedAt }) {
      const { data, error } = await serviceRest().rpc('resolve_square_worker_issue', {
        organization_id: organizationId, code, resolved_at: resolvedAt ?? new Date().toISOString(), source_refs: null,
      });
      if (error) throw error;
      return data;
    },
    async resolveSourceIssueRefs({ organizationId, code, sourceRefs, resolvedAt }) {
      if (!Array.isArray(sourceRefs) || sourceRefs.length === 0) return 0;
      const { data, error } = await serviceRest().rpc('resolve_square_worker_issue', {
        organization_id: organizationId, code, resolved_at: resolvedAt ?? new Date().toISOString(), source_refs: sourceRefs,
      });
      if (error) throw error;
      return data;
    },
    async getProjectionSnapshot({ organizationId, sourceRevision, startAt, endAt }) {
      const { data, error } = await serviceRest().rpc('get_square_projection_snapshot', {
        organization_id: organizationId, source_revision: sourceRevision,
        start_at: startAt ?? null, end_at: endAt ?? null,
      });
      if (error) throw error;
      if (!data || !Number.isSafeInteger(data.sourceRevision) || !Array.isArray(data.facts)) return data;
      const snapshot = makeProjectionSnapshot(data, { startAt: data.periodStart ?? startAt, endAt: data.periodEnd ?? endAt });
      return { sourceRevision: data.sourceRevision, snapshot };
    },
    async saveProjectionRunSystem({ organizationId, sourceRevision, calculationVersion, result, sourceSnapshot, cause, idempotencyKey }) {
      const sourceSnapshotHash = sha256(sourceSnapshot);
      const { data, error } = await serviceRest().rpc('save_projection_run_system', {
        organization_id: organizationId, source_revision: sourceRevision,
        calculation_version: calculationVersion, result, source_snapshot: sourceSnapshot,
        source_snapshot_hash: sourceSnapshotHash, cause: String(cause ?? 'worker').slice(0, 300),
        idempotency_key: idempotencyKey,
      });
      if (error) throw error;
      return typeof data === 'string' ? { id: data } : data;
    },
    async syncProjectionIssues({ organizationId, sourceRevision, calculationVersion, periodStart, periodEnd, issues }) {
      const { data, error } = await serviceRest().rpc('sync_square_projection_issues', {
        organization_id: organizationId, source_revision: sourceRevision,
        calculation_version: calculationVersion, period_start: periodStart ?? null,
        period_end: periodEnd ?? null, issues,
      });
      if (error) throw error;
      return data;
    },
    async getSyncHealth({ organizationId }) {
      return await getWorkerHealth(organizationId);
    },
    async getMembership({ organizationId, userId, accessToken }) {
      const rest = userRest(accessToken);
      const rows = await table(rest, 'memberships', new URLSearchParams({ select: 'role', organization_id: eq(organizationId), user_id: eq(userId), limit: '2' }));
      return one(rows, 'membership');
    },
    async getDashboard({ organizationId, accountId, from, to, accessToken }) {
      const rest = userRest(accessToken);
      const orgQuery = new URLSearchParams({ select: 'id,name,base_currency,timezone', id: eq(organizationId), limit: '2' });
      const accountQuery = new URLSearchParams({ select: 'id,name,kind,currency,active', organization_id: eq(organizationId), order: 'name.asc', limit: '500' });
      const policyQuery = new URLSearchParams({ select: 'currency,timezone,tax_treatment,inventory_cost_method,gift_card_treatment,reconciliation_tolerance_minor', organization_id: eq(organizationId), limit: '2' });
      if (accountId) accountQuery.set('id', eq(accountId));
      const runQuery = new URLSearchParams({ select: '*', organization_id: eq(organizationId), period_start: `gte.${from}`, period_end: `lte.${to}`, order: 'created_at.desc', limit: '1' });
      const [orgRows, accounts, policies, rows, workerHealth] = await Promise.all([
        table(rest, 'organizations', orgQuery), table(rest, 'accounts', accountQuery),
        table(rest, 'organization_accounting_policies', policyQuery), table(rest, 'projection_runs', runQuery),
        getWorkerHealth(organizationId),
      ]);
      const latest = rows[0] ?? null;
      const result = latest?.result ?? null;
      const flags = Array.isArray(result?.issues) ? result.issues.map(issue => ({
        code: String(issue.code ?? 'PROJECTION_ISSUE').slice(0, 100),
        message: String(issue.message ?? 'Projection issue requires review.').slice(0, 500)
      })) : [];
      if (!latest) flags.push({ code: 'PROJECTION_UNAVAILABLE', message: 'No projection is available for this period.', severity: 'info' });
      if (!workerHealth) flags.push({ code: 'SOURCE_FRESHNESS_UNAVAILABLE', message: 'Source sync freshness is unavailable.', severity: 'info' });
      const organization = one(orgRows, 'organization');
      const policy = one(policies, 'accounting policy');
      const selectedAccount = accountId ? accounts.find(account => account.id === accountId) : null;
      const accountResults = Array.isArray(result?.accounts) ? result.accounts : [];
      const cash = accountId
        ? accountResults.find(item => item.accountId === accountId) ?? null
        : accountResults.length === 1 ? accountResults[0] : result?.cash ?? null;
      return {
        organization,
        period: { from, to, accountId: accountId ?? null, currency: selectedAccount?.currency ?? policy?.currency ?? organization?.base_currency ?? null, toleranceMinor: policy?.reconciliation_tolerance_minor ?? null },
        projectionVersion: latest?.calculation_version ?? null,
        freshness: { status: workerHealth?.status ?? 'unknown', lastSyncedAt: workerHealth?.lastSuccessfulSyncAt ?? null },
        income: result?.income ?? null,
        cash,
        accounts,
        policy,
        flags,
      };
    },
    async listIssues({ organizationId, state, accessToken }) {
      const query = new URLSearchParams({ select: '*,proposals!proposals_organization_id_issue_id_fkey(id,issue_id,payload,revision,decision,created_at)', organization_id: eq(organizationId), order: 'updated_at.desc', limit: '500' });
      // The API's `open` filter means every state that still needs attention.
      // The schema does not persist an `open` state; filtering for it hid the
      // worker's normal `awaiting_human` and `proposal_pending` issues.
      if (state === 'open') query.set('state', 'in.(monitoring,diagnosing,awaiting_human,proposal_pending,failed)');
      else if (state) query.set('state', eq(state));
      const rows = await table(userRest(accessToken), 'issues', query);
      return rows.map(({ proposals, details, ...issue }) => ({
        ...issue,
        proposal_supported: SUPPORTED_DIAGNOSIS_ISSUE_TYPES.includes(details?.issue_type ?? ISSUE_TYPE_BY_CODE[issue.code]),
        title: typeof details?.title === 'string' ? details.title.slice(0, 200) : undefined,
        details: { ...(typeof details?.message === 'string' ? { message: details.message.slice(0, 1000) } : {}), ...(typeof details?.description === 'string' ? { description: details.description.slice(0, 1000) } : {}) },
        proposals: (Array.isArray(proposals) ? proposals : []).filter(proposal => proposal.decision === 'pending').map(proposal => ({
          id: proposal.id,
          issueId: proposal.issue_id,
          revision: proposal.revision,
          decision: proposal.decision,
          createdAt: proposal.created_at,
          payload: {
            issue_type: proposal.payload?.issue_type ?? null,
            proposed_category: proposal.payload?.proposed_category ?? null,
            confidence: proposal.payload?.confidence ?? null,
            rationale: proposal.payload?.rationale ?? null,
            question: proposal.payload?.question ?? null,
            missing_evidence: proposal.payload?.missing_evidence ?? [],
            candidate_source_ids: proposal.payload?.candidate_source_ids ?? []
          },
          summary: {
            rationale: proposal.payload?.rationale ?? null,
            question: proposal.payload?.question ?? null,
            proposedCategory: proposal.payload?.proposed_category ?? null,
            confidence: proposal.payload?.confidence ?? null,
            missingEvidence: proposal.payload?.missing_evidence ?? [],
            candidateSourceIds: proposal.payload?.candidate_source_ids ?? []
          }
        }))
      }));
    },
    async listManualMovements({ organizationId, accountId, from, to, accessToken }) {
      const query = new URLSearchParams({ select: '*', organization_id: eq(organizationId), order: 'occurred_at.desc', limit: '1000' });
      if (accountId) query.set('account_id', eq(accountId));
      if (from || to) {
        const filters = [from && `occurred_at.gte.${from}`, to && `occurred_at.lt.${to}`].filter(Boolean);
        query.set('and', `(${filters.join(',')})`);
      }
      return table(userRest(accessToken), 'cash_movements', query);
    },
    async getOrganizationFeatureFlags({ organizationId, accessToken }) {
      const query = new URLSearchParams({ select: 'inventory_tracking,product_analytics', organization_id: eq(organizationId), limit: '2' });
      const row = one(await table(userRest(accessToken), 'organization_feature_flags', query), 'organization feature flags');
      return { inventoryTracking: row?.inventory_tracking === true, productAnalytics: row?.product_analytics === true };
    },
    async listInventoryMovements({ organizationId, from, to, accessToken }) {
      const query = new URLSearchParams({ select: '*', organization_id: eq(organizationId), order: 'occurred_at.desc,id.desc', limit: '1000' });
      if (from || to) {
        const filters = [from && `occurred_at.gte.${from}`, to && `occurred_at.lt.${to}`].filter(Boolean);
        query.set('and', `(${filters.join(',')})`);
      }
      return table(userRest(accessToken), 'inventory_movements', query);
    },
    async getInventorySnapshot({ organizationId, from, to, currency, accessToken }) {
      const { data, error } = await userRest(accessToken).rpc('get_inventory_snapshot', {
        organization_id: organizationId, start_at: from, end_at: to, currency
      });
      if (error) throw error;
      return data ?? { from, to, currency, items: [], movements: [], lines: [] };
    },
    async listInventoryItems({ organizationId, asOf, accessToken }) {
      const query = new URLSearchParams({ select: 'id,sku,square_catalog_object_id,name,currency,effective_from,effective_until,unit_cost_minor', organization_id: eq(organizationId), effective_from: `lte.${asOf}`, order: 'name.asc,effective_from.desc', limit: '1000' });
      query.set('or', `(effective_until.is.null,effective_until.gt.${asOf})`);
      const manualQuery = new URLSearchParams({ select: 'id,sku,name,currency,evidence_file_id,reason,created_at', organization_id: eq(organizationId), order: 'name.asc', limit: '1000' });
      const [definitions, manualItems] = await Promise.all([
        table(userRest(accessToken), 'item_definitions', query),
        table(userRest(accessToken), 'inventory_items', manualQuery)
      ]);
      return [
        ...definitions.map(item => ({ ...item, item_kind: 'catalog' })),
        ...manualItems.map(item => ({ ...item, square_catalog_object_id: null, effective_from: null, effective_until: null, unit_cost_minor: null, item_kind: 'manual' }))
      ].sort((a, b) => a.name.localeCompare(b.name) || a.item_kind.localeCompare(b.item_kind));
    },
    async hasEvidenceFile({ organizationId, evidenceFileId, accessToken }) {
      const query = new URLSearchParams({ select: 'id', organization_id: eq(organizationId), id: eq(evidenceFileId), limit: '2' });
      return Boolean(one(await table(userRest(accessToken), 'evidence_files', query), 'evidence file'));
    },
    async recordInventoryItem(args) {
      const { data, error } = await userRest(args.accessToken).rpc('record_inventory_item', {
        organization_id: args.organizationId, sku: args.sku, name: args.name,
        currency: args.currency, evidence_file_id: args.evidenceFileId,
        reason: args.reason, idempotency_key: args.idempotencyKey
      });
      if (error) throw error;
      return { itemId: data };
    },
    async recordSquareCatalogItem(args) {
      const { data, error } = await userRest(args.accessToken).rpc('record_square_catalog_item', {
        organization_id: args.organizationId, idempotency_key: args.idempotencyKey,
        square_catalog_object_id: args.squareCatalogObjectId, name: args.name, sku: args.sku,
        unit_cost_minor: args.unitCostMinor, currency: args.currency, effective_from: args.effectiveFrom,
        evidence_file_id: args.evidenceFileId, reason: args.reason, square_price_minor: args.squarePriceMinor
      });
      if (error) throw error;
      return data;
    },
    async registerSquareCatalogCreationTicket(args) {
      const { data, error } = await serviceRest().rpc('register_square_catalog_creation_ticket', {
        organization_id: args.organizationId, idempotency_key: args.idempotencyKey,
        square_item_id: args.squareItemId, square_catalog_object_id: args.squareCatalogObjectId,
        name: args.name, variation_name: args.variationName, sku: args.sku,
        currency: args.currency, price_minor: args.priceMinor
      });
      if (error) throw error;
      return data === true;
    },
    async recordSquareCatalogManagementEvent(args) {
      const { data, error } = await userRest(args.accessToken).rpc('record_square_catalog_management_event', {
        organization_id: args.organizationId, idempotency_key: args.idempotencyKey,
        action: args.action, square_object_id: args.squareObjectId,
        before_state: args.beforeState ?? {}, after_state: args.afterState ?? {}, reason: args.reason,
      });
      if (error) throw error;
      return data;
    },
    async recordInventoryPurchase(args) {
      const { data, error } = await userRest(args.accessToken).rpc('record_inventory_purchase', {
        organization_id: args.organizationId, account_id: args.accountId,
        amount_minor: args.amountMinor, currency: args.currency, occurred_at: args.occurredAt,
        description: args.description, evidence_file_id: args.evidenceFileId,
        idempotency_key: args.idempotencyKey,
        lines: args.lines.map(line => ({ itemId: line.itemId, itemName: line.itemName, quantity: line.quantity, unitCostMinor: line.unitCostMinor }))
      });
      if (error) throw error;
      return data;
    },
    async reserveReceiptModelBudget(args) {
      const { data, error } = await userRest(args.accessToken).rpc('reserve_receipt_agent_budget', {
        organization_id: args.organizationId, run_id: args.runId, model_id: args.model,
        max_input_tokens: args.maxInputTokens, max_output_tokens: args.maxOutputTokens, max_attempts: args.maxAttempts
      });
      if (error) throw error;
      return data === true;
    },
    async recordReceiptModelUsage(args) {
      const { data, error } = await userRest(args.accessToken).rpc('record_receipt_agent_usage', {
        organization_id: args.organizationId, run_id: args.runId, model_id: args.model,
        usage: args.usage ?? {}, attempt: args.attempt
      });
      if (error) throw error;
      return data === true;
    },
    async listReceiptCatalogCandidates(args) {
      const { data, error } = await userRest(args.accessToken).rpc('list_receipt_catalog_candidates', {
        organization_id: args.organizationId, currency: args.currency
      });
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    },
    async recordReceiptItemCosts(args) {
      const { data, error } = await userRest(args.accessToken).rpc('record_receipt_item_costs', {
        organization_id: args.organizationId, evidence_file_id: args.evidenceFileId,
        reason: args.reason, idempotency_key: args.idempotencyKey,
        updates: args.updates.map(update => ({ catalogObjectId: update.catalogObjectId, name: update.name, unitCostMinor: update.unitCostMinor,
          currency: update.currency, effectiveFrom: update.effectiveFrom }))
      });
      if (error) throw error;
      return data;
    },
    async recordInventoryCorrection(args) {
      const { data, error } = await userRest(args.accessToken).rpc('record_inventory_correction', {
        organization_id: args.organizationId, item_id: args.itemId,
        quantity_delta: args.quantityDelta, occurred_at: args.occurredAt,
        reason: args.reason, evidence_file_id: args.evidenceFileId,
        idempotency_key: args.idempotencyKey
      });
      if (error) throw error;
      return { movementId: data };
    },
    async recordInventoryOpening(args) {
      const { data, error } = await userRest(args.accessToken).rpc('record_inventory_opening', {
        organization_id: args.organizationId, item_id: args.itemId, quantity: args.quantity,
        occurred_at: args.occurredAt, reason: args.reason, evidence_file_id: args.evidenceFileId,
        idempotency_key: args.idempotencyKey
      });
      if (error) throw error;
      return { movementId: data };
    },
    async listProductAnalyticsFacts({ organizationId, from, to, accessToken }) {
      const { data, error } = await userRest(accessToken).rpc('get_product_analytics_facts', {
        organization_id: organizationId, start_at: from, end_at: to
      });
      if (error) throw error;
      return data ?? { from, to, facts: [], policy: {}, sourceHealth: [], openIssueCount: 0 };
    },
    async listProductCatalogItems({ organizationId, accessToken }) {
      const { data, error } = await userRest(accessToken).rpc('get_product_catalog_items', {
        organization_id: organizationId
      });
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    },
    async listObservations({ organizationId, accountId, accessToken }) {
      const query = new URLSearchParams({ select: '*', organization_id: eq(organizationId), order: 'observed_at.desc', limit: '1000' });
      if (accountId) query.set('account_id', eq(accountId));
      return table(userRest(accessToken), 'balance_observations', query);
    },
    async listAuditEvents({ organizationId, limit, accessToken }) {
      const query = new URLSearchParams({ select: '*', organization_id: eq(organizationId), order: 'created_at.desc', limit: String(limit) });
      return table(userRest(accessToken), 'audit_events', query);
    },
    async getSettings({ organizationId, accessToken }) {
      const rest = userRest(accessToken);
      const orgRows = await table(rest, 'organizations', new URLSearchParams({ select: 'id,name,base_currency,timezone', id: eq(organizationId), limit: '2' }));
      const accounts = await table(rest, 'accounts', new URLSearchParams({ select: 'id,name,kind,currency,active', organization_id: eq(organizationId), order: 'name.asc', limit: '500' }));
      const periods = await table(rest, 'accounting_periods', new URLSearchParams({ select: 'id,starts_at,ends_at,status,closed_at', organization_id: eq(organizationId), order: 'starts_at.desc', limit: '100' }));
      const policies = await table(rest, 'organization_accounting_policies', new URLSearchParams({ select: '*', organization_id: eq(organizationId), limit: '2' }));
      return { organization: one(orgRows, 'organization'), accounts, periods, policy: one(policies, 'accounting policy') };
    },
    async getIssue({ organizationId, issueId, accessToken }) {
      const query = new URLSearchParams({ select: '*', organization_id: eq(organizationId), id: eq(issueId), limit: '2' });
      const row = one(await table(userRest(accessToken), 'issues', query), 'issue');
      if (!row) return null;
      const type = row.details?.issue_type ?? ISSUE_TYPE_BY_CODE[row.code];
      return {
        ...row,
        type,
        // Projection issues carry the accounting calculation version rather
        // than a separate diagnosis policy version. Reuse it as the stable
        // policy context for a proposal, with a safe fallback for older rows.
        policyVersion: row.details?.policy_version ?? row.details?.calculation_version ?? 'finance-loop-accounting-v1',
        // No category is allowed unless the issue explicitly supplies a
        // reviewed allowlist. That keeps proposals from inventing costs.
        allowedCategories: Array.isArray(row.details?.allowed_categories) ? row.details.allowed_categories : [],
      };
    },
    async getIssueEvidence({ organizationId, issueId, accessToken }) {
      const issue = await db.getIssue({ organizationId, issueId, accessToken });
      if (!issue) return { evidence: [], correctionReady: false };
      let { data, error } = await serviceRest().rpc('get_issue_square_evidence', {
        organization_id: organizationId, issue_code: issue.code, source_refs: issueEvidenceRefs(issue),
      });
      let correctionReady = !error;
      if (error && ['PGRST202', '42883'].includes(error.code)) {
        // Older deployments can still show evidence while waiting for the scoped evidence RPC migration.
        const fallback = await serviceRest().rpc('get_square_projection_snapshot', {
          organization_id: organizationId, source_revision: 0, start_at: null, end_at: null,
        });
        data = fallback.data;
        error = fallback.error;
        correctionReady = false;
      }
      if (error) throw error;
      const storedFacts = Array.isArray(data?.facts) ? data.facts : [];
      const facts = await refreshIssueSquareEvidence({ issue, facts: storedFacts, tokenVault, squareBaseUrl, squareApiVersion, fetchImpl });
      const evidence = issueEvidenceFromFacts(issue, facts);
      Object.defineProperty(evidence, 'correctionReady', { value: correctionReady, enumerable: false });
      return evidence;
    },
    async recordItemDefinition(args) {
      const { data, error } = await userRest(args.accessToken).rpc('record_item_definition', {
        organization_id: args.organizationId, issue_id: args.issueId,
        square_catalog_object_id: args.squareCatalogObjectId, name: args.name,
        unit_cost_minor: args.unitCostMinor, currency: args.currency,
        effective_from: args.effectiveFrom, approval_reason: args.reason,
        idempotency_key: args.idempotencyKey
      });
      if (error) throw error;
      return typeof data === 'string' ? { id: data } : data;
    },
    async recordSaleLineCostOverride(args) {
      const { data, error } = await userRest(args.accessToken).rpc('record_square_sale_line_cost_override', {
        organization_id: args.organizationId, issue_id: args.issueId,
        square_order_id: args.squareOrderId, square_line_uid: args.squareLineUid,
        unit_cost_minor: args.unitCostMinor,
        currency: args.currency, approval_reason: args.reason, idempotency_key: args.idempotencyKey
      });
      if (error) throw error;
      return typeof data === 'string' ? { id: data } : data;
    },
    async recordRefundCostReview(args) {
      const { data, error } = await userRest(args.accessToken).rpc('record_refund_cost_review', {
        organization_id: args.organizationId, issue_id: args.issueId,
        square_refund_id: args.squareRefundId, square_order_id: args.squareOrderId,
        disposition: args.disposition, approved_cogs_reversal_minor: args.approvedCogsReversalMinor,
        currency: args.currency, decision_reason: args.reason, idempotency_key: args.idempotencyKey
      });
      if (error) throw error;
      return typeof data === 'string' ? { id: data } : data;
    },
    async createProposalAtomic(args) {
      const { data, error } = await userRest(args.accessToken).rpc('create_proposal_atomic', {
        organization_id: args.organizationId, issue_id: args.issueId, payload: args.proposal,
        model_id: args.modelId, prompt_version: args.promptVersion, validation_status: args.validationStatus,
        idempotency_key: args.idempotencyKey, correlation_id: args.correlationId
      });
      if (error) throw error;
      return typeof data === 'string' ? { id: data } : data;
    },
    async reserveModelBudget(args) {
      const { data, error } = await userRest(args.accessToken).rpc('reserve_model_budget', {
        organization_id: args.organizationId, issue_id: args.issueId, model_id: args.model,
        max_input_tokens: args.maxInputTokens ?? 12000,
        max_output_tokens: args.maxOutputTokens, max_attempts: args.maxAttempts
      });
      if (error) throw error;
      return data === true;
    },
    async recordModelUsage(args) {
      const { data, error } = await userRest(args.accessToken).rpc('record_model_usage', {
        organization_id: args.organizationId, issue_id: args.issueId, model_id: args.model,
        usage: args.usage ?? {}, attempt: args.attempt
      });
      if (error) throw error;
      return data;
    },
    async configureAccountOpeningBalance(args) {
      const { data, error } = await userRest(args.accessToken).rpc('configure_account_opening_balance', {
        organization_id: args.organizationId, account_id: args.accountId,
        amount_minor: args.amountMinor, observed_at: args.observedAt,
        evidence_file_id: args.evidenceFileId, reason: args.reason
      });
      if (error) throw error;
      return data;
    },
    async getReplaySnapshot({ organizationId, runId, accessToken }) {
      const query = new URLSearchParams({ select: 'id,source_snapshot', organization_id: eq(organizationId), id: eq(runId), limit: '2' });
      const row = one(await table(userRest(accessToken), 'projection_runs', query), 'projection run');
      // Never replay a derived result in place of its source inputs.
      return row?.source_snapshot && typeof row.source_snapshot === 'object' ? row.source_snapshot : null;
    },
    async saveProjectionRun(args) {
      const { data, error } = await userRest(args.accessToken).rpc('save_projection_run', {
        organization_id: args.organizationId, source_run_id: args.sourceRunId,
        calculation_version: args.calculationVersion, result: args.result,
        idempotency_key: args.idempotencyKey, correlation_id: args.correlationId
      });
      if (error) throw error;
      return typeof data === 'string' ? { id: data } : data;
    }
  };

  const queue = {
    async enqueueSquareSync(args) {
      const { data, error } = await serviceRest().rpc('enqueue_square_sync', {
        organization_id: args.organizationId, start_at: args.startAt, end_at: args.endAt,
        location_ids: args.locationIds, idempotency_key: args.idempotencyKey, requested_by: args.requestedBy
      });
      if (error) throw error;
      return typeof data === 'string' ? { id: data } : data;
    },
    async enqueueSquareWebhook({ notificationId }) {
      const { data, error } = await serviceRest().rpc('enqueue_square_webhook', { notification_id: notificationId });
      if (error) throw error;
      return data;
    },
    async enqueueProjectionReplay(args) {
      const { data, error } = await serviceRest().rpc('enqueue_projection_replay', {
        organization_id: args.organizationId, start_at: args.startAt, end_at: args.endAt,
        idempotency_key: args.idempotencyKey, requested_by: args.requestedBy
      });
      if (error) throw error;
      return typeof data === 'string' ? { id: data } : data;
    },
    async claim({ workerId, leaseSeconds, types }) {
      const { data, error } = await serviceRest().rpc('claim_durable_jobs', { worker_id: workerId, lease_seconds: leaseSeconds, types });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return row ? { id: row.id, organizationId: row.organization_id, type: row.job_type, payload: row.payload, attempts: row.attempts, maxAttempts: row.max_attempts, leaseToken: row.lease_token } : null;
    },
    async extendLease({ jobId, workerId, leaseToken, leaseSeconds }) {
      const { data, error } = await serviceRest().rpc('extend_durable_job_lease', {
        job_id: jobId, worker_id: workerId, lease_token: leaseToken, lease_seconds: leaseSeconds,
      });
      if (error) throw error;
      return data === true;
    },
    async ack({ jobId, workerId, leaseToken }) {
      const { data, error } = await serviceRest().rpc('ack_durable_job', { job_id: jobId, worker_id: workerId, lease_token: leaseToken });
      if (error) throw error;
      return data;
    },
    async retry({ jobId, workerId, leaseToken, delayMs, code }) {
      const { data, error } = await serviceRest().rpc('retry_durable_job', { job_id: jobId, worker_id: workerId, lease_token: leaseToken, delay_ms: delayMs, error_code: code });
      if (error) throw error;
      return data;
    },
    async deadLetter({ jobId, workerId, leaseToken, code, message }) {
      const { data, error } = await serviceRest().rpc('dead_letter_durable_job', { job_id: jobId, worker_id: workerId, lease_token: leaseToken, error_code: code, message });
      if (error) throw error;
      return data;
    }
  };
  const webhookInbox = {
    async putIfAbsent(notificationId, record) {
      const { data, error } = await serviceRest().rpc('persist_square_webhook', { notification_id: notificationId, record });
      if (error) throw error;
      return { inserted: data === true, record };
    }
  };
  const stateStore = {
    async save({ state, organizationId, userId, redirectUri, expiresAt, scopes }) {
      const stateSha256 = createHash('sha256').update(state).digest('hex');
      const { error } = await serviceRest().rpc('save_square_oauth_state', {
        state_sha256: stateSha256, organization_id: organizationId, user_id: userId,
        redirect_uri: redirectUri, expires_at: expiresAt, scopes
      });
      if (error) throw error;
    },
    async consume({ state }) {
      const stateSha256 = createHash('sha256').update(state).digest('hex');
      const { data, error } = await serviceRest().rpc('consume_square_oauth_state', { state_sha256: stateSha256 });
      if (error) throw error;
      return data ? { state, ...data } : null;
    }
  };
  const tokenVault = {
    async storeEncrypted(record) {
      if (!encryptionKey) throw new Error('Square token encryption key is unavailable');
      const aad = `${record.organizationId}:${record.merchantId}`;
      const encrypt = (token, purpose) => {
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
        cipher.setAAD(Buffer.from(`${aad}:${purpose}`));
        const ciphertext = Buffer.concat([cipher.update(requiredString(token, `${purpose} token`), 'utf8'), cipher.final()]);
        return { ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
      };
      const access = encrypt(record.accessToken, 'access');
      const refresh = encrypt(record.refreshToken, 'refresh');
      const encrypted = {
        organizationId: record.organizationId, connectedBy: record.connectedBy, merchantId: record.merchantId,
        accessCiphertext: access.ciphertext, accessNonce: access.nonce, accessTag: access.tag,
        refreshCiphertext: refresh.ciphertext, refreshNonce: refresh.nonce, refreshTag: refresh.tag,
        expiresAt: record.expiresAt, scopes: record.scopes, tokenType: record.tokenType
      };
      const { error } = await serviceRest().rpc('store_square_tokens', { record: encrypted });
      if (error) throw error;
    },
    async getDecrypted({ organizationId }) {
      if (!encryptionKey) throw new Error('Square token encryption key is unavailable');
      const { data, error } = await serviceRest().rpc('get_square_tokens', { organization_id: organizationId });
      if (error) throw error;
      if (!data) return null;
      const aad = `${data.organizationId}:${data.merchantId}`;
      const decrypt = (purpose, prefix) => {
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(data[`${prefix}Nonce`], 'base64'));
        decipher.setAAD(Buffer.from(`${aad}:${purpose}`));
        decipher.setAuthTag(Buffer.from(data[`${prefix}Tag`], 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(data[`${prefix}Ciphertext`], 'base64')), decipher.final()]).toString('utf8');
      };
      return { organizationId: data.organizationId, connectedBy: data.connectedBy, merchantId: data.merchantId,
        accessToken: decrypt('access', 'access'), refreshToken: decrypt('refresh', 'refresh'),
        expiresAt: data.expiresAt, scopes: data.scopes, tokenType: data.tokenType };
    }
  };
  const supabase = {
    auth: {
      async getUser(accessToken) {
        if (!publicKey) return { data: null, error: new Error('Supabase publishable key is unavailable') };
        const response = await fetchImpl(`${baseUrl}/auth/v1/user`, {
          headers: { apikey: publicKey, Authorization: `Bearer ${requiredString(accessToken, 'accessToken')}` }
        });
        let data = null; try { data = await response.json(); } catch {}
        if (!response.ok) return { data: null, error: safeError(data, response.status) };
        return { data: { user: data }, error: null };
      }
    }
  };
  return Object.freeze({ supabase, db: Object.freeze(db), queue: Object.freeze(queue), webhookInbox, stateStore, tokenVault });
}
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
