import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHandlers } from '../src/server/index.mjs';

const org='11111111-1111-4111-8111-111111111111', receiptId='55555555-5555-4555-8555-555555555555';
const userToken='valid.user.jwt', integrationToken='flpr_abcdefghijklmnopqrstuvwxyz0123456789';
const bytes=Buffer.from('%PDF-1.7\nminimal test fixture');
function harness({role='owner',receiptBytes=bytes}={}) {
  const calls=[];
  const db={
    async getMembership(args){calls.push(['membership',args]);return {role};},
    async getDashboard(){return {}},async listIssues(){return []},async listManualMovements(){return []},async listObservations(){return []},async listAuditEvents(){return []},async getSettings(){return {}},
    async getIssue(){return null},async getIssueEvidence(){return []},async recordItemDefinition(){},async recordSaleLineCostOverride(){},async recordRefundCostReview(){},async createProposalAtomic(){},async reserveModelBudget(){return true},async recordModelUsage(){},async getReplaySnapshot(){return null},async saveProjectionRun(){return {}},asUser(){return {async rpc(){return {data:'id',error:null}}}},
    async createPurchaseReceiptIntegration(args){calls.push(['createIntegration',args]);return {id:'66666666-6666-4666-8666-666666666666'};},
    async listPurchaseReceiptIntegrations(args){calls.push(['listIntegrations',args]);return [{id:'i-1',name:'Power Automate',createdAt:'2026-10-04T00:00:00Z',revokedAt:null}];},
    async revokePurchaseReceiptIntegration(args){calls.push(['revokeIntegration',args]);},
    async authorizePurchaseReceiptIntegration(args){calls.push(['authorizeIntegration',args]);return args.tokenSha256===createHash('sha256').update(integrationToken).digest('hex')?{organizationId:org,integrationId:'77777777-7777-4777-8777-777777777777'}:null;},
    async createPurchaseReceiptSubmission(args){calls.push(['submit',args]);return {receiptId,status:'awaiting_upload',objectKey:`${org}/purchase-receipts/${receiptId}/source.pdf`};},
    async createManualPurchaseReceiptSubmission(args){calls.push(['manualSubmit',args]);return {receiptId,status:'awaiting_upload',objectKey:`${org}/purchase-receipts/${receiptId}/source.pdf`};},
    async createPurchaseReceiptUploadUrl(args){calls.push(['signedUpload',args]);return {url:'https://storage.test/signed?token=once',token:'once'};},
    async downloadPurchaseReceiptObject(args){calls.push(['download',args]);return new Uint8Array(receiptBytes);},
    async completePurchaseReceiptUpload(args){calls.push(['complete',args]);return {receiptId,status:'queued',jobId:'job-1'};},
    async getPurchaseReceiptForIntegration(args){calls.push(['integrationReceipt',args]);return {id:receiptId,status:'awaiting_upload',original_filename:'source.pdf',declared_mime_type:'application/pdf'};},
    async getPurchaseReceipt(args){calls.push(['getReceipt',args]);return {id:receiptId,status:'needs_review',active_draft_version:2,original_filename:'source.pdf',declared_mime_type:'application/pdf',submitted_at:'2026-10-03T00:00:00Z',evidence_file_id:null};},
    async getPurchaseReceiptDraft(args){calls.push(['getDraft',args]);return {version:2,draft:{documentKind:'receipt',currency:null,totals:{totalMinor:47688,totalAmount:'476.88'},lines:[{lineId:'line-1'}]}};},
    async listPurchaseReceipts(){return [];}, async listPurchaseReceiptCatalogCandidates(){return [{catalogObjectId:'variation-1',name:'Tea',sku:'T-1',currency:'USD'}];},
    async listInventoryItems(){return [{id:'88888888-8888-4888-8888-888888888888',name:'Tea',sku:'T-1',currency:'USD',square_catalog_object_id:'variation-1',item_kind:'catalog'}];},
    async getEvidenceSignedUrl(){return {url:'https://storage.test/view?token=short'};},
    async listPurchaseReceiptEffects(){return []},async listPurchaseReceiptDecisions(){return []},
    async approvePurchaseReceipt(args){calls.push(['approve',args]);return {receiptId,status:'projection_pending'};},
    async rejectPurchaseReceipt(args){calls.push(['reject',args]);return {receiptId,status:'rejected'};},
  };
  const queue={async enqueueSquareSync(){return {id:'sync'}},async enqueueSquareWebhook(){},async enqueueProjectionReplay(){return {id:'replay'}}};
  const supabase={auth:{async getUser(token){return token===userToken?{data:{user:{id:'user-1'}},error:null}:{data:null,error:new Error('bad token')};}}};
  return {handlers:createHandlers({supabase,db,queue,config:{inventoryTrackingEnabled:true,productAnalyticsEnabled:false},webhookInbox:{async putIfAbsent(){return {inserted:true}}}}),calls};
}
const auth={authorization:`Bearer ${userToken}`};
const post=(url,body,headers={})=>new Request(`https://app.test${url}`,{method:'POST',headers:{...auth,'content-type':'application/json',...headers},body:JSON.stringify(body)});

