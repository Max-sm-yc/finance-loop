-- Resolve the duplicate organization_id join in the refund-review materializer.
create or replace function public.materialize_square_financial_events(p_organization_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare spec record; prior_id uuid; event_id uuid; mapped_location uuid; mapped_variation uuid;
  event_version text; line_quantity numeric; inserted_count integer:=0; line_amount bigint;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('square.materialize:'||p_organization_id::text,0));
  for spec in
    with current_facts as (
      select v.fact_kind,v.object_id,v.object_version,v.fact
      from private.square_fact_current c
      join private.square_fact_versions v using(organization_id,fact_kind,object_id,object_version)
      where c.organization_id=p_organization_id
    ), completed_orders as (
      select o.object_id,o.fact from current_facts o where o.fact_kind='order'
        and lower(coalesce(o.fact->>'status',''))='completed'
    ), event_specs as (
      select 'sale'::text event_type,'order_line.sale'::text source_type,l.object_id source_id,l.object_version source_version,
        l.fact->>'occurredAt' occurred_at,l.fact->>'currency' currency,
        case when coalesce(l.fact->>'grossMinor','') ~ '^-?[0-9]{1,15}$' then (l.fact->>'grossMinor')::bigint end amount_minor,
        coalesce(nullif(btrim(l.fact->>'name'), ''), 'Unnamed Square sale item') description,coalesce(o.fact->>'locationId',l.fact->>'locationId') square_location_id,
        jsonb_build_object('squareOrderId',l.fact->>'orderId','squareLineId',l.object_id,'lineItemUid',l.fact->>'lineItemUid',
          'squareCatalogObjectId',l.fact->>'catalogObjectId','quantity',l.fact->>'quantity','grossStatus',l.fact->>'grossStatus',
          'nameStatus',case when nullif(btrim(l.fact->>'name'),'') is null then 'missing_square_item_name' else 'present' end) details,
        l.fact->>'catalogObjectId' square_variation_id,l.fact->>'quantity' quantity_text
      from current_facts l join completed_orders o on o.object_id=l.fact->>'orderId'
      where l.fact_kind='order_line' and upper(coalesce(l.fact->>'itemType','ITEM'))<>'GIFT_CARD'
      union all
      select 'discount','order_line.discount',l.object_id,l.object_version,l.fact->>'occurredAt',l.fact->>'currency',
        case when coalesce(l.fact->>'discountMinor','') ~ '^[0-9]{1,15}$' then -abs((l.fact->>'discountMinor')::bigint) end,
        coalesce(l.fact->>'name','Discount'),coalesce(o.fact->>'locationId',l.fact->>'locationId'),
        jsonb_build_object('squareOrderId',l.fact->>'orderId','squareLineId',l.object_id,'lineItemUid',l.fact->>'lineItemUid',
          'discountStatus',l.fact->>'discountStatus'),null,null
      from current_facts l join completed_orders o on o.object_id=l.fact->>'orderId'
      where l.fact_kind='order_line' and coalesce(l.fact->>'discountStatus','')<>'missing_square_discount_total'
        and coalesce(l.fact->>'discountMinor','') ~ '^[0-9]{1,15}$'
      union all
      select 'tax','order_line.tax',l.object_id,l.object_version,l.fact->>'occurredAt',l.fact->>'currency',
        case when coalesce(l.fact->>'taxMinor','') ~ '^[0-9]{1,15}$' then abs((l.fact->>'taxMinor')::bigint) end,
        coalesce(l.fact->>'name','Sales tax'),coalesce(o.fact->>'locationId',l.fact->>'locationId'),
        jsonb_build_object('squareOrderId',l.fact->>'orderId','squareLineId',l.object_id,'lineItemUid',l.fact->>'lineItemUid'),null,null
      from current_facts l join completed_orders o on o.object_id=l.fact->>'orderId'
      where l.fact_kind='order_line' and coalesce(l.fact->>'taxMinor','') ~ '^-?[0-9]{1,15}$'
      union all
      select 'refund','refund',r.object_id,r.object_version,r.fact->>'occurredAt',r.fact->>'currency',
        case when coalesce(r.fact->>'amountMinor','') ~ '^[0-9]{1,15}$' then -abs((r.fact->>'amountMinor')::bigint) end,
        'Square refund',null,jsonb_build_object('squareOrderId',r.fact->>'orderId','squarePaymentId',r.fact->>'paymentId','status',r.fact->>'status'),null,null
      from current_facts r where r.fact_kind='refund' and upper(coalesce(r.fact->>'status',''))='COMPLETED'
      union all
      select 'processing_fee','payment.fee',p.object_id,p.object_version,p.fact->>'occurredAt',p.fact->>'currency',
        case when coalesce(p.fact->>'feeMinor','') ~ '^[0-9]{1,15}$' then -abs((p.fact->>'feeMinor')::bigint) end,
        'Square processing fee',p.fact->>'locationId',jsonb_build_object('squareOrderId',p.fact->>'orderId','feeStatus',p.fact->>'feeStatus'),null,null
      from current_facts p where p.fact_kind='payment' and upper(coalesce(p.fact->>'status',''))='COMPLETED'
      union all
      select 'payout','payout_entry',p.object_id,p.object_version,p.fact->>'occurredAt',p.fact->>'currency',
        case when coalesce(p.fact->>'netAmountMinor','') ~ '^-?[0-9]{1,15}$' then (p.fact->>'netAmountMinor')::bigint
          when coalesce(p.fact->>'amountMinor','') ~ '^-?[0-9]{1,15}$' then (p.fact->>'amountMinor')::bigint end,
        'Square payout entry',null,jsonb_build_object('squarePayoutId',p.fact->>'payoutId','entryType',p.fact->>'type',
          'squarePaymentId',p.fact->>'paymentId','squareRefundId',p.fact->>'refundId','squareOrderId',p.fact->>'orderId'),null,null
      from current_facts p where p.fact_kind='payout_entry'
      union all
      select 'cost_of_goods_sold','order_line.cogs',l.object_id,
        l.object_version||'|cost:'||coalesce(o.id::text,'item:'||d.id::text||':'||d.version::text,'missing'),
        l.fact->>'occurredAt',l.fact->>'currency',
        case when coalesce(o.unit_cost_minor,d.unit_cost_minor) is not null
              and coalesce(l.fact->>'quantity','') ~ '^[0-9]+(\.[0-9]+)?$'
              and coalesce(o.unit_cost_minor,d.unit_cost_minor)*(l.fact->>'quantity')::numeric
                =trunc(coalesce(o.unit_cost_minor,d.unit_cost_minor)*(l.fact->>'quantity')::numeric)
              and coalesce(o.unit_cost_minor,d.unit_cost_minor)*(l.fact->>'quantity')::numeric<1000000000000000
          then -(coalesce(o.unit_cost_minor,d.unit_cost_minor)*(l.fact->>'quantity')::numeric)::bigint end,
        coalesce(nullif(btrim(l.fact->>'name'),''),'Cost of goods sold'),coalesce(ord.fact->>'locationId',l.fact->>'locationId'),
        jsonb_build_object('squareOrderId',l.fact->>'orderId','squareLineId',l.object_id,'lineItemUid',l.fact->>'lineItemUid',
          'squareCatalogObjectId',l.fact->>'catalogObjectId','quantity',l.fact->>'quantity',
          'costSource',case when o.id is not null then 'sale_line_override' when d.id is not null then 'item_definition' else 'missing' end,
          'costRecordId',coalesce(o.id::text,d.id::text),'unitCostMinor',coalesce(o.unit_cost_minor,d.unit_cost_minor)) details,
        l.fact->>'catalogObjectId',l.fact->>'quantity'
      from current_facts l join completed_orders ord on ord.object_id=l.fact->>'orderId'
      left join public.sale_line_cost_overrides o on o.organization_id=p_organization_id
        and o.square_order_id=l.fact->>'orderId' and o.square_line_uid=l.fact->>'lineItemUid'
        and o.currency=l.fact->>'currency'
      left join lateral (
        select d0.id,d0.version,d0.unit_cost_minor from public.item_definitions d0
        where d0.organization_id=p_organization_id and d0.square_catalog_object_id=l.fact->>'catalogObjectId'
          and d0.currency=l.fact->>'currency' and d0.effective_from<=(l.fact->>'occurredAt')::timestamptz
          and (d0.effective_until is null or d0.effective_until>(l.fact->>'occurredAt')::timestamptz)
        order by d0.effective_from desc,d0.version desc limit 1
      ) d on true
      where l.fact_kind='order_line' and upper(coalesce(l.fact->>'itemType','ITEM'))<>'GIFT_CARD'
    )
    select e.*,m.entity_id mapped_location,
      e.source_version||'|location:'||coalesce(m.entity_id::text,'unmapped') event_version
    from event_specs e
    left join public.domain_source_mappings m on m.organization_id=p_organization_id
      and m.provider='square' and m.source_type='LOCATION' and m.source_id=e.square_location_id
    where nullif(e.occurred_at,'') is not null and e.currency ~ '^[A-Z]{3}$'
      and not exists(select 1 from public.financial_events prior
        where prior.organization_id=p_organization_id and prior.source_provider='square'
          and prior.source_type=e.source_type and prior.source_id=e.source_id
          and prior.source_version=e.source_version||'|location:'||coalesce(m.entity_id::text,'unmapped'))
    order by e.occurred_at,e.source_type,e.source_id
    limit 100
  loop
    mapped_location:=spec.mapped_location;
    event_version:=spec.event_version;
    select e.id into prior_id from public.financial_events e where e.organization_id=p_organization_id
      and e.source_provider='square' and e.source_type=spec.source_type and e.source_id=spec.source_id
      order by e.ingested_at desc,e.created_at desc limit 1;
    insert into public.financial_events(organization_id,event_type,status,occurred_at,location_id,amount_minor,currency,description,
      source_provider,source_type,source_id,source_version,idempotency_key,supersedes_event_id,originating_automation,details)
    values(p_organization_id,spec.event_type,case when spec.amount_minor is null then 'incomplete' else 'posted' end,
      spec.occurred_at::timestamptz,mapped_location,spec.amount_minor,spec.currency,spec.description,
      'square',spec.source_type,spec.source_id,event_version,
      'square:'||private.sha256_hex(spec.source_type||':'||spec.source_id||':'||event_version),prior_id,'square_sync',
      coalesce(spec.details,'{}'::jsonb)||jsonb_build_object('squareSourceVersion',spec.source_version)) returning id into event_id;
    insert into public.domain_source_mappings(organization_id,provider,source_type,source_id,entity_type,entity_id,
      source_version,source_hash,ingestion_actor_kind,active)
    values(p_organization_id,'square',spec.source_type,spec.source_id,'financial_event',event_id,event_version,
      private.sha256_hex(coalesce(spec.details,'{}'::jsonb)::text),'integration',true)
    on conflict (organization_id,provider,source_type,source_id) do update set entity_id=excluded.entity_id,
      source_version=excluded.source_version,source_hash=excluded.source_hash,observed_at=now(),active=true;
    if spec.event_type in ('sale','cost_of_goods_sold') then
      mapped_variation:=null;
      select m.entity_id into mapped_variation from public.domain_source_mappings m
        where m.organization_id=p_organization_id and m.provider='square' and m.source_type='ITEM_VARIATION'
          and m.source_id=spec.square_variation_id;
      line_quantity:=case when coalesce(spec.quantity_text,'') ~ '^[0-9]+(\.[0-9]+)?$' then spec.quantity_text::numeric end;
      line_amount:=spec.amount_minor;
      insert into public.financial_event_lines(organization_id,financial_event_id,line_number,variation_id,description,quantity,amount_minor,currency)
        values(p_organization_id,event_id,1,mapped_variation,coalesce(spec.description,''),line_quantity,line_amount,spec.currency);
    end if;
    inserted_count:=inserted_count+1;
  end loop;
  for spec in
    select r.id,r.square_refund_id,r.approved_cogs_reversal_minor,r.currency,r.disposition,r.updated_at,r.reviewed_by,
      f.fact->>'occurredAt' occurred_at,m.entity_id mapped_location,
      'review:'||r.id::text||':'||r.updated_at::text event_version
    from public.refund_cost_reviews r
    join private.square_fact_current c on c.organization_id=r.organization_id and c.fact_kind='refund' and c.object_id=r.square_refund_id
    join private.square_fact_versions f on f.organization_id=c.organization_id
      and f.fact_kind=c.fact_kind and f.object_id=c.object_id and f.object_version=c.object_version
    left join private.square_fact_current oc on oc.organization_id=f.organization_id and oc.fact_kind='order' and oc.object_id=f.fact->>'orderId'
    left join private.square_fact_versions o on o.organization_id=oc.organization_id and o.fact_kind=oc.fact_kind
      and o.object_id=oc.object_id and o.object_version=oc.object_version
    left join public.domain_source_mappings m on m.organization_id=p_organization_id and m.provider='square'
      and m.source_type='LOCATION' and m.source_id=o.fact->>'locationId'
    where r.organization_id=p_organization_id and upper(coalesce(f.fact->>'status',''))='COMPLETED'
      and nullif(f.fact->>'occurredAt','') is not null
      and not exists(select 1 from public.financial_events prior
        where prior.organization_id=p_organization_id and prior.source_provider='vernius'
          and prior.source_type='refund.cogs_reversal' and prior.source_id=r.square_refund_id
          and prior.source_version='review:'||r.id::text||':'||r.updated_at::text)
    order by f.fact->>'occurredAt',r.id
    limit 100
  loop
    event_version:=spec.event_version;
    select e.id into prior_id from public.financial_events e where e.organization_id=p_organization_id
      and e.source_provider='vernius' and e.source_type='refund.cogs_reversal' and e.source_id=spec.square_refund_id
      order by e.ingested_at desc,e.created_at desc limit 1;
    mapped_location:=spec.mapped_location;
    insert into public.financial_events(organization_id,event_type,status,occurred_at,location_id,amount_minor,currency,description,
      source_provider,source_type,source_id,source_version,idempotency_key,supersedes_event_id,recorded_by,details)
    values(p_organization_id,'cost_of_goods_sold','posted',spec.occurred_at::timestamptz,mapped_location,
      spec.approved_cogs_reversal_minor,spec.currency,'Approved COGS reversal for Square refund',
      'vernius','refund.cogs_reversal',spec.square_refund_id,event_version,
      'vernius:'||private.sha256_hex('refund.cogs_reversal:'||spec.square_refund_id||':'||event_version),prior_id,
      spec.reviewed_by,jsonb_build_object('refundReviewId',spec.id,'disposition',spec.disposition,'reversal',true)) returning id into event_id;
    insert into public.domain_source_mappings(organization_id,provider,source_type,source_id,entity_type,entity_id,
      source_version,source_hash,ingestion_actor_kind,active)
    values(p_organization_id,'vernius','refund.cogs_reversal',spec.square_refund_id,'financial_event',event_id,event_version,
      private.sha256_hex(event_version),'system',true)
    on conflict (organization_id,provider,source_type,source_id) do update set entity_id=excluded.entity_id,
      source_version=excluded.source_version,source_hash=excluded.source_hash,observed_at=now(),active=true;
    inserted_count:=inserted_count+1;
  end loop;
  return inserted_count;
end
$$;
revoke all on function public.materialize_square_financial_events(uuid) from public,anon,authenticated;
grant execute on function public.materialize_square_financial_events(uuid) to service_role;
