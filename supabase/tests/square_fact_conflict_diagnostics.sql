begin;
select plan(5);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table square_fact_conflict_test_org (id uuid) on commit drop;
with created as (
  insert into public.organizations (name) values ('square fact conflict diagnostic test') returning id
)
insert into square_fact_conflict_test_org select id from created;

select lives_ok(
  format(
    'select public.upsert_square_facts(%L::uuid, %L::jsonb, %L)',
    (select id from square_fact_conflict_test_org),
    '[{"kind":"payment","objectId":"diagnostic-test-payment","version":"1","versionSort":"00000000000000000001","fact":{"status":"COMPLETED","amountMinor":1250}}]',
    'pgTAP conflict diagnostic seed'
  ),
  'initial normalized fact is stored'
);

create temporary table square_fact_conflict_diagnostic (state text, detail text) on commit drop;
do $$
declare
  v_organization_id uuid;
  v_state text;
  v_detail text;
begin
  select id into v_organization_id from square_fact_conflict_test_org;
  begin
    perform public.upsert_square_facts(
      v_organization_id,
      '[{"kind":"payment","objectId":"diagnostic-test-payment","version":"1","versionSort":"00000000000000000001","fact":{"status":"FAILED","amountMinor":1250}}]'::jsonb,
      'pgTAP conflict diagnostic mismatch'
    );
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_detail = pg_exception_detail;
    insert into square_fact_conflict_diagnostic values (v_state, v_detail);
  end;
end
$$;

select is((select state from square_fact_conflict_diagnostic), 'P0001',
  'conflicting same-version content remains rejected');
select ok(position('fact_kind=payment' in (select detail from square_fact_conflict_diagnostic)) > 0,
  'diagnostic identifies the fact kind');
select ok(position('differing_fields=status' in (select detail from square_fact_conflict_diagnostic)) > 0,
  'diagnostic identifies changed normalized fields without logging their values');
select ok(
  position('object_key_sha256=' in (select detail from square_fact_conflict_diagnostic)) > 0
  and position('version_key_sha256=' in (select detail from square_fact_conflict_diagnostic)) > 0
  and position('incoming_fact_sha256=' in (select detail from square_fact_conflict_diagnostic)) > 0
  and position('diagnostic-test-payment' in (select detail from square_fact_conflict_diagnostic)) = 0
  and position('FAILED' in (select detail from square_fact_conflict_diagnostic)) = 0,
  'diagnostic uses fingerprints and omits source identifiers and fact values'
);

select * from finish();
rollback;