test('creates one-time integration credentials as an owner and only stores their SHA-256 digest',async()=>{
  const {handlers,calls}=harness();
  const response=await handlers.receiptIntegration(post('/api/purchase-receipt-integrations',{organizationId:org,name:'Power Automate'}));
  const result=await response.json();
  assert.equal(response.status,201);assert.match(result.token,/^flpr_/);assert.equal(result.id,'66666666-6666-4666-8666-666666666666');
  assert.equal(calls.find(x=>x[0]==='createIntegration')[1].tokenSha256,createHash('sha256').update(result.token).digest('hex'));
  assert.equal(JSON.stringify(calls).includes(result.token),false);
});

test('integration intake derives the organization from its credential and returns direct signed upload metadata',async()=>{
  const {handlers,calls}=harness();
  const response=await handlers.purchaseReceiptIntake(new Request('https://app.test/api/integrations/purchase-receipts',{method:'POST',headers:{authorization:`Bearer ${integrationToken}`,'content-type':'application/json','Idempotency-Key':'flow-run-2026-10-04'},body:JSON.stringify({externalSubmissionId:'flow-run-2026-10-04',filename:'receipt.pdf',contentType:'application/pdf'})}));
  const result=await response.json();
  assert.equal(response.status,201);assert.equal(result.upload.method,'PUT');assert.equal(result.upload.headers['x-upsert'],'false');
  assert.equal(calls.find(x=>x[0]==='submit')[1].organizationId,org);
  assert.equal(calls.find(x=>x[0]==='authorizeIntegration')[1].tokenSha256,createHash('sha256').update(integrationToken).digest('hex'));
  const invalid=await handlers.purchaseReceiptIntake(new Request('https://app.test/api/integrations/purchase-receipts',{method:'POST',headers:{authorization:'Bearer random','content-type':'application/json','Idempotency-Key':'flow-run-2'},body:JSON.stringify({externalSubmissionId:'flow-run-2',filename:'r.pdf',contentType:'application/pdf'})}));
  assert.equal(invalid.status,401);
});

