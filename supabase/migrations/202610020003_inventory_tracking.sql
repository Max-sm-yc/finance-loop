-- Staged inventory and product analytics persistence. Both capabilities stay
-- disabled for every organization until an operator changes the database flag.
create table public.organization_feature_flags (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  inventory_tracking boolean not null default false,
  product_analytics boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.organization_feature_flags (organization_id)
select id from public.organizations on conflict do nothing;
create unique index if not exists item_definitions_organization_id_id_idx
  on public.item_definitions(organization_id,id);
create or replace function private.initialize_organization_features()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.organization_feature_flags (organization_id) values (new.id) on conflict do nothing;
  return new;
end $$;
revoke all on function private.initialize_organization_features() from public,anon,authenticated;
create trigger organizations_initialize_features after insert on public.organizations
  for each row execute function private.initialize_organization_features();
alter table public.organization_feature_flags enable row level security;
revoke all on public.organization_feature_flags from public,anon,authenticated;
grant select on public.organization_feature_flags to authenticated;
create policy organization_feature_flags_read on public.organization_feature_flags
  for select to authenticated using (public.is_org_member(organization_id));

-- Manual supply SKUs are inventory identities only; they are never assigned
-- invented Square catalog IDs or used as a cost mapping for Square sales.
create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  sku text not null check (length(btrim(sku)) between 1 and 100),
  name text not null check (length(btrim(name)) between 1 and 256),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  evidence_file_id uuid not null,
  reason text not null check (length(btrim(reason)) >= 10),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (organization_id,id),
  foreign key (organization_id,evidence_file_id) references public.evidence_files(organization_id,id)
);
create unique index inventory_items_org_sku_ci_idx on public.inventory_items(organization_id,lower(btrim(sku)));
alter table public.inventory_items enable row level security;
revoke all on public.inventory_items from public,anon,authenticated;
grant select on public.inventory_items to authenticated;
create policy inventory_items_read on public.inventory_items for select to authenticated
  using (public.is_org_member(organization_id) and exists(select 1 from public.organization_feature_flags f
    where f.organization_id=inventory_items.organization_id and f.inventory_tracking));
create trigger inventory_items_append_only before update or delete on public.inventory_items
  for each row execute function private.reject_row_change();
create or replace function private.audit_inventory_item()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,
    after_state,reason,correlation_id)
  values(new.organization_id,new.created_by,'human','insert','inventory_item',new.id,
    jsonb_build_object('sku',new.sku,'name',new.name,'currency',new.currency,'evidenceFileId',new.evidence_file_id),
    new.reason,new.id::text);
  return new;
end $$;
revoke all on function private.audit_inventory_item() from public,anon,authenticated;
create trigger inventory_items_audit after insert on public.inventory_items
  for each row execute function private.audit_inventory_item();

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  item_definition_id uuid,
  inventory_item_id uuid,
  item_name text not null check (length(btrim(item_name)) between 1 and 256),
  square_catalog_object_id text,
  movement_type text not null check (movement_type in ('purchase_receipt','manual_correction','opening_balance')),
  quantity_delta numeric(18,6) not null,
  unit_cost_minor bigint,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz not null,
  cash_movement_id uuid,
  evidence_file_id uuid not null,
  reason text not null check (length(btrim(reason)) >= 10),
  idempotency_key text not null check (length(btrim(idempotency_key)) >= 8),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (organization_id,id),
  unique (organization_id,idempotency_key),
  foreign key (organization_id,item_definition_id)
    references public.item_definitions(organization_id,id),
  foreign key (organization_id,inventory_item_id)
    references public.inventory_items(organization_id,id),
  foreign key (organization_id,evidence_file_id)
    references public.evidence_files(organization_id,id),
  foreign key (organization_id,cash_movement_id)
    references public.cash_movements(organization_id,id),
  check ((item_definition_id is not null and inventory_item_id is null and square_catalog_object_id is not null)
    or (item_definition_id is null and inventory_item_id is not null and square_catalog_object_id is null)),
  check ((movement_type='purchase_receipt' and quantity_delta > 0 and unit_cost_minor is not null
      and unit_cost_minor between 0 and 999999999999 and cash_movement_id is not null)
    or (movement_type='manual_correction' and quantity_delta<>0 and unit_cost_minor is null and cash_movement_id is null)
    or (movement_type='opening_balance' and quantity_delta >= 0 and unit_cost_minor is null and cash_movement_id is null)),
  check (quantity_delta=trunc(quantity_delta) and abs(quantity_delta)<=1000000)
);
create index inventory_movements_item_time_idx
  on public.inventory_movements(organization_id,item_definition_id,occurred_at,id);
create unique index inventory_one_receipt_per_purchase_line
  on public.inventory_movements(organization_id,cash_movement_id,idempotency_key)
  where movement_type='purchase_receipt';
create unique index inventory_one_opening_per_catalog_item
  on public.inventory_movements(organization_id,square_catalog_object_id)
  where movement_type='opening_balance';
create unique index inventory_one_opening_per_manual_item
  on public.inventory_movements(organization_id,inventory_item_id)
  where movement_type='opening_balance' and inventory_item_id is not null;
