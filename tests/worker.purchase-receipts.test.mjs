import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorker } from '../src/worker/index.mjs';

const receiptId = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';
const job = { id: 'receipt-job', organizationId: org, type: 'receipt.process',
  payload: { receiptId }, attempts: 1, leaseToken: 'receipt-lease' };

function harness({ processed = false, budget = true, downloadError, attempts = 1, wrongHash = false, modelResponse } = {}) {
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
    fetchImpl: async () => {
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
  assert.ok(!events.some(event => ['saveProjectionRunSystem', 'upsertSquareFacts'].includes(event)));
  assert.equal(events.at(-1)[0], 'ack');
});
