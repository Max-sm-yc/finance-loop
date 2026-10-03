begin;
select plan(40);

select has_table('public','organization_feature_flags','organization feature flags are persisted');
select has_table('public','inventory_movements','inventory receipts and corrections share an append-only ledger');
select has_table('public','inventory_items','standalone supplies do not need Square catalog IDs');
select has_table('private','inventory_requests','inventory idempotency requests remain private');
select has_function('public','record_inventory_purchase',array['uuid','uuid','bigint','text','timestamp with time zone','text','uuid','text','jsonb'],'purchase cash and stock are atomic');
select has_function('public','record_inventory_correction',array['uuid','uuid','numeric','timestamp with time zone','text','uuid','text'],'signed stock correction RPC exists');
select has_function('public','record_inventory_opening',array['uuid','uuid','numeric','timestamp with time zone','text','uuid','text'],'opening balance RPC exists');
select has_function('public','record_inventory_item',array['uuid','text','text','text','uuid','text','text'],'authorized standalone supply registration RPC exists');
select has_function('public','get_inventory_snapshot',array['uuid','timestamp with time zone','timestamp with time zone','text'],'inventory snapshot is feature gated');
select has_function('public','get_product_analytics_facts',array['uuid','timestamp with time zone','timestamp with time zone'],'analytics facts are feature gated');
select ok(not has_table_privilege('authenticated','public.organization_feature_flags','UPDATE'),'authenticated cannot change feature flags');
select ok(not has_table_privilege('authenticated','public.inventory_movements','INSERT'),'inventory ledger has no direct browser writes');
select ok(not has_table_privilege('authenticated','public.inventory_items','INSERT'),'standalone items can only be registered through the audited RPC');
select ok(not has_table_privilege('authenticated','private.inventory_requests','SELECT'),'idempotency payloads stay private');
select ok((select relrowsecurity from pg_class where oid='public.inventory_movements'::regclass),'inventory ledger RLS is enabled');
select ok((select count(*)=2 from pg_trigger where tgname in ('inventory_movements_append_only','inventory_movements_audit') and not tgisinternal),'inventory writes are audited and append-only');

