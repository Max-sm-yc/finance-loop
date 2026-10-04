begin;
select plan(13);

select has_function('public','get_square_sync_coverage',array['uuid','timestamp with time zone','timestamp with time zone'],'lightweight sync coverage RPC exists');
select ok(has_function_privilege('authenticated','public.get_square_sync_coverage(uuid,timestamptz,timestamptz)','EXECUTE'),'authenticated members may read sync coverage');
select ok(not has_function_privilege('anon','public.get_square_sync_coverage(uuid,timestamptz,timestamptz)','EXECUTE'),'anonymous callers cannot read sync coverage');

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
values('e284f8b5-f143-4b44-9a16-16399cf3e5a1','authenticated','authenticated','sync-coverage-test@example.invalid','',now(),now(),now());
insert into public.organizations(id,name) values
  ('0a568874-0aae-431f-b85f-ef7219e1441c','Sync coverage test'),
  ('657d1a65-e14e-402a-926d-907790945b87','Other sync coverage test');
insert into public.memberships(organization_id,user_id,role)
values('0a568874-0aae-431f-b85f-ef7219e1441c','e284f8b5-f143-4b44-9a16-16399cf3e5a1','owner');
select set_config('request.jwt.claims','{"sub":"e284f8b5-f143-4b44-9a16-16399cf3e5a1","role":"authenticated"}',true);
create temporary table sync_coverage_test_window as
select now()-interval '3 days' as start_at, now()-interval '2 days' as end_at;

select is(jsonb_array_length(public.get_square_sync_coverage(
  '0a568874-0aae-431f-b85f-ef7219e1441c',(select start_at from sync_coverage_test_window),(select end_at from sync_coverage_test_window)
)->'windows'),0,'no completed sync means no covered window');
select is((public.get_square_sync_coverage(
  '0a568874-0aae-431f-b85f-ef7219e1441c',(select start_at from sync_coverage_test_window),(select end_at from sync_coverage_test_window)
)->>'sourceHealthFresh')::boolean,false,'missing health records require a fresh sync');
select throws_ok($$select public.get_square_sync_coverage('657d1a65-e14e-402a-926d-907790945b87',now()-interval '1 day',now())$$,
  'P0001','Organization membership required','coverage is restricted to organization members');
select throws_ok($$select public.get_square_sync_coverage('0a568874-0aae-431f-b85f-ef7219e1441c',now(),now()-interval '1 day')$$,
  'P0001','Invalid sync coverage window','invalid windows are rejected');

insert into private.durable_jobs(organization_id,requested_by,job_type,idempotency_key,payload,status,finished_at)
select '0a568874-0aae-431f-b85f-ef7219e1441c','e284f8b5-f143-4b44-9a16-16399cf3e5a1','square.sync','coverage-test-sync',
  jsonb_build_object('startAt',start_at,'endAt',end_at), 'complete', now()
from sync_coverage_test_window;
insert into private.square_worker_health(organization_id,resource,status,last_successful_sync_at,gap,checked_at)
select '0a568874-0aae-431f-b85f-ef7219e1441c',required.resource,'fresh',now(),null,now()
from unnest(array['square','orders','payments','refunds','catalog','payouts']::text[]) as required(resource);

select is(jsonb_array_length(public.get_square_sync_coverage(
  '0a568874-0aae-431f-b85f-ef7219e1441c',(select start_at from sync_coverage_test_window),(select end_at from sync_coverage_test_window)
)->'windows'),1,'completed sync windows are returned');
select is((public.get_square_sync_coverage(
  '0a568874-0aae-431f-b85f-ef7219e1441c',(select start_at from sync_coverage_test_window),(select end_at from sync_coverage_test_window)
)->>'sourceHealthFresh')::boolean,true,'fresh source health permits covered periods to be reused');
select is((public.get_square_sync_coverage(
  '0a568874-0aae-431f-b85f-ef7219e1441c',(select start_at from sync_coverage_test_window),(select end_at from sync_coverage_test_window)
)->'sourceGaps'->>'missingParentOrderLineCount')::bigint,0::bigint,'complete order facts have no missing parents');
select is((public.get_square_sync_coverage(
  '0a568874-0aae-431f-b85f-ef7219e1441c',(select start_at from sync_coverage_test_window),(select end_at from sync_coverage_test_window)
)->'sourceGaps'->>'missingPayoutEntryHealthCount')::bigint,0::bigint,'period without payouts has no missing payout entry health');
select is(jsonb_array_length(public.get_square_sync_coverage(
  '0a568874-0aae-431f-b85f-ef7219e1441c',(select start_at from sync_coverage_test_window),(select end_at from sync_coverage_test_window)
)->'pendingWindows'),0,'completed sync does not appear as pending');

insert into private.durable_jobs(organization_id,requested_by,job_type,idempotency_key,payload)
select '0a568874-0aae-431f-b85f-ef7219e1441c','e284f8b5-f143-4b44-9a16-16399cf3e5a1','square.sync','coverage-test-pending',
  jsonb_build_object('startAt',start_at,'endAt',end_at)
from sync_coverage_test_window;
select is(jsonb_array_length(public.get_square_sync_coverage(
  '0a568874-0aae-431f-b85f-ef7219e1441c',(select start_at from sync_coverage_test_window),(select end_at from sync_coverage_test_window)
)->'pendingWindows'),1,'queued sync is surfaced to prevent duplicate requests');

select * from finish();
rollback;
