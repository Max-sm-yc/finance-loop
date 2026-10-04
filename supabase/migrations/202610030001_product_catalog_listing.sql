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
      v.fact->>'name' as variation_name,
      v.fact->>'sku' as sku,
      parent.fact->>'name' as item_name,
      case when v.fact->>'priceMinor' ~ '^(0|[1-9][0-9]*)$'
        then (v.fact->>'priceMinor')::bigint end as selling_price_minor,
      case when v.fact->>'currency' ~ '^[A-Z]{3}$'
        then v.fact->>'currency' end as currency,
      v.fact->>'pricingType' as pricing_type
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
    select v.square_catalog_object_id as id,
      coalesce(nullif(v.item_name,''),nullif(v.variation_name,''),d.name,'Unnamed item') as item_name,
      case when nullif(v.item_name,'') is not null and nullif(v.variation_name,'') is not null
          and v.variation_name<>v.item_name then v.variation_name end as variation_name,
      coalesce(v.sku,d.sku) as sku,
      coalesce(v.currency,d.currency) as currency,
      v.selling_price_minor,
      v.pricing_type,
      case when d.unit_cost_minor=trunc(d.unit_cost_minor)
          and d.unit_cost_minor<1000000000000 then d.unit_cost_minor::bigint end as unit_cost_minor,
      d.effective_from as cost_effective_from,
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

    select d.square_catalog_object_id as id,d.name as item_name,null::text as variation_name,
      d.sku,d.currency,null::bigint as selling_price_minor,null::text as pricing_type,
      case when d.unit_cost_minor=trunc(d.unit_cost_minor)
          and d.unit_cost_minor<1000000000000 then d.unit_cost_minor::bigint end as unit_cost_minor,
      d.effective_from as cost_effective_from,'square'::text as item_kind
    from active_definitions d
    where not exists(select 1 from catalog_variations v where v.square_catalog_object_id=d.square_catalog_object_id)

    union all

    select i.id::text as id,i.name as item_name,null::text as variation_name,i.sku,i.currency,
      null::bigint as selling_price_minor,null::text as pricing_type,null::bigint as unit_cost_minor,
      null::timestamptz as cost_effective_from,'supply'::text as item_kind
    from public.inventory_items i where i.organization_id=p_organization_id
      and exists(select 1 from public.organization_feature_flags f
        where f.organization_id=p_organization_id and f.inventory_tracking)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',q.id,'itemName',q.item_name,'variationName',q.variation_name,'sku',q.sku,
    'currency',q.currency,'sellingPriceMinor',q.selling_price_minor,'pricingType',q.pricing_type,
    'unitCostMinor',q.unit_cost_minor,'costEffectiveFrom',q.cost_effective_from,
    'itemKind',q.item_kind
  ) order by q.item_name,q.variation_name nulls first,q.currency,q.id),'[]'::jsonb)
  into items from listing q;

  return items;
end
$$;

revoke all on function public.get_product_catalog_items(uuid) from public,anon;
grant execute on function public.get_product_catalog_items(uuid) to authenticated;
