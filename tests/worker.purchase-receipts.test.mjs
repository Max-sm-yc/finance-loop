import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorker } from '../src/worker/index.mjs';

const receiptId = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';
const job = { id: 'receipt-job', organizationId: org, type: 'receipt.process',
  payload: { receiptId }, attempts: 1, leaseToken: 'receipt-lease' };

function harness({ processed = false, budget = true, downloadError, attempts = 1, wrongHash = false, modelResponse,
  matchingOptions = { catalogRows: [], inventoryRows: [] }, jevFailure = false } = {}) {
  const events = [];
  let saved = processed;
  const db = Object.fromEntries(['getWebhookNotification','upsertSquareFacts','recordSourceHealth',
    'upsertSourceIssue','resolveSourceIssueRefs','getProjectionSnapshot','saveProjectionRunSystem',
    'syncProjectionIssues','getSyncHealth'].map(name => [name, async () => { events.push(name); return {}; }]));
  Object.assign(db, {
    getPurchaseReceiptForProcessing: async args => {
      assert.equal(args.organizationId, org);
      return saved ? null : { objectKey: `${org}/receipts/${receiptId}/source.pdf`, mimeType: 'application/pdf', activeDraftVersion: 0,
        sha256Hex: wrongHash ? '0'.repeat(64) : createHash('sha256').update('%PDF-synthetic-test-document').digest('hex') };
    },
    downloadPurchaseReceiptObject: async () => {
      if (downloadError) throw downloadError;
      return Buffer.from('%PDF-synthetic-test-document');
    },
    reservePurchaseReceiptModelBudget: async () => { events.push('reserve'); return budget; },
    recordPurchaseReceiptModelUsage: async () => { events.push('usage'); },
    getPurchaseReceiptMatchingOptionsSystem: async args => { events.push(['matching-options', args]); return matchingOptions; },
    reservePurchaseReceiptJevBudget: async args => { events.push(['jev-reserve', args]); return true; },
    recordPurchaseReceiptJevUsage: async args => { events.push(['jev-usage', args]); },
    savePurchaseReceiptDraftSystem: async args => { saved = true; events.push(['draft', args]); return { version: 1 }; },
    failPurchaseReceiptProcessing: async args => { events.push(['failed', args]); },
  });
  const queue = {
    claim: async () => ({ ...job, attempts }),
    ack: async args => { events.push(['ack', args]); return true; },
    retry: async args => { events.push(['retry', args]); return true; },
    deadLetter: async args => { events.push(['dead', args]); return true; },
  };
  const worker = createWorker({ db, queue, tokenVault: { getDecrypted: async () => { throw new Error('Receipt must not fetch Square tokens'); } },
    config: { squareApiVersion: 'test', enabledJobTypes: ['receipt.process'], openRouterApiKey: 'test-only-key', maxJobAttempts: 2 },
    makeSquareClient: () => { throw new Error('Receipt must not call Square'); },
    extractReceiptDocumentTextFn: async () => 'Supplier USD purchase receipt',
    fetchImpl: async (url, request) => {
      if (String(url).includes('/alpha/decisions')) {
        events.push('jev-model');
        if (jevFailure) throw Object.assign(new Error('provider details must not be saved'), { code: 'JEV_UNAVAILABLE' });
        const body = JSON.parse(request.body);
        const answers = Object.fromEntries(Object.keys(body.questions).map(key => {
          const choices = Object.keys(body.questions[key].criteria);
          const choice = choices.find(value => value.startsWith('item_')) ?? '__none__';
          return [key, { type: 'choice', choice, confidence: 0.9,
            probabilities: Object.fromEntries(choices.map(value => [value, value === choice ? 0.9 : 0.1 / (choices.length - 1)])) }];
        }));
        return new Response(JSON.stringify({ model: 'typesafe/jev-1.13', usage: { input_tokens: 100, output_tokens: 20 }, answers }), { status: 200 });
      }
      events.push('model');
      if (!modelResponse) throw new Error('Budget denial must prevent model calls');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelResponse) } }] }), { status: 200 });
    },
  });
  return { worker, events };
}

