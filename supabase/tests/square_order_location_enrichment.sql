begin;
select plan(7);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table square_order_enrichment_test_org (id uuid) on commit drop;
with created as (
  insert into public.organizations (name) values ('square order location enrichment test') returning id
)
insert into square_order_enrichment_test_org select id from created;

select lives_ok(
  format(
    'select public.upsert_square_facts(%L::uuid, %L::jsonb, %L)',
    (select id from square_order_enrichment_test_org),
    '[{"kind":"order","objectId":"enrichment-test-order","version":"6","versionSort":"n:0000000000000000000000000000000000000006","fact":{"locationId":null,"totalMinor":1250}}]',
    'pgTAP order enrichment seed'
  ),
  'initial order fact with unknown location is stored'
);

select lives_ok(
  format(
    'select public.upsert_square_facts(%L::uuid, %L::jsonb, %L)',
    (select id from square_order_enrichment_test_org),
    '[{"kind":"order","objectId":"enrichment-test-order","version":"6","versionSort":"n:0000000000000000000000000000000000000006","fact":{"locationId":"location-test-a","totalMinor":1250}}]',
    'pgTAP order location enrichment'
  ),
  'same-version null-to-known location is appended as an enrichment'
);

select is(
  (select count(*) from private.square_fact_versions
    where organization_id=(select id from square_order_enrichment_test_org)
      and fact_kind='order' and object_id='enrichment-test-order'),
  2::bigint,
  'original and enriched order facts are both preserved'
);

select is(
  (select v.fact->>'locationId' from private.square_fact_current c
    join private.square_fact_versions v using (organization_id,fact_kind,object_id,object_version)
    where c.organization_id=(select id from square_order_enrichment_test_org)
      and c.fact_kind='order' and c.object_id='enrichment-test-order'),
  'location-test-a',
  'the enriched order fact becomes current'
);

select lives_ok(
  format(
    'select public.upsert_square_facts(%L::uuid, %L::jsonb, %L)',
    (select id from square_order_enrichment_test_org),
    '[{"kind":"order","objectId":"enrichment-test-order","version":"6","versionSort":"n:0000000000000000000000000000000000000006","fact":{"locationId":"location-test-a","totalMinor":1250}}]',
    'pgTAP order location enrichment duplicate'
  ),
  'repeated identical enrichment is idempotent'
);

select throws_ok(
  format(
    'select public.upsert_square_facts(%L::uuid, %L::jsonb, %L)',
    (select id from square_order_enrichment_test_org),
    '[{"kind":"order","objectId":"enrichment-test-order","version":"6","versionSort":"n:0000000000000000000000000000000000000006","fact":{"locationId":"location-test-a","totalMinor":1300}}]',
    'pgTAP order non-location conflict'
  ),
  'P0001',
  'Square returned conflicting content for the same object version',
  'same-version amount changes still fail closed'
);

select throws_ok(
  format(
    'select public.upsert_square_facts(%L::uuid, %L::jsonb, %L)',
    (select id from square_order_enrichment_test_org),
    '[{"kind":"order","objectId":"enrichment-test-order","version":"6","versionSort":"n:0000000000000000000000000000000000000006","fact":{"locationId":"location-test-b","totalMinor":1250}}]',
    'pgTAP order conflicting location'
  ),
  'P0001',
  'Square returned conflicting content for the same object version',
  'a second distinct non-null location still fails closed'
);

select * from finish();
rollback;