test('completion validates uploaded file bytes and durably marks evidence before returning accepted',async()=>{
  const {handlers,calls}=harness();
  const response=await handlers.purchaseReceiptComplete(new Request(`https://app.test/api/integrations/purchase-receipts/${receiptId}/complete`,{method:'POST',headers:{authorization:`Bearer ${integrationToken}`,'content-type':'application/json'},body:'{}'}));
  const result=await response.json();
  assert.equal(response.status,202);assert.equal(result.status,'queued');
  assert.equal(calls.find(x=>x[0]==='complete')[1].sha256Hex,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(calls.find(x=>x[0]==='complete')[1].byteSize,bytes.length);
  const invalidHarness=harness({receiptBytes:Buffer.from('invalid')});
  const invalid=await invalidHarness.handlers.purchaseReceiptComplete(new Request(`https://app.test/api/integrations/purchase-receipts/${receiptId}/complete`,{method:'POST',headers:{authorization:`Bearer ${integrationToken}`,'content-type':'application/json'},body:'{}'}));
  assert.equal(invalid.status,415);
});

test('human intake and completion use caller JWT and accept body organization without a query string',async()=>{
  const {handlers,calls}=harness();
  const start=await handlers.purchaseReceipts(post('/api/purchase-receipts',{organizationId:org,externalSubmissionId:'ui-run-1',filename:'source.pdf',contentType:'application/pdf',ignored:true},{'Idempotency-Key':'human-run-1'}));
  assert.equal(start.status,400); // strict request shape
  const validStart=await handlers.purchaseReceipts(post('/api/purchase-receipts',{organizationId:org,externalSubmissionId:'human-run-1',filename:'source.pdf',contentType:'application/pdf'},{'Idempotency-Key':'human-run-1'}));
  assert.equal(validStart.status,201);
  const complete=await handlers.purchaseReceipts(post(`/api/purchase-receipts/${receiptId}/complete`,{organizationId:org}));
  assert.equal(complete.status,202);
  assert.ok(calls.some(x=>x[0]==='membership'&&x[1].accessToken===userToken));
});

test('approval verifies the current draft version and converts UI dates into atomic RPC effect keys',async()=>{
  const {handlers,calls}=harness();
  const body={organizationId:org,expectedVersion:2,reason:'Supplier document checked against the source lines.',confirmPurchaseDocument:true,currency:'USD',
    costUpdates:[],stockReceipts:[{lineId:'line-1',itemId:'88888888-8888-4888-8888-888888888888',quantity:36,unitCostMinor:118,currency:'USD',packageQuantity:1,unitsPerPackage:36,receivedAt:'2026-10-03T12:00:00Z'}],
    payments:[{amountMinor:47688,currency:'USD',paidAt:'2026-10-03T12:00:00Z',accountId:'99999999-9999-4999-8999-999999999999'}]};
  const response=await handlers.purchaseReceipts(post(`/api/purchase-receipts/${receiptId}/approve`,body,{'Idempotency-Key':'receipt-approval-1'}));
  assert.equal(response.status,201);
  const args=calls.find(x=>x[0]==='approve')[1];
  assert.equal(args.selections.stockReceipts[0].occurredAt,body.stockReceipts[0].receivedAt);
  assert.equal(args.selections.stockReceipts[0].eventKey,'receipt-approval-1:stock:line-1:0');
  assert.equal(args.selections.payments[0].occurredAt,body.payments[0].paidAt);
  assert.equal(args.selections.payments[0].paymentKey,'receipt-approval-1:payment:0');
  assert.equal(args.selections.confirmPurchaseDocument,true);
  const stale=await handlers.purchaseReceipts(post(`/api/purchase-receipts/${receiptId}/approve`,{...body,expectedVersion:1},{'Idempotency-Key':'receipt-approval-2'}));
  assert.equal(stale.status,409);assert.equal((await stale.json()).code,'RECEIPT_VERSION_CONFLICT');
});

test('detail returns normalized receipt metadata, private preview URL, stock choices, catalog candidates, and prior effects',async()=>{
  const {handlers}=harness();
  const response=await handlers.purchaseReceipts(new Request(`https://app.test/api/purchase-receipts/${receiptId}?organizationId=${org}&currency=USD`,{headers:auth}));
  const detail=await response.json();
  assert.equal(response.status,200);assert.equal(detail.receipt.activeDraftVersion,2);assert.equal(detail.receipt.originalFilename,'source.pdf');
  assert.equal(detail.evidenceUrl,null);assert.equal(detail.candidates[0].catalogObjectId,'variation-1');
  assert.equal(detail.inventoryItems[0].id,'88888888-8888-4888-8888-888888888888');assert.deepEqual(detail.effects,[]);
});

test('owner can list and revoke integration metadata without receiving token hashes',async()=>{
  const {handlers,calls}=harness();
  const listing=await handlers.receiptIntegration(new Request(`https://app.test/api/purchase-receipt-integrations?organizationId=${org}`,{headers:auth}));
  assert.equal(listing.status,200);assert.deepEqual((await listing.json()).integrations[0],{id:'i-1',name:'Power Automate',createdAt:'2026-10-04T00:00:00Z',revokedAt:null});
  const integrationId='66666666-6666-4666-8666-666666666666';
  const revoked=await handlers.receiptIntegration(new Request(`https://app.test/api/purchase-receipt-integrations/${integrationId}`,{method:'DELETE',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({organizationId:org})}));
  assert.equal(revoked.status,200);assert.deepEqual(await revoked.json(),{revoked:true});
  assert.ok(calls.some(x=>x[0]==='revokeIntegration'&&x[1].integrationId===integrationId));
});
