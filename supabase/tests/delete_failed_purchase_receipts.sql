begin;
select plan(16);

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
values('10000000-0000-4000-8000-000000000001','authenticated','authenticated','delete-receipt@example.invalid','',now(),now(),now());
insert into public.organizations(id,name) values
('20000000-0000-4000-8000-000000000001','Receipt deletion test'),
('20000000-0000-4000-8000-000000000002','Other organization');
insert into public.memberships(organization_id,user_id,role)
values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','owner');
insert into public.purchase_receipt_submissions(id,organization_id,external_submission_id,original_filename,declared_mime_type,created_by,status)
values
('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','failed-test','failed.pdf','application/pdf','10000000-0000-4000-8000-000000000001','awaiting_upload'),
('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','queued-test','queued.pdf','application/pdf','10000000-0000-4000-8000-000000000001','queued'),
('30000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','draft-test','draft.pdf','application/pdf','10000000-0000-4000-8000-000000000001','failed'),
('30000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000001','fresh-test','fresh.pdf','application/pdf','10000000-0000-4000-8000-000000000001','awaiting_upload');
insert into public.purchase_receipt_draft_versions(organization_id,receipt_id,version,draft)
values('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003',1,'{"lines":[]}');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.complete_purchase_receipt_upload('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',
 '20000000-0000-4000-8000-000000000001/purchase-receipts/30000000-0000-4000-8000-000000000001/failed.pdf',repeat('a',64),128,'application/pdf');
select public.fail_purchase_receipt_processing('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','RECEIPT_MODEL_UNAVAILABLE');
-- Existing duplicate deliveries must not become new deduplication anchors after deletion.
insert into public.purchase_receipt_submissions(id,organization_id,external_submission_id,original_filename,declared_mime_type,created_by,status,duplicate_of,evidence_file_id)
select '30000000-0000-4000-8000-000000000005',organization_id,'duplicate-test','duplicate.pdf','application/pdf',created_by,'duplicate',id,evidence_file_id
from public.purchase_receipt_submissions where id='30000000-0000-4000-8000-000000000001';

select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select ok(not has_function_privilege('anon','public.delete_failed_purchase_receipt(uuid,uuid)','EXECUTE'),'anonymous callers cannot delete');
select throws_ok($$select public.delete_failed_purchase_receipt('20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001')$$,
 'P0001','Organization owner or reviewer role required','cross-tenant deletion denied');
select throws_ok($$select public.delete_failed_purchase_receipt('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002')$$,
 'P0001','Only failed receipts without drafts, decisions or effects can be deleted','queued receipt cannot be deleted');
select throws_ok($$select public.delete_failed_purchase_receipt('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003')$$,
 'P0001','Only failed receipts without drafts, decisions or effects can be deleted','draft history blocks deletion even without active version');
reset role;
update public.memberships set role='operator' where organization_id='20000000-0000-4000-8000-000000000001';
set local role authenticated;
select throws_ok($$select public.delete_failed_purchase_receipt('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001')$$,
 'P0001','Organization owner or reviewer role required','operator cannot delete');
reset role;
update public.memberships set role='reviewer' where organization_id='20000000-0000-4000-8000-000000000001';
set local role authenticated;
select is(public.delete_failed_purchase_receipt('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001')->>'deleted','true','reviewer deletes failed receipt');
select is((select count(*) from public.purchase_receipt_submissions where id='30000000-0000-4000-8000-000000000001'),0::bigint,'deleted receipt hidden by actual RLS');
select is(public.delete_failed_purchase_receipt('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001')->>'deleted','true','delete retry is idempotent');
reset role;
select is((select deleted_by from public.purchase_receipt_submissions where id='30000000-0000-4000-8000-000000000001'),
 '10000000-0000-4000-8000-000000000001'::uuid,'deletion actor retained');
select is((select count(*) from public.audit_events where entity_id='30000000-0000-4000-8000-000000000001' and action='delete'),1::bigint,'retry writes no extra audit event');
select is((select count(*) from public.evidence_files where sha256_hex=repeat('a',64)),1::bigint,'source evidence retained');
select is((select count(*) from private.durable_jobs where payload->>'receiptId'='30000000-0000-4000-8000-000000000001'),1::bigint,'job history retained');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select is(public.get_purchase_receipt_for_processing('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001'),null::jsonb,'worker cannot reprocess deleted receipt');
select throws_ok($$select public.complete_purchase_receipt_upload('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',
 '20000000-0000-4000-8000-000000000001/purchase-receipts/30000000-0000-4000-8000-000000000001/failed.pdf',repeat('a',64),128,'application/pdf')$$,
 'P0001','Receipt submission not found','deleted original cannot be completed again');
select is(public.complete_purchase_receipt_upload('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000004',
 '20000000-0000-4000-8000-000000000001/purchase-receipts/30000000-0000-4000-8000-000000000004/fresh.pdf',repeat('a',64),128,'application/pdf')->>'status','queued','fresh upload of same bytes is not blocked by deleted original');
select is((select count(*) from private.durable_jobs where payload->>'receiptId'='30000000-0000-4000-8000-000000000004'),1::bigint,'fresh submission has its own extraction job');
select * from finish();
rollback;
