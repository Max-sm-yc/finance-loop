-- Permission-checked, idempotent commands for Vernius-owned catalog drafts and
-- purchase orders. These records remain independent of Square until an
-- approved publication action creates a source mapping.

alter table public.purchase_orders add column location_id uuid;
alter table public.purchase_orders add constraint purchase_orders_location_fk
  foreign key (organization_id,location_id) references public.business_locations(organization_id,id);
create index purchase_orders_location_idx on public.purchase_orders(organization_id,location_id,created_at desc);

drop policy if exists purchase_orders_read on public.purchase_orders;
create policy purchase_orders_read on public.purchase_orders for select to authenticated
  using (private.has_org_permission(organization_id,'purchases.read',location_id));
drop policy if exists purchase_order_lines_read on public.purchase_order_lines;
create policy purchase_order_lines_read on public.purchase_order_lines for select to authenticated
  using (exists(select 1 from public.purchase_orders p where p.organization_id=purchase_order_lines.organization_id
    and p.id=purchase_order_lines.purchase_order_id
    and private.has_org_permission(p.organization_id,'purchases.read',p.location_id)));

create table public.domain_command_idempotency (
  organization_id uuid not null references public.organizations(id),
  command_type text not null check (command_type in ('catalog_item.draft_create','purchase_order.draft_create')),
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid not null references auth.users(id),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (organization_id,command_type,idempotency_key)
);
alter table public.domain_command_idempotency enable row level security;
revoke all on public.domain_command_idempotency from public,anon,authenticated,service_role;

