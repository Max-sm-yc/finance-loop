begin;
select plan(3);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table worker_persistence_test_org (id uuid) on commit drop;
with created as (
  insert into public.organizations (name) values ('worker persistence upsert test') returning id
)
insert into worker_persistence_test_org select id from created;

select lives_ok(
  format(
    'select public.upsert_square_facts(%L::uuid, %L::jsonb, %L)',
    (select id from worker_persistence_test_org),
    '[{"kind":"payment","objectId":"worker-test-payment","version":"1","versionSort":"00000000000000000001","fact":{"status":"COMPLETED"}}]',
    'pgTAP worker upsert test'
  ),
  'worker fact upsert succeeds without ambiguous column references'
);

select lives_ok(
  format(
    'select public.upsert_square_facts(%L::uuid, %L::jsonb, %L)',
    (select id from worker_persistence_test_org),
    '[{"kind":"payment","objectId":"worker-test-payment","version":"1","versionSort":"00000000000000000001","fact":{"status":"COMPLETED"}}]',
    'pgTAP worker upsert duplicate test'
  ),
  'worker fact upsert accepts an idempotent duplicate version'
);

select is(
  (select count(*) from private.square_fact_current c
    where c.organization_id=(select id from worker_persistence_test_org)
      and c.fact_kind='payment' and c.object_id='worker-test-payment'),
  1::bigint,
  'idempotent upsert leaves one current payment fact'
);

select * from finish();
rollback;
