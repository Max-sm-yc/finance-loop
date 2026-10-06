begin;
select plan(57);

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
values('7d9db4a4-37a8-4241-a885-3120f73b3377','authenticated','authenticated','purchase-receipt@example.invalid','',now(),now(),now());
insert into public.organizations(id,name) values('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','Purchase receipt test');
insert into public.memberships(organization_id,user_id,role)
values('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','7d9db4a4-37a8-4241-a885-3120f73b3377','owner');
insert into public.accounts(organization_id,name,kind,currency)
values('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','Receipt checking','bank','USD');

select set_config('request.jwt.claims','{"sub":"7d9db4a4-37a8-4241-a885-3120f73b3377","role":"authenticated"}',true);
create temporary table receipt_test_integration as
select public.register_purchase_receipt_integration('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','Power Automate',repeat('b',64)) as result;
select is((select result->>'name' from receipt_test_integration),'Power Automate','owner creates integration from a token hash');
select is((select token_sha256 from private.purchase_receipt_integrations where token_sha256=repeat('b',64)),repeat('b',64),'only token hash is stored');

select set_config('request.jwt.claims','{"role":"service_role"}',true);
create temporary table receipt_test_submission as
select public.create_purchase_receipt_submission('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'id')::uuid from receipt_test_integration),'external-test-001','supplier.pdf','application/pdf') as result;
select is((select result->>'status' from receipt_test_submission),'awaiting_upload','integration submission starts awaiting upload');
create temporary table receipt_test_upload as
select public.complete_purchase_receipt_upload('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_submission),
  (select result->>'objectKey' from receipt_test_submission),repeat('a',64),128,'application/pdf') as result;
select is((select result->>'status' from receipt_test_upload),'queued','complete upload atomically queues extraction');
select is((select count(*) from private.durable_jobs where job_type='receipt.process' and organization_id='95c9874f-fb81-4f32-bc8b-bbc558d2ee07'),1::bigint,'receipt extraction has one durable job');
insert into private.ai_model_budgets(organization_id,daily_token_limit)
values('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',4096)
on conflict (organization_id) do update set daily_token_limit=excluded.daily_token_limit;
update public.purchase_receipt_submissions set status='processing'
where id=(select (result->>'receiptId')::uuid from receipt_test_upload);
update private.durable_jobs set status='running'
where id=(select (result->>'jobId')::uuid from receipt_test_upload);
select throws_ok($$select public.reserve_purchase_receipt_model_budget('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),(select (result->>'jobId')::uuid from receipt_test_upload),
  'openai/gpt-6-luna',12000,3001,1)$$,'P0001','Invalid receipt model budget request',
  'worker rejects output limits above 3000 tokens');
select ok(public.reserve_purchase_receipt_model_budget('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),(select (result->>'jobId')::uuid from receipt_test_upload),
  'openai/gpt-6-luna',12000,3000,1),'worker accepts the 3000-token output limit');
select is((select reserved_tokens from private.receipt_agent_budget_reservations
  where run_id=(select (result->>'jobId')::uuid from receipt_test_upload)),4096,
  'receipt job receives the fixed 4,096-token reservation');
select ok(public.record_purchase_receipt_model_usage('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),(select (result->>'jobId')::uuid from receipt_test_upload),
  'openai/gpt-6-luna','{}'::jsonb,1),'worker usage records against reserved receipt budget');
update private.durable_jobs set status='dead_letter',finished_at=now(),last_error_code='MODEL_INVALID_RESPONSE'
where id=(select (result->>'jobId')::uuid from receipt_test_upload);
update public.purchase_receipt_submissions set status='failed',last_error_code='MODEL_INVALID_RESPONSE'
where id=(select (result->>'receiptId')::uuid from receipt_test_upload);
select set_config('request.jwt.claims','{"sub":"7d9db4a4-37a8-4241-a885-3120f73b3377","role":"authenticated"}',true);
create temporary table receipt_test_retry as
select public.reprocess_failed_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload)) as result;
select is((select result->>'status' from receipt_test_retry),'queued','failed receipt retry queues a new job');
select isnt((select result->>'jobId' from receipt_test_retry),(select result->>'jobId' from receipt_test_upload),
  'failed receipt retry receives a fresh durable job id');