alter table public.inventory_movements enable row level security;
revoke all on public.inventory_movements from public,anon,authenticated;
grant select on public.inventory_movements to authenticated;
create policy inventory_movements_read on public.inventory_movements
  for select to authenticated using (public.is_org_member(organization_id)
    and exists (select 1 from public.organization_feature_flags f
      where f.organization_id=inventory_movements.organization_id and f.inventory_tracking));
create trigger inventory_movements_append_only before update or delete on public.inventory_movements
  for each row execute function private.reject_row_change();
create trigger inventory_movements_period_guard before insert on public.inventory_movements
  for each row execute function private.reject_closed_period_write();
create or replace function private.audit_inventory_movement()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,
    before_state,after_state,reason,correlation_id)
  values(new.organization_id,new.created_by,'human','insert','inventory_movement',new.id,null,
    to_jsonb(new),new.reason,new.id::text);
  return new;
end $$;
revoke all on function private.audit_inventory_movement() from public,anon,authenticated;
create trigger inventory_movements_audit after insert on public.inventory_movements
  for each row execute function private.audit_inventory_movement();

create table private.inventory_requests (
  organization_id uuid not null references public.organizations(id),
  idempotency_key text not null,
  request_payload jsonb not null,
  entity_type text not null check (entity_type in ('purchase','correction','opening','item')),
  cash_movement_id uuid,
  movement_ids uuid[] not null,
  projection_job_id uuid references private.durable_jobs(id),
  primary key (organization_id,idempotency_key)
);
revoke all on private.inventory_requests from public,anon,authenticated;
create trigger inventory_requests_append_only before update or delete on private.inventory_requests
  for each row execute function private.reject_row_change();

create or replace function private.inventory_period_is_open(org uuid, event_time timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.accounting_periods p where p.organization_id=org
    and p.status='closed' and event_time >= p.starts_at and event_time < p.ends_at)
$$;
revoke all on function private.inventory_period_is_open(uuid,timestamptz) from public,anon,authenticated;

create or replace function public.record_inventory_item(
  p_organization_id uuid,p_sku text,p_name text,p_currency text,p_evidence_file_id uuid,
  p_reason text,p_idempotency_key text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  payload jsonb;
  existing private.inventory_requests%rowtype;
  result_id uuid;
begin
  if not private.has_org_role(p_organization_id,array['owner','reviewer']) then raise exception 'Organization owner or reviewer role required'; end if;
  if actor is null then raise exception 'Organization owner or reviewer role required'; end if;
  if not exists(select 1 from public.organization_feature_flags f where f.organization_id=p_organization_id and f.inventory_tracking)
    then raise exception 'FEATURE_DISABLED: inventory_tracking'; end if;
  if p_sku is null or length(btrim(p_sku)) not between 1 and 100 or p_name is null or length(btrim(p_name)) not between 1 and 256
     or p_currency is null or p_currency !~ '^[A-Z]{3}$' or length(btrim(coalesce(p_reason,'')))<10
     or length(btrim(coalesce(p_idempotency_key,'')))<8
     or not exists(select 1 from public.evidence_files e where e.organization_id=p_organization_id and e.id=p_evidence_file_id) then
    raise exception 'Invalid inventory item'; end if;
  payload:=jsonb_build_object('sku',btrim(p_sku),'name',btrim(p_name),'currency',p_currency,
    'evidenceFileId',p_evidence_file_id,'reason',btrim(p_reason));
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_idempotency_key,0));
  select * into existing from private.inventory_requests r where r.organization_id=p_organization_id and r.idempotency_key=p_idempotency_key;
  if found then
    if existing.request_payload is distinct from payload or existing.entity_type<>'item' then raise exception 'Inventory item idempotency key was used with different data'; end if;
    return existing.movement_ids[1];
  end if;
  insert into public.inventory_items(organization_id,sku,name,currency,evidence_file_id,reason,created_by)
    values(p_organization_id,btrim(p_sku),btrim(p_name),p_currency,p_evidence_file_id,btrim(p_reason),actor)
    returning id into result_id;
  insert into private.inventory_requests(organization_id,idempotency_key,request_payload,entity_type,cash_movement_id,movement_ids)
    values(p_organization_id,p_idempotency_key,payload,'item',null,array[result_id]);
  return result_id;
end $$;

