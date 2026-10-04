import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseAdapters } from '../src/adapters/supabase.mjs';

const org='11111111-1111-4111-8111-111111111111', receipt='55555555-5555-4555-8555-555555555555';
const publishable='public-key', service='sb_secret_private', human='owner.jwt';
const json=(value)=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});

test('purchase receipt RPC and storage adapters keep privileged and caller-JWT operations separated',async()=>{
  const calls=[];
  const adapters=createSupabaseAdapters({url:'https://tenant.supabase.test',publishableKey:publishable,secretKey:service,fetchImpl:async(url,init)=>{
    const headers=new Headers(init.headers);calls.push({url:String(url),headers,body:init.body&&typeof init.body==='string'?JSON.parse(init.body):null,method:init.method});
    if(String(url).includes('/storage/v1/object/upload/sign/')) return json({url:'/object/upload/sign/finance-evidence/receipt/path.pdf',token:'signed-token'});
    if(String(url).endsWith('/rpc/authorize_purchase_receipt_integration')) return json({organizationId:org,integrationId:'integration-1'});
    if(String(url).endsWith('/rpc/complete_purchase_receipt_upload')) return json({receiptId:receipt,status:'queued'});
    if(String(url).endsWith('/rpc/reserve_purchase_receipt_model_budget')) return json(true);
    if(String(url).endsWith('/rpc/approve_purchase_receipt')) return json({status:'projection_pending'});
    if(String(url).endsWith('/rpc/finalize_purchase_receipt_projection')) return json(null);
    return json([]);
  }});
  const authorized=await adapters.db.authorizePurchaseReceiptIntegration({tokenSha256:'a'.repeat(64)});
  assert.deepEqual(authorized,{organizationId:org,integrationId:'integration-1'});
  const signed=await adapters.db.createPurchaseReceiptUploadUrl({objectKey:`${org}/purchase-receipts/${receipt}/source.pdf`});
  assert.match(signed.url,/token=signed-token/);
  await adapters.db.completePurchaseReceiptUpload({organizationId:org,receiptId:receipt,objectKey:`${org}/purchase-receipts/${receipt}/source.pdf`,sha256Hex:'b'.repeat(64),byteSize:24,mimeType:'application/pdf'});
  assert.equal(await adapters.db.reservePurchaseReceiptModelBudget({organizationId:org,receiptId:receipt,model:'openai/gpt-6-luna',maxInputTokens:1000,maxOutputTokens:1400,maxAttempts:2}),true);
  await adapters.db.approvePurchaseReceipt({organizationId:org,receiptId:receipt,expectedVersion:1,selections:{currency:'USD'},reason:'Verified source invoice.',idempotencyKey:'approve-1',accessToken:human});
  await adapters.db.listPurchaseReceiptCatalogCandidates({organizationId:org,currency:'USD',accessToken:human});
  await adapters.db.deleteFailedPurchaseReceipt({organizationId:org,receiptId:receipt,accessToken:human});
  await adapters.db.finalizePurchaseReceiptProjection({organizationId:org,receiptId:receipt,decisionId:'decision-1',succeeded:true});
  const authCall=calls.find(call=>call.url.endsWith('/rpc/authorize_purchase_receipt_integration'));
  const completeCall=calls.find(call=>call.url.endsWith('/rpc/complete_purchase_receipt_upload'));
  const reserveCall=calls.find(call=>call.url.endsWith('/rpc/reserve_purchase_receipt_model_budget'));
  const approveCall=calls.find(call=>call.url.endsWith('/rpc/approve_purchase_receipt'));
  assert.equal(authCall.headers.get('apikey'),service);assert.equal(authCall.body.p_token_sha256,'a'.repeat(64));
  assert.equal(completeCall.headers.get('apikey'),service);assert.equal(completeCall.body.p_organization_id,org);assert.equal(completeCall.body.p_object_key,`${org}/purchase-receipts/${receipt}/source.pdf`);
  assert.deepEqual(reserveCall.body,{p_organization_id:org,p_receipt_id:receipt,p_model_id:'openai/gpt-6-luna',p_max_input_tokens:1000,p_max_output_tokens:1400,p_max_attempts:2});
  assert.equal(approveCall.headers.get('apikey'),publishable);assert.equal(approveCall.headers.get('authorization'),`Bearer ${human}`);
  const candidatesCall=calls.find(call=>call.url.endsWith('/rpc/list_purchase_receipt_catalog_candidates'));
  const deleteCall=calls.find(call=>call.url.endsWith('/rpc/delete_failed_purchase_receipt'));
  assert.deepEqual(deleteCall.body,{p_organization_id:org,p_receipt_id:receipt});
  assert.equal(deleteCall.headers.get('apikey'),publishable);
  assert.equal(deleteCall.headers.get('authorization'),`Bearer ${human}`);
  assert.deepEqual(candidatesCall.body,{p_organization_id:org,p_currency:'USD'});
  assert.equal(candidatesCall.headers.get('apikey'),publishable);
  assert.equal(candidatesCall.headers.get('authorization'),`Bearer ${human}`);
  assert.ok(!calls.some(call=>call.headers.get('authorization')?.includes(human)&&call.url.includes('service')));
});