select ok((select released_at is not null from private.receipt_agent_budget_reservations
  where run_id=(select (result->>'jobId')::uuid from receipt_test_upload)),
  'failed run reservation is released and retained as history');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update private.durable_jobs set status='running'
where id=(select (result->>'jobId')::uuid from receipt_test_retry);
update public.purchase_receipt_submissions set status='processing'
where id=(select (result->>'receiptId')::uuid from receipt_test_upload);
select ok(public.reserve_purchase_receipt_model_budget('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),(select (result->>'jobId')::uuid from receipt_test_retry),
  'openai/gpt-6-luna',12000,1500,1),'retry receives the released 4,096-token allocation');
select is((select sum(reserved_tokens) from private.receipt_agent_budget_reservations
  where organization_id='95c9874f-fb81-4f32-bc8b-bbc558d2ee07'
    and budget_day=(now() at time zone 'UTC')::date and released_at is null),4096::bigint,
  'failed retry does not double-count the same daily allocation');
select ok(public.record_purchase_receipt_model_usage('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),(select (result->>'jobId')::uuid from receipt_test_retry),
  'openai/gpt-6-luna','{}'::jsonb,1),'reallocated reservation accepts usage for the retry job');
update private.ai_model_budgets set daily_token_limit=200000
where organization_id='95c9874f-fb81-4f32-bc8b-bbc558d2ee07';
create temporary table receipt_test_jev_run as select gen_random_uuid() as run_id;
select ok(public.reserve_purchase_receipt_jev_budget('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),(select (result->>'jobId')::uuid from receipt_test_retry),
  (select run_id from receipt_test_jev_run),'typesafe/jev-1.13',100,200,1),'worker Jev request reserves against its active receipt job');
select is((select reserved_tokens from private.receipt_agent_budget_reservations where run_id=(select run_id from receipt_test_jev_run)),300,
  'worker Jev reservation records the bounded request allowance');
select ok(public.record_purchase_receipt_jev_usage('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),(select (result->>'jobId')::uuid from receipt_test_retry),
  (select run_id from receipt_test_jev_run),'typesafe/jev-1.13','{"input_tokens":80,"output_tokens":20}'::jsonb,1),
  'worker Jev usage is linked to its active receipt job and reservation');
select throws_ok($$select public.reserve_purchase_receipt_jev_budget('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),'00000000-0000-4000-8000-000000000000',
  gen_random_uuid(),'typesafe/jev-1.13',100,200,1)$$,'P0001','Active purchase receipt job not found',
  'worker Jev reservation cannot be detached from the active receipt job');