-- Exercise enabled defaults, explicit kill switches, and tenant membership.
insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
values('e284f8b5-f143-4b44-9a16-16399cf3e5a1','authenticated','authenticated','inventory-test@example.invalid','',now(),now(),now());
insert into public.organizations(id,name) values('0a568874-0aae-431f-b85f-ef7219e1441c','Inventory test');
insert into public.memberships(organization_id,user_id,role) values('0a568874-0aae-431f-b85f-ef7219e1441c','e284f8b5-f143-4b44-9a16-16399cf3e5a1','owner');
select is((select inventory_tracking from public.organization_feature_flags where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c'),true,'new organizations start with inventory tracking enabled');
select ok((select inventory_tracking and product_analytics from public.organization_feature_flags where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c'),'all released features default on');
update public.organization_feature_flags set inventory_tracking=false,product_analytics=false where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c';
select set_config('request.jwt.claims','{"sub":"e284f8b5-f143-4b44-9a16-16399cf3e5a1","role":"authenticated"}',true);
select throws_ok($$select public.get_inventory_snapshot('0a568874-0aae-431f-b85f-ef7219e1441c',now()-interval '1 day',now(),'USD')$$,'P0001','FEATURE_DISABLED: inventory_tracking','inventory reads fail closed while disabled');
select throws_ok($$select public.get_product_analytics_facts('0a568874-0aae-431f-b85f-ef7219e1441c',now()-interval '1 day',now())$$,'P0001','FEATURE_DISABLED: product_analytics','analytics reads fail closed while disabled');

-- Enable inventory for the rest of this tenant's movement tests.
update public.organization_feature_flags set inventory_tracking=true where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c';
insert into public.accounts(organization_id,name,kind,currency) values('0a568874-0aae-431f-b85f-ef7219e1441c','Inventory test cash','bank','USD');
insert into public.evidence_files(id,organization_id,object_key,sha256_hex,mime_type,byte_size,uploaded_by)
values('db1ac51a-490f-4110-9f1c-01b1cb8ac131','0a568874-0aae-431f-b85f-ef7219e1441c','inventory/test.pdf',repeat('a',64),'application/pdf',100,'e284f8b5-f143-4b44-9a16-16399cf3e5a1');
insert into public.item_definitions(organization_id,square_catalog_object_id,name,unit_cost_minor,currency,effective_from,approved_by,version)
values('0a568874-0aae-431f-b85f-ef7219e1441c','VAR-TEST','Tea',500,'USD',now()-interval '1 day','e284f8b5-f143-4b44-9a16-16399cf3e5a1',1);
create temporary table inventory_opening_result as
select public.record_inventory_opening('0a568874-0aae-431f-b85f-ef7219e1441c',(select id from public.item_definitions where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c'),0,now(),'Physical count confirmed zero','db1ac51a-490f-4110-9f1c-01b1cb8ac131','opening-zero-key-1') as movement_id;
select is((select count(*) from public.inventory_movements where movement_type='opening_balance' and quantity_delta=0),1::bigint,'zero opening count is a valid evidenced baseline');
select lives_ok($$select public.record_inventory_opening('0a568874-0aae-431f-b85f-ef7219e1441c',(select id from public.item_definitions where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c'),0,now(),'Physical count confirmed zero','db1ac51a-490f-4110-9f1c-01b1cb8ac131','opening-zero-key-1')$$,'same opening request retries idempotently');
select is((select count(*) from public.inventory_movements where movement_type='opening_balance'),1::bigint,'idempotent opening retry does not add another baseline');
insert into public.organizations(id,name) values('657d1a65-e14e-402a-926d-907790945b87','Other tenant');
insert into public.evidence_files(id,organization_id,object_key,sha256_hex,mime_type,byte_size,uploaded_by)
values('d63c55b1-5849-4229-b8b6-f75861c56f66','657d1a65-e14e-402a-926d-907790945b87','other/test.pdf',repeat('b',64),'application/pdf',100,'e284f8b5-f143-4b44-9a16-16399cf3e5a1');
insert into public.item_definitions(organization_id,square_catalog_object_id,name,unit_cost_minor,currency,effective_from,approved_by,version)
values('657d1a65-e14e-402a-926d-907790945b87','OTHER-VAR','Tea',500,'USD',now()-interval '1 day','e284f8b5-f143-4b44-9a16-16399cf3e5a1',1);
select throws_ok($$select public.record_inventory_purchase('0a568874-0aae-431f-b85f-ef7219e1441c',(select id from public.accounts where name='Inventory test cash'),-600,'USD',now(),'Supply purchase','d63c55b1-5849-4229-b8b6-f75861c56f66','foreign-evidence-1',(select jsonb_agg(jsonb_build_object('itemId',id,'itemName','Tea','quantity',1,'unitCostMinor',500)) from public.item_definitions where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c'))$$,'P0001','Organization evidence file required','purchase cannot use evidence from another tenant');
select throws_ok($$select public.record_inventory_purchase('0a568874-0aae-431f-b85f-ef7219e1441c',(select id from public.accounts where name='Inventory test cash'),-600,'USD',now(),'Supply purchase','db1ac51a-490f-4110-9f1c-01b1cb8ac131','foreign-item-0001',(select jsonb_agg(jsonb_build_object('itemId',id,'itemName','Tea','quantity',1,'unitCostMinor',500)) from public.item_definitions where organization_id='657d1a65-e14e-402a-926d-907790945b87'))$$,'P0001','Inventory item does not match organization, name, or currency','purchase cannot use an item definition from another tenant');
create temporary table inventory_purchase_result as
select public.record_inventory_purchase('0a568874-0aae-431f-b85f-ef7219e1441c',
  (select id from public.accounts where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c'),
  -1300,'USD',now(),'Supply purchase','db1ac51a-490f-4110-9f1c-01b1cb8ac131','purchase-key-0001',
  (select jsonb_agg(jsonb_build_object('itemId',id,'itemName','Tea','quantity',q,'unitCostMinor',500))
   from (select id,1 as q from public.item_definitions where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c') d
   cross join generate_series(1,2) g)) as result;
select is((select count(*) from public.cash_movements where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c' and kind='purchase'),1::bigint,'purchase RPC creates exactly one cash movement');
select is((select count(*) from public.inventory_movements where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c' and movement_type='purchase_receipt'),2::bigint,'purchase RPC creates a receipt for each input line');
select throws_ok($$select public.record_inventory_opening('0a568874-0aae-431f-b85f-ef7219e1441c',(select id from public.item_definitions where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c'),1,now()+interval '1 hour','Late physical count evidence','db1ac51a-490f-4110-9f1c-01b1cb8ac131','opening-too-late-1')$$,'P0001','Opening balance must predate existing inventory movements','opening baseline cannot be entered after a receipt');
select is((select count(*) from private.durable_jobs where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c' and job_type='projection.replay' and idempotency_key='inventory-purchase:purchase-key-0001'),1::bigint,'cash purchase queues one deterministic projection replay in the same transaction');
select lives_ok($$select public.record_inventory_purchase('0a568874-0aae-431f-b85f-ef7219e1441c',(select id from public.accounts where name='Inventory test cash'),-1300,'USD', (select occurred_at from public.cash_movements where id=(select (result->>'cashMovementId')::uuid from inventory_purchase_result)),'Supply purchase','db1ac51a-490f-4110-9f1c-01b1cb8ac131','purchase-key-0001',(select jsonb_agg(jsonb_build_object('itemId',id,'itemName','Tea','quantity',q,'unitCostMinor',500)) from (select id,1 as q from public.item_definitions where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c') d cross join generate_series(1,2) g))$$,'repeat purchase request is accepted idempotently');
select is((select count(*) from public.cash_movements where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c' and kind='purchase'),1::bigint,'idempotent retry does not duplicate cash movement');
create temporary table inventory_item_result as
select public.record_inventory_item('0a568874-0aae-431f-b85f-ef7219e1441c','SUPPLY-001','Uncatalogued supply','USD',
  'db1ac51a-490f-4110-9f1c-01b1cb8ac131','Supplier receipt identifies this supply','supply-item-key-001') as item_id;
select ok(public.record_inventory_item('0a568874-0aae-431f-b85f-ef7219e1441c','SUPPLY-001','Uncatalogued supply','USD',
  'db1ac51a-490f-4110-9f1c-01b1cb8ac131','Supplier receipt identifies this supply','supply-item-key-001')=(select item_id from inventory_item_result),'standalone item registration retries idempotently');
select is((select count(*) from public.inventory_items i where i.id=(select item_id from inventory_item_result)
  and i.organization_id='0a568874-0aae-431f-b85f-ef7219e1441c'),1::bigint,'audited registration creates an organization-owned supply SKU');
select lives_ok($$select public.record_inventory_purchase('0a568874-0aae-431f-b85f-ef7219e1441c',(select id from public.accounts where name='Inventory test cash'),-600,'USD',now(),'Uncatalogued supply purchase','db1ac51a-490f-4110-9f1c-01b1cb8ac131','manual-supply-purchase-1',(select jsonb_agg(jsonb_build_object('itemId',item_id,'itemName','Uncatalogued supply','quantity',1,'unitCostMinor',500)) from inventory_item_result))$$,'standalone supply SKU can be purchased without a Square catalog mapping');
select is((select count(*) from public.inventory_movements m where m.inventory_item_id=(select item_id from inventory_item_result)
  and m.item_definition_id is null and m.square_catalog_object_id is null and m.movement_type='purchase_receipt'),1::bigint,'standalone supply receipt retains its manual item identity and no Square ID');
select is((select count(*) from public.audit_events a where a.entity_type='inventory_item' and a.entity_id=(select item_id from inventory_item_result)),1::bigint,'standalone supply registration is audited');
select throws_ok($$update public.inventory_items set name='mutated supply' where id=(select item_id from inventory_item_result)$$,'55000',null,'standalone supply identities are append-only');
update public.memberships set role='operator' where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c' and user_id='e284f8b5-f143-4b44-9a16-16399cf3e5a1';
select throws_ok($$select public.record_inventory_correction('0a568874-0aae-431f-b85f-ef7219e1441c',(select id from public.item_definitions where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c'),-1,now(),'unverified adjustment','db1ac51a-490f-4110-9f1c-01b1cb8ac131','correction-key-1')$$,'P0001','Organization owner or reviewer role required','operators cannot record inventory corrections');
insert into public.accounting_periods(organization_id,starts_at,ends_at,status,closed_by,closed_at,close_reason)
values('0a568874-0aae-431f-b85f-ef7219e1441c',now()-interval '1 day',now()+interval '1 day','closed','e284f8b5-f143-4b44-9a16-16399cf3e5a1',now(),'Test closed period');
select throws_ok($$select public.record_inventory_purchase('0a568874-0aae-431f-b85f-ef7219e1441c',(select id from public.accounts where name='Inventory test cash'),-600,'USD',now(),'Supply purchase','db1ac51a-490f-4110-9f1c-01b1cb8ac131','closed-period-01',(select jsonb_agg(jsonb_build_object('itemId',id,'itemName','Tea','quantity',1,'unitCostMinor',500)) from public.item_definitions where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c'))$$,'P0001','PERIOD_CLOSED','purchase is rejected in a closed accounting period');
select throws_ok($$update public.inventory_movements set reason='changed evidence reason' where organization_id='0a568874-0aae-431f-b85f-ef7219e1441c'$$,'55000',null,'inventory movement records are append-only');

select * from finish();
rollback;
