create or replace function public.get_product_catalog_items(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare items jsonb;
begin
  if not public.is_org_member(p_organization_id) then
    raise exception 'Organization membership required';
  end if;
  if not exists(select 1 from public.organization_feature_flags f
      where f.organization_id=p_organization_id and f.product_analytics) then
    raise exception 'FEATURE_DISABLED: product_analytics';
  end if;

  with catalog_variations as (
    select v.object_id as square_catalog_object_id,
      v.fact->>'itemId' as square_item_id,
      v.fact->>'name' as variation_name,
      v.fact->>'sku' as sku,
      parent.fact->>'name' as item_name,
      coalesce(parent.fact->>'description', '') as description,
      case when v.fact->>'priceMinor' ~ '^(0|[1-9][0-9]*)$'
        then (v.fact->>'priceMinor')::bigint end as selling_price_minor,
      case when v.fact->>'currency' ~ '^[A-Z]{3}$'
        then v.fact->>'currency' end as currency,
      v.fact->>'pricingType' as pricing_type,
      coalesce((parent.fact->>'isArchived')::boolean, false) as is_archived
    from private.square_fact_current c
    join private.square_fact_versions v using (organization_id,fact_kind,object_id,object_version)
    left join private.square_fact_current parent_current
      on parent_current.organization_id=v.organization_id and parent_current.fact_kind='catalog'
      and parent_current.object_id=v.fact->>'itemId'
    left join private.square_fact_versions parent
      on parent.organization_id=parent_current.organization_id and parent.fact_kind=parent_current.fact_kind
      and parent.object_id=parent_current.object_id and parent.object_version=parent_current.object_version
    where c.organization_id=p_organization_id and v.fact_kind='catalog'
      and v.fact->>'objectType'='ITEM_VARIATION'
      and v.fact->>'isDeleted' is distinct from 'true'
      and (parent.fact is null or parent.fact->>'isDeleted' is distinct from 'true')
  ), active_definitions as (
    select distinct on (d.square_catalog_object_id,d.currency)
      d.square_catalog_object_id,d.name,d.sku,d.currency,d.unit_cost_minor,d.effective_from,d.version
    from public.item_definitions d
    where d.organization_id=p_organization_id and d.effective_from<=now()
      and (d.effective_until is null or d.effective_until>now())
    order by d.square_catalog_object_id,d.currency,d.effective_from desc,d.version desc
  ), listing as (
    select v.square_catalog_object_id as id,v.square_item_id as square_item_id,
      coalesce(nullif(v.item_name,''),nullif(v.variation_name,''),d.name,'Unnamed item') as item_name,
      case when nullif(v.item_name,'') is not null and nullif(v.variation_name,'') is not null
          and v.variation_name<>v.item_name then v.variation_name end as variation_name,
      v.description,
      coalesce(v.sku,d.sku) as sku,
      coalesce(v.currency,d.currency) as currency,
      v.selling_price_minor,
      v.pricing_type,
      case when d.unit_cost_minor=trunc(d.unit_cost_minor)
          and d.unit_cost_minor<1000000000000 then d.unit_cost_minor::bigint end as unit_cost_minor,
      d.effective_from as cost_effective_from,
      v.is_archived,
      'square'::text as item_kind
    from catalog_variations v
    left join lateral (
      select x.* from active_definitions x
      where x.square_catalog_object_id=v.square_catalog_object_id
        and (v.currency is null or x.currency=v.currency)
      order by (x.currency=v.currency) desc,x.effective_from desc,x.version desc
      limit 1
    ) d on true

    union all

    select d.square_catalog_object_id as id,null::text as square_item_id,
      d.name as item_name,null::text as variation_name,''::text as description,
      d.sku,d.currency,null::bigint as selling_price_minor,null::text as pricing_type,
      case when d.unit_cost_minor=trunc(d.unit_cost_minor)
          and d.unit_cost_minor<1000000000000 then d.unit_cost_minor::bigint end as unit_cost_minor,
      d.effective_from as cost_effective_from,false as is_archived,'square'::text as item_kind
    from active_definitions d
    where not exists(select 1 from catalog_variations v where v.square_catalog_object_id=d.square_catalog_object_id)

    union all

    select i.id::text as id,null::text as square_item_id,i.name as item_name,null::text as variation_name,
      ''::text as description,i.sku,i.currency,null::bigint as selling_price_minor,null::text as pricing_type,
      null::bigint as unit_cost_minor,null::timestamptz as cost_effective_from,false as is_archived,'supply'::text as item_kind
    from public.inventory_items i where i.organization_id=p_organization_id
      and exists(select 1 from public.organization_feature_flags f
        where f.organization_id=p_organization_id and f.inventory_tracking)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',q.id,'squareItemId',q.square_item_id,'itemName',q.item_name,'variationName',q.variation_name,
    'description',q.description,'sku',q.sku,'currency',q.currency,'sellingPriceMinor',q.selling_price_minor,
    'pricingType',q.pricing_type,'unitCostMinor',q.unit_cost_minor,'costEffectiveFrom',q.cost_effective_from,
    'archived',q.is_archived,'itemKind',q.item_kind
  ) order by q.item_name,q.variation_name nulls first,q.currency,q.id),'[]'::jsonb)
  into items from listing q;

  return items;