select set_config('request.jwt.claims','{"sub":"7d9db4a4-37a8-4241-a885-3120f73b3377","role":"authenticated"}',true);
create temporary table receipt_test_manual_jev_run as select gen_random_uuid() as run_id;
select ok(public.reserve_receipt_agent_budget('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select run_id from receipt_test_manual_jev_run),'typesafe/jev-1.13',100,200,1),
  'reviewer Jev retry can reserve within the shared daily budget');
select ok(public.record_receipt_agent_usage('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select run_id from receipt_test_manual_jev_run),'typesafe/jev-1.13','{"input_tokens":80,"output_tokens":20}'::jsonb,1),
  'reviewer Jev retry records usage against its reservation');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
create temporary table receipt_test_duplicate_submission as
select public.create_purchase_receipt_submission('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'id')::uuid from receipt_test_integration),'external-test-002','supplier-copy.pdf','application/pdf') as result;
create temporary table receipt_test_duplicate_upload as
select public.complete_purchase_receipt_upload('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_duplicate_submission),
  (select result->>'objectKey' from receipt_test_duplicate_submission),repeat('a',64),128,'application/pdf') as result;
select is((select result->>'status' from receipt_test_duplicate_upload),'duplicate','same source bytes are held as a duplicate');
select is((select result->>'duplicateOf' from receipt_test_duplicate_upload),(select result->>'receiptId' from receipt_test_upload),'duplicate points to existing receipt');
select lives_ok($$select public.get_purchase_receipt_for_processing('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload))$$,'worker can fetch the original receipt for processing');
select public.save_purchase_receipt_draft('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),0,
  '{"documentKind":"receipt","currency":null,"totals":{"totalMinor":null,"rawAmounts":{"total":"12.00"}},"lines":[{"lineId":"line-1","quantity":"2","packageQuantity":"2","unitsPerPackage":"6","currency":null},{"lineId":"line-2","quantity":"1","packageQuantity":"1","unitsPerPackage":"1","currency":null}]}'::jsonb);
select is((select status from public.purchase_receipt_submissions where id=(select (result->>'receiptId')::uuid from receipt_test_upload)),'needs_review','worker draft becomes human review item');

select set_config('request.jwt.claims','{"sub":"7d9db4a4-37a8-4241-a885-3120f73b3377","role":"authenticated"}',true);
insert into private.square_fact_versions(organization_id,fact_kind,object_id,object_version,version_sort,fact,cause) values
  ('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','catalog','ITEM-RECEIPT-1','v1','00000000000000000001','{"objectType":"ITEM","name":"Dry goods"}','receipt test'),
  ('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','catalog','CAT-RECEIPT-1','v1','00000000000000000001','{"objectType":"ITEM_VARIATION","itemId":"ITEM-RECEIPT-1","name":"Test purchase item","currency":"USD","priceMinor":100}','receipt test'),
  ('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','catalog','CAT-UNSOLD','v1','00000000000000000001','{"objectType":"ITEM_VARIATION","itemId":"ITEM-RECEIPT-1","name":"Brown rice","sku":"RICE-1","currency":"USD","priceMinor":250}','receipt test'),
  ('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','catalog','CAT-UNKNOWN-CURRENCY','v1','00000000000000000001','{"objectType":"ITEM_VARIATION","itemId":"ITEM-RECEIPT-1","name":"Local produce"}','receipt test');
insert into private.square_fact_current(organization_id,fact_kind,object_id,object_version,version_sort,source_revision) values
  ('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','catalog','ITEM-RECEIPT-1','v1','00000000000000000001',1),
  ('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','catalog','CAT-RECEIPT-1','v1','00000000000000000001',1),
  ('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','catalog','CAT-UNSOLD','v1','00000000000000000001',1),
  ('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','catalog','CAT-UNKNOWN-CURRENCY','v1','00000000000000000001',1);
select ok(public.list_purchase_receipt_catalog_candidates('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','USD') @>
  '[{"catalogObjectId":"CAT-UNSOLD","name":"Dry goods — Brown rice","sku":"RICE-1","currency":"USD"},{"catalogObjectId":"CAT-UNKNOWN-CURRENCY","name":"Dry goods — Local produce","sku":null,"currency":"USD"}]'::jsonb,
  'purchase candidate listing includes unsold variations with matching or unknown price currency');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select lives_ok($$select public.list_purchase_receipt_catalog_candidates('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','USD')$$,
  'receipt worker can load the same organization-scoped catalog candidates');
select set_config('request.jwt.claims','{"sub":"7d9db4a4-37a8-4241-a885-3120f73b3377","role":"authenticated"}',true);
insert into public.item_definitions(organization_id,square_catalog_object_id,name,unit_cost_minor,currency,effective_from,approved_by,version)
values('95c9874f-fb81-4f32-bc8b-bbc558d2ee07','CAT-RECEIPT-1','Test purchase item',100,'USD',now()-interval '1 day','7d9db4a4-37a8-4241-a885-3120f73b3377',1);
create temporary table receipt_test_item as
select id from public.item_definitions where organization_id='95c9874f-fb81-4f32-bc8b-bbc558d2ee07' and square_catalog_object_id='CAT-RECEIPT-1';
create temporary table receipt_test_approval as
select public.approve_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),1,
  jsonb_build_object('currency','USD','costUpdates',jsonb_build_array(jsonb_build_object('lineId','line-1','catalogObjectId','CAT-RECEIPT-1','name','Test purchase item',
    'unitCostMinor',200,'currency','USD','effectiveFrom',now())),'stockReceipts',jsonb_build_array(jsonb_build_object('lineId','line-1','eventKey','delivery-1','itemId',(select id from receipt_test_item),
    'quantity',6,'packageQuantity',2,'unitsPerPackage',6,'unitCostMinor',200,'currency','USD','occurredAt',now())),
    'payments',jsonb_build_array(jsonb_build_object('paymentKey','paid-1','accountId',(select id from public.accounts where name='Receipt checking'),
      'amountMinor',600,'currency','USD','occurredAt',now()))),
  'Approved from supplier invoice and payment evidence','receipt-approval-001') as result;
select is((select count(*) from public.inventory_movements where movement_type='supplier_receipt' and quantity_delta=6),1::bigint,'approval records a partial stock receipt without requiring cash movement linkage');
select is((select count(*) from public.item_definitions where organization_id='95c9874f-fb81-4f32-bc8b-bbc558d2ee07' and square_catalog_object_id='CAT-RECEIPT-1' and unit_cost_minor=200),1::bigint,'human-approved receipt cost becomes an effective item definition');
select is((select count(*) from public.inventory_movements m where m.movement_type='supplier_receipt' and m.item_definition_id=(select id from public.item_definitions where square_catalog_object_id='CAT-RECEIPT-1' and unit_cost_minor=200) and m.unit_cost_minor=200),1::bigint,'same approval resolves stock to the new effective cost definition');
select is((select count(*) from public.cash_movements where kind='purchase' and amount_minor=-600 and evidence_file_id=(select (result->>'evidenceFileId')::uuid from receipt_test_upload)),1::bigint,'confirmed partial payment records matching cash outflow');
select is((select status from public.purchase_receipt_submissions where id=(select (result->>'receiptId')::uuid from receipt_test_upload)),'projection_pending','approved effects wait for projection replay');
select lives_ok($$select public.approve_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),1,
  jsonb_build_object('currency','USD','costUpdates',jsonb_build_array(jsonb_build_object('lineId','line-1','catalogObjectId','CAT-RECEIPT-1','name','Test purchase item',
    'unitCostMinor',200,'currency','USD','effectiveFrom',now())),'stockReceipts',jsonb_build_array(jsonb_build_object('lineId','line-1','eventKey','delivery-1','itemId',(select id from receipt_test_item),
    'quantity',6,'packageQuantity',2,'unitsPerPackage',6,'unitCostMinor',200,'currency','USD','occurredAt',now())),
    'payments',jsonb_build_array(jsonb_build_object('paymentKey','paid-1','accountId',(select id from public.accounts where name='Receipt checking'),
      'amountMinor',600,'currency','USD','occurredAt',now()))),
  'Approved from supplier invoice and payment evidence','receipt-approval-001')$$,'identical approval retry is idempotent');
select is((select count(*) from public.inventory_movements where movement_type='supplier_receipt'),1::bigint,'approval retry does not duplicate stock');
select is((select count(*) from public.cash_movements where kind='purchase' and amount_minor=-600),1::bigint,'approval retry does not duplicate cash');

select throws_ok($$select public.approve_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),1,
  jsonb_build_object('currency','USD','payments',jsonb_build_array(jsonb_build_object('paymentKey','wrong-currency','accountId',(select id from public.accounts where name='Receipt checking'),
    'amountMinor',1,'currency','CAD','occurredAt',now()))),
  'Wrong currency should be rejected by the reviewer','wrong-currency-approval')$$,'P0001','Payment currency requires human confirmation matching source currency','payment currency cannot conflict with the confirmed receipt currency');
