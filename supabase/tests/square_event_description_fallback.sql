begin;
select plan(6);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table square_event_description_test_org (id uuid) on commit drop;
with created as (
  insert into public.organizations (name) values ('square event description test') returning id
)
insert into square_event_description_test_org select id from created;

insert into private.square_fact_versions(
  organization_id,fact_kind,object_id,object_version,version_sort,fact,cause
) values
  ((select id from square_event_description_test_org),'order','order-test','v1','t:0000000000000001',
    jsonb_build_object('status','COMPLETED'),'description fallback test'),
  ((select id from square_event_description_test_org),'order_line','order-test:line-null','v1','t:0000000000000001',
    jsonb_build_object('orderId','order-test','occurredAt','2026-09-04T15:00:00Z','currency','USD','grossMinor',525,
      'name',null,'quantity','1','itemType','ITEM','grossStatus','provided','lineItemUid','line-null'),
    'description fallback test'),
  ((select id from square_event_description_test_org),'order_line','order-test:line-blank','v1','t:0000000000000001',
    jsonb_build_object('orderId','order-test','occurredAt','2026-09-04T15:01:00Z','currency','USD','grossMinor',525,
      'name','   ','quantity','1','itemType','ITEM','grossStatus','provided','lineItemUid','line-blank'),
    'description fallback test');

insert into private.square_fact_current(
  organization_id,fact_kind,object_id,object_version,version_sort,source_revision
)
select organization_id,fact_kind,object_id,object_version,version_sort,1
from private.square_fact_versions
where organization_id=(select id from square_event_description_test_org)
  and object_id in ('order-test','order-test:line-null','order-test:line-blank');

select lives_ok(
  format('select public.materialize_square_financial_events(%L::uuid)', (select id from square_event_description_test_org)),
  'materializer accepts null and blank Square item names'
);

select is(
  (select count(*) from public.financial_events
    where organization_id=(select id from square_event_description_test_org)
      and source_type='order_line.sale' and description='Unnamed Square sale item'),
  2::bigint,
  'sale events use a clear fallback for null and blank item names'
);

select is(
  (select sum(amount_minor) from public.financial_events
    where organization_id=(select id from square_event_description_test_org) and source_type='order_line.sale'),
  1050::numeric,
  'sale amounts remain unchanged'
);

select is(
  (select count(*) from public.financial_events
    where organization_id=(select id from square_event_description_test_org)
      and source_type='order_line.sale' and details->>'nameStatus'='missing_square_item_name'),
  2::bigint,
  'sale event details retain that the source item name was missing'
);

select is(
  (select count(*) from public.financial_events
    where organization_id=(select id from square_event_description_test_org)
      and source_type='order_line.cogs' and description='Cost of goods sold'),
  2::bigint,
  'cost events also receive a nonblank fallback description'
);

select ok(
  (select bool_and(status='incomplete' and amount_minor is null) from public.financial_events
    where organization_id=(select id from square_event_description_test_org) and source_type='order_line.cogs'),
  'missing acquisition costs stay incomplete and are not replaced with zero'
);

select * from finish();
rollback;