create or replace function public.create_domain_catalog_item(
  p_organization_id uuid,p_item jsonb,p_reason text,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  request_hash text;
  prior public.domain_command_idempotency%rowtype;
  category_value uuid;
  item_id uuid;
  variation jsonb;
  variation_id uuid;
  variation_ids jsonb := '[]'::jsonb;
  variation_name text;
  variation_sku text;
  variation_barcode text;
  unit_value text;
  price_value bigint;
  currency_value text;
  created_result jsonb;
begin
  if actor is null then raise exception 'Authentication required'; end if;
  if not private.has_org_permission(p_organization_id,'catalog.write') then raise exception 'Catalog write permission required'; end if;
  if p_item is null or jsonb_typeof(p_item)<>'object'
      or exists(select 1 from jsonb_object_keys(p_item) as key_list(key_name) where key_name not in ('name','description','categoryId','variations'))
      or not (p_item ? 'name') or not (p_item ? 'variations')
      or jsonb_typeof(p_item->'name')<>'string' or length(btrim(p_item->>'name')) not between 1 and 200
      or (p_item ? 'description' and jsonb_typeof(p_item->'description') not in ('string','null'))
      or length(coalesce(p_item->>'description',''))>4096
      or jsonb_typeof(p_item->'variations')<>'array' or jsonb_array_length(p_item->'variations') not between 1 and 250
      or length(btrim(coalesce(p_reason,''))) not between 10 and 1000
      or length(coalesce(p_idempotency_key,'')) not between 8 and 200
      or p_idempotency_key !~ '^[A-Za-z0-9_:./-]+$' then
    raise exception 'Invalid draft catalog item';
  end if;
  if p_item->'categoryId' is not null and p_item->'categoryId'<>'null'::jsonb then
    if jsonb_typeof(p_item->'categoryId')<>'string' then raise exception 'Invalid catalog category'; end if;
    category_value:=(p_item->>'categoryId')::uuid;
    if not exists(select 1 from public.catalog_categories c where c.organization_id=p_organization_id and c.id=category_value and c.status='active') then
      raise exception 'Catalog category not found';
    end if;
  end if;

  request_hash:=private.sha256_hex(jsonb_build_object('item',p_item,'reason',btrim(p_reason))::text);
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':catalog_item.draft_create:'||p_idempotency_key,0));
  select * into prior from public.domain_command_idempotency d where d.organization_id=p_organization_id
    and d.command_type='catalog_item.draft_create' and d.idempotency_key=p_idempotency_key;
  if found then
    if prior.request_hash<>request_hash or prior.actor_user_id<>actor then raise exception 'Idempotency key collision'; end if;
    return prior.result;
  end if;

  insert into public.catalog_items(organization_id,category_id,name,description,status,created_by,updated_by)
    values(p_organization_id,category_value,btrim(p_item->>'name'),coalesce(p_item->>'description',''),'draft',actor,actor)
    returning id into item_id;
  for variation in select value from jsonb_array_elements(p_item->'variations') loop
    if jsonb_typeof(variation)<>'object'
        or exists(select 1 from jsonb_object_keys(variation) as key_list(key_name) where key_name not in ('name','sku','barcode','unitOfMeasure','priceMinor','currency'))
        or not (variation ? 'name') or jsonb_typeof(variation->'name')<>'string'
        or length(btrim(variation->>'name')) not between 1 and 200
        or (variation ? 'sku' and jsonb_typeof(variation->'sku') not in ('string','null'))
        or (variation ? 'barcode' and jsonb_typeof(variation->'barcode') not in ('string','null'))
        or (variation ? 'unitOfMeasure' and jsonb_typeof(variation->'unitOfMeasure') not in ('string','null')) then
      raise exception 'Invalid draft catalog variation';
    end if;
    variation_name:=btrim(variation->>'name');
    variation_sku:=nullif(btrim(coalesce(variation->>'sku','')),'');
    variation_barcode:=nullif(btrim(coalesce(variation->>'barcode','')),'');
    unit_value:=coalesce(nullif(btrim(variation->>'unitOfMeasure'),''),'each');
    if length(coalesce(variation_sku,''))>100 or length(coalesce(variation_barcode,''))>200 or length(unit_value)>40 then
      raise exception 'Invalid draft catalog variation';
    end if;
    if (variation->>'priceMinor') is null and (variation->>'currency') is null then
      price_value:=null; currency_value:=null;
    elsif jsonb_typeof(variation->'priceMinor')='number' and jsonb_typeof(variation->'currency')='string'
        and coalesce(variation->>'priceMinor','') ~ '^[0-9]+$'
        and (variation->>'priceMinor')::numeric<=9007199254740991
        and coalesce(variation->>'currency','') ~ '^[A-Z]{3}$' then
      if not private.has_org_permission(p_organization_id,'catalog.price.write') then raise exception 'Catalog price write permission required'; end if;
      price_value:=(variation->>'priceMinor')::bigint; currency_value:=variation->>'currency';
    else
      raise exception 'Invalid draft catalog variation price or currency';
    end if;
    insert into public.catalog_variations(organization_id,item_id,name,sku,barcode,unit_of_measure,price_minor,currency,status,created_by,updated_by)
      values(p_organization_id,item_id,variation_name,variation_sku,variation_barcode,unit_value,price_value,currency_value,'draft',actor,actor)
      returning id into variation_id;
    variation_ids:=variation_ids||jsonb_build_array(variation_id);
  end loop;

  insert into public.domain_source_mappings(organization_id,provider,source_type,source_id,entity_type,entity_id,source_version,source_hash,
    ingestion_actor_kind,originating_user_id,active)
  values(p_organization_id,'vernius','catalog_item',item_id::text,'catalog_item',item_id,'1',request_hash,'human',actor,true);
  created_result:=jsonb_build_object('itemId',item_id,'variationIds',variation_ids,'status','draft','revision',1);
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,after_state,reason,correlation_id,execution_status)
  values(p_organization_id,actor,'human','domain.catalog_item.draft_create','catalog_item',item_id,
    jsonb_build_object('name',btrim(p_item->>'name'),'description',coalesce(p_item->>'description',''),'categoryId',category_value,
      'status','draft','variationIds',variation_ids),btrim(p_reason),'domain-command:catalog_item:'||request_hash,'succeeded');
  insert into public.domain_command_idempotency(organization_id,command_type,idempotency_key,request_hash,actor_user_id,result)
    values(p_organization_id,'catalog_item.draft_create',p_idempotency_key,request_hash,actor,created_result);
  return created_result;
end
$$;