select throws_ok($$select public.approve_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),1,
  jsonb_build_object('currency','USD','stockReceipts',jsonb_build_array(jsonb_build_object('lineId','line-1','eventKey','too-many-units','itemId',(select id from receipt_test_item),
    'quantity',7,'packageQuantity',2,'unitsPerPackage',6,'unitCostMinor',200,'currency','USD','occurredAt',now()))),
  'Excess units should stay unposted','excess-stock-approval')$$,'P0001','Received inventory exceeds confirmed purchased quantity','partial receipt cannot exceed confirmed package quantity');

select throws_ok($$select public.approve_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),1,
  jsonb_build_object('currency','USD','stockReceipts',jsonb_build_array(jsonb_build_object('lineId','line-1','eventKey','changed-conversion','itemId',(select id from receipt_test_item),
    'quantity',1,'packageQuantity',2,'unitsPerPackage',3,'unitCostMinor',200,'currency','USD','occurredAt',now()))),
  'Changed package conversions require a separate correction','changed-conversion-approval')$$,'P0001','Partial receipt must retain the confirmed item, currency and package conversion','partial receipts keep the first confirmed conversion');

select lives_ok($$select public.approve_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),1,
  jsonb_build_object('currency','USD','costUpdates',jsonb_build_array(jsonb_build_object('lineId','line-2','catalogObjectId','CAT-UNKNOWN-CURRENCY','name','Local produce',
    'unitCostMinor',150,'currency','USD','effectiveFrom',now()))),
  'Supplier receipt confirms USD for this variable-priced catalog variation','unknown-catalog-currency-approval')$$,
  'unknown-price-currency variation can receive a cost after human currency confirmation');