create or replace function public.record_inventory_purchase(
  p_organization_id uuid,p_account_id uuid,p_amount_minor bigint,p_currency text,
  p_occurred_at timestamptz,p_description text,p_evidence_file_id uuid,
  p_idempotency_key text,p_lines jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  item jsonb;
  def public.item_definitions%rowtype;
  manual_item public.inventory_items%rowtype;
  cash_id uuid;
  move_id uuid;
  move_ids uuid[] := array[]::uuid[];
  request_body jsonb;
  old_request private.inventory_requests%rowtype;
  account_currency char(3);
  cost_total numeric := 0;
  line_count integer := 0;
  line_number integer := 0;
  line_key text;
  projection_job_id uuid;
  current_revision bigint;
  org_timezone text;
  replay_start timestamptz;
  replay_end timestamptz;
begin
  if not private.has_org_role(p_organization_id,array['owner','operator']) then raise exception 'Organization operator role required'; end if;
  if not exists (select 1 from public.organization_feature_flags f where f.organization_id=p_organization_id and f.inventory_tracking)
    then raise exception 'FEATURE_DISABLED: inventory_tracking'; end if;
  if actor is null then raise exception 'Organization operator role required'; end if;
  if p_amount_minor is null or p_amount_minor >= 0 or p_amount_minor < -1000000000000
     or p_currency is null or p_currency !~ '^[A-Z]{3}$' or p_occurred_at is null
     or length(btrim(coalesce(p_description,''))) not between 1 and 500
     or length(btrim(coalesce(p_idempotency_key,''))) < 8 or p_lines is null or jsonb_typeof(p_lines)<>'array'
     or jsonb_array_length(p_lines)<1 or jsonb_array_length(p_lines)>100 then raise exception 'Invalid inventory purchase'; end if;
  if not private.inventory_period_is_open(p_organization_id,p_occurred_at) then raise exception 'PERIOD_CLOSED'; end if;
  if not exists (select 1 from public.evidence_files e where e.organization_id=p_organization_id and e.id=p_evidence_file_id) then raise exception 'Organization evidence file required'; end if;
  select a.currency into account_currency from public.accounts a where a.organization_id=p_organization_id and a.id=p_account_id and a.active;
  if not found or account_currency<>p_currency then raise exception 'Account not found or currency does not match'; end if;
  for item in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(item)<>'object' or (select count(*) from jsonb_object_keys(item))<>4 or not (item ?& array['itemId','itemName','quantity','unitCostMinor'])
       or (item->>'itemId') is null or (item->>'itemName') is null or (item->>'quantity') is null
       or (item->>'unitCostMinor') is null or (item->>'quantity') !~ '^([0-9]+)(\.[0-9]{1,6})?$'
       or (item->>'quantity') !~ '^[0-9]+$' or (item->>'unitCostMinor') !~ '^[0-9]+$' then raise exception 'Invalid inventory purchase line'; end if;
    select * into def from public.item_definitions d where d.organization_id=p_organization_id
      and d.id=(item->>'itemId')::uuid and d.currency=p_currency and d.effective_from<=p_occurred_at
      and (d.effective_until is null or d.effective_until>p_occurred_at) order by d.effective_from desc limit 1;
    if found then
      if btrim(item->>'itemName')<>btrim(def.name) then raise exception 'Item definition does not match organization, name, currency, or date'; end if;
    else
      select * into manual_item from public.inventory_items i where i.organization_id=p_organization_id
        and i.id=(item->>'itemId')::uuid and i.currency=p_currency;
      if not found or btrim(item->>'itemName')<>btrim(manual_item.name) then raise exception 'Inventory item does not match organization, name, or currency'; end if;
    end if;
    if (item->>'quantity')::numeric<=0 or (item->>'quantity')::numeric>1000000 or (item->>'unitCostMinor')::numeric>999999999999 then raise exception 'Invalid quantity or unit cost'; end if;
    cost_total := cost_total + (item->>'quantity')::numeric*(item->>'unitCostMinor')::numeric;
    line_count := line_count+1;
  end loop;
  if cost_total > abs(p_amount_minor) then raise exception 'Inventory acquisition subtotal exceeds purchase cash outflow'; end if;
  request_body := jsonb_build_object('accountId',p_account_id,'amountMinor',p_amount_minor,'currency',p_currency,'occurredAt',p_occurred_at,'description',btrim(p_description),'evidenceFileId',p_evidence_file_id,'lines',p_lines);
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_idempotency_key,0));
  select * into old_request from private.inventory_requests r where r.organization_id=p_organization_id and r.idempotency_key=p_idempotency_key;
  if found then
    if old_request.request_payload is distinct from request_body or old_request.entity_type<>'purchase' then raise exception 'Inventory idempotency key was used with different data'; end if;
    return jsonb_build_object('cashMovementId',old_request.cash_movement_id,'inventoryMovementIds',old_request.movement_ids,
      'projectionJobId',old_request.projection_job_id);
  end if;
  insert into public.cash_movements(organization_id,account_id,kind,amount_minor,currency,occurred_at,description,evidence_ref,evidence_file_id,created_by,idempotency_key,approval_status)
  values(p_organization_id,p_account_id,'purchase',p_amount_minor,p_currency,p_occurred_at,btrim(p_description),p_evidence_file_id::text,p_evidence_file_id,actor,'inventory:'||p_idempotency_key,'approved') returning id into cash_id;
  for item in select value from jsonb_array_elements(p_lines) loop
    select * into def from public.item_definitions d where d.organization_id=p_organization_id and d.id=(item->>'itemId')::uuid and d.currency=p_currency and d.effective_from<=p_occurred_at and (d.effective_until is null or d.effective_until>p_occurred_at) order by d.effective_from desc limit 1;
    line_key := 'inventory:'||p_idempotency_key||':'||line_number::text;
    if found then
      insert into public.inventory_movements(organization_id,item_definition_id,inventory_item_id,item_name,square_catalog_object_id,movement_type,quantity_delta,unit_cost_minor,currency,occurred_at,cash_movement_id,evidence_file_id,reason,idempotency_key,created_by)
      values(p_organization_id,def.id,null,btrim(def.name),def.square_catalog_object_id,'purchase_receipt',(item->>'quantity')::numeric,(item->>'unitCostMinor')::bigint,p_currency,p_occurred_at,cash_id,p_evidence_file_id,'Inventory received with purchase: '||left(btrim(p_description),350),line_key,actor) returning id into move_id;
    else
      select * into manual_item from public.inventory_items i where i.organization_id=p_organization_id and i.id=(item->>'itemId')::uuid and i.currency=p_currency;
      insert into public.inventory_movements(organization_id,item_definition_id,inventory_item_id,item_name,square_catalog_object_id,movement_type,quantity_delta,unit_cost_minor,currency,occurred_at,cash_movement_id,evidence_file_id,reason,idempotency_key,created_by)
      values(p_organization_id,null,manual_item.id,btrim(manual_item.name),null,'purchase_receipt',(item->>'quantity')::numeric,(item->>'unitCostMinor')::bigint,p_currency,p_occurred_at,cash_id,p_evidence_file_id,'Inventory received with purchase: '||left(btrim(p_description),350),line_key,actor) returning id into move_id;
    end if;
    move_ids := array_append(move_ids,move_id);
    line_number := line_number+1;
  end loop;
  select o.timezone into org_timezone from public.organizations o where o.id=p_organization_id;
  replay_start := date_trunc('month',p_occurred_at at time zone org_timezone) at time zone org_timezone;
  replay_end := (date_trunc('month',p_occurred_at at time zone org_timezone)+interval '1 month') at time zone org_timezone;
  select coalesce(s.source_revision,0) into current_revision from private.square_worker_state s where s.organization_id=p_organization_id;
  current_revision:=coalesce(current_revision,0);
  insert into private.durable_jobs(organization_id,requested_by,job_type,idempotency_key,payload)
  values(p_organization_id,actor,'projection.replay','inventory-purchase:'||p_idempotency_key,
    jsonb_build_object('sourceRevision',current_revision,'startAt',replay_start,'endAt',replay_end,'requestedBy',actor))
  on conflict (job_type,organization_id,idempotency_key) where organization_id is not null do nothing returning id into projection_job_id;
  if projection_job_id is null then
    select j.id into projection_job_id from private.durable_jobs j where j.organization_id=p_organization_id
      and j.job_type='projection.replay' and j.idempotency_key='inventory-purchase:'||p_idempotency_key
      and (j.payload->>'startAt')::timestamptz is not distinct from replay_start
      and (j.payload->>'endAt')::timestamptz is not distinct from replay_end;
    if projection_job_id is null then raise exception 'Inventory purchase replay key collision'; end if;
  end if;
  insert into private.inventory_requests(organization_id,idempotency_key,request_payload,entity_type,cash_movement_id,movement_ids,projection_job_id)
  values(p_organization_id,p_idempotency_key,request_body,'purchase',cash_id,move_ids,projection_job_id);
  return jsonb_build_object('cashMovementId',cash_id,'inventoryMovementIds',move_ids,'projectionJobId',projection_job_id);
