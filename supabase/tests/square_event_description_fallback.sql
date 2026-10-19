begin;
select plan(13);
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

insert into private.square_fact_versions(
  organization_id,fact_kind,object_id,object_version,version_sort,fact,cause
)
select (select id from square_event_description_test_org),'order_line','order-test:batch:'||line_number::text,
  'v1','t:'||lpad(line_number::text,16,'0'),
  jsonb_build_object('orderId','order-test','occurredAt','2026-09-04T16:00:00Z','currency','USD',
    'grossMinor',100+line_number,'name','Batch item','quantity','1','itemType','ITEM','grossStatus','provided',
    'lineItemUid','batch-'||line_number::text),
  'description fallback batch test'
from generate_series(1,101) as lines(line_number);

insert into private.square_fact_current(
  organization_id,fact_kind,object_id,object_version,version_sort,source_revision
)
select organization_id,fact_kind,object_id,object_version,version_sort,1
from private.square_fact_versions
where organization_id=(select id from square_event_description_test_org)
  and object_id like 'order-test:batch:%';

select is(
  public.materialize_square_financial_events((select id from square_event_description_test_org)),
  100,
  'materialization limits the first call to one bounded batch'
);

select is(
  public.materialize_square_financial_events((select id from square_event_description_test_org)),
  100,
  'materialization advances to the next pending batch'
);

select is(
  public.materialize_square_financial_events((select id from square_event_description_test_org)),
  2,
  'materialization drains the final partial batch'
);

select is(
  public.materialize_square_financial_events((select id from square_event_description_test_org)),
  0,
  'a fully materialized source revision is idempotent'
);

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
values('10000000-0000-4000-8000-000000000091','authenticated','authenticated',
  'square-event-refund@example.invalid','',now(),now(),now());

insert into private.square_fact_versions(
  organization_id,fact_kind,object_id,object_version,version_sort,fact,cause
) values (
  (select id from square_event_description_test_org),'refund','refund-test','v1','t:0000000000000001',
  jsonb_build_object('orderId','order-test','status','COMPLETED','occurredAt','2026-09-04T17:00:00Z',
    'currency','USD','amountMinor',50),
  'refund review materialization test'
);

insert into private.square_fact_current(
  organization_id,fact_kind,object_id,object_version,version_sort,source_revision
)
select organization_id,fact_kind,object_id,object_version,version_sort,1
from private.square_fact_versions
where organization_id=(select id from square_event_description_test_org) and object_id='refund-test';

insert into public.refund_cost_reviews(organization_id,square_refund_id,square_order_id,disposition,
  approved_cogs_reversal_minor,currency,decision_reason,reviewed_by)
values((select id from square_event_description_test_org),'refund-test','order-test',
  'not_returned_to_inventory',0,'USD','Merchant confirmed no restock.',
  '10000000-0000-4000-8000-000000000091');

select is(
  public.materialize_square_financial_events((select id from square_event_description_test_org)),
  2,
  'refund source and approved refund review materialize together'
);

select is(
  (select count(*) from public.financial_events where organization_id=(select id from square_event_description_test_org)
    and source_type='refund.cogs_reversal'),
  1::bigint,
  'approved refund review creates its COGS reversal event'
);

select is(
  public.materialize_square_financial_events((select id from square_event_description_test_org)),
  0,
  'refund review materialization is idempotent'
);

select * from finish();
rollback;