insert into public.accounting_periods(organization_id,starts_at,ends_at,status,closed_by,closed_at,close_reason)
values('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',now()+interval '12 hours',now()+interval '2 days','closed',
  '7d9db4a4-37a8-4241-a885-3120f73b3377',now(),'Purchase receipt closed period test');
select throws_ok($$select public.approve_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),1,
  jsonb_build_object('currency','USD','costUpdates',jsonb_build_array(jsonb_build_object('lineId','line-2','catalogObjectId','CAT-RECEIPT-1','name','Test purchase item',
    'unitCostMinor',300,'currency','USD','effectiveFrom',now()+interval '1 day'))),
  'Cost changes cannot modify a closed period','closed-cost-approval')$$,'P0001','PERIOD_CLOSED','effective cost updates cannot alter closed accounting periods');
select throws_ok($$select public.approve_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),1,
  jsonb_build_object('currency','USD','stockReceipts',jsonb_build_array(jsonb_build_object('lineId','line-1','eventKey','closed-stock','itemId',(select id from public.item_definitions where square_catalog_object_id='CAT-RECEIPT-1' and unit_cost_minor=200),
    'quantity',1,'packageQuantity',2,'unitsPerPackage',6,'unitCostMinor',200,'currency','USD','occurredAt',now()+interval '1 day'))),
  'Closed period inventory must remain unposted','closed-stock-approval')$$,'P0001','PERIOD_CLOSED','stock receipt is rejected in a closed period');
select throws_ok($$select public.approve_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),1,
  jsonb_build_object('currency','USD','payments',jsonb_build_array(jsonb_build_object('paymentKey','closed-payment','accountId',(select id from public.accounts where name='Receipt checking'),
    'amountMinor',100,'currency','USD','occurredAt',now()+interval '1 day'))),
  'Closed period payment must remain unposted','closed-payment-approval')$$,'P0001','PERIOD_CLOSED','payment is rejected in a closed period');
select is((select count(*) from public.inventory_movements where movement_type='supplier_receipt'),1::bigint,'failed closed-period decisions leave inventory unchanged');
select is((select count(*) from public.cash_movements where kind='purchase' and evidence_file_id=(select (result->>'evidenceFileId')::uuid from receipt_test_upload)),1::bigint,'failed decisions leave cash unchanged');

select lives_ok($$select public.approve_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),1,
  jsonb_build_object('currency','USD','stockReceipts',jsonb_build_array(jsonb_build_object('lineId','line-1','eventKey','delivery-2','itemId',(select id from public.item_definitions where square_catalog_object_id='CAT-RECEIPT-1' and unit_cost_minor=200),
    'quantity',6,'packageQuantity',2,'unitsPerPackage',6,'unitCostMinor',200,'currency','USD','occurredAt',now())),
    'payments',jsonb_build_array(jsonb_build_object('paymentKey','paid-2','accountId',(select id from public.accounts where name='Receipt checking'),
      'amountMinor',600,'currency','USD','occurredAt',now()))),
  'Second partial delivery and payment confirmed','receipt-approval-0002')$$,'later partial delivery and payment can post against the same immutable receipt lines');