end $$;

create or replace function public.record_inventory_correction(
  p_organization_id uuid,p_item_id uuid,p_quantity_delta numeric,p_occurred_at timestamptz,
  p_reason text,p_evidence_file_id uuid,p_idempotency_key text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  def public.item_definitions%rowtype;
  manual_item public.inventory_items%rowtype;
  item_name_value text;
  catalog_id_value text;
  item_currency_value char(3);
  existing private.inventory_requests%rowtype;
  request_body jsonb;
  result_id uuid;
begin
  if not private.has_org_role(p_organization_id,array['owner','reviewer']) then raise exception 'Organization owner or reviewer role required'; end if;
  if not exists (select 1 from public.organization_feature_flags f where f.organization_id=p_organization_id and f.inventory_tracking)
    then raise exception 'FEATURE_DISABLED: inventory_tracking'; end if;
  if actor is null then raise exception 'Organization owner or reviewer role required'; end if;
  if p_quantity_delta is null or p_quantity_delta=0 or abs(p_quantity_delta)>1000000 or p_quantity_delta<>trunc(p_quantity_delta)
     or p_occurred_at is null or length(btrim(coalesce(p_reason,'')))<10 or length(btrim(coalesce(p_idempotency_key,'')))<8
     or not exists(select 1 from public.evidence_files e where e.organization_id=p_organization_id and e.id=p_evidence_file_id) then raise exception 'Invalid inventory correction'; end if;
  if not private.inventory_period_is_open(p_organization_id,p_occurred_at) then raise exception 'PERIOD_CLOSED'; end if;
  select * into def from public.item_definitions d where d.organization_id=p_organization_id and d.id=p_item_id and d.effective_from<=p_occurred_at and (d.effective_until is null or d.effective_until>p_occurred_at) order by d.effective_from desc limit 1;
  if found then
    item_name_value:=def.name; catalog_id_value:=def.square_catalog_object_id; item_currency_value:=def.currency;
  else
    select * into manual_item from public.inventory_items i where i.organization_id=p_organization_id and i.id=p_item_id;
    if not found then raise exception 'Inventory item unavailable for correction'; end if;
    item_name_value:=manual_item.name; catalog_id_value:=null; item_currency_value:=manual_item.currency;
  end if;
  request_body:=jsonb_build_object('itemId',p_item_id,'quantityDelta',p_quantity_delta,'occurredAt',p_occurred_at,'reason',btrim(p_reason),'evidenceFileId',p_evidence_file_id);
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_idempotency_key,0));
  select * into existing from private.inventory_requests r where r.organization_id=p_organization_id and r.idempotency_key=p_idempotency_key;
  if found then
    if existing.request_payload is distinct from request_body or existing.entity_type<>'correction' then raise exception 'Inventory idempotency key was used with different data'; end if;
    return existing.movement_ids[1];
  end if;
  insert into public.inventory_movements(organization_id,item_definition_id,inventory_item_id,item_name,square_catalog_object_id,movement_type,quantity_delta,unit_cost_minor,currency,occurred_at,evidence_file_id,reason,idempotency_key,created_by)
  values(p_organization_id,case when def.id is not null then def.id end,case when def.id is null then manual_item.id end,item_name_value,catalog_id_value,'manual_correction',p_quantity_delta,null,item_currency_value,p_occurred_at,p_evidence_file_id,btrim(p_reason),'inventory:'||p_idempotency_key,actor) returning id into result_id;
  insert into private.inventory_requests(organization_id,idempotency_key,request_payload,entity_type,cash_movement_id,movement_ids)
  values(p_organization_id,p_idempotency_key,request_body,'correction',null,array[result_id]);
  return result_id;
