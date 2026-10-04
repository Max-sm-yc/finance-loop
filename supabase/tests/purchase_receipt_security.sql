begin;
select plan(10);

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
values
('10000000-0000-4000-8000-000000000001','authenticated','authenticated','receipt-owner@example.invalid','',now(),now(),now()),
('10000000-0000-4000-8000-000000000002','authenticated','authenticated','receipt-other@example.invalid','',now(),now(),now());
insert into public.organizations(id,name) values
('20000000-0000-4000-8000-000000000001','Receipt isolation A'),
('20000000-0000-4000-8000-000000000002','Receipt isolation B');
insert into public.memberships(organization_id,user_id,role) values
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','owner'),
('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','owner');
insert into public.purchase_receipt_submissions(id,organization_id,external_submission_id,original_filename,declared_mime_type,created_by)
values
('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','isolation-a','supplier-a.pdf','application/pdf','10000000-0000-4000-8000-000000000001'),
('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','isolation-b','supplier-b.pdf','application/pdf','10000000-0000-4000-8000-000000000002');
insert into public.purchase_receipt_draft_versions(organization_id,receipt_id,version,draft) values
('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',1,'{"lines":[{"lineId":"line-1"}]}'),
('20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002',1,'{"lines":[{"lineId":"line-1"}]}');

select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*) from public.purchase_receipt_submissions),1::bigint,'actual authenticated RLS sees only its organization receipt');
select is((select count(*) from public.purchase_receipt_draft_versions),1::bigint,'actual authenticated RLS hides other organization extraction');
select throws_ok($$select public.approve_purchase_receipt('20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002',1,'{}','Supplier source review reason','cross-org-decision')$$,
 'P0001','Organization owner or reviewer role required','cross-organization approval is denied inside database');
select throws_ok($$select public.register_purchase_receipt_integration('20000000-0000-4000-8000-000000000002','Cross organization',repeat('c',64))$$,
 'P0001','Organization owner role required','cross-organization credential creation is denied');
select ok(not has_table_privilege(current_user,'public.purchase_receipt_decisions','INSERT'),'human cannot directly insert an approval');
select ok(not has_function_privilege(current_user,'public.save_purchase_receipt_draft(uuid,uuid,integer,jsonb)','EXECUTE'),'human cannot call worker extraction persistence');
reset role;

update public.memberships set role='operator' where organization_id='20000000-0000-4000-8000-000000000001';
set local role authenticated;
select throws_ok($$select public.register_purchase_receipt_integration('20000000-0000-4000-8000-000000000001','Operator credential',repeat('d',64))$$,
 'P0001','Organization owner role required','operator cannot provision integration token');
select throws_ok($$select public.approve_purchase_receipt('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',1,'{}','Supplier source review reason','operator-decision')$$,
 'P0001','Organization owner or reviewer role required','operator cannot approve financial effects');
reset role;
select ok(not has_function_privilege('service_role','public.approve_purchase_receipt(uuid,uuid,integer,jsonb,text,text)','EXECUTE'),'machine role lacks human approval RPC privilege');
select throws_ok($$update public.purchase_receipt_draft_versions set draft='{}' where receipt_id='30000000-0000-4000-8000-000000000001'$$,
 '55000',null,'extraction source versions cannot be rewritten');

select * from finish();
rollback;