select is((select count(*) from public.inventory_movements where movement_type='supplier_receipt'),2::bigint,'separate partial deliveries remain separately auditable');
select is((select sum(quantity_delta) from public.inventory_movements where movement_type='supplier_receipt'),12::numeric,'cumulative stock addition matches confirmed package quantity');
select is((select sum(amount_minor) from public.cash_movements where kind='purchase' and evidence_file_id=(select (result->>'evidenceFileId')::uuid from receipt_test_upload)),-1200::numeric,'cumulative payment does not exceed the exact document total');
select throws_ok($$select public.approve_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload),1,
  jsonb_build_object('currency','USD','payments',jsonb_build_array(jsonb_build_object('paymentKey','overpayment','accountId',(select id from public.accounts where name='Receipt checking'),
    'amountMinor',1,'currency','USD','occurredAt',now()))),
  'Overpayment must stay unposted','overpayment-approval')$$,'P0001','Payments exceed receipt total','cumulative payment cannot exceed the parsed document total');
select is((select count(*) from public.cash_movements where kind='purchase' and evidence_file_id=(select (result->>'evidenceFileId')::uuid from receipt_test_upload)),2::bigint,'rejected overpayment rolls back its tentative cash movement');

select set_config('request.jwt.claims','{"role":"service_role"}',true);
update private.durable_jobs set status='complete',finished_at=now() where job_type='projection.replay'
  and payload->>'receiptId'=(select result->>'receiptId' from receipt_test_upload);
select is((select status from public.purchase_receipt_submissions where id=(select (result->>'receiptId')::uuid from receipt_test_upload)),'posted','last successful replay finalizes the receipt atomically with job acknowledgement');

create temporary table receipt_test_rejection_submission as
select public.create_purchase_receipt_submission('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'id')::uuid from receipt_test_integration),'external-reject-001','unclear.pdf','application/pdf') as result;
create temporary table receipt_test_rejection_upload as
select public.complete_purchase_receipt_upload('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_rejection_submission),
  (select result->>'objectKey' from receipt_test_rejection_submission),repeat('c',64),128,'application/pdf') as result;
select public.get_purchase_receipt_for_processing('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_rejection_upload));
select public.save_purchase_receipt_draft('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_rejection_upload),0,
  '{"documentKind":"unclear","currency":null,"totals":{"rawAmounts":{"total":"1.00"}},"lines":[{"lineId":"line-reject","description":"Unclear item"}]}'::jsonb);
select set_config('request.jwt.claims','{"sub":"7d9db4a4-37a8-4241-a885-3120f73b3377","role":"authenticated"}',true);
select lives_ok($$select public.reject_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_rejection_upload),1,'This source is not a supplier purchase','receipt-reject-001')$$,'untrusted or unclear document can be rejected with a reason');
select lives_ok($$select public.reject_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_rejection_upload),1,'This source is not a supplier purchase','receipt-reject-001')$$,'identical reject retry is idempotent');
select is((select status from public.purchase_receipt_submissions where id=(select (result->>'receiptId')::uuid from receipt_test_rejection_upload)),'rejected','rejection remains visible and creates no financial effect');

create temporary table receipt_test_deleted_posted as
select public.delete_purchase_receipt('95c9874f-fb81-4f32-bc8b-bbc558d2ee07',
  (select (result->>'receiptId')::uuid from receipt_test_upload)) as result;
select is((select result->>'deleted' from receipt_test_deleted_posted),'true','owner can remove a posted receipt from the inbox');
select ok((select deleted_at is not null and deleted_by='7d9db4a4-37a8-4241-a885-3120f73b3377'::uuid and status='posted'
  from public.purchase_receipt_submissions where id=(select (result->>'receiptId')::uuid from receipt_test_upload)),
  'deleting a posted receipt records the actor while retaining its workflow status');
select ok(exists(select 1 from public.evidence_files where id=(select evidence_file_id from public.purchase_receipt_submissions
    where id=(select (result->>'receiptId')::uuid from receipt_test_upload)))
  and exists(select 1 from public.purchase_receipt_decisions where receipt_id=(select (result->>'receiptId')::uuid from receipt_test_upload)
    and decision='approved')
  and exists(select 1 from public.purchase_receipt_effects where receipt_id=(select (result->>'receiptId')::uuid from receipt_test_upload)),
  'deletion preserves original evidence, human decisions, and posted receipt effects');

select * from finish();
rollback;