end $$;

create or replace function public.record_inventory_opening(
  p_organization_id uuid,p_item_id uuid,p_quantity numeric,p_occurred_at timestamptz,
  p_reason text,p_evidence_file_id uuid,p_idempotency_key text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  def public.item_definitions%rowtype;
  manual_item public.inventory_items%rowtype;
  item_name_value text;
  catalog_id_value text;
  item_currency_value char(3);
  existing private.inventory_requests%rowtype;
  request_body jsonb;
  result_id uuid;
begin
  if not private.has_org_role(p_organization_id,array['owner','reviewer']) then raise exception 'Organization owner or reviewer role required'; end if;
  if not exists (select 1 from public.organization_feature_flags f where f.organization_id=p_organization_id and f.inventory_tracking)
    then raise exception 'FEATURE_DISABLED: inventory_tracking'; end if;
  if actor is null then raise exception 'Organization owner or reviewer role required'; end if;
  if p_quantity is null or p_quantity<0 or p_quantity>1000000 or p_quantity<>trunc(p_quantity) or p_occurred_at is null
     or length(btrim(coalesce(p_reason,'')))<10 or length(btrim(coalesce(p_idempotency_key,'')))<8
     or not exists(select 1 from public.evidence_files e where e.organization_id=p_organization_id and e.id=p_evidence_file_id) then raise exception 'Invalid inventory opening balance'; end if;
  select * into def from public.item_definitions d where d.organization_id=p_organization_id and d.id=p_item_id
    and d.effective_from<=p_occurred_at and (d.effective_until is null or d.effective_until>p_occurred_at)
    order by d.effective_from desc limit 1;
  if found then
    item_name_value:=def.name; catalog_id_value:=def.square_catalog_object_id; item_currency_value:=def.currency;
  else
    select * into manual_item from public.inventory_items i where i.organization_id=p_organization_id and i.id=p_item_id;
    if not found then raise exception 'Inventory item unavailable for opening balance'; end if;
    item_name_value:=manual_item.name; catalog_id_value:=null; item_currency_value:=manual_item.currency;
  end if;
  request_body:=jsonb_build_object('itemId',p_item_id,'quantity',p_quantity,'occurredAt',p_occurred_at,'reason',btrim(p_reason),'evidenceFileId',p_evidence_file_id);
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_idempotency_key,0));
  select * into existing from private.inventory_requests r where r.organization_id=p_organization_id and r.idempotency_key=p_idempotency_key;
  if found then
    if existing.request_payload is distinct from request_body or existing.entity_type<>'opening' then raise exception 'Inventory idempotency key was used with different data'; end if;
    return existing.movement_ids[1];
  end if;
  if not private.inventory_period_is_open(p_organization_id,p_occurred_at) then raise exception 'PERIOD_CLOSED'; end if;
  if exists(select 1 from public.inventory_movements m where m.organization_id=p_organization_id
      and ((catalog_id_value is not null and m.square_catalog_object_id=catalog_id_value)
        or (manual_item.id is not null and m.inventory_item_id=manual_item.id))
      and m.occurred_at<p_occurred_at) then
    raise exception 'Opening balance must predate existing inventory movements';
  end if;
  insert into public.inventory_movements(organization_id,item_definition_id,inventory_item_id,item_name,square_catalog_object_id,movement_type,quantity_delta,unit_cost_minor,currency,occurred_at,evidence_file_id,reason,idempotency_key,created_by)
  values(p_organization_id,case when def.id is not null then def.id end,case when def.id is null then manual_item.id end,item_name_value,catalog_id_value,'opening_balance',p_quantity,null,item_currency_value,p_occurred_at,p_evidence_file_id,btrim(p_reason),'inventory:'||p_idempotency_key,actor) returning id into result_id;
  insert into private.inventory_requests(organization_id,idempotency_key,request_payload,entity_type,cash_movement_id,movement_ids)
  values(p_organization_id,p_idempotency_key,request_body,'opening',null,array[result_id]);
  return result_id;