create or replace function public.list_domain_purchase_orders(p_organization_id uuid,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not exists(select 1 from public.memberships m where m.organization_id=p_organization_id and m.user_id=(select auth.uid())) then
    raise exception 'Purchase order membership required';
  end if;
  if not private.has_org_permission(p_organization_id,'purchases.read') and not exists(
    select 1 from public.membership_location_scopes s where s.organization_id=p_organization_id and s.user_id=(select auth.uid())
      and private.has_org_permission(p_organization_id,'purchases.read',s.location_id)
  ) then raise exception 'Purchase read permission required'; end if;
  if p_limit not between 1 and 500 then raise exception 'Invalid purchase order limit'; end if;
  select coalesce(jsonb_agg(x.entry_value order by x.created_at desc),'[]'::jsonb) into result from (
    select p.created_at,jsonb_build_object('id',p.id,'supplierId',p.supplier_id,'locationId',p.location_id,'status',p.status,
      'currency',p.currency,'orderedAt',p.ordered_at,'expectedAt',p.expected_at,'revision',p.revision,'createdAt',p.created_at,
      'lines',coalesce(l.rows,'[]'::jsonb)) entry_value
    from public.purchase_orders p left join lateral (
      select jsonb_agg(jsonb_build_object('lineNumber',pl.line_number,'variationId',pl.variation_id,'description',pl.description,
        'quantity',pl.quantity,'unitCostMinor',pl.unit_cost_minor,'currency',pl.currency,'receivedQuantity',pl.received_quantity)
        order by pl.line_number) rows
      from public.purchase_order_lines pl where pl.organization_id=p.organization_id and pl.purchase_order_id=p.id
    ) l on true
    where p.organization_id=p_organization_id and private.has_org_permission(p_organization_id,'purchases.read',p.location_id)
    order by p.created_at desc,p.id limit p_limit
  ) x;
  return result;
end
$$;

create or replace function public.create_domain_purchase_order(
  p_organization_id uuid,p_purchase_order jsonb,p_reason text,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  request_hash text;
  prior public.domain_command_idempotency%rowtype;
  supplier_value uuid;
  location_value uuid;
  order_currency text;
  expected_value timestamptz;
  order_id uuid;
  line jsonb;
  line_number_value integer:=0;
  quantity_value numeric;
  unit_cost_value bigint;
  variation_value uuid;
  description_value text;
  created_result jsonb;
begin
  if actor is null then raise exception 'Authentication required'; end if;
  if p_purchase_order is null or jsonb_typeof(p_purchase_order)<>'object'
      or exists(select 1 from jsonb_object_keys(p_purchase_order) as key_list(key_name) where key_name not in ('supplierId','locationId','currency','expectedAt','lines'))
      or not (p_purchase_order ? 'currency') or not (p_purchase_order ? 'lines')
      or coalesce(p_purchase_order->>'currency','') !~ '^[A-Z]{3}$'
      or jsonb_typeof(p_purchase_order->'lines')<>'array' or jsonb_array_length(p_purchase_order->'lines') not between 1 and 500
      or length(btrim(coalesce(p_reason,''))) not between 10 and 1000
      or length(coalesce(p_idempotency_key,'')) not between 8 and 200
      or p_idempotency_key !~ '^[A-Za-z0-9_:./-]+$' then
    raise exception 'Invalid purchase order';
  end if;
  order_currency:=p_purchase_order->>'currency';
  supplier_value:=case when nullif(p_purchase_order->>'supplierId','') is null then null else (p_purchase_order->>'supplierId')::uuid end;
  location_value:=case when nullif(p_purchase_order->>'locationId','') is null then null else (p_purchase_order->>'locationId')::uuid end;
  if not private.has_org_permission(p_organization_id,'purchases.write',location_value) then raise exception 'Purchase write permission required'; end if;
  if supplier_value is not null and not exists(select 1 from public.suppliers s where s.organization_id=p_organization_id and s.id=supplier_value and s.status='active') then
    raise exception 'Supplier not found';
  end if;
  if location_value is not null and not exists(select 1 from public.business_locations l where l.organization_id=p_organization_id and l.id=location_value and l.status='active') then
    raise exception 'Purchase location not found';
  end if;
  expected_value:=case when nullif(p_purchase_order->>'expectedAt','') is null then null else (p_purchase_order->>'expectedAt')::timestamptz end;
  request_hash:=private.sha256_hex(jsonb_build_object('purchaseOrder',p_purchase_order,'reason',btrim(p_reason))::text);
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':purchase_order.draft_create:'||p_idempotency_key,0));
  select * into prior from public.domain_command_idempotency d where d.organization_id=p_organization_id
    and d.command_type='purchase_order.draft_create' and d.idempotency_key=p_idempotency_key;
  if found then
    if prior.request_hash<>request_hash or prior.actor_user_id<>actor then raise exception 'Idempotency key collision'; end if;
    return prior.result;
  end if;

  insert into public.purchase_orders(organization_id,supplier_id,location_id,status,currency,expected_at,created_by)
    values(p_organization_id,supplier_value,location_value,'draft',order_currency,expected_value,actor) returning id into order_id;
  for line in select value from jsonb_array_elements(p_purchase_order->'lines') loop
    line_number_value:=line_number_value+1;
    if jsonb_typeof(line)<>'object' or exists(select 1 from jsonb_object_keys(line) as key_list(key_name) where key_name not in ('variationId','description','quantity','unitCostMinor'))
        or not (line ? 'description') or not (line ? 'quantity')
        or jsonb_typeof(line->'description')<>'string' or length(btrim(line->>'description')) not between 1 and 500
        or jsonb_typeof(line->'quantity')<>'number' then raise exception 'Invalid purchase order line'; end if;
    quantity_value:=(line->>'quantity')::numeric;
    if quantity_value<=0 or quantity_value>999999999999.999999 or quantity_value<>trunc(quantity_value,6) then raise exception 'Invalid purchase order quantity'; end if;
    description_value:=btrim(line->>'description');
    variation_value:=case when nullif(line->>'variationId','') is null then null else (line->>'variationId')::uuid end;
    if variation_value is not null and not exists(select 1 from public.catalog_variations v join public.catalog_items i
        on i.organization_id=v.organization_id and i.id=v.item_id where v.organization_id=p_organization_id and v.id=variation_value and v.status<>'archived' and i.status<>'archived') then
      raise exception 'Purchase variation not found';
    end if;
    if line->'unitCostMinor' is null or line->'unitCostMinor'='null'::jsonb then
      unit_cost_value:=null;
    elsif jsonb_typeof(line->'unitCostMinor')='number' and coalesce(line->>'unitCostMinor','') ~ '^[0-9]+$'
        and (line->>'unitCostMinor')::numeric<=9007199254740991 then
      unit_cost_value:=(line->>'unitCostMinor')::bigint;
    else
      raise exception 'Invalid purchase unit cost';
    end if;
    insert into public.purchase_order_lines(organization_id,purchase_order_id,line_number,variation_id,description,quantity,unit_cost_minor,currency)
      values(p_organization_id,order_id,line_number_value,variation_value,description_value,quantity_value,unit_cost_value,order_currency);
  end loop;
  insert into public.domain_source_mappings(organization_id,provider,source_type,source_id,entity_type,entity_id,source_version,source_hash,
    ingestion_actor_kind,originating_user_id,active)
  values(p_organization_id,'vernius','purchase_order',order_id::text,'purchase_order',order_id,'1',request_hash,'human',actor,true);
  created_result:=jsonb_build_object('purchaseOrderId',order_id,'status','draft','revision',1,'lineCount',line_number_value);
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,after_state,reason,correlation_id,execution_status)
  values(p_organization_id,actor,'human','domain.purchase_order.draft_create','purchase_order',order_id,
    jsonb_build_object('supplierId',supplier_value,'locationId',location_value,'currency',order_currency,'expectedAt',expected_value,
      'status','draft','lineCount',line_number_value),btrim(p_reason),'domain-command:purchase_order:'||request_hash,'succeeded');
  insert into public.domain_command_idempotency(organization_id,command_type,idempotency_key,request_hash,actor_user_id,result)
    values(p_organization_id,'purchase_order.draft_create',p_idempotency_key,request_hash,actor,created_result);
  return created_result;
end
$$;

revoke all on function public.create_domain_catalog_item(uuid,jsonb,text,text) from public,anon;
revoke all on function public.list_domain_purchase_orders(uuid,integer) from public,anon;
revoke all on function public.create_domain_purchase_order(uuid,jsonb,text,text) from public,anon;
grant execute on function public.create_domain_catalog_item(uuid,jsonb,text,text) to authenticated;
grant execute on function public.list_domain_purchase_orders(uuid,integer) to authenticated;
grant execute on function public.create_domain_purchase_order(uuid,jsonb,text,text) to authenticated;