end
$$;

create table private.square_catalog_management_requests (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  idempotency_key text not null,
  request_payload jsonb not null,
  audit_event_id uuid not null references public.audit_events(id),
  created_at timestamptz not null default now(),
  primary key (organization_id,idempotency_key)
);
revoke all on table private.square_catalog_management_requests from public,anon,authenticated;
create trigger square_catalog_management_requests_append_only before update or delete
  on private.square_catalog_management_requests for each row execute function private.reject_row_change();

create or replace function public.record_square_catalog_management_event(
  p_organization_id uuid,p_idempotency_key text,p_action text,p_square_object_id text,
  p_before_state jsonb,p_after_state jsonb,p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  request_body jsonb;
  existing private.square_catalog_management_requests%rowtype;
  audit_id uuid;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner']) then
    raise exception 'Organization owner role required';
  end if;
  if not exists(select 1 from public.organization_feature_flags f
      where f.organization_id=p_organization_id and f.inventory_tracking) then
    raise exception 'FEATURE_DISABLED: inventory_tracking';
  end if;
  if length(btrim(coalesce(p_idempotency_key,''))) not between 8 and 200
     or p_action not in ('create','update','archive','restore','add_variation')
     or length(btrim(coalesce(p_square_object_id,''))) not between 1 and 200
     or jsonb_typeof(coalesce(p_before_state,'{}'::jsonb))<>'object'
     or jsonb_typeof(coalesce(p_after_state,'{}'::jsonb))<>'object'
     or octet_length(coalesce(p_before_state,'{}'::jsonb)::text)>20000
     or octet_length(coalesce(p_after_state,'{}'::jsonb)::text)>20000
     or length(btrim(coalesce(p_reason,''))) not between 10 and 1000 then
    raise exception 'Invalid Square catalog management event';
  end if;
  if not exists(select 1 from private.square_fact_current c
      where c.organization_id=p_organization_id and c.fact_kind='catalog' and c.object_id=p_square_object_id) then
    raise exception 'Square catalog object is not registered for this organization';
  end if;

  request_body:=jsonb_build_object('action',p_action,'squareObjectId',p_square_object_id,
    'before',coalesce(p_before_state,'{}'::jsonb),'after',coalesce(p_after_state,'{}'::jsonb),
    'reason',btrim(p_reason));
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_idempotency_key,0));
  select * into existing from private.square_catalog_management_requests r
   where r.organization_id=p_organization_id and r.idempotency_key=p_idempotency_key;
  if found then
    if existing.request_payload is distinct from request_body then
      raise exception 'Square catalog management key was used with different data';
    end if;
    return jsonb_build_object('auditEventId',existing.audit_event_id);
  end if;

  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,
    entity_id,before_state,after_state,reason,correlation_id)
  values(p_organization_id,actor,'human',p_action,'square_catalog_item',null,
    coalesce(p_before_state,'{}'::jsonb),
    coalesce(p_after_state,'{}'::jsonb)||jsonb_build_object('squareObjectId',p_square_object_id),
    btrim(p_reason),'square-catalog-management:'||p_idempotency_key)
  returning id into audit_id;

  insert into private.square_catalog_management_requests(organization_id,idempotency_key,request_payload,audit_event_id)
  values(p_organization_id,p_idempotency_key,request_body,audit_id);
  return jsonb_build_object('auditEventId',audit_id);
end
$$;

revoke all on function public.record_square_catalog_management_event(uuid,text,text,text,jsonb,jsonb,text) from public,anon;
grant execute on function public.record_square_catalog_management_event(uuid,text,text,text,jsonb,jsonb,text) to authenticated;
