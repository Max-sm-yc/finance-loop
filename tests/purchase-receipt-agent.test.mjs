import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPurchaseReceipt } from '../src/agent/purchase-receipt.mjs';

const makeFetch = (result, expectedMaxTokens = 1400) => async (_url, request) => {
  const input=JSON.parse(request.body);
  assert.equal(input.max_tokens,expectedMaxTokens);
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:200,completion_tokens:300}}),{status:200,headers:{'content-type':'application/json'}});
};
const base = overrides => ({
  document_kind:'receipt',supplier:'Example Supply',invoice_date:'2026-10-03',purchase_reference:'R-123',currency:'USD',
  totals:{subtotal:'468.74',discount:'4.00',tax:'4.14',shipping:'8.00',other_charges:'0.00',total:'476.88'},
  payment:{status:'authorized',paid_date:null,funding_hint:'credit card'},
  lines:[{description:'Kit Kat 36 pack',quantity:'5',units_per_package:'36',unit_price:'42.56',line_amount:'212.80'},
    {description:'Other supplier items',quantity:'1',units_per_package:null,unit_price:null,line_amount:'251.94'}],
  ...overrides
});

test('purchase receipt extraction accepts 3000 output tokens and rejects larger limits',async()=>{
  let reservedOutputTokens;
  const draft=await extractPurchaseReceipt({text:'Supplier receipt'}, {
    apiKey:'test-only',maxOutputTokens:3000,fetchImpl:makeFetch(base(),3000),
    reserveBudget:async args=>{reservedOutputTokens=args.maxOutputTokens;return true;}
  });
  assert.equal(draft.documentKind,'receipt');
  assert.equal(reservedOutputTokens,3000);
  await assert.rejects(extractPurchaseReceipt({text:'Supplier receipt'}, {
    apiKey:'test-only',maxOutputTokens:3001,fetchImpl:makeFetch(base(),3001),reserveBudget:async()=>true
  }),{code:'INVALID_INPUT'});
});

test('reconciles net item amounts with separately printed discount, tax, shipping and total',async()=>{
  let reserved, recorded;
  const draft=await extractPurchaseReceipt({text:'[page 1]\nKit Kat 36 pack\nQty 5\n$42.56 each\n$212.80\nSubtotal $468.74\nSavings $4.00\nShipping $8.00\nTax $4.14\nTotal $476.88'}, {
    apiKey:'test-only',fetchImpl:makeFetch(base()),reserveBudget:async args=>(reserved=args,true),recordUsage:async args=>{recorded=args;}
  });
  assert.equal(draft.documentKind,'receipt');
  assert.equal(draft.reconciliation.status,'matched');
  assert.equal(draft.reconciliation.discountPlacement,'separate_from_subtotal');
  assert.equal(draft.lines[0].lineId,'line-1');
  assert.equal(draft.lines[0].lineAmountMinor,21280);
  assert.equal(draft.lines[0].unitsPerPackage,36);
  assert.equal(draft.lines[0].sourcePage,1);
  assert.ok(reserved.maxInputTokens<=12000);
  assert.equal(recorded.usage.completion_tokens,300);
});

test('retains exact decimal source amounts when currency is not printed and keeps minor amounts unresolved',async()=>{
  const result=base({currency:null,totals:{subtotal:'12.00',discount:null,tax:null,shipping:null,other_charges:null,total:'12.00'},lines:[{description:'Soap',quantity:'2',units_per_package:null,unit_price:null,line_amount:'12.00'}]});
  const draft=await extractPurchaseReceipt({text:'Soap qty 2 $12.00'}, {apiKey:'test-only',fetchImpl:makeFetch(result),reserveBudget:async()=>true});
  assert.equal(draft.currency,null);
  assert.equal(draft.totals.totalMinor,null);
  assert.equal(draft.totals.totalAmount,'12.00');
  assert.equal(draft.lines[0].lineAmountMinor,null);
  assert.equal(draft.lines[0].sourceAmounts.lineAmount,'12.00');
  assert.equal(draft.reconciliation.status,'incomplete');
});

test('does not treat a missing line amount as zero and marks unsupported documents for human confirmation',async()=>{
  const result=base({document_kind:'unsupported',lines:[{description:'Something',quantity:null,units_per_package:null,unit_price:null,line_amount:null}]});
  const draft=await extractPurchaseReceipt({text:'A document'}, {apiKey:'test-only',fetchImpl:makeFetch(result),reserveBudget:async()=>true});
  assert.equal(draft.documentKind,'unsupported');
  assert.equal(draft.lines[0].lineAmountMinor,null);
  assert.equal(draft.reconciliation.lineTotalMinor,null);
  assert.equal(draft.reconciliation.status,'incomplete');
  assert.ok(draft.lines[0].reviewFlags.includes('line_amount_missing'));
});

test('preserves out-of-currency precision as an unresolved source amount',async()=>{
  const result=base({lines:[{description:'bad',quantity:'2',units_per_package:null,unit_price:null,line_amount:'1.001'}]});
  const draft=await extractPurchaseReceipt({text:'x'}, {apiKey:'test-only',fetchImpl:makeFetch(result),reserveBudget:async()=>true});
  assert.equal(draft.lines[0].lineAmountMinor,null);
  assert.ok(draft.lines[0].reviewFlags.includes('money_precision_or_range'));
});
