import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseIssue, redactEvidence, validateDiagnosis, DiagnosisError } from '../src/agent/diagnosis.mjs';

const proposal = {
  issue_type: 'balance_mismatch', candidate_source_ids: ['receipt-1'], proposed_category: 'misc_spend',
  confidence: 0.7, rationale: 'Receipt may explain the difference', missing_evidence: [],
  question: null, policy_version: 'p1'
};
const context = { issueType: 'balance_mismatch', sourceIds: new Set(['receipt-1']), policyVersion: 'p1', allowedCategories: new Set(['misc_spend']) };

test('rejects invented evidence, unauthorized category, extra arithmetic, and wrong policy', () => {
  for (const patch of [
    { candidate_source_ids: ['invented'] }, { proposed_category: 'pay' },
    { amount_minor: -1000 }, { policy_version: 'p2' }
  ]) assert.throws(() => validateDiagnosis({ ...proposal, ...patch }, context), DiagnosisError);
  assert.deepEqual(validateDiagnosis(proposal, context), proposal);
});

test('accepts a refund COGS review draft that asks for human evidence without deciding a category', () => {
  const draft = {
    issue_type: 'refund_cogs_review', candidate_source_ids: ['refund-1'], proposed_category: null,
    confidence: 0.8, rationale: 'The linked refund does not show whether goods returned to inventory.',
    missing_evidence: ['Return and restock disposition'],
    question: 'Were the refunded goods returned to inventory, and should COGS be reversed?',
    policy_version: 'finance-loop-accounting-v1'
  };
  assert.deepEqual(validateDiagnosis(draft, {
    issueType: 'refund_cogs_review', sourceIds: new Set(['refund-1']),
    policyVersion: 'finance-loop-accounting-v1', allowedCategories: new Set()
  }), draft);
});

test('sends only allowlisted evidence and returns an unposted draft', async () => {
  let requestBody;
  const result = await diagnoseIssue({
    issue: { id: 'issue-1', type: 'balance_mismatch', code: 'BALANCE_MISMATCH', details: { customerEmail: 'secret@example.com' } },
    records: [{ id: 'receipt-1', type: 'receipt', amount_minor: -1000, description: 'secret@example.com', card_number: 'secret' }],
    policyVersion: 'p1', allowedCategories: ['misc_spend']
  }, {
    apiKey: 'fake', reserveBudget: async () => true,
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(proposal) } }], usage: { total_tokens: 20 } }) };
    }
  });
  assert.equal(result.status, 'draft');
  assert.equal(result.proposal.candidate_source_ids[0], 'receipt-1');
  assert.equal(JSON.stringify(requestBody).includes('secret'), false);
  assert.equal(requestBody.response_format.type, 'json_schema');
});

test('budget denial prevents model call and invalid JSON fails closed', async () => {
  let called = false;
  const input = { issue: { id: 'i', type: 'balance_mismatch' }, records: [], policyVersion: 'p1' };
  await assert.rejects(diagnoseIssue(input, { apiKey: 'fake', reserveBudget: async () => false, fetchImpl: () => { called = true; } }), { code: 'BUDGET_EXCEEDED' });
  assert.equal(called, false);
  await assert.rejects(diagnoseIssue(input, { apiKey: 'fake', reserveBudget: async () => true, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not JSON' } }] }) }) }), { code: 'MODEL_UNAVAILABLE' });
});

test('redacts unsupported fields', () => {
  assert.deepEqual(redactEvidence([{ id: 'r', amount_minor: 2, email: 'private' }]), [{ id: 'r', amount_minor: 2 }]);
  assert.deepEqual(redactEvidence([{ id: 'line', catalog_object_id: null, quantity: 1.25, refund_minor: null }]), [
    { id: 'line', refund_minor: null, quantity: 1.25, catalog_object_id: null }
  ]);
});