end $$;

create or replace function public.get_product_analytics_facts(
  p_organization_id uuid,p_start_at timestamptz,p_end_at timestamptz
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare rows jsonb; policy_row jsonb; health_rows jsonb; open_issue_count bigint; source_revision bigint; sync_windows jsonb; missing_parent_count bigint; missing_payout_health_count bigint;
begin
  if not public.is_org_member(p_organization_id) then raise exception 'Organization membership required'; end if;
  if not exists(select 1 from public.organization_feature_flags f where f.organization_id=p_organization_id and f.product_analytics)
    then raise exception 'FEATURE_DISABLED: product_analytics'; end if;
  if p_start_at is null or p_end_at is null or p_end_at<=p_start_at or p_end_at-p_start_at>interval '366 days' then raise exception 'Invalid analytics window'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind',q.fact_kind,'objectId',q.object_id,'version',q.object_version,'fact',q.safe_fact) order by q.fact_kind,q.object_id), '[]'::jsonb)
    into rows from (
      select v.fact_kind,v.object_id,v.object_version,
        case when v.fact_kind='order_line' then jsonb_strip_nulls(jsonb_build_object(
          'orderId',v.fact->>'orderId','occurredAt',v.fact->>'occurredAt','lineItemUid',v.fact->>'lineItemUid',
          'status',(select o.fact->>'status' from private.square_fact_current oc
            join private.square_fact_versions o using(organization_id,fact_kind,object_id,object_version)
            where oc.organization_id=v.organization_id and o.fact_kind='order' and o.object_id=v.fact->>'orderId'),
          'itemType',v.fact->>'itemType','catalogObjectId',v.fact->>'catalogObjectId','name',v.fact->>'name',
          'quantity',nullif(v.fact->>'quantity','')::numeric,'currency',v.fact->>'currency',
          'grossMinor',nullif(v.fact->>'grossMinor','')::bigint,'discountMinor',nullif(v.fact->>'discountMinor','')::bigint,
          'taxMinor',nullif(v.fact->>'taxMinor','')::bigint,'tipMinor',nullif(v.fact->>'tipMinor','')::bigint,
          'unitCostMinor',coalesce(o.unit_cost_minor,d.unit_cost_minor),
          'costCurrency',coalesce(o.currency,d.currency)))
        when v.fact_kind='refund' then jsonb_strip_nulls(jsonb_build_object(
          'orderId',v.fact->>'orderId','occurredAt',v.fact->>'occurredAt','status',v.fact->>'status',
          'currency',v.fact->>'currency','amountMinor',nullif(v.fact->>'amountMinor','')::bigint,
          'disposition',(select r.disposition from public.refund_cost_reviews r where r.organization_id=v.organization_id and r.square_refund_id=v.object_id),
          'approvedCogsReversalMinor',(select r.approved_cogs_reversal_minor from public.refund_cost_reviews r where r.organization_id=v.organization_id and r.square_refund_id=v.object_id),
          'reviewCurrency',(select r.currency from public.refund_cost_reviews r where r.organization_id=v.organization_id and r.square_refund_id=v.object_id)))
        when v.fact_kind='payment' then jsonb_strip_nulls(jsonb_build_object(
          'orderId',v.fact->>'orderId','occurredAt',v.fact->>'occurredAt','status',v.fact->>'status',
          'sourceType',v.fact->>'sourceType','currency',v.fact->>'currency',
          'amountMinor',nullif(v.fact->>'amountMinor','')::bigint,'feeMinor',nullif(v.fact->>'feeMinor','')::bigint,
          'feeStatus',v.fact->>'feeStatus'))
        else jsonb_strip_nulls(jsonb_build_object('occurredAt',v.fact->>'occurredAt','status',v.fact->>'status',
          'currency',v.fact->>'currency','totals',v.fact->'totals')) end as safe_fact
      from private.square_fact_current c join private.square_fact_versions v using(organization_id,fact_kind,object_id,object_version)
      left join public.sale_line_cost_overrides o on v.fact_kind='order_line' and o.organization_id=v.organization_id
        and o.square_order_id=v.fact->>'orderId' and o.square_line_uid=v.fact->>'lineItemUid' and o.currency=v.fact->>'currency'
      left join public.item_definitions d on v.fact_kind='order_line' and d.organization_id=v.organization_id
        and d.square_catalog_object_id=v.fact->>'catalogObjectId' and d.currency=v.fact->>'currency'
        and d.effective_from<=(v.fact->>'occurredAt')::timestamptz
        and (d.effective_until is null or d.effective_until>(v.fact->>'occurredAt')::timestamptz)
      where c.organization_id=p_organization_id and v.fact_kind in ('order','order_line','refund','payment')
        and nullif(v.fact->>'occurredAt','') is not null and (v.fact->>'occurredAt')::timestamptz>=p_start_at and (v.fact->>'occurredAt')::timestamptz<p_end_at
    ) q;
  select jsonb_build_object('currency',p.currency,'taxTreatment',p.tax_treatment) into policy_row
    from public.organization_accounting_policies p where p.organization_id=p_organization_id;
  select coalesce(jsonb_agg(jsonb_build_object('resource',h.resource,'status',h.status,
    'gap',case when coalesce(h.gap,'null'::jsonb)='null'::jsonb then null else jsonb_strip_nulls(jsonb_build_object('code',h.gap->>'code','message',h.gap->>'message')) end,
    'lastSuccessfulSyncAt',h.last_successful_sync_at,'checkedAt',h.checked_at) order by h.resource),'[]'::jsonb)
    into health_rows from private.square_worker_health h where h.organization_id=p_organization_id;
  select count(*) into open_issue_count from public.issues i where i.organization_id=p_organization_id and i.state<>'resolved';
  select count(*) into missing_parent_count from private.square_fact_current c join private.square_fact_versions v using(organization_id,fact_kind,object_id,object_version)
    where c.organization_id=p_organization_id and v.fact_kind='order_line'
      and nullif(v.fact->>'occurredAt','') is not null and (v.fact->>'occurredAt')::timestamptz>=p_start_at
      and (v.fact->>'occurredAt')::timestamptz<p_end_at and not exists(
        select 1 from private.square_fact_current oc where oc.organization_id=v.organization_id and oc.fact_kind='order' and oc.object_id=v.fact->>'orderId');
  select count(*) into missing_payout_health_count
    from private.square_fact_current c join private.square_fact_versions v using(organization_id,fact_kind,object_id,object_version)
    where c.organization_id=p_organization_id and v.fact_kind='payout'
      and nullif(v.fact->>'occurredAt','') is not null
      and (v.fact->>'occurredAt')::timestamptz>=p_start_at and (v.fact->>'occurredAt')::timestamptz<p_end_at
      and not exists(select 1 from private.square_worker_health h where h.organization_id=p_organization_id
        and h.resource='payout_entries:'||v.object_id);
  select coalesce(s.source_revision,0) into source_revision from private.square_worker_state s where s.organization_id=p_organization_id;
  select coalesce(jsonb_agg(jsonb_build_object('from',j.payload->>'startAt','to',j.payload->>'endAt') order by j.created_at),'[]'::jsonb)
    into sync_windows from private.durable_jobs j where j.organization_id=p_organization_id and j.job_type='square.sync'
      and j.status='complete' and nullif(j.payload->>'startAt','') is not null and nullif(j.payload->>'endAt','') is not null
      and (j.payload->>'startAt')::timestamptz<p_end_at and (j.payload->>'endAt')::timestamptz>p_start_at;
  return jsonb_build_object('from',p_start_at,'to',p_end_at,'facts',rows,'policy',coalesce(policy_row,'{}'::jsonb),
    'sourceHealth',health_rows,'sourceCoverage',jsonb_build_object('windows',sync_windows),
    'sourceGaps',jsonb_build_object('missingParentOrderLineCount',missing_parent_count,'missingPayoutEntryHealthCount',missing_payout_health_count),
    'openIssueCount',open_issue_count,'sourceRevision',coalesce(source_revision,0));
end $$;

create or replace function public.get_inventory_snapshot(
  p_organization_id uuid,p_start_at timestamptz,p_end_at timestamptz,p_currency text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare movements jsonb; lines jsonb; items jsonb; source_revision bigint; sync_windows jsonb; required_from timestamptz; health_rows jsonb; missing_parent_count bigint;
begin
  if not public.is_org_member(p_organization_id) then raise exception 'Organization membership required'; end if;
  if not exists(select 1 from public.organization_feature_flags f where f.organization_id=p_organization_id and f.inventory_tracking)
    then raise exception 'FEATURE_DISABLED: inventory_tracking'; end if;
  if p_start_at is null or p_end_at is null or p_end_at<=p_start_at or p_end_at-p_start_at>interval '366 days'
     or p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'Inventory window and currency required'; end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.occurred_at,m.created_at,m.id),'[]'::jsonb) into movements
    from public.inventory_movements m where m.organization_id=p_organization_id and m.currency=p_currency and m.occurred_at<p_end_at;
  select coalesce(jsonb_agg(q.item order by q.name),'[]'::jsonb) into items from (
    select d.id,d.name,jsonb_build_object('id',d.id,'item_kind','catalog','sku',d.sku,
      'square_catalog_object_id',d.square_catalog_object_id,
      'name',d.name,'currency',d.currency,'effective_from',d.effective_from,'effective_until',d.effective_until,
      'unit_cost_minor',d.unit_cost_minor) as item
    from (select distinct on (x.organization_id,x.square_catalog_object_id) x.* from public.item_definitions x
      where x.organization_id=p_organization_id and x.currency=p_currency and x.effective_from<p_end_at
        and (x.effective_until is null or x.effective_until>=p_end_at)
      order by x.organization_id,x.square_catalog_object_id,x.effective_from desc,x.version desc) d
    union all
    select i.id,i.name,jsonb_build_object('id',i.id,'item_kind','manual','sku',i.sku,
      'square_catalog_object_id',null,'name',i.name,'currency',i.currency,'effective_from',null,
      'effective_until',null,'unit_cost_minor',null) as item
      from public.inventory_items i where i.organization_id=p_organization_id and i.currency=p_currency
  ) q;
  select coalesce(jsonb_agg(jsonb_build_object('objectId',v.object_id,'orderId',v.fact->>'orderId',
      'occurredAt',v.fact->>'occurredAt','lineItemUid',v.fact->>'lineItemUid','itemType',v.fact->>'itemType',
      'catalogObjectId',v.fact->>'catalogObjectId','name',v.fact->>'name',
      'quantity',nullif(v.fact->>'quantity','')::numeric,'currency',v.fact->>'currency')
      order by v.fact->>'occurredAt',v.object_id),'[]'::jsonb) into lines
    from private.square_fact_current c join private.square_fact_versions v using(organization_id,fact_kind,object_id,object_version)
    join private.square_fact_current oc on oc.organization_id=v.organization_id and oc.fact_kind='order' and oc.object_id=v.fact->>'orderId'
    join private.square_fact_versions ord on ord.organization_id=oc.organization_id and ord.fact_kind=oc.fact_kind and ord.object_id=oc.object_id and ord.object_version=oc.object_version
    where c.organization_id=p_organization_id and v.fact_kind='order_line'
      and upper(coalesce(v.fact->>'itemType','ITEM'))<>'GIFT_CARD' and lower(coalesce(ord.fact->>'status',''))='completed'
      and v.fact->>'currency'=p_currency and nullif(v.fact->>'occurredAt','') is not null
      and (v.fact->>'occurredAt')::timestamptz<p_end_at;
  select coalesce(s.source_revision,0) into source_revision from private.square_worker_state s where s.organization_id=p_organization_id;
  select min(m.occurred_at) into required_from from public.inventory_movements m where m.organization_id=p_organization_id and m.currency=p_currency;
  select coalesce(jsonb_agg(jsonb_build_object('resource',h.resource,'status',h.status,
    'gap',case when coalesce(h.gap,'null'::jsonb)='null'::jsonb then null else jsonb_strip_nulls(jsonb_build_object('code',h.gap->>'code','message',h.gap->>'message')) end,
    'lastSuccessfulSyncAt',h.last_successful_sync_at,'checkedAt',h.checked_at) order by h.resource),'[]'::jsonb)
    into health_rows from private.square_worker_health h where h.organization_id=p_organization_id;
  select count(*) into missing_parent_count from private.square_fact_current c join private.square_fact_versions v using(organization_id,fact_kind,object_id,object_version)
    where c.organization_id=p_organization_id and v.fact_kind='order_line' and v.fact->>'currency'=p_currency
      and nullif(v.fact->>'occurredAt','') is not null and (v.fact->>'occurredAt')::timestamptz<p_end_at and not exists(
        select 1 from private.square_fact_current oc where oc.organization_id=v.organization_id and oc.fact_kind='order' and oc.object_id=v.fact->>'orderId');
  select coalesce(jsonb_agg(jsonb_build_object('from',j.payload->>'startAt','to',j.payload->>'endAt') order by j.created_at),'[]'::jsonb)
    into sync_windows from private.durable_jobs j where j.organization_id=p_organization_id and j.job_type='square.sync'
      and j.status='complete' and nullif(j.payload->>'startAt','') is not null and nullif(j.payload->>'endAt','') is not null
      and (j.payload->>'startAt')::timestamptz<p_end_at
      and (j.payload->>'endAt')::timestamptz>coalesce(required_from,p_start_at);
  return jsonb_build_object('from',p_start_at,'to',p_end_at,'currency',p_currency,'items',items,'movements',movements,'lines',lines,
    'sourceCoverage',jsonb_build_object('requiredFrom',required_from,'windows',sync_windows),
    'sourceRevision',coalesce(source_revision,0),'sourceHealth',health_rows,
    'sourceGaps',jsonb_build_object('missingParentOrderLineCount',missing_parent_count));