test('already processed receipt jobs acknowledge without extracting or posting financial facts', async () => {
  const { worker, events } = harness({ processed: true });
  const result = await worker.runOne({ workerId: 'receipt-worker' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(events.map(event => Array.isArray(event) ? event[0] : event), ['ack']);
  assert.equal(events[0][1].leaseToken, job.leaseToken);
});

test('receipt budget denial persists failure and dead-letters without model or accounting writes', async () => {
  const { worker, events } = harness({ budget: false });
  const result = await worker.runOne({ workerId: 'receipt-worker' });
  assert.equal(result.status, 'dead_lettered');
  assert.equal(result.code, 'BUDGET_EXCEEDED');
  assert.ok(events.some(event => Array.isArray(event) && event[0] === 'failed' && event[1].code === 'BUDGET_EXCEEDED'));
  assert.ok(events.some(event => Array.isArray(event) && event[0] === 'dead'));
  assert.ok(!events.some(event => ['draft','usage','saveProjectionRunSystem','upsertSquareFacts'].includes(Array.isArray(event) ? event[0] : event)));
});

test('invalid model response marks the receipt failed without retrying against the same reservation', async () => {
  const { worker, events } = harness({ modelResponse: { document_kind: 'invoice' } });
  const result = await worker.runOne({ workerId: 'receipt-worker' });
  assert.equal(result.status, 'dead_lettered');
  assert.equal(result.code, 'MODEL_INVALID_RESPONSE');
  assert.ok(events.some(event => Array.isArray(event) && event[0] === 'failed' && event[1].code === 'MODEL_INVALID_RESPONSE'));
  assert.ok(events.some(event => Array.isArray(event) && event[0] === 'dead'));
  assert.ok(!events.some(event => Array.isArray(event) && event[0] === 'retry'));
});

test('terminal receipt download failure marks the inbox failed instead of leaving it processing', async () => {
  const { worker, events } = harness({ attempts: 2, downloadError: Object.assign(new Error('network unavailable'), { code: 'NETWORK_FAILURE' }) });
  const result = await worker.runOne({ workerId: 'receipt-worker' });
  assert.equal(result.status, 'dead_lettered');
  assert.ok(events.some(event => Array.isArray(event) && event[0] === 'failed'));
  assert.ok(!events.includes('reserve'));
});

test('changed evidence bytes fail before extraction budget or model use', async () => {
  const { worker, events } = harness({ wrongHash: true });
  const result = await worker.runOne({ workerId: 'receipt-worker' });
  assert.equal(result.status, 'dead_lettered');
  assert.equal(result.code, 'RECEIPT_CHECKSUM_MISMATCH');
  assert.ok(!events.includes('reserve') && !events.includes('model'));
});

test('successful document processing saves an evidence draft and never posts accounting facts', async () => {
  const modelResponse = { document_kind: 'invoice', supplier: 'Synthetic supplier', invoice_date: '2026-10-03',
    purchase_reference: null, currency: 'USD',
    totals: { subtotal: '12.00', discount: '0.00', tax: '0.00', shipping: '0.00', other_charges: '0.00', total: '12.00' },
    payment: { status: 'unpaid', paid_date: null, funding_hint: null },
    lines: [{ description: 'Synthetic stock', quantity: '2', units_per_package: '1', unit_price: '6.00', line_amount: '12.00' }] };
  const { worker, events } = harness({ modelResponse });
  const result = await worker.runOne({ workerId: 'receipt-worker' });
  assert.equal(result.status, 'completed');
  const savedDraft = events.find(event => Array.isArray(event) && event[0] === 'draft')[1];
  assert.equal(savedDraft.receiptId, receiptId);
  assert.equal(savedDraft.expectedVersion, 0);
  assert.equal(savedDraft.draft.totals.totalMinor, 1200);
  assert.equal(savedDraft.draft.payment.status, 'unpaid');
  assert.equal(savedDraft.draft.inventoryMatching.status, 'completed');
  assert.equal(savedDraft.draft.inventoryMatching.matches[0].reason, 'no_inventory_options');
  assert.ok(!events.some(event => ['saveProjectionRunSystem', 'upsertSquareFacts'].includes(event)));
  assert.equal(events.at(-1)[0], 'ack');
});

test('receipt upload processing saves automatic Jev suggestions alongside extraction without posting them', async () => {
  const modelResponse = { document_kind: 'invoice', supplier: 'Synthetic supplier', invoice_date: '2026-10-03',
    purchase_reference: null, currency: 'USD',
    totals: { subtotal: '12.00', discount: '0.00', tax: '0.00', shipping: '0.00', other_charges: '0.00', total: '12.00' },
    payment: { status: 'unpaid', paid_date: null, funding_hint: null },
    lines: [{ description: 'Synthetic stock', quantity: '2', units_per_package: '1', unit_price: '6.00', line_amount: '12.00' }] };
  const matchingOptions = { catalogRows: [{ catalogObjectId: 'variation-1', name: 'Synthetic stock · 2 pack', currency: 'USD' }], inventoryRows: [] };
  const { worker, events } = harness({ modelResponse, matchingOptions });
  const result = await worker.runOne({ workerId: 'receipt-worker' });
  assert.equal(result.status, 'completed');
  const savedDraft = events.find(event => Array.isArray(event) && event[0] === 'draft')[1].draft;
  assert.deepEqual(savedDraft.inventoryMatching.matches, [{ lineId: 'line-1', itemId: 'square:variation-1',
    itemName: 'Synthetic stock · 2 pack', confidence: 0.9, reason: null }]);
  assert.ok(events.indexOf('jev-model') < events.findIndex(event => Array.isArray(event) && event[0] === 'draft'));
  assert.ok(events.some(event => Array.isArray(event) && event[0] === 'jev-reserve' && event[1].jobId === job.id));
  assert.ok(events.some(event => Array.isArray(event) && event[0] === 'jev-usage'));
  assert.ok(!events.some(event => ['saveProjectionRunSystem', 'upsertSquareFacts'].includes(event)));
});

test('Jev provider failure preserves the extracted draft for human review', async () => {
  const modelResponse = { document_kind: 'receipt', supplier: 'Synthetic supplier', invoice_date: '2026-10-03',
    purchase_reference: null, currency: 'USD',
    totals: { subtotal: '12.00', discount: '0.00', tax: '0.00', shipping: '0.00', other_charges: '0.00', total: '12.00' },
    payment: { status: 'unpaid', paid_date: null, funding_hint: null },
    lines: [{ description: 'Synthetic stock', quantity: '2', units_per_package: '1', unit_price: '6.00', line_amount: '12.00' }] };
  const { worker, events } = harness({ modelResponse, matchingOptions: {
    catalogRows: [{ catalogObjectId: 'variation-1', name: 'Synthetic stock', currency: 'USD' }], inventoryRows: [],
  }, jevFailure: true });
  const result = await worker.runOne({ workerId: 'receipt-worker' });
  assert.equal(result.status, 'completed');
  const savedDraft = events.find(event => Array.isArray(event) && event[0] === 'draft')[1].draft;
  assert.equal(savedDraft.inventoryMatching.status, 'unavailable');
  assert.equal(savedDraft.inventoryMatching.errorCode, 'JEV_UNAVAILABLE');
  assert.equal(savedDraft.supplier, 'Synthetic supplier');
  assert.ok(!events.some(event => Array.isArray(event) && event[0] === 'failed'));
});