end $$;

-- Explicitly no authenticated write grants or RPC exist for feature switches.
revoke all on function public.record_inventory_purchase(uuid,uuid,bigint,text,timestamptz,text,uuid,text,jsonb) from public,anon;
grant execute on function public.record_inventory_purchase(uuid,uuid,bigint,text,timestamptz,text,uuid,text,jsonb) to authenticated;
revoke all on function public.record_inventory_item(uuid,text,text,text,uuid,text,text) from public,anon;
grant execute on function public.record_inventory_item(uuid,text,text,text,uuid,text,text) to authenticated;
revoke all on function public.record_inventory_correction(uuid,uuid,numeric,timestamptz,text,uuid,text) from public,anon;
grant execute on function public.record_inventory_correction(uuid,uuid,numeric,timestamptz,text,uuid,text) to authenticated;
revoke all on function public.record_inventory_opening(uuid,uuid,numeric,timestamptz,text,uuid,text) from public,anon;
grant execute on function public.record_inventory_opening(uuid,uuid,numeric,timestamptz,text,uuid,text) to authenticated;
revoke all on function public.get_product_analytics_facts(uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.get_product_analytics_facts(uuid,timestamptz,timestamptz) to authenticated;
revoke all on function public.get_inventory_snapshot(uuid,timestamptz,timestamptz,text) from public,anon;
grant execute on function public.get_inventory_snapshot(uuid,timestamptz,timestamptz,text) to authenticated;
