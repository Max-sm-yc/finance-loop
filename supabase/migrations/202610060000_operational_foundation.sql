-- Vernius Phase 1 operational foundation.
-- Additive canonical identities, explicit permissions, immutable financial
-- events, and a reusable approval state machine. Square facts remain source
-- evidence; these tables are the provider-independent domain layer.

-- Role and location scope foundation. Existing role names remain valid while
-- new organizations can use the requested employee-facing role vocabulary.
alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships add constraint memberships_role_check
  check (role in ('owner','administrator','manager','employee','operator','reviewer','read_only','custom'));
alter table public.memberships add column if not exists custom_role_id uuid;
alter table public.memberships add column if not exists location_scope_mode text not null default 'all'
  check (location_scope_mode in ('all','selected'));

create table public.organization_custom_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null check (length(btrim(name)) between 1 and 80),
  description text not null default '',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (organization_id,id),
  unique (organization_id,name)
);
create unique index organization_custom_roles_name_unique on public.organization_custom_roles(organization_id,lower(name));
alter table public.memberships add constraint memberships_custom_role_fk
  foreign key (organization_id,custom_role_id)
  references public.organization_custom_roles(organization_id,id);
alter table public.memberships add constraint memberships_custom_role_shape
  check ((role='custom' and custom_role_id is not null) or (role<>'custom' and custom_role_id is null));

create table public.organization_role_permission_overrides (
  organization_id uuid not null references public.organizations(id),
  role_key text not null,
  permission_key text not null check (permission_key ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  allowed boolean not null,
  changed_by uuid not null references auth.users(id),
  changed_at timestamptz not null default now(),
  primary key (organization_id,role_key,permission_key)
);
create table public.custom_role_permissions (
  organization_id uuid not null,
  custom_role_id uuid not null,
  permission_key text not null check (permission_key ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  allowed boolean not null,
  changed_by uuid not null references auth.users(id),
  changed_at timestamptz not null default now(),
  primary key (organization_id,custom_role_id,permission_key),
  foreign key (organization_id,custom_role_id)
    references public.organization_custom_roles(organization_id,id)
);
create table public.membership_location_scopes (
  organization_id uuid not null,
  user_id uuid not null,
  location_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id,user_id,location_id),
  foreign key (organization_id,user_id) references public.memberships(organization_id,user_id)
);
create table public.external_identity_mappings (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, user_id uuid not null,
  provider text not null check (provider='microsoft_teams'), tenant_id uuid not null, external_user_id uuid not null,
  external_email text, status text not null default 'active' check (status in ('active','inactive')),
  linked_by uuid not null references auth.users(id), linked_at timestamptz not null default now(),
  unique (organization_id,id),
  foreign key (organization_id,user_id) references public.memberships(organization_id,user_id),
  check (external_email is null or length(external_email)<=320)
);
create unique index external_identity_active_source_unique on public.external_identity_mappings(organization_id,provider,tenant_id,external_user_id)
  where status='active';
create unique index external_identity_active_user_unique on public.external_identity_mappings(organization_id,provider,tenant_id,user_id)
  where status='active';

-- Stable Vernius IDs for provider-independent business records. Square IDs
-- live only in source mappings and are never used as primary keys.
create table public.business_locations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  name text not null check (length(btrim(name)) between 1 and 200),
  timezone text, address jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','inactive','archived')),
  created_by uuid references auth.users(id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), revision integer not null default 1 check (revision>0),
  unique (organization_id,id)
);
alter table public.membership_location_scopes add constraint membership_location_scopes_location_fk
  foreign key (organization_id,location_id) references public.business_locations(organization_id,id);
create table public.business_employees (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  user_id uuid references auth.users(id), display_name text not null check (length(btrim(display_name)) between 1 and 200),
  email text, status text not null default 'active' check (status in ('invited','active','inactive')),
  created_by uuid references auth.users(id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), revision integer not null default 1 check (revision>0),
  unique (organization_id,id),
  foreign key (organization_id,user_id) references public.memberships(organization_id,user_id)
);
create unique index business_employees_user_unique on public.business_employees(organization_id,user_id) where user_id is not null;
create table public.suppliers (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  name text not null check (length(btrim(name)) between 1 and 200),
  contact jsonb not null default '{}'::jsonb, status text not null default 'active' check (status in ('active','inactive','archived')),
  created_by uuid references auth.users(id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), revision integer not null default 1 check (revision>0),
  unique (organization_id,id)
);
create table public.catalog_categories (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  parent_id uuid, name text not null check (length(btrim(name)) between 1 and 200),
  status text not null default 'active' check (status in ('active','archived')),
  created_by uuid references auth.users(id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), revision integer not null default 1 check (revision>0),
  unique (organization_id,id),
  foreign key (organization_id,parent_id) references public.catalog_categories(organization_id,id)
);
create table public.catalog_items (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  category_id uuid, name text not null check (length(btrim(name)) between 1 and 200),
  description text not null default '', status text not null default 'draft' check (status in ('draft','active','archived')),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  revision integer not null default 1 check (revision>0), unique (organization_id,id),
  foreign key (organization_id,category_id) references public.catalog_categories(organization_id,id)
);
create table public.catalog_variations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  item_id uuid not null, name text not null check (length(btrim(name)) between 1 and 200),
  sku text, barcode text, unit_of_measure text not null default 'each' check (length(btrim(unit_of_measure)) between 1 and 40),
  price_minor bigint, currency char(3), status text not null default 'draft' check (status in ('draft','active','archived')),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  revision integer not null default 1 check (revision>0), unique (organization_id,id),
  foreign key (organization_id,item_id) references public.catalog_items(organization_id,id),
  check ((price_minor is null and currency is null) or (price_minor is not null and price_minor>=0 and currency ~ '^[A-Z]{3}$'))
);
create unique index catalog_variations_sku_unique on public.catalog_variations(organization_id,lower(sku)) where sku is not null;
create unique index catalog_variations_barcode_unique on public.catalog_variations(organization_id,barcode) where barcode is not null;
create table public.catalog_location_availability (
  organization_id uuid not null, variation_id uuid not null, location_id uuid not null,
  availability text not null check (availability in ('available','unavailable','limited','unknown')),
  quantity numeric(18,6) check (quantity is null or quantity>=0), observed_at timestamptz,
  square_source_version text, square_source_hash text,
  updated_at timestamptz not null default now(), primary key (organization_id,variation_id,location_id),
  foreign key (organization_id,variation_id) references public.catalog_variations(organization_id,id),
  foreign key (organization_id,location_id) references public.business_locations(organization_id,id)
);
create table public.square_inventory_count_observations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  variation_id uuid not null, location_id uuid not null,
  square_catalog_object_id text not null, square_location_id text not null,
  state text not null check (state in ('IN_STOCK','SOLD','RETURNED_BY_CUSTOMER','RESERVED_FOR_SALE','WASTE','UNLINKED_RETURN','NONE')),
  quantity numeric(18,5) not null check (quantity>=0), calculated_at timestamptz not null,
  source_version text not null, source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null default now(),
  unique (organization_id,variation_id,location_id,state,source_version),
  foreign key (organization_id,variation_id) references public.catalog_variations(organization_id,id),
  foreign key (organization_id,location_id) references public.business_locations(organization_id,id)
);
create index square_inventory_count_latest_idx on public.square_inventory_count_observations
  (organization_id,variation_id,location_id,state,calculated_at desc,observed_at desc);
create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  supplier_id uuid, status text not null default 'draft' check (status in ('draft','pending_approval','approved','sent','partially_received','received','cancelled')),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'), ordered_at timestamptz,
  expected_at timestamptz, created_by uuid references auth.users(id), created_at timestamptz not null default now(),
  revision integer not null default 1 check (revision>0), unique (organization_id,id),
  foreign key (organization_id,supplier_id) references public.suppliers(organization_id,id)
);
create table public.purchase_order_lines (
  organization_id uuid not null, purchase_order_id uuid not null, line_number integer not null check (line_number>0),
  variation_id uuid, description text not null, quantity numeric(18,6) not null check (quantity>0),
  unit_cost_minor bigint check (unit_cost_minor is null or unit_cost_minor>=0), currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  received_quantity numeric(18,6) not null default 0 check (received_quantity>=0),
  primary key (organization_id,purchase_order_id,line_number),
  foreign key (organization_id,purchase_order_id) references public.purchase_orders(organization_id,id),
  foreign key (organization_id,variation_id) references public.catalog_variations(organization_id,id),
  check (unit_cost_minor is not null or received_quantity=0)
);

-- External identifiers map to internal entity UUIDs and retain source version
-- and observation provenance. Draft Vernius entities may have no mapping yet.
create table public.domain_source_mappings (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  provider text not null check (length(btrim(provider)) between 1 and 80),
  source_type text not null check (length(btrim(source_type)) between 1 and 100),
  source_id text not null check (length(btrim(source_id)) between 1 and 1000),
  entity_type text not null check (entity_type in ('location','employee','supplier','category','catalog_item','catalog_variation','purchase_order','financial_event')),
  entity_id uuid not null, source_version text, source_hash text,
  source_updated_at timestamptz, observed_at timestamptz not null default now(),
  ingestion_actor_kind text not null default 'system' check (ingestion_actor_kind in ('human','system','agent','integration')),
  originating_user_id uuid references auth.users(id), originating_automation text,
  active boolean not null default true, created_at timestamptz not null default now(),
  unique (organization_id,id), unique (organization_id,provider,source_type,source_id)
);
create index domain_source_mappings_entity_idx on public.domain_source_mappings(organization_id,entity_type,entity_id);

create or replace function private.guard_domain_source_mapping_entity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare matched boolean := false;
begin
  case new.entity_type
    when 'location' then select exists(select 1 from public.business_locations x where x.organization_id=new.organization_id and x.id=new.entity_id) into matched;
    when 'employee' then select exists(select 1 from public.business_employees x where x.organization_id=new.organization_id and x.id=new.entity_id) into matched;
    when 'supplier' then select exists(select 1 from public.suppliers x where x.organization_id=new.organization_id and x.id=new.entity_id) into matched;
    when 'category' then select exists(select 1 from public.catalog_categories x where x.organization_id=new.organization_id and x.id=new.entity_id) into matched;
    when 'catalog_item' then select exists(select 1 from public.catalog_items x where x.organization_id=new.organization_id and x.id=new.entity_id) into matched;
    when 'catalog_variation' then select exists(select 1 from public.catalog_variations x where x.organization_id=new.organization_id and x.id=new.entity_id) into matched;
    when 'purchase_order' then select exists(select 1 from public.purchase_orders x where x.organization_id=new.organization_id and x.id=new.entity_id) into matched;
    when 'financial_event' then select exists(select 1 from public.financial_events x where x.organization_id=new.organization_id and x.id=new.entity_id) into matched;
  end case;
  if not matched then raise exception 'Source mapping target does not exist in this organization'; end if;
  return new;
end
$$;
create trigger domain_source_mapping_target_guard before insert or update on public.domain_source_mappings
  for each row execute function private.guard_domain_source_mapping_entity();

-- Normalized financial events are append-only. Corrections supersede an event
-- with a new row; projections can be rebuilt from these rows plus policy.
create table public.financial_events (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  event_type text not null check (event_type in ('sale','refund','discount','tax','processing_fee','payout','purchase','inventory_acquisition','cost_of_goods_sold','operating_expense','transfer','adjustment','other')),
  status text not null default 'posted' check (status in ('draft','posted','incomplete','superseded')),
  occurred_at timestamptz not null, ingested_at timestamptz not null default now(),
  location_id uuid, supplier_id uuid, amount_minor bigint, currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  description text not null default '', source_provider text, source_type text, source_id text, source_version text,
  source_event_id uuid, idempotency_key text not null check (length(btrim(idempotency_key)) between 8 and 240),
  supersedes_event_id uuid, recorded_by uuid references auth.users(id), originating_automation text,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details)='object'),
  created_at timestamptz not null default now(), unique (organization_id,id), unique (organization_id,idempotency_key),
  foreign key (organization_id,location_id) references public.business_locations(organization_id,id),
  foreign key (organization_id,supplier_id) references public.suppliers(organization_id,id),
  foreign key (organization_id,source_event_id) references private.source_events(organization_id,id),
  foreign key (organization_id,supersedes_event_id) references public.financial_events(organization_id,id),
  check ((status='incomplete') or amount_minor is not null),
  check ((source_provider is null and source_type is null and source_id is null and source_version is null)
      or (source_provider is not null and source_type is not null and source_id is not null and source_version is not null))
);
create unique index financial_events_source_version_unique on public.financial_events
  (organization_id,source_provider,source_type,source_id,source_version) where source_provider is not null;
create index financial_events_period_idx on public.financial_events(organization_id,occurred_at,event_type);
create table public.financial_event_lines (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, financial_event_id uuid not null,
  line_number integer not null check (line_number>0), variation_id uuid, description text not null default '',
  quantity numeric(18,6), unit_amount_minor bigint, amount_minor bigint, currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(), unique (organization_id,id),
  unique (organization_id,financial_event_id,line_number),
  foreign key (organization_id,financial_event_id) references public.financial_events(organization_id,id),
  foreign key (organization_id,variation_id) references public.catalog_variations(organization_id,id),
  check (quantity is null or quantity>0)
);
create or replace function private.guard_financial_event_line_currency()
returns trigger language plpgsql security definer set search_path = '' as $$
declare event_currency char(3);
begin
  select e.currency into event_currency from public.financial_events e
    where e.organization_id=new.organization_id and e.id=new.financial_event_id;
  if not found or new.currency is distinct from event_currency then
    raise exception 'Financial event line currency must match its parent event';
  end if;
  return new;
end
$$;
revoke all on function private.guard_financial_event_line_currency() from public,anon,authenticated;
create trigger financial_event_line_currency_guard before insert on public.financial_event_lines
  for each row execute function private.guard_financial_event_line_currency();
create table public.financial_event_documents (
  organization_id uuid not null, financial_event_id uuid not null, evidence_file_id uuid not null,
  relationship text not null default 'supporting' check (relationship in ('supporting','receipt','invoice','payment_proof','correction_evidence')),
  linked_by uuid references auth.users(id), linked_at timestamptz not null default now(),
  primary key (organization_id,financial_event_id,evidence_file_id),
  foreign key (organization_id,financial_event_id) references public.financial_events(organization_id,id),
  foreign key (organization_id,evidence_file_id) references public.evidence_files(organization_id,id)
);

create or replace function private.audit_canonical_domain_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare before_value jsonb; after_value jsonb; organization_id_value uuid; entity_id_value uuid; actor uuid:=(select auth.uid()); action_value text;
begin
  if tg_op<>'INSERT' then before_value:=to_jsonb(old)-'contact'-'email'; end if;
  if tg_op<>'DELETE' then after_value:=to_jsonb(new)-'contact'-'email'; end if;
  organization_id_value:=coalesce(nullif(after_value->>'organization_id','')::uuid,nullif(before_value->>'organization_id','')::uuid);
  entity_id_value:=coalesce(nullif(after_value->>'id','')::uuid,nullif(before_value->>'id','')::uuid,
    nullif(after_value->>'variation_id','')::uuid,nullif(before_value->>'variation_id','')::uuid,
    nullif(after_value->>'purchase_order_id','')::uuid,nullif(before_value->>'purchase_order_id','')::uuid,
    nullif(after_value->>'financial_event_id','')::uuid,nullif(before_value->>'financial_event_id','')::uuid);
  action_value:=case tg_op when 'INSERT' then 'create' when 'UPDATE' then 'update' else 'delete' end;
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,before_state,after_state,correlation_id,execution_status)
    values(organization_id_value,actor,case when actor is null or coalesce(auth.role(),'')='service_role' then 'system' else 'human' end,
      action_value,tg_table_name,entity_id_value,before_value,after_value,
      'domain:'||tg_table_name||':'||coalesce(entity_id_value::text,'unknown')||':'||gen_random_uuid()::text,'succeeded');
  if tg_op='DELETE' then return old; end if;
  return new;
end
$$;
do $$ declare t text; begin
  foreach t in array array['business_locations','business_employees','suppliers','catalog_categories','catalog_items','catalog_variations',
    'catalog_location_availability','square_inventory_count_observations','purchase_orders','purchase_order_lines','domain_source_mappings'] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.audit_canonical_domain_change()',t||'_audit',t);
    execute format('create trigger %I before delete on public.%I for each row execute function private.reject_row_change()',t||'_no_delete',t);
  end loop;
end $$;
create trigger financial_events_audit_insert after insert on public.financial_events
  for each row execute function private.audit_canonical_domain_change();
create trigger financial_event_lines_audit_insert after insert on public.financial_event_lines
  for each row execute function private.audit_canonical_domain_change();
create trigger financial_event_documents_audit_insert after insert on public.financial_event_documents
  for each row execute function private.audit_canonical_domain_change();

-- Expand audit records to distinguish origin and confirmed execution outcomes.
alter table public.audit_events add column if not exists source_message_ref text;
alter table public.audit_events add column if not exists originating_automation text;
alter table public.audit_events add column if not exists execution_status text not null default 'succeeded'
  check (execution_status in ('attempted','succeeded','failed','partial'));
alter table public.audit_events add column if not exists outcome_code text;
create index audit_events_entity_idx on public.audit_events(organization_id,entity_type,entity_id,created_at desc);
create index audit_events_correlation_idx on public.audit_events(organization_id,correlation_id,created_at);

-- Explicit role permissions with conservative defaults. Location-scoped users
-- can only use location-aware permissions for assigned locations.
create or replace function private.has_org_permission(
  p_organization_id uuid,p_permission_key text,p_location_id uuid default null
) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare m public.memberships%rowtype; custom_allowed boolean; override_allowed boolean; default_allowed boolean := false;
begin
  select * into m from public.memberships x where x.organization_id=p_organization_id and x.user_id=(select auth.uid());
  if not found then return false; end if;
  if p_location_id is not null and not exists(select 1 from public.business_locations l where l.organization_id=p_organization_id and l.id=p_location_id) then return false; end if;
  if m.location_scope_mode='selected' then
    if p_location_id is not null and not exists(select 1 from public.membership_location_scopes s
        where s.organization_id=p_organization_id and s.user_id=m.user_id and s.location_id=p_location_id) then return false; end if;
    if p_location_id is null and p_permission_key in ('finance.metrics.read','finance.cash.write','inventory.read','inventory.write','purchases.read','purchases.write','audit.read') then return false; end if;
  end if;
  if m.role='owner' then return true; end if;
  if m.role='custom' then
    select p.allowed into custom_allowed from public.custom_role_permissions p
      where p.organization_id=m.organization_id and p.custom_role_id=m.custom_role_id and p.permission_key=p_permission_key;
    return coalesce(custom_allowed,false);
  end if;
  select p.allowed into override_allowed from public.organization_role_permission_overrides p
    where p.organization_id=m.organization_id and p.role_key=m.role and p.permission_key=p_permission_key;
  if found then return override_allowed; end if;
  default_allowed := case m.role
    when 'administrator' then p_permission_key not in ('organization.owner_transfer')
    when 'manager' then p_permission_key in ('catalog.read','catalog.write','catalog.price.write','inventory.read','inventory.write','finance.metrics.read','finance.cash.write','issues.read','issues.propose','approvals.read','approvals.decide','actions.propose','audit.read','sync.read','employees.read','locations.read','suppliers.read','purchases.read','purchases.write')
    when 'employee' then p_permission_key in ('catalog.read','inventory.read','inventory.write','actions.propose','issues.read','sync.read','locations.read')
    when 'operator' then p_permission_key in ('catalog.read','inventory.read','inventory.write','finance.metrics.read','finance.cash.write','issues.read','issues.propose','approvals.read','actions.propose','sync.read','audit.read','locations.read','purchases.write')
    when 'reviewer' then p_permission_key in ('catalog.read','inventory.read','finance.metrics.read','finance.cost.approve','finance.refund.review','issues.read','approvals.read','approvals.decide','audit.read','sync.read','employees.read','locations.read','suppliers.read','purchases.read')
    when 'read_only' then p_permission_key in ('catalog.read','inventory.read','finance.metrics.read','issues.read','approvals.read','audit.read','sync.read','employees.read','locations.read','suppliers.read','purchases.read')
    else false end;
  return default_allowed;
end
$$;
revoke all on function private.has_org_permission(uuid,text,uuid) from public,anon;
grant execute on function private.has_org_permission(uuid,text,uuid) to authenticated,service_role;

-- Financial and audit reads are permission-checked in Postgres as well as in
-- the API. Existing member policies on descriptive organization data remain.
drop policy if exists account_read on public.accounts;
create policy account_read on public.accounts for select to authenticated
  using (private.has_org_permission(organization_id,'finance.metrics.read'));
drop policy if exists item_read on public.item_definitions;
create policy item_read on public.item_definitions for select to authenticated
  using (private.has_org_permission(organization_id,'finance.metrics.read'));
drop policy if exists sale_read on public.sale_lines;
create policy sale_read on public.sale_lines for select to authenticated
  using (private.has_org_permission(organization_id,'finance.metrics.read'));
drop policy if exists cash_read on public.cash_movements;
create policy cash_read on public.cash_movements for select to authenticated
  using (private.has_org_permission(organization_id,'finance.metrics.read'));
drop policy if exists balance_read on public.balance_observations;
create policy balance_read on public.balance_observations for select to authenticated
  using (private.has_org_permission(organization_id,'finance.metrics.read'));
drop policy if exists projection_read on public.projection_runs;
create policy projection_read on public.projection_runs for select to authenticated
  using (private.has_org_permission(organization_id,'finance.metrics.read'));
drop policy if exists issue_read on public.issues;
create policy issue_read on public.issues for select to authenticated
  using (private.has_org_permission(organization_id,'issues.read'));
drop policy if exists proposal_read on public.proposals;
create policy proposal_read on public.proposals for select to authenticated
  using (private.has_org_permission(organization_id,'issues.read'));
drop policy if exists audit_read on public.audit_events;
create policy audit_read on public.audit_events for select to authenticated
  using (private.has_org_permission(organization_id,'audit.read'));
drop policy if exists membership_read on public.memberships;
create policy membership_read on public.memberships for select to authenticated
  using (user_id=(select auth.uid()) or private.has_org_permission(organization_id,'people.manage'));

-- Read contracts for canonical records. Writes are through permission-checked
-- RPCs or the service worker, never direct browser table writes.
do $$ declare t text; begin
  foreach t in array array['organization_custom_roles','organization_role_permission_overrides','custom_role_permissions','external_identity_mappings',
    'membership_location_scopes','business_locations','business_employees','suppliers','catalog_categories','catalog_items',
    'catalog_variations','catalog_location_availability','square_inventory_count_observations','purchase_orders','purchase_order_lines','domain_source_mappings',
    'financial_events','financial_event_lines','financial_event_documents'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy %I on public.%I for select to authenticated using (private.has_org_permission(organization_id,''%s''))',
      t||'_read',t,case when t='business_locations' then 'locations.read'
        when t in ('business_employees','suppliers') then 'employees.read'
        when t in ('catalog_location_availability','square_inventory_count_observations') then 'inventory.read'
        when t like 'catalog_%' then 'catalog.read' when t like 'purchase_%' then 'purchases.read'
        when t like 'financial_%' then 'finance.metrics.read' when t='domain_source_mappings' then 'sync.read'
        else 'people.manage' end);
  end loop;
end $$;
-- For custom-role and scope tables, expose only the caller's organization and
-- restrict mutation to owner-only RPCs (there are no direct write grants).
drop policy if exists organization_custom_roles_read on public.organization_custom_roles;
create policy organization_custom_roles_read on public.organization_custom_roles for select to authenticated
  using (public.is_org_member(organization_id));
drop policy if exists organization_role_permission_overrides_read on public.organization_role_permission_overrides;
create policy organization_role_permission_overrides_read on public.organization_role_permission_overrides for select to authenticated
  using (private.has_org_permission(organization_id,'people.manage'));
drop policy if exists custom_role_permissions_read on public.custom_role_permissions;
create policy custom_role_permissions_read on public.custom_role_permissions for select to authenticated
  using (private.has_org_permission(organization_id,'people.manage'));
drop policy if exists membership_location_scopes_read on public.membership_location_scopes;
create policy membership_location_scopes_read on public.membership_location_scopes for select to authenticated
  using (user_id=(select auth.uid()) or private.has_org_permission(organization_id,'people.manage'));
drop policy if exists business_locations_read on public.business_locations;
create policy business_locations_read on public.business_locations for select to authenticated
  using (private.has_org_permission(organization_id,'locations.read',id));
drop policy if exists catalog_location_availability_read on public.catalog_location_availability;
create policy catalog_location_availability_read on public.catalog_location_availability for select to authenticated
  using (private.has_org_permission(organization_id,'inventory.read',location_id));
drop policy if exists square_inventory_count_observations_read on public.square_inventory_count_observations;
create policy square_inventory_count_observations_read on public.square_inventory_count_observations for select to authenticated
  using (private.has_org_permission(organization_id,'inventory.read',location_id));
drop policy if exists financial_events_read on public.financial_events;
create policy financial_events_read on public.financial_events for select to authenticated
  using (private.has_org_permission(organization_id,'finance.metrics.read',location_id));
drop policy if exists financial_event_lines_read on public.financial_event_lines;
create policy financial_event_lines_read on public.financial_event_lines for select to authenticated
  using (exists(select 1 from public.financial_events e where e.organization_id=financial_event_lines.organization_id
    and e.id=financial_event_lines.financial_event_id and private.has_org_permission(e.organization_id,'finance.metrics.read',e.location_id)));
drop policy if exists financial_event_documents_read on public.financial_event_documents;
create policy financial_event_documents_read on public.financial_event_documents for select to authenticated
  using (exists(select 1 from public.financial_events e where e.organization_id=financial_event_documents.organization_id
    and e.id=financial_event_documents.financial_event_id and private.has_org_permission(e.organization_id,'finance.metrics.read',e.location_id)));
revoke all on public.organization_role_permission_overrides,public.custom_role_permissions,public.membership_location_scopes from authenticated;
grant select on public.organization_custom_roles,public.organization_role_permission_overrides,public.custom_role_permissions,public.membership_location_scopes to authenticated;

-- Append-only normalized event evidence and decisions.
create trigger financial_events_append_only before update or delete on public.financial_events
  for each row execute function private.reject_row_change();
create trigger financial_event_lines_append_only before update or delete on public.financial_event_lines
  for each row execute function private.reject_row_change();
create trigger financial_event_documents_append_only before update or delete on public.financial_event_documents
  for each row execute function private.reject_row_change();
create trigger square_inventory_count_observations_append_only before update or delete on public.square_inventory_count_observations
  for each row execute function private.reject_row_change();

-- General-purpose transactional approvals. A proposal payload/hash never
-- changes after submission; material edits require a replacement proposal.
create table public.action_proposals (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  action_type text not null check (action_type ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  status text not null default 'pending_approval' check (status in ('draft','pending_approval','approved','rejected','expired','cancelled','executing','retrying','succeeded','failed','conflicted')),
  payload jsonb not null check (jsonb_typeof(payload)='object' and octet_length(payload::text)<=20000),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  expected_source_version text, location_id uuid, amount_minor bigint, currency char(3),
  evidence_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_refs)='array'),
  proposed_by uuid not null references auth.users(id), proposed_by_kind text not null default 'human' check (proposed_by_kind in ('human','agent','automation')),
  source_message_ref text, originating_automation text, idempotency_key text not null,
  expires_at timestamptz not null default now()+interval '7 days', supersedes_proposal_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id,id), unique (organization_id,idempotency_key),
  foreign key (organization_id,location_id) references public.business_locations(organization_id,id),
  foreign key (organization_id,supersedes_proposal_id) references public.action_proposals(organization_id,id),
  check ((amount_minor is null and currency is null) or (amount_minor is not null and currency ~ '^[A-Z]{3}$'))
);
create index action_proposals_queue_idx on public.action_proposals(organization_id,status,created_at desc);
create index action_proposals_expiry_idx on public.action_proposals(expires_at,organization_id) where status='pending_approval';
create table public.action_approval_policies (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), action_type text not null,
  location_id uuid, amount_currency text, min_amount_minor bigint, max_amount_minor bigint,
  required_permission text not null default 'approvals.decide', required_role text,
  required_approval_count integer not null default 1 check (required_approval_count between 1 and 5),
  max_single_approver_minor bigint, enabled boolean not null default true,
  changed_by uuid references auth.users(id), changed_at timestamptz not null default now(),
  foreign key (organization_id,location_id) references public.business_locations(organization_id,id),
  check (min_amount_minor is null or min_amount_minor>=0),
  check (max_amount_minor is null or max_amount_minor>=0),
  check (max_amount_minor is null or min_amount_minor is null or max_amount_minor>=min_amount_minor),
  check (max_single_approver_minor is null or max_single_approver_minor>=0),
  check (amount_currency is null or amount_currency ~ '^[A-Z]{3}$'),
  check ((min_amount_minor is null and max_amount_minor is null and max_single_approver_minor is null) = (amount_currency is null))
);
create index action_approval_policy_lookup on public.action_approval_policies(organization_id,action_type,location_id,enabled,min_amount_minor);
create table public.action_approval_decisions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, proposal_id uuid not null,
  decision text not null check (decision in ('approved','rejected','cancelled','expired')),
  decided_by uuid references auth.users(id), decided_by_kind text not null default 'human' check (decided_by_kind in ('human','system')),
  reason text not null check (length(btrim(reason)) between 10 and 1000),
  proposal_revision_hash text not null, idempotency_key text not null,
  created_at timestamptz not null default now(), unique (organization_id,id),
  unique (organization_id,idempotency_key),
  foreign key (organization_id,proposal_id) references public.action_proposals(organization_id,id),
  check ((decided_by_kind='human' and decided_by is not null) or (decided_by_kind='system' and decided_by is null))
);
create unique index action_approval_decisions_one_per_approver
  on public.action_approval_decisions(organization_id,proposal_id,decided_by) where decision='approved';
create unique index action_approval_policy_rule_unique on public.action_approval_policies
  (organization_id,action_type,coalesce(location_id,'00000000-0000-0000-0000-000000000000'::uuid),coalesce(amount_currency,''),
   coalesce(min_amount_minor,-1),coalesce(max_amount_minor,-1));
create table public.action_execution_records (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, proposal_id uuid not null,
  attempt integer not null check (attempt>0), status text not null check (status in ('queued','executing','retrying','succeeded','failed','conflicted')),
  approved_payload_sha256 text not null, outcome_code text, result_summary jsonb not null default '{}'::jsonb,
  started_at timestamptz, completed_at timestamptz, created_at timestamptz not null default now(),
  unique (organization_id,id), unique (organization_id,proposal_id,attempt),
  foreign key (organization_id,proposal_id) references public.action_proposals(organization_id,id)
);
create or replace function private.guard_action_execution_record_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.organization_id,new.proposal_id,new.attempt,new.approved_payload_sha256,new.created_at) is distinct from
     (old.organization_id,old.proposal_id,old.attempt,old.approved_payload_sha256,old.created_at) then
    raise exception 'Action execution identity is immutable';
  end if;
  if new.status is distinct from old.status and not (
    (old.status='queued' and new.status in ('executing','conflicted','failed')) or
    (old.status='executing' and new.status in ('retrying','succeeded','failed','conflicted')) or
    (old.status='retrying' and new.status in ('executing','failed','conflicted'))
  ) then raise exception 'Invalid action execution state transition'; end if;
  return new;
end
$$;
alter table public.action_proposals enable row level security;
alter table public.action_approval_policies enable row level security;
alter table public.action_approval_decisions enable row level security;
alter table public.action_execution_records enable row level security;
revoke all on public.action_proposals,public.action_approval_policies,public.action_approval_decisions,public.action_execution_records from anon,authenticated;
grant select on public.action_proposals,public.action_approval_decisions,public.action_execution_records to authenticated;
grant select on public.action_approval_policies to authenticated;
create policy action_proposals_read on public.action_proposals for select to authenticated
  using (private.has_org_permission(organization_id,'approvals.read',location_id));
create policy action_approval_policies_read on public.action_approval_policies for select to authenticated
  using (private.has_org_permission(organization_id,'people.manage'));
create policy action_approval_decisions_read on public.action_approval_decisions for select to authenticated
  using (exists(select 1 from public.action_proposals p where p.organization_id=action_approval_decisions.organization_id
    and p.id=action_approval_decisions.proposal_id and private.has_org_permission(p.organization_id,'approvals.read',p.location_id)));
create policy action_execution_records_read on public.action_execution_records for select to authenticated
  using (exists(select 1 from public.action_proposals p where p.organization_id=action_execution_records.organization_id
    and p.id=action_execution_records.proposal_id and private.has_org_permission(p.organization_id,'approvals.read',p.location_id)));
create trigger action_approval_decisions_append_only before update or delete on public.action_approval_decisions
  for each row execute function private.reject_row_change();
create trigger action_execution_record_update_guard before update on public.action_execution_records
  for each row execute function private.guard_action_execution_record_update();
create trigger action_execution_records_no_delete before delete on public.action_execution_records
  for each row execute function private.reject_row_change();

alter table private.durable_jobs drop constraint if exists durable_jobs_job_type_check;
alter table private.durable_jobs add constraint durable_jobs_job_type_check
  check (job_type in ('square.sync','square.webhook','projection.replay','issue.investigate','receipt.process','approved_action.execute'));

create or replace function private.guard_action_proposal_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.organization_id,new.action_type,new.payload,new.payload_sha256,new.request_sha256,new.expected_source_version,new.location_id,
      new.amount_minor,new.currency,new.evidence_refs,new.proposed_by,new.proposed_by_kind,new.idempotency_key,new.expires_at,
      new.supersedes_proposal_id,new.created_at) is distinct from
     (old.organization_id,old.action_type,old.payload,old.payload_sha256,old.request_sha256,old.expected_source_version,old.location_id,
      old.amount_minor,old.currency,old.evidence_refs,old.proposed_by,old.proposed_by_kind,old.idempotency_key,old.expires_at,
      old.supersedes_proposal_id,old.created_at) then
    raise exception 'Action proposal contents are immutable; create a replacement proposal';
  end if;
  if new.status is distinct from old.status and not (
    (old.status='pending_approval' and new.status in ('approved','rejected','cancelled','expired','conflicted')) or
    (old.status='approved' and new.status in ('executing','cancelled','expired','conflicted')) or
    (old.status='executing' and new.status in ('retrying','succeeded','failed','conflicted')) or
    (old.status='retrying' and new.status in ('executing','failed','conflicted'))
  ) then raise exception 'Invalid action proposal state transition'; end if;
  new.updated_at:=now();
  return new;
end
$$;
create trigger action_proposal_update_guard before update on public.action_proposals
  for each row execute function private.guard_action_proposal_update();
create trigger action_proposal_no_delete before delete on public.action_proposals
  for each row execute function private.reject_row_change();

-- Tie optimistic versions to the exact Square object that an action will write.
create or replace function private.action_source_version_matches(
  p_organization_id uuid,p_action_type text,p_payload jsonb,p_expected_source_version text
) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare expected_type text; expected_id text; mapping_id uuid; current_version text;
  target_variation_id uuid; target_location_id uuid; source_exists boolean;
begin
  if p_action_type='square.catalog.item.create' then
    return p_expected_source_version is null and not (p_payload ? 'sourceMappingId');
  end if;
  if p_action_type='square.inventory.count.set' then
    if coalesce(p_payload->>'sourceMappingId','') !~ '^[0-9a-fA-F-]{36}$'
        or coalesce(p_payload->>'locationMappingId','') !~ '^[0-9a-fA-F-]{36}$'
        or coalesce(p_payload->>'businessLocationId','') !~ '^[0-9a-fA-F-]{36}$'
        or nullif(p_payload->>'squareVariationId','') is null
        or nullif(p_payload->>'squareLocationId','') is null
        or p_payload->>'state'<>'IN_STOCK'
        or coalesce(p_payload->>'quantity','') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,5})?$'
        or (p_payload->>'expectedSquareVersion') is distinct from p_expected_source_version then return false; end if;
    mapping_id:=(p_payload->>'sourceMappingId')::uuid;
    select m.entity_id into target_variation_id from public.domain_source_mappings m
      where m.organization_id=p_organization_id and m.id=mapping_id and m.provider='square'
        and m.source_type='ITEM_VARIATION' and m.source_id=p_payload->>'squareVariationId'
        and m.entity_type='catalog_variation' and m.active;
    if not found then return false; end if;
    select m.entity_id into target_location_id from public.domain_source_mappings m
      where m.organization_id=p_organization_id and m.id=(p_payload->>'locationMappingId')::uuid
        and m.provider='square' and m.source_type='LOCATION' and m.source_id=p_payload->>'squareLocationId'
        and m.entity_type='location' and m.active;
    if not found or target_location_id is distinct from (p_payload->>'businessLocationId')::uuid then return false; end if;
    select a.square_source_version into current_version from public.catalog_location_availability a
      where a.organization_id=p_organization_id and a.variation_id=target_variation_id and a.location_id=target_location_id;
    source_exists:=found;
    if p_expected_source_version is null then return not source_exists; end if;
    return source_exists and current_version is not distinct from p_expected_source_version;
  end if;
  if p_action_type in ('square.catalog.item.update','square.catalog.item.archive','square.catalog.variation.add') then
    expected_type:='ITEM'; expected_id:=p_payload->>'squareItemId';
  elsif p_action_type='square.catalog.variation.update' then
    expected_type:='ITEM_VARIATION'; expected_id:=p_payload->>'squareVariationId';
  else
    return false;
  end if;
  if coalesce(p_payload->>'sourceMappingId','') !~ '^[0-9a-fA-F-]{36}$'
      or nullif(expected_id,'') is null or nullif(p_expected_source_version,'') is null then return false; end if;
  mapping_id:=(p_payload->>'sourceMappingId')::uuid;
  select m.source_version into current_version from public.domain_source_mappings m
    where m.organization_id=p_organization_id and m.id=mapping_id and m.provider='square'
      and m.source_type=expected_type and m.source_id=expected_id and m.active;
  return found and current_version is not distinct from p_expected_source_version;
end
$$;
revoke all on function private.action_source_version_matches(uuid,text,jsonb,text) from public,anon,authenticated,service_role;

create or replace function public.propose_action(
  p_organization_id uuid,p_action_type text,p_payload jsonb,p_expected_source_version text,
  p_location_id uuid,p_amount_minor bigint,p_currency text,p_evidence_refs jsonb,
  p_idempotency_key text,p_source_message_ref text default null,p_originating_automation text default null,
  p_supersedes_proposal_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid:=(select auth.uid()); proposal_id uuid; request_hash text; payload_hash text;
  prior public.action_proposals%rowtype; superseded public.action_proposals%rowtype;
begin
  if actor is null or not private.has_org_permission(p_organization_id,'actions.propose',p_location_id) then raise exception 'Action proposal permission required'; end if;
  if p_action_type not in ('square.catalog.item.create','square.catalog.item.update','square.catalog.item.archive',
      'square.catalog.variation.update','square.catalog.variation.add','square.inventory.count.set')
    or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>20000
    or length(btrim(coalesce(p_idempotency_key,''))) not between 8 and 200
    or jsonb_typeof(coalesce(p_evidence_refs,'[]'::jsonb))<>'array'
    or jsonb_array_length(coalesce(p_evidence_refs,'[]'::jsonb))>100
    or (p_amount_minor is null)<>(p_currency is null)
    or (p_currency is not null and p_currency !~ '^[A-Z]{3}$')
    or length(coalesce(p_source_message_ref,''))>300 or length(coalesce(p_originating_automation,''))>200 then
    raise exception 'Invalid action proposal'; end if;
  if p_action_type='square.inventory.count.set' and (p_location_id is null
      or p_payload->>'businessLocationId' is distinct from p_location_id::text
      or not private.has_org_permission(p_organization_id,'inventory.write',p_location_id)) then
    raise exception 'Inventory write permission required';
  end if;
  if p_action_type like 'square.catalog.%' and not private.has_org_permission(p_organization_id,'catalog.write',p_location_id) then
    raise exception 'Catalog write permission required';
  end if;
  if p_action_type in ('square.catalog.variation.update','square.catalog.variation.add')
      or (p_action_type='square.catalog.item.create' and exists(select 1 from jsonb_array_elements(
        case when jsonb_typeof(p_payload->'variations')='array' then p_payload->'variations' else '[]'::jsonb end) v
        where v->>'pricingType'='FIXED_PRICING')) then
    if not private.has_org_permission(p_organization_id,'catalog.price.write',p_location_id) then raise exception 'Catalog price write permission required'; end if;
  end if;
  if not private.action_source_version_matches(p_organization_id,p_action_type,p_payload,p_expected_source_version) then
    raise exception 'Action source mapping or version is invalid'; end if;
  request_hash:=private.sha256_hex(jsonb_build_object('actionType',p_action_type,'payload',p_payload,
    'expectedSourceVersion',p_expected_source_version,'locationId',p_location_id,'amountMinor',p_amount_minor,
    'currency',p_currency,'evidenceRefs',coalesce(p_evidence_refs,'[]'::jsonb),'sourceMessageRef',p_source_message_ref,
    'originatingAutomation',p_originating_automation,'supersedesProposalId',p_supersedes_proposal_id)::text);
  payload_hash:=private.sha256_hex(p_payload::text);
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_idempotency_key,0));
  select * into prior from public.action_proposals where organization_id=p_organization_id and idempotency_key=p_idempotency_key;
  if found then
    if prior.request_sha256<>request_hash then raise exception 'Idempotency key collision'; end if;
    return jsonb_build_object('proposalId',prior.id,'status',prior.status,'payloadSha256',prior.payload_sha256);
  end if;
  if p_supersedes_proposal_id is not null then
    select * into superseded from public.action_proposals where organization_id=p_organization_id and id=p_supersedes_proposal_id for update;
    if not found or superseded.action_type<>p_action_type or superseded.location_id is distinct from p_location_id
        or superseded.status not in ('pending_approval','rejected','expired','cancelled','conflicted') then
      raise exception 'Replacement must reference an eligible proposal of the same action and location';
    end if;
    if superseded.status='pending_approval' then
      if superseded.proposed_by<>actor and not private.has_org_permission(p_organization_id,'approvals.decide',p_location_id) then
        raise exception 'Only the proposer or an approver can replace a pending action';
      end if;
      if superseded.expires_at<=now() then
        update public.action_proposals set status='expired' where organization_id=p_organization_id and id=superseded.id;
        insert into public.action_approval_decisions(organization_id,proposal_id,decision,decided_by,decided_by_kind,reason,proposal_revision_hash,idempotency_key)
          values(p_organization_id,superseded.id,'expired',null,'system','Proposal expired before replacement',superseded.payload_sha256,'proposal-expired:'||superseded.id::text)
          on conflict (organization_id,idempotency_key) do nothing;
        insert into public.audit_events(organization_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id,execution_status)
          values(p_organization_id,'system','expire','action_proposal',superseded.id,
            jsonb_build_object('status','pending_approval'),jsonb_build_object('status','expired'),
            'Proposal expired before replacement','proposal:'||superseded.id::text,'succeeded');
      else
        update public.action_proposals set status='cancelled' where organization_id=p_organization_id and id=superseded.id;
        insert into public.action_approval_decisions(organization_id,proposal_id,decision,decided_by,decided_by_kind,reason,proposal_revision_hash,idempotency_key)
          values(p_organization_id,superseded.id,'cancelled',actor,'human','Replaced by a revised action proposal',superseded.payload_sha256,'proposal-replaced:'||superseded.id::text)
          on conflict (organization_id,idempotency_key) do nothing;
        insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id,execution_status)
          values(p_organization_id,actor,'human','cancel_for_revision','action_proposal',superseded.id,
            jsonb_build_object('status','pending_approval'),jsonb_build_object('status','cancelled','replacementProposalPending',true),
            'Replaced by a revised action proposal','proposal:'||superseded.id::text,'succeeded');
      end if;
    end if;
  end if;
  insert into public.action_proposals(organization_id,action_type,payload,payload_sha256,request_sha256,expected_source_version,location_id,
    amount_minor,currency,evidence_refs,proposed_by,proposed_by_kind,idempotency_key,source_message_ref,originating_automation,supersedes_proposal_id)
  values(p_organization_id,p_action_type,p_payload,payload_hash,request_hash,p_expected_source_version,p_location_id,p_amount_minor,p_currency,
    coalesce(p_evidence_refs,'[]'::jsonb),actor,'human',p_idempotency_key,nullif(p_source_message_ref,''),nullif(p_originating_automation,''),p_supersedes_proposal_id)
  returning id into proposal_id;
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,after_state,reason,correlation_id,source_message_ref,execution_status)
  values(p_organization_id,actor,'human','propose','action_proposal',proposal_id,
    jsonb_build_object('actionType',p_action_type,'payloadSha256',payload_hash,'status','pending_approval'),
    'Action submitted for approval','proposal:'||proposal_id::text,nullif(p_source_message_ref,''),'succeeded');
  return jsonb_build_object('proposalId',proposal_id,'status','pending_approval','payloadSha256',payload_hash);
end
$$;

create or replace function public.decide_action(
  p_organization_id uuid,p_proposal_id uuid,p_decision text,p_reason text,p_expected_payload_sha256 text,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid:=(select auth.uid()); actor_role text; p public.action_proposals%rowtype;
  existing public.action_approval_decisions%rowtype; policy public.action_approval_policies%rowtype;
  required_permission text:='approvals.decide'; required_count integer:=1; approved_count integer:=0;
  current_source_version text; mapping_id uuid; result_status text; job_id uuid;
begin
  if actor is null then raise exception 'Action approval permission required'; end if;
  if p_decision not in ('approved','rejected') or length(btrim(coalesce(p_reason,''))) not between 10 and 1000
     or length(btrim(coalesce(p_idempotency_key,''))) not between 8 and 200 then raise exception 'Invalid action decision'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_proposal_id::text,0));
  select * into p from public.action_proposals where organization_id=p_organization_id and id=p_proposal_id for update;
  if not found then raise exception 'Action proposal not found'; end if;
  select * into existing from public.action_approval_decisions where organization_id=p_organization_id and idempotency_key=p_idempotency_key;
  if found then
    if existing.proposal_id<>p_proposal_id or existing.decision<>p_decision or existing.reason<>btrim(p_reason) then raise exception 'Idempotency key collision'; end if;
    return jsonb_build_object('proposalId',p.id,'status',p.status);
  end if;
  if p.status='expired' then return jsonb_build_object('proposalId',p.id,'status','expired','payloadSha256',p.payload_sha256); end if;
  if p.proposed_by=actor then raise exception 'Proposer cannot approve or reject their own action'; end if;
  if p.status<>'pending_approval' then raise exception 'Action proposal is no longer pending'; end if;
  if p.expires_at<=now() then
    update public.action_proposals set status='expired' where id=p.id;
    insert into public.action_approval_decisions(organization_id,proposal_id,decision,decided_by,decided_by_kind,reason,proposal_revision_hash,idempotency_key)
      values(p_organization_id,p.id,'expired',null,'system','Proposal expired before decision',p.payload_sha256,'proposal-expired:'||p.id::text)
      on conflict (organization_id,idempotency_key) do nothing;
    insert into public.audit_events(organization_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id,execution_status)
      values(p_organization_id,'system','expire','action_proposal',p.id,jsonb_build_object('status','pending_approval'),
        jsonb_build_object('status','expired'),'Proposal expired before decision','proposal:'||p.id::text,'succeeded');
    return jsonb_build_object('proposalId',p.id,'status','expired','payloadSha256',p.payload_sha256);
  end if;
  if p.payload_sha256 is distinct from p_expected_payload_sha256 then raise exception 'Action proposal changed; refresh and review again'; end if;
  if p.expected_source_version is not null or p.action_type='square.inventory.count.set' then
    mapping_id:=(p.payload->>'sourceMappingId')::uuid;
    if p.action_type='square.inventory.count.set' then
      select a.square_source_version into current_source_version from public.catalog_location_availability a
        join public.domain_source_mappings m on m.organization_id=a.organization_id and m.entity_id=a.variation_id
        join public.domain_source_mappings lm on lm.organization_id=a.organization_id and lm.entity_id=a.location_id
        where a.organization_id=p_organization_id and m.id=mapping_id and m.source_type='ITEM_VARIATION'
          and m.source_id=p.payload->>'squareVariationId' and lm.id=(p.payload->>'locationMappingId')::uuid
          and lm.source_type='LOCATION' and lm.source_id=p.payload->>'squareLocationId' and a.location_id=p.location_id;
    else
      select m.source_version into current_source_version from public.domain_source_mappings m
        where m.organization_id=p_organization_id and m.id=mapping_id;
    end if;
    if not private.action_source_version_matches(p_organization_id,p.action_type,p.payload,p.expected_source_version) then
      update public.action_proposals set status='conflicted' where id=p.id;
      insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id,execution_status,outcome_code)
      values(p_organization_id,actor,'human','conflict_detected','action_proposal',p.id,
        jsonb_build_object('expectedSourceVersion',p.expected_source_version),jsonb_build_object('observedSourceVersion',current_source_version),
        btrim(p_reason),'proposal:'||p.id::text,'failed','SOURCE_VERSION_CONFLICT');
      return jsonb_build_object('proposalId',p.id,'status','conflicted','payloadSha256',p.payload_sha256);
    end if;
  end if;
  select * into policy from public.action_approval_policies r where r.organization_id=p_organization_id
    and r.action_type=p.action_type and r.enabled
    and (r.location_id is null or r.location_id=p.location_id)
    and (p.amount_minor is null or (r.min_amount_minor is null or p.amount_minor>=r.min_amount_minor))
    and (p.amount_minor is null or (r.max_amount_minor is null or p.amount_minor<=r.max_amount_minor))
    and (p.amount_minor is not null or (r.min_amount_minor is null and r.max_amount_minor is null))
    and (r.amount_currency is null or r.amount_currency=p.currency)
    order by (r.location_id is not null) desc,r.min_amount_minor desc nulls last,r.max_amount_minor asc nulls last limit 1;
  if found then
    required_permission:=policy.required_permission;
    required_count:=policy.required_approval_count;
  end if;
  if not private.has_org_permission(p_organization_id,required_permission,p.location_id) then raise exception 'Action approval permission required'; end if;
  select m.role into actor_role from public.memberships m where m.organization_id=p_organization_id and m.user_id=actor;
  if policy.id is not null and policy.required_role is not null and actor_role not in (policy.required_role,'owner') then
    raise exception 'Required approver role is not held';
  end if;
  if p_decision='approved' and policy.id is not null and policy.max_single_approver_minor is not null
      and p.amount_minor>policy.max_single_approver_minor then required_count:=greatest(required_count,2); end if;
  insert into public.action_approval_decisions(organization_id,proposal_id,decision,decided_by,reason,proposal_revision_hash,idempotency_key)
  values(p_organization_id,p.id,p_decision,actor,btrim(p_reason),p.payload_sha256,p_idempotency_key);
  if p_decision='approved' then
    select count(*) into approved_count from public.action_approval_decisions d
      where d.organization_id=p_organization_id and d.proposal_id=p.id and d.decision='approved';
    result_status:=case when approved_count>=required_count then 'approved' else 'pending_approval' end;
  else result_status:='rejected'; end if;
  update public.action_proposals set status=result_status where id=p.id;
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id,execution_status)
  values(p_organization_id,actor,'human',p_decision,'action_proposal',p.id,
    jsonb_build_object('status','pending_approval','payloadSha256',p.payload_sha256),
    jsonb_build_object('status',result_status,'payloadSha256',p.payload_sha256,'approvals',approved_count,'requiredApprovals',required_count),btrim(p_reason),'proposal:'||p.id::text,'succeeded');
  if result_status='approved' then
    insert into public.action_execution_records(organization_id,proposal_id,attempt,status,approved_payload_sha256)
      values(p_organization_id,p.id,1,'queued',p.payload_sha256);
    update public.action_proposals set status='executing' where id=p.id;
    insert into private.durable_jobs(organization_id,requested_by,job_type,idempotency_key,payload)
      values(p_organization_id,p.proposed_by,'approved_action.execute','action:'||p.id::text,
        jsonb_build_object('proposalId',p.id,'actionType',p.action_type,'payload',p.payload,'payloadSha256',p.payload_sha256,
          'expectedSourceVersion',p.expected_source_version,'attempt',1)) on conflict do nothing returning id into job_id;
    if job_id is null then
      select j.id into job_id from private.durable_jobs j where j.organization_id=p_organization_id
        and j.job_type='approved_action.execute' and j.idempotency_key='action:'||p.id::text;
    end if;
    insert into public.audit_events(organization_id,actor_kind,action,entity_type,entity_id,after_state,correlation_id,execution_status)
      values(p_organization_id,'system','execution_queued','action_proposal',p.id,
        jsonb_build_object('jobId',job_id,'payloadSha256',p.payload_sha256),'proposal:'||p.id::text,'attempted');
    result_status:='executing';
  end if;
  return jsonb_build_object('proposalId',p.id,'status',result_status,'payloadSha256',p.payload_sha256,'jobId',job_id);
end
$$;

create or replace function public.expire_action_proposals_system(p_organization_id uuid default null,p_limit integer default 500)
returns integer language plpgsql security definer set search_path = '' as $$
declare p public.action_proposals%rowtype; changed integer:=0;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if p_limit not between 1 and 2000 then raise exception 'Invalid expiry batch size'; end if;
  for p in select q.* from public.action_proposals q where (p_organization_id is null or q.organization_id=p_organization_id)
      and q.status='pending_approval' and q.expires_at<=now()
      order by q.expires_at,q.id limit p_limit for update skip locked
  loop
    update public.action_proposals set status='expired' where organization_id=p.organization_id and id=p.id;
    insert into public.action_approval_decisions(organization_id,proposal_id,decision,decided_by,decided_by_kind,reason,proposal_revision_hash,idempotency_key)
      values(p.organization_id,p.id,'expired',null,'system','Proposal expired automatically',p.payload_sha256,'proposal-expired:'||p.id::text)
      on conflict (organization_id,idempotency_key) do nothing;
    insert into public.audit_events(organization_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id,execution_status)
      values(p.organization_id,'system','expire','action_proposal',p.id,jsonb_build_object('status','pending_approval'),
        jsonb_build_object('status','expired'),'Proposal expired automatically','proposal:'||p.id::text,'succeeded');
    changed:=changed+1;
  end loop;
  return changed;
end
$$;
revoke all on function public.expire_action_proposals_system(uuid,integer) from public,anon,authenticated;
grant execute on function public.expire_action_proposals_system(uuid,integer) to service_role;

create or replace function public.cancel_action_proposal(
  p_organization_id uuid,p_proposal_id uuid,p_reason text,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid:=(select auth.uid()); p public.action_proposals%rowtype; existing public.action_approval_decisions%rowtype;
  result_status text; decision_actor uuid; decision_kind text; reason_value text;
begin
  if actor is null or length(btrim(coalesce(p_reason,''))) not between 10 and 1000
      or length(btrim(coalesce(p_idempotency_key,''))) not between 8 and 200 then raise exception 'Invalid action cancellation'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_proposal_id::text,0));
  select * into p from public.action_proposals where organization_id=p_organization_id and id=p_proposal_id for update;
  if not found then raise exception 'Action proposal not found'; end if;
  select * into existing from public.action_approval_decisions where organization_id=p_organization_id and idempotency_key=p_idempotency_key;
  if found then
    if existing.proposal_id<>p_proposal_id or existing.decision<>'cancelled' or existing.decided_by is distinct from actor
        or existing.reason<>btrim(p_reason) then raise exception 'Idempotency key collision'; end if;
    return jsonb_build_object('proposalId',p.id,'status',p.status);
  end if;
  if p.status='expired' then return jsonb_build_object('proposalId',p.id,'status','expired','payloadSha256',p.payload_sha256); end if;
  if p.status<>'pending_approval' then raise exception 'Action proposal is no longer pending'; end if;
  if not private.has_org_permission(p_organization_id,'actions.propose',p.location_id)
      and not private.has_org_permission(p_organization_id,'approvals.decide',p.location_id) then
    raise exception 'Action cancellation permission required'; end if;
  if p.proposed_by<>actor and not private.has_org_permission(p_organization_id,'approvals.decide',p.location_id) then
    raise exception 'Only the proposer or an approver can cancel this action'; end if;
  if p.expires_at<=now() then
    result_status:='expired'; decision_actor:=null; decision_kind:='system'; reason_value:='Proposal expired before cancellation';
  else
    result_status:='cancelled'; decision_actor:=actor; decision_kind:='human'; reason_value:=btrim(p_reason);
  end if;
  update public.action_proposals set status=result_status where organization_id=p_organization_id and id=p.id;
  insert into public.action_approval_decisions(organization_id,proposal_id,decision,decided_by,decided_by_kind,reason,proposal_revision_hash,idempotency_key)
    values(p_organization_id,p.id,result_status,decision_actor,decision_kind,reason_value,p.payload_sha256,
      case when result_status='expired' then 'proposal-expired:'||p.id::text else p_idempotency_key end)
    on conflict (organization_id,idempotency_key) do nothing;
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id,execution_status)
    values(p_organization_id,decision_actor,decision_kind,case when result_status='expired' then 'expire' else 'cancel' end,
      'action_proposal',p.id,jsonb_build_object('status','pending_approval'),jsonb_build_object('status',result_status),reason_value,
      'proposal:'||p.id::text,'succeeded');
  return jsonb_build_object('proposalId',p.id,'status',result_status,'payloadSha256',p.payload_sha256);
end
$$;

create or replace function public.begin_action_execution(p_organization_id uuid,p_proposal_id uuid,p_expected_payload_sha256 text,p_attempt integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.action_proposals%rowtype; rec public.action_execution_records%rowtype; current_source_version text; mapping_id uuid; approved_at timestamptz;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  select * into p from public.action_proposals where organization_id=p_organization_id and id=p_proposal_id for update;
  if not found then raise exception 'Action proposal not found'; end if;
  if p.payload_sha256<>p_expected_payload_sha256 or p_attempt not between 1 and 12 then raise exception 'Approved action is stale or not executable'; end if;
  if p.status not in ('approved','executing','retrying') then return jsonb_build_object('status',p.status); end if;
  select * into rec from public.action_execution_records e where e.organization_id=p_organization_id and e.proposal_id=p.id and e.attempt=p_attempt for update;
  if not found then
    if p.status not in ('retrying','executing') then raise exception 'Action execution attempt was not queued'; end if;
    insert into public.action_execution_records(organization_id,proposal_id,attempt,status,approved_payload_sha256)
      values(p_organization_id,p.id,p_attempt,'queued',p.payload_sha256) returning * into rec;
  end if;
  if rec.status in ('succeeded','failed','conflicted') then return jsonb_build_object('status',rec.status,'attempt',p_attempt); end if;
  if p.expected_source_version is not null or p.action_type='square.inventory.count.set' then
    mapping_id:=(p.payload->>'sourceMappingId')::uuid;
    if p.action_type='square.inventory.count.set' then
      select a.square_source_version into current_source_version from public.catalog_location_availability a
        join public.domain_source_mappings m on m.organization_id=a.organization_id and m.entity_id=a.variation_id
        join public.domain_source_mappings lm on lm.organization_id=a.organization_id and lm.entity_id=a.location_id
        where a.organization_id=p_organization_id and m.id=mapping_id and m.source_type='ITEM_VARIATION'
          and m.source_id=p.payload->>'squareVariationId' and lm.id=(p.payload->>'locationMappingId')::uuid
          and lm.source_type='LOCATION' and lm.source_id=p.payload->>'squareLocationId' and a.location_id=p.location_id;
    else
      select m.source_version into current_source_version from public.domain_source_mappings m
        where m.organization_id=p_organization_id and m.id=mapping_id;
    end if;
    if not private.action_source_version_matches(p_organization_id,p.action_type,p.payload,p.expected_source_version) then
      update public.action_proposals set status='conflicted' where id=p.id;
      update public.action_execution_records set status='conflicted',outcome_code='SOURCE_VERSION_CONFLICT',completed_at=now()
        where organization_id=p_organization_id and proposal_id=p.id and attempt=p_attempt;
      insert into public.audit_events(organization_id,actor_kind,action,entity_type,entity_id,before_state,after_state,correlation_id,execution_status,outcome_code)
        values(p_organization_id,'system','conflict_detected','action_proposal',p.id,
          jsonb_build_object('expectedSourceVersion',p.expected_source_version),jsonb_build_object('observedSourceVersion',current_source_version),
          'proposal:'||p.id::text,'failed','SOURCE_VERSION_CONFLICT');
      return jsonb_build_object('status','conflicted','attempt',p_attempt);
    end if;
  end if;
  update public.action_proposals set status='executing' where id=p.id and status in ('approved','retrying');
  update public.action_execution_records set status='executing',started_at=coalesce(started_at,now())
    where organization_id=p_organization_id and proposal_id=p.id and attempt=p_attempt and status in ('queued','retrying');
  select max(d.created_at) into approved_at from public.action_approval_decisions d
    where d.organization_id=p_organization_id and d.proposal_id=p.id and d.decision='approved';
  return jsonb_build_object('status','executing','attempt',p_attempt,'actionType',p.action_type,'payload',p.payload,
    'payloadSha256',p.payload_sha256,'expectedSourceVersion',p.expected_source_version,'approvedAt',approved_at);
end
$$;

create or replace function public.finish_action_execution(
  p_organization_id uuid,p_proposal_id uuid,p_attempt integer,p_status text,p_outcome_code text,p_result_summary jsonb default '{}'
) returns boolean language plpgsql security definer set search_path = '' as $$
declare rec public.action_execution_records%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if p_status not in ('retrying','succeeded','failed','conflicted') or jsonb_typeof(coalesce(p_result_summary,'{}'::jsonb))<>'object'
     or octet_length(coalesce(p_result_summary,'{}'::jsonb)::text)>4000 then raise exception 'Invalid execution result'; end if;
  select * into rec from public.action_execution_records where organization_id=p_organization_id and proposal_id=p_proposal_id and attempt=p_attempt for update;
  if not found then raise exception 'Action execution attempt not found'; end if;
  if rec.status in ('succeeded','failed','conflicted') then
    if rec.status=p_status and rec.outcome_code is not distinct from p_outcome_code then return true; end if;
    raise exception 'Action execution attempt already has a different terminal outcome';
  end if;
  update public.action_execution_records set status=p_status,outcome_code=p_outcome_code,result_summary=coalesce(p_result_summary,'{}'::jsonb),
    completed_at=case when p_status in ('succeeded','failed','conflicted') then now() else null end where id=rec.id;
  update public.action_proposals set status=p_status where organization_id=p_organization_id and id=p_proposal_id;
  insert into public.audit_events(organization_id,actor_kind,action,entity_type,entity_id,after_state,correlation_id,execution_status,outcome_code)
  values(p_organization_id,'system','execution_'||p_status,'action_proposal',p_proposal_id,
    jsonb_build_object('attempt',p_attempt,'result',coalesce(p_result_summary,'{}'::jsonb)),'proposal:'||p_proposal_id::text,
    case p_status when 'succeeded' then 'succeeded' when 'failed' then 'failed' when 'conflicted' then 'failed' else 'attempted' end,p_outcome_code);
  return true;
end
$$;

create or replace function public.create_custom_role(
  p_organization_id uuid,p_name text,p_description text,p_permissions text[]
) returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid:=(select auth.uid()); role_id uuid; permission_key text;
begin
  if actor is null or not private.has_org_permission(p_organization_id,'people.manage') then raise exception 'People management permission required'; end if;
  if length(btrim(coalesce(p_name,''))) not between 1 and 80 or length(coalesce(p_description,''))>500
    or coalesce(array_length(p_permissions,1),0)>50 then raise exception 'Invalid custom role'; end if;
  if exists(select 1 from unnest(coalesce(p_permissions,array[]::text[])) x
      where x !~ '^[a-z][a-z0-9_.-]{1,99}$' or x in ('people.manage','organization.owner_transfer')) then
    raise exception 'Custom role contains a protected or invalid permission'; end if;
  insert into public.organization_custom_roles(organization_id,name,description,created_by)
    values(p_organization_id,btrim(p_name),btrim(coalesce(p_description,'')),actor) returning id into role_id;
  foreach permission_key in array coalesce(p_permissions,array[]::text[]) loop
    insert into public.custom_role_permissions(organization_id,custom_role_id,permission_key,allowed,changed_by)
      values(p_organization_id,role_id,permission_key,true,actor) on conflict do nothing;
  end loop;
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','create','organization_role',role_id,
      jsonb_build_object('name',btrim(p_name),'permissions',to_jsonb(coalesce(p_permissions,array[]::text[]))),
      'Custom permission role created','role:'||role_id::text);
  return role_id;
end
$$;

create or replace function public.set_membership_role(
  p_organization_id uuid,p_user_id uuid,p_role text,p_custom_role_id uuid,
  p_location_scope_mode text,p_location_ids uuid[]
) returns boolean language plpgsql security definer set search_path = '' as $$
declare actor uuid:=(select auth.uid()); old_row public.memberships%rowtype; before_data jsonb;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner','administrator']) then raise exception 'People management permission required'; end if;
  if p_role not in ('owner','administrator','manager','employee','operator','reviewer','read_only','custom')
    or (p_role='custom')<>(p_custom_role_id is not null) or p_location_scope_mode not in ('all','selected')
    or coalesce(array_length(p_location_ids,1),0)>100
    or (p_location_scope_mode='selected' and coalesce(array_length(p_location_ids,1),0)=0)
    or (p_location_scope_mode='all' and coalesce(array_length(p_location_ids,1),0)>0) then raise exception 'Invalid membership role assignment'; end if;
  if p_custom_role_id is not null and not exists(select 1 from public.organization_custom_roles r
      where r.organization_id=p_organization_id and r.id=p_custom_role_id) then raise exception 'Custom role not found'; end if;
  if exists(select 1 from unnest(coalesce(p_location_ids,array[]::uuid[])) x
      where not exists(select 1 from public.business_locations l where l.organization_id=p_organization_id and l.id=x)) then
    raise exception 'Location scope includes a different organization'; end if;
  select * into old_row from public.memberships m where m.organization_id=p_organization_id and m.user_id=p_user_id for update;
  if not found then raise exception 'Organization membership not found'; end if;
  if not private.has_org_role(p_organization_id,array['owner']) and (old_row.role='owner' or p_role='owner') then
    raise exception 'Only an owner can change owner membership'; end if;
  if old_row.role='owner' and p_role<>'owner' and
      (select count(*) from public.memberships m where m.organization_id=p_organization_id and m.role='owner')<=1 then
    raise exception 'The organization must retain an owner'; end if;
  before_data:=jsonb_build_object('role',old_row.role,'customRoleId',old_row.custom_role_id,'locationScopeMode',old_row.location_scope_mode);
  update public.memberships set role=p_role,custom_role_id=p_custom_role_id,location_scope_mode=p_location_scope_mode
    where organization_id=p_organization_id and user_id=p_user_id;
  delete from public.membership_location_scopes where organization_id=p_organization_id and user_id=p_user_id;
  if p_location_scope_mode='selected' then
    insert into public.membership_location_scopes(organization_id,user_id,location_id)
      select p_organization_id,p_user_id,x from unnest(p_location_ids) x;
  end if;
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','update_role','membership',p_user_id,before_data,
      jsonb_build_object('role',p_role,'customRoleId',p_custom_role_id,'locationScopeMode',p_location_scope_mode,'locations',to_jsonb(coalesce(p_location_ids,array[]::uuid[]))),
      'Membership permissions updated','membership:'||p_user_id::text);
  return true;
end
$$;

create or replace function public.set_role_permission(
  p_organization_id uuid,p_role text,p_permission_key text,p_allowed boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
declare actor uuid:=(select auth.uid());
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner','administrator']) then raise exception 'People management permission required'; end if;
  if p_role not in ('administrator','manager','employee','operator','reviewer','read_only')
    or p_permission_key !~ '^[a-z][a-z0-9_.-]{1,99}$'
    or p_permission_key in ('organization.owner_transfer','people.manage') then raise exception 'Invalid role permission'; end if;
  insert into public.organization_role_permission_overrides(organization_id,role_key,permission_key,allowed,changed_by)
    values(p_organization_id,p_role,p_permission_key,p_allowed,actor)
    on conflict (organization_id,role_key,permission_key) do update set allowed=excluded.allowed,changed_by=excluded.changed_by,changed_at=now();
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','set_permission','organization_role',
      jsonb_build_object('role',p_role,'permission',p_permission_key,'allowed',p_allowed),
      'Role permission policy updated','role-permission:'||p_role||':'||p_permission_key);
  return true;
end
$$;

create or replace function public.set_teams_identity(
  p_organization_id uuid,p_user_id uuid,p_tenant_id uuid,p_teams_user_id uuid,p_email text,p_active boolean,p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid:=(select auth.uid()); identity_row public.external_identity_mappings%rowtype;
  current_row public.external_identity_mappings%rowtype; before_value jsonb; after_value jsonb; action_value text;
begin
  if actor is null or not private.has_org_permission(p_organization_id,'people.manage') then raise exception 'People management permission required'; end if;
  if p_user_id is null or p_tenant_id is null or p_teams_user_id is null or p_active is null
      or length(btrim(coalesce(p_reason,''))) not between 10 and 1000
      or (p_email is not null and (length(p_email)>320 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')) then
    raise exception 'Invalid Teams identity mapping'; end if;
  if not exists(select 1 from public.memberships m where m.organization_id=p_organization_id and m.user_id=p_user_id) then
    raise exception 'Target user is not an organization member'; end if;
  select * into identity_row from public.external_identity_mappings x where x.organization_id=p_organization_id
    and x.provider='microsoft_teams' and x.tenant_id=p_tenant_id and x.external_user_id=p_teams_user_id for update;
  if p_active then
    if found and identity_row.status='active' and identity_row.user_id<>p_user_id then raise exception 'Teams identity is already linked to another member'; end if;
    select * into current_row from public.external_identity_mappings x where x.organization_id=p_organization_id
      and x.provider='microsoft_teams' and x.tenant_id=p_tenant_id and x.user_id=p_user_id and x.status='active' for update;
    if found and current_row.external_user_id<>p_teams_user_id then
      before_value:=jsonb_build_object('provider',current_row.provider,'tenantId',current_row.tenant_id,'teamsUserId',current_row.external_user_id,'userId',current_row.user_id,'status',current_row.status);
      update public.external_identity_mappings set status='inactive' where id=current_row.id;
    end if;
    if identity_row.id is null then
      insert into public.external_identity_mappings(organization_id,user_id,provider,tenant_id,external_user_id,external_email,linked_by)
        values(p_organization_id,p_user_id,'microsoft_teams',p_tenant_id,p_teams_user_id,lower(nullif(btrim(p_email),'')),actor)
        returning * into identity_row;
    else
      if before_value is null then before_value:=jsonb_build_object('provider',identity_row.provider,'tenantId',identity_row.tenant_id,
        'teamsUserId',identity_row.external_user_id,'userId',identity_row.user_id,'status',identity_row.status); end if;
      update public.external_identity_mappings set user_id=p_user_id,external_email=lower(nullif(btrim(p_email),'')),
        status='active',linked_by=actor,linked_at=now() where id=identity_row.id returning * into identity_row;
    end if;
    action_value:='link';
  else
    if identity_row.id is null or identity_row.user_id<>p_user_id or identity_row.status<>'active' then raise exception 'Active Teams identity mapping not found'; end if;
    before_value:=jsonb_build_object('provider',identity_row.provider,'tenantId',identity_row.tenant_id,
      'teamsUserId',identity_row.external_user_id,'userId',identity_row.user_id,'status',identity_row.status);
    update public.external_identity_mappings set status='inactive',linked_by=actor,linked_at=now()
      where id=identity_row.id returning * into identity_row;
    action_value:='unlink';
  end if;
  after_value:=jsonb_build_object('provider',identity_row.provider,'tenantId',identity_row.tenant_id,
    'teamsUserId',identity_row.external_user_id,'userId',identity_row.user_id,'status',identity_row.status);
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human',action_value,'external_identity',identity_row.id,before_value,after_value,btrim(p_reason),
      'teams-identity:'||identity_row.id::text||':'||gen_random_uuid()::text);
  return jsonb_build_object('id',identity_row.id,'status',identity_row.status,'userId',identity_row.user_id);
end
$$;

create or replace function public.set_action_approval_policy(
  p_organization_id uuid,p_action_type text,p_location_id uuid,p_amount_currency text,p_min_amount_minor bigint,p_max_amount_minor bigint,
  p_required_permission text,p_required_role text,p_required_approval_count integer,p_max_single_approver_minor bigint
) returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid:=(select auth.uid()); policy_id uuid; before_value jsonb;
begin
  if actor is null or not private.has_org_permission(p_organization_id,'people.manage') then raise exception 'People management permission required'; end if;
  if p_action_type not in ('square.catalog.item.create','square.catalog.item.update','square.catalog.item.archive','square.catalog.variation.update','square.catalog.variation.add','square.inventory.count.set')
    or p_required_permission not in ('approvals.decide','finance.cost.approve','catalog.price.write')
    or p_required_role not in ('owner','administrator','manager','reviewer')
    or p_required_approval_count not between 1 and 5
    or (p_min_amount_minor is not null and p_min_amount_minor<0)
    or (p_max_amount_minor is not null and p_max_amount_minor<0)
    or (p_min_amount_minor is not null and p_max_amount_minor is not null and p_max_amount_minor<p_min_amount_minor)
    or (p_max_single_approver_minor is not null and p_max_single_approver_minor<0)
    or (p_amount_currency is not null and p_amount_currency !~ '^[A-Z]{3}$')
    or ((p_min_amount_minor is not null or p_max_amount_minor is not null or p_max_single_approver_minor is not null) <> (p_amount_currency is not null))
    then raise exception 'Invalid approval policy'; end if;
  if p_location_id is not null and not exists(select 1 from public.business_locations l where l.organization_id=p_organization_id and l.id=p_location_id) then
    raise exception 'Approval policy location belongs to a different organization'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_action_type||':'||coalesce(p_location_id::text,'all'),0));
  select r.id,to_jsonb(r) into policy_id,before_value from public.action_approval_policies r where r.organization_id=p_organization_id and r.action_type=p_action_type
    and r.location_id is not distinct from p_location_id and r.min_amount_minor is not distinct from p_min_amount_minor
    and r.max_amount_minor is not distinct from p_max_amount_minor and r.amount_currency is not distinct from p_amount_currency limit 1 for update;
  if policy_id is null then
    insert into public.action_approval_policies(organization_id,action_type,location_id,amount_currency,min_amount_minor,max_amount_minor,
      required_permission,required_role,required_approval_count,max_single_approver_minor,changed_by)
    values(p_organization_id,p_action_type,p_location_id,p_amount_currency,p_min_amount_minor,p_max_amount_minor,p_required_permission,
      p_required_role,p_required_approval_count,p_max_single_approver_minor,actor) returning id into policy_id;
  else
    update public.action_approval_policies set required_permission=p_required_permission,required_role=p_required_role,
      required_approval_count=p_required_approval_count,max_single_approver_minor=p_max_single_approver_minor,
      enabled=true,changed_by=actor,changed_at=now() where id=policy_id;
  end if;
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','set_approval_policy','approval_policy',policy_id,
      before_value,
      jsonb_build_object('actionType',p_action_type,'locationId',p_location_id,'minAmountMinor',p_min_amount_minor,
        'amountCurrency',p_amount_currency,'maxAmountMinor',p_max_amount_minor,'requiredPermission',p_required_permission,'requiredRole',p_required_role,
        'requiredApprovalCount',p_required_approval_count,'maxSingleApproverMinor',p_max_single_approver_minor),
      'Approval threshold policy updated','approval-policy:'||policy_id::text);
  return policy_id;
end
$$;

create or replace function public.upsert_square_catalog_entities(p_organization_id uuid,p_facts jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare f jsonb; target_item_id uuid; entity_id uuid; target_category_id uuid; fact_count integer:=0; version_value text; before_value jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if jsonb_typeof(p_facts)<>'array' or jsonb_array_length(p_facts)>2000 then raise exception 'Invalid Square catalog facts'; end if;
  for f in select v.fact from private.square_fact_current c join private.square_fact_versions v
      using (organization_id,fact_kind,object_id,object_version)
    where c.organization_id=p_organization_id and c.fact_kind='catalog'
    order by case v.fact->>'objectType' when 'CATEGORY' then 0 when 'ITEM' then 1 else 2 end,v.object_id loop
    if f->>'kind'<>'catalog' or coalesce(f->>'objectId','')='' or coalesce(f->>'objectType','') not in ('CATEGORY','ITEM','ITEM_VARIATION') then continue; end if;
    version_value:=split_part(coalesce(f->>'version',''), '|', 1);
    if version_value='' then raise exception 'Square catalog fact has no source version'; end if;
    if f->>'objectType'='CATEGORY' then
      select m.entity_id into entity_id from public.domain_source_mappings m where m.organization_id=p_organization_id and m.provider='square' and m.source_type='CATEGORY' and m.source_id=f->>'objectId' for update;
      if entity_id is null then
        insert into public.catalog_categories(organization_id,name,status)
          values(p_organization_id,coalesce(nullif(f->>'name',''),'Unnamed category'),case when coalesce((f->>'isDeleted')::boolean,false) then 'archived' else 'active' end) returning id into entity_id;
        insert into public.domain_source_mappings(organization_id,provider,source_type,source_id,entity_type,entity_id,source_version,source_hash,source_updated_at,ingestion_actor_kind,active)
          values(p_organization_id,'square','CATEGORY',f->>'objectId','category',entity_id,version_value,
            private.sha256_hex(f::text),nullif(f->>'sourceUpdatedAt','')::timestamptz,'integration',not coalesce((f->>'isDeleted')::boolean,false));
      else
        update public.catalog_categories set name=coalesce(nullif(f->>'name',''),'Unnamed category'),
          status=case when coalesce((f->>'isDeleted')::boolean,false) then 'archived' else 'active' end,
          revision=revision+1,updated_at=now() where organization_id=p_organization_id and id=entity_id
          and (name is distinct from coalesce(nullif(f->>'name',''),'Unnamed category') or status is distinct from case when coalesce((f->>'isDeleted')::boolean,false) then 'archived' else 'active' end);
        update public.domain_source_mappings set source_version=version_value,source_hash=private.sha256_hex(f::text),
          source_updated_at=nullif(f->>'sourceUpdatedAt','')::timestamptz,observed_at=now(),active=not coalesce((f->>'isDeleted')::boolean,false)
          where organization_id=p_organization_id and provider='square' and source_type='CATEGORY' and source_id=f->>'objectId'
            and (source_version is distinct from version_value or source_hash is distinct from private.sha256_hex(f::text)
              or active is distinct from not coalesce((f->>'isDeleted')::boolean,false));
      end if;
      fact_count:=fact_count+1;
    elsif f->>'objectType'='ITEM' then
      target_category_id:=null;
      if nullif(f->>'categoryId','') is not null then select m.entity_id into target_category_id from public.domain_source_mappings m
        where m.organization_id=p_organization_id and m.provider='square' and m.source_type='CATEGORY' and m.source_id=f->>'categoryId' and m.active; end if;
      select m.entity_id into entity_id from public.domain_source_mappings m where m.organization_id=p_organization_id and m.provider='square' and m.source_type='ITEM' and m.source_id=f->>'objectId' for update;
      if entity_id is null then
        insert into public.catalog_items(organization_id,category_id,name,description,status)
          values(p_organization_id,target_category_id,coalesce(nullif(f->>'name',''),'Unnamed item'),coalesce(f->>'description',''),
            case when coalesce((f->>'isDeleted')::boolean,false) or coalesce((f->>'isArchived')::boolean,false) then 'archived' else 'active' end) returning id into entity_id;
        insert into public.domain_source_mappings(organization_id,provider,source_type,source_id,entity_type,entity_id,source_version,source_hash,source_updated_at,ingestion_actor_kind,active)
          values(p_organization_id,'square','ITEM',f->>'objectId','catalog_item',entity_id,version_value,
            private.sha256_hex(f::text),nullif(f->>'sourceUpdatedAt','')::timestamptz,'integration',not coalesce((f->>'isDeleted')::boolean,false));
      else
        select to_jsonb(i) into before_value from public.catalog_items i where i.organization_id=p_organization_id and i.id=entity_id;
        update public.catalog_items set category_id=target_category_id,name=coalesce(nullif(f->>'name',''),'Unnamed item'),description=coalesce(f->>'description',''),
          status=case when coalesce((f->>'isDeleted')::boolean,false) or coalesce((f->>'isArchived')::boolean,false) then 'archived' else 'active' end,
          revision=revision+1,updated_at=now()
          where organization_id=p_organization_id and id=entity_id
            and (catalog_items.category_id is distinct from target_category_id or name is distinct from coalesce(nullif(f->>'name',''),'Unnamed item')
              or description is distinct from coalesce(f->>'description','') or status is distinct from case when coalesce((f->>'isDeleted')::boolean,false) or coalesce((f->>'isArchived')::boolean,false) then 'archived' else 'active' end);
        update public.domain_source_mappings set source_version=version_value,source_hash=private.sha256_hex(f::text),
          source_updated_at=nullif(f->>'sourceUpdatedAt','')::timestamptz,observed_at=now(),active=not coalesce((f->>'isDeleted')::boolean,false)
          where organization_id=p_organization_id and provider='square' and source_type='ITEM' and source_id=f->>'objectId'
            and (source_version is distinct from version_value or source_hash is distinct from private.sha256_hex(f::text)
              or active is distinct from not coalesce((f->>'isDeleted')::boolean,false));
      end if;
      fact_count:=fact_count+1;
    else
      select m.entity_id into target_item_id from public.domain_source_mappings m where m.organization_id=p_organization_id and m.provider='square' and m.source_type='ITEM' and m.source_id=f->>'itemId' and m.active;
      if target_item_id is null then raise exception 'Square catalog variation parent has not been imported'; end if;
      select m.entity_id into entity_id from public.domain_source_mappings m where m.organization_id=p_organization_id and m.provider='square' and m.source_type='ITEM_VARIATION' and m.source_id=f->>'objectId' for update;
      if entity_id is null then
        insert into public.catalog_variations(organization_id,item_id,name,sku,price_minor,currency,status)
          values(p_organization_id,target_item_id,coalesce(nullif(f->>'name',''),'Default'),nullif(f->>'sku',''),
            case when coalesce(f->>'priceMinor','') ~ '^[0-9]+$' then (f->>'priceMinor')::bigint end,
            nullif(f->>'currency',''),case when coalesce((f->>'isDeleted')::boolean,false) then 'archived' else 'active' end) returning id into entity_id;
        insert into public.domain_source_mappings(organization_id,provider,source_type,source_id,entity_type,entity_id,source_version,source_hash,source_updated_at,ingestion_actor_kind,active)
          values(p_organization_id,'square','ITEM_VARIATION',f->>'objectId','catalog_variation',entity_id,version_value,
            private.sha256_hex(f::text),nullif(f->>'sourceUpdatedAt','')::timestamptz,'integration',not coalesce((f->>'isDeleted')::boolean,false));
      else
        update public.catalog_variations set item_id=target_item_id,name=coalesce(nullif(f->>'name',''),'Default'),sku=nullif(f->>'sku',''),
          price_minor=case when coalesce(f->>'priceMinor','') ~ '^[0-9]+$' then (f->>'priceMinor')::bigint end,currency=nullif(f->>'currency',''),
          status=case when coalesce((f->>'isDeleted')::boolean,false) then 'archived' else 'active' end,revision=revision+1,updated_at=now()
          where organization_id=p_organization_id and id=entity_id
            and (catalog_variations.item_id is distinct from target_item_id or name is distinct from coalesce(nullif(f->>'name',''),'Default')
              or sku is distinct from nullif(f->>'sku','')
              or price_minor is distinct from case when coalesce(f->>'priceMinor','') ~ '^[0-9]+$' then (f->>'priceMinor')::bigint end
              or currency is distinct from nullif(f->>'currency','')
              or status is distinct from case when coalesce((f->>'isDeleted')::boolean,false) then 'archived' else 'active' end);
        update public.domain_source_mappings set source_version=version_value,source_hash=private.sha256_hex(f::text),
          source_updated_at=nullif(f->>'sourceUpdatedAt','')::timestamptz,observed_at=now(),active=not coalesce((f->>'isDeleted')::boolean,false)
          where organization_id=p_organization_id and provider='square' and source_type='ITEM_VARIATION' and source_id=f->>'objectId'
            and (source_version is distinct from version_value or source_hash is distinct from private.sha256_hex(f::text)
              or active is distinct from not coalesce((f->>'isDeleted')::boolean,false));
      end if;
      fact_count:=fact_count+1;
    end if;
  end loop;
  return fact_count;
end
$$;

create or replace function public.get_domain_catalog(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not private.has_org_permission(p_organization_id,'catalog.read') then raise exception 'Catalog read permission required'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('itemId',i.id,'name',i.name,'description',i.description,'status',i.status,
      'revision',i.revision,'categoryId',i.category_id,'variations',coalesce(v.rows,'[]'::jsonb)) order by i.name,i.id),'[]'::jsonb)
    into result from public.catalog_items i left join lateral (
      select jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'sku',v.sku,'barcode',v.barcode,'unitOfMeasure',v.unit_of_measure,
        'priceMinor',v.price_minor,'currency',v.currency,'status',v.status,'revision',v.revision,
        'squareId',m.source_id,'squareVersion',m.source_version,'sourceMappingId',m.id) order by v.name,v.id) rows
      from public.catalog_variations v left join public.domain_source_mappings m on m.organization_id=v.organization_id
        and m.entity_type='catalog_variation' and m.entity_id=v.id and m.active
      where v.organization_id=i.organization_id and v.item_id=i.id
    ) v on true where i.organization_id=p_organization_id;
  return result;
end
$$;

create or replace function public.upsert_square_locations(p_organization_id uuid,p_locations jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare f jsonb; entity_id uuid; version_value text; changed_count integer:=0; status_value text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if jsonb_typeof(p_locations)<>'array' or jsonb_array_length(p_locations)>1000 then raise exception 'Invalid Square location page'; end if;
  for f in select value from jsonb_array_elements(p_locations) loop
    if coalesce(f->>'id','')='' or length(f->>'id')>200 or coalesce(f->>'name','')='' then continue; end if;
    status_value:=case when upper(coalesce(f->>'status','ACTIVE'))='ACTIVE' then 'active' else 'inactive' end;
    version_value:=coalesce(nullif(f->>'version',''),nullif(f->>'updatedAt',''),private.sha256_hex(f::text));
    select m.entity_id into entity_id from public.domain_source_mappings m where m.organization_id=p_organization_id
      and m.provider='square' and m.source_type='LOCATION' and m.source_id=f->>'id' for update;
    if entity_id is null then
      insert into public.business_locations(organization_id,name,timezone,address,status)
        values(p_organization_id,left(f->>'name',200),nullif(f->>'timezone',''),coalesce(f->'address','{}'::jsonb),status_value) returning id into entity_id;
      insert into public.domain_source_mappings(organization_id,provider,source_type,source_id,entity_type,entity_id,source_version,source_hash,source_updated_at,ingestion_actor_kind,active)
        values(p_organization_id,'square','LOCATION',f->>'id','location',entity_id,version_value,
          private.sha256_hex(f::text),nullif(f->>'updatedAt','')::timestamptz,'integration',status_value='active');
    else
      update public.business_locations set name=left(f->>'name',200),timezone=nullif(f->>'timezone',''),
        address=coalesce(f->'address','{}'::jsonb),status=status_value,revision=revision+1,updated_at=now()
        where organization_id=p_organization_id and id=entity_id
          and (name is distinct from left(f->>'name',200) or timezone is distinct from nullif(f->>'timezone','')
            or address is distinct from coalesce(f->'address','{}'::jsonb) or status is distinct from status_value);
      update public.domain_source_mappings set source_version=version_value,source_hash=private.sha256_hex(f::text),
        source_updated_at=nullif(f->>'updatedAt','')::timestamptz,observed_at=now(),active=status_value='active'
        where organization_id=p_organization_id and provider='square' and source_type='LOCATION' and source_id=f->>'id';
    end if;
    changed_count:=changed_count+1;
  end loop;
  return changed_count;
end
$$;

create or replace function public.get_square_inventory_targets_system(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  select jsonb_build_object(
    'catalogObjectIds',coalesce((select jsonb_agg(m.source_id order by m.source_id) from public.domain_source_mappings m
      join public.catalog_variations v on v.organization_id=m.organization_id and v.id=m.entity_id
      join public.catalog_items i on i.organization_id=v.organization_id and i.id=v.item_id and i.status='active'
      where m.organization_id=p_organization_id and m.provider='square' and m.source_type='ITEM_VARIATION'
        and m.entity_type='catalog_variation' and m.active and v.status='active'),'[]'::jsonb),
    'locationIds',coalesce((select jsonb_agg(m.source_id order by m.source_id) from public.domain_source_mappings m
      join public.business_locations l on l.organization_id=m.organization_id and l.id=m.entity_id
      where m.organization_id=p_organization_id and m.provider='square' and m.source_type='LOCATION'
        and m.entity_type='location' and m.active and l.status='active'),'[]'::jsonb)) into result;
  return result;
end
$$;

create or replace function public.get_square_inventory_counts(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if exists(select 1 from public.business_locations l where l.organization_id=p_organization_id)
      and not exists(select 1 from public.business_locations l where l.organization_id=p_organization_id
        and private.has_org_permission(p_organization_id,'inventory.read',l.id)) then
    raise exception 'Inventory read permission required';
  end if;
  with latest as (
    select distinct on (o.organization_id,o.variation_id,o.location_id,o.state) o.*
    from public.square_inventory_count_observations o
    where o.organization_id=p_organization_id
    order by o.organization_id,o.variation_id,o.location_id,o.state,o.calculated_at desc,o.observed_at desc
  ), mapped_targets as (
    select v.id variation_id,i.id item_id,i.name item_name,v.name variation_name,v.sku,
      l.id location_id,l.name location_name,vm.source_id square_catalog_object_id,lm.source_id square_location_id,
      vm.id variation_mapping_id,lm.id location_mapping_id
    from public.domain_source_mappings vm
    join public.catalog_variations v on v.organization_id=vm.organization_id and v.id=vm.entity_id and v.status='active'
    join public.catalog_items i on i.organization_id=v.organization_id and i.id=v.item_id and i.status='active'
    join public.business_locations l on l.organization_id=vm.organization_id and l.status='active'
    join public.domain_source_mappings lm on lm.organization_id=l.organization_id and lm.provider='square'
      and lm.source_type='LOCATION' and lm.entity_type='location' and lm.entity_id=l.id and lm.active
    where vm.organization_id=p_organization_id and vm.provider='square' and vm.source_type='ITEM_VARIATION'
      and vm.entity_type='catalog_variation' and vm.active
  ), inventory_rows as (
    select t.variation_id,t.item_id,t.item_name,t.variation_name,t.sku,t.location_id,t.location_name,o.state,
      o.quantity,o.calculated_at,o.observed_at,o.source_version,o.square_catalog_object_id,o.square_location_id,
      t.variation_mapping_id,t.location_mapping_id
    from latest o join mapped_targets t on t.variation_id=o.variation_id and t.location_id=o.location_id
      and t.square_catalog_object_id=o.square_catalog_object_id and t.square_location_id=o.square_location_id
    union all
    select t.variation_id,t.item_id,t.item_name,t.variation_name,t.sku,t.location_id,t.location_name,'IN_STOCK',
      null::numeric,null::timestamptz,null::timestamptz,null::text,t.square_catalog_object_id,t.square_location_id,
      t.variation_mapping_id,t.location_mapping_id
    from mapped_targets t where not exists(select 1 from latest o where o.organization_id=p_organization_id
      and o.variation_id=t.variation_id and o.location_id=t.location_id and o.state='IN_STOCK')
  )
  select coalesce(jsonb_agg(jsonb_build_object('variationId',q.variation_id,'itemId',q.item_id,'itemName',q.item_name,
      'variationName',q.variation_name,'sku',q.sku,'locationId',q.location_id,'locationName',q.location_name,'state',q.state,
      'quantity',q.quantity,'calculatedAt',q.calculated_at,'observedAt',q.observed_at,'sourceVersion',q.source_version,
      'squareVariationId',q.square_catalog_object_id,'squareLocationId',q.square_location_id,
      'sourceMappingId',q.variation_mapping_id,'locationMappingId',q.location_mapping_id)
      order by q.location_name,q.item_name,q.variation_name,q.state),'[]'::jsonb) into result
  from (select * from inventory_rows q where private.has_org_permission(p_organization_id,'inventory.read',q.location_id)
    order by q.location_name,q.item_name,q.variation_name,q.state limit 5000) q;
  return result;
end
$$;

create or replace function public.upsert_square_inventory_counts(p_organization_id uuid,p_counts jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare f jsonb; target_variation_id uuid; target_location_id uuid; version_value text; hash_value text;
  quantity_value numeric; calculated_value timestamptz; state_value text; inserted_count integer:=0;
  changed_count integer:=0; unmapped_count integer:=0; conflict_count integer:=0; inserted_rows integer;
  current_row public.catalog_location_availability%rowtype; unmapped_refs jsonb:='[]'::jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if jsonb_typeof(p_counts)<>'array' or jsonb_array_length(p_counts)>1000 then raise exception 'Invalid Square inventory count batch'; end if;
  for f in select value from jsonb_array_elements(p_counts) loop
    if coalesce(f->>'catalogObjectId','')='' or coalesce(f->>'locationId','')=''
        or coalesce(f->>'state','') not in ('IN_STOCK','SOLD','RETURNED_BY_CUSTOMER','RESERVED_FOR_SALE','WASTE','UNLINKED_RETURN','NONE')
        or coalesce(f->>'quantity','') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,5})?$'
        or coalesce(f->>'calculatedAt','')='' or coalesce(f->>'sourceVersion','')='' then
      raise exception 'Invalid Square inventory count';
    end if;
    quantity_value:=(f->>'quantity')::numeric;
    calculated_value:=(f->>'calculatedAt')::timestamptz;
    state_value:=f->>'state';
    version_value:=left(f->>'sourceVersion',300);
    hash_value:=coalesce(nullif(f->>'sourceHash',''),private.sha256_hex(f::text));
    if length(hash_value)<>64 or hash_value !~ '^[0-9a-f]{64}$' then raise exception 'Invalid Square inventory hash'; end if;
    select m.entity_id into target_variation_id from public.domain_source_mappings m
      where m.organization_id=p_organization_id and m.provider='square' and m.source_type='ITEM_VARIATION'
        and m.source_id=f->>'catalogObjectId' and m.entity_type='catalog_variation' and m.active;
    select m.entity_id into target_location_id from public.domain_source_mappings m
      where m.organization_id=p_organization_id and m.provider='square' and m.source_type='LOCATION'
        and m.source_id=f->>'locationId' and m.entity_type='location' and m.active;
    if target_variation_id is null or target_location_id is null then
      unmapped_count:=unmapped_count+1;
      if jsonb_array_length(unmapped_refs)<50 then unmapped_refs:=unmapped_refs||jsonb_build_array(jsonb_build_object(
        'catalogObjectId',f->>'catalogObjectId','locationId',f->>'locationId')); end if;
      continue;
    end if;
    insert into public.square_inventory_count_observations(organization_id,variation_id,location_id,
      square_catalog_object_id,square_location_id,state,quantity,calculated_at,source_version,source_hash)
    values(p_organization_id,target_variation_id,target_location_id,f->>'catalogObjectId',f->>'locationId',state_value,
      quantity_value,calculated_value,version_value,hash_value)
    on conflict (organization_id,variation_id,location_id,state,source_version) do nothing;
    get diagnostics inserted_rows=row_count;
    inserted_count:=inserted_count+inserted_rows;
    if state_value<>'IN_STOCK' then continue; end if;
    select * into current_row from public.catalog_location_availability a where a.organization_id=p_organization_id
      and a.variation_id=target_variation_id and a.location_id=target_location_id for update;
    if not found then
      insert into public.catalog_location_availability(organization_id,variation_id,location_id,availability,quantity,
        observed_at,square_source_version,square_source_hash)
      values(p_organization_id,target_variation_id,target_location_id,case when quantity_value=0 then 'unavailable' else 'available' end,
        quantity_value,calculated_value,version_value,hash_value);
      changed_count:=changed_count+1;
    elsif calculated_value>coalesce(current_row.observed_at,'-infinity'::timestamptz) then
      update public.catalog_location_availability set availability=case when quantity_value=0 then 'unavailable' else 'available' end,
        quantity=quantity_value,observed_at=calculated_value,square_source_version=version_value,square_source_hash=hash_value,updated_at=now()
        where organization_id=p_organization_id and variation_id=target_variation_id and location_id=target_location_id;
      changed_count:=changed_count+1;
    elsif calculated_value=current_row.observed_at and current_row.square_source_version is distinct from version_value then
      conflict_count:=conflict_count+1;
    end if;
  end loop;
  return jsonb_build_object('inserted',inserted_count,'changed',changed_count,'unmappedCount',unmapped_count,
    'conflictCount',conflict_count,'unmappedRefs',unmapped_refs);
end
$$;

revoke all on function public.propose_action(uuid,text,jsonb,text,uuid,bigint,text,jsonb,text,text,text,uuid) from public,anon;
revoke all on function public.decide_action(uuid,uuid,text,text,text,text) from public,anon;
revoke all on function public.cancel_action_proposal(uuid,uuid,text,text) from public,anon;
revoke all on function public.begin_action_execution(uuid,uuid,text,integer) from public,anon,authenticated;
revoke all on function public.finish_action_execution(uuid,uuid,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.propose_action(uuid,text,jsonb,text,uuid,bigint,text,jsonb,text,text,text,uuid) to authenticated;
grant execute on function public.decide_action(uuid,uuid,text,text,text,text) to authenticated;
grant execute on function public.cancel_action_proposal(uuid,uuid,text,text) to authenticated;
grant execute on function public.begin_action_execution(uuid,uuid,text,integer) to service_role;
grant execute on function public.finish_action_execution(uuid,uuid,integer,text,text,jsonb) to service_role;
revoke all on function public.create_custom_role(uuid,text,text,text[]) from public,anon;
revoke all on function public.set_membership_role(uuid,uuid,text,uuid,text,uuid[]) from public,anon;
revoke all on function public.set_role_permission(uuid,text,text,boolean) from public,anon;
revoke all on function public.set_teams_identity(uuid,uuid,uuid,uuid,text,boolean,text) from public,anon;
revoke all on function public.set_action_approval_policy(uuid,text,uuid,text,bigint,bigint,text,text,integer,bigint) from public,anon;
revoke all on function public.upsert_square_catalog_entities(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.get_domain_catalog(uuid) from public,anon;
revoke all on function public.upsert_square_locations(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.get_square_inventory_targets_system(uuid) from public,anon,authenticated;
revoke all on function public.get_square_inventory_counts(uuid) from public,anon;
revoke all on function public.upsert_square_inventory_counts(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.create_custom_role(uuid,text,text,text[]) to authenticated;
grant execute on function public.set_membership_role(uuid,uuid,text,uuid,text,uuid[]) to authenticated;
grant execute on function public.set_role_permission(uuid,text,text,boolean) to authenticated;
grant execute on function public.set_teams_identity(uuid,uuid,uuid,uuid,text,boolean,text) to authenticated;
grant execute on function public.set_action_approval_policy(uuid,text,uuid,text,bigint,bigint,text,text,integer,bigint) to authenticated;
grant execute on function public.upsert_square_catalog_entities(uuid,jsonb) to service_role;
grant execute on function public.get_domain_catalog(uuid) to authenticated;
grant execute on function public.upsert_square_locations(uuid,jsonb) to service_role;
grant execute on function public.get_square_inventory_targets_system(uuid) to service_role;
grant execute on function public.get_square_inventory_counts(uuid) to authenticated;
grant execute on function public.upsert_square_inventory_counts(uuid,jsonb) to service_role;

-- pgcrypto is installed in `extensions` on hosted Supabase and can be in
-- `public` on standalone PostgreSQL. Resolve it explicitly under the empty
-- search path used by security-definer routines.
create or replace function private.sha256_hex(p_value text)
returns text language plpgsql immutable security definer set search_path = '' as $$
declare result bytea;
begin
  if to_regprocedure('extensions.digest(bytea,text)') is not null then
    execute 'select extensions.digest($1, $2)' into result using convert_to(p_value,'UTF8'),'sha256';
  else
    execute 'select public.digest($1, $2)' into result using convert_to(p_value,'UTF8'),'sha256';
  end if;
  return encode(result,'hex');
end
$$;
revoke all on function private.sha256_hex(text) from public,anon,authenticated;
grant execute on function private.sha256_hex(text) to service_role;

create or replace function public.has_organization_permission(
  p_organization_id uuid,p_permission_key text,p_location_id uuid default null
) returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_org_permission(p_organization_id,p_permission_key,p_location_id)
$$;
revoke all on function public.has_organization_permission(uuid,text,uuid) from public,anon;
grant execute on function public.has_organization_permission(uuid,text,uuid) to authenticated;

-- Prevent direct execution of the older membership-only finance RPCs. These
-- wrappers enforce the same explicit permission model used by row-level RLS.
create or replace function public.get_product_analytics_facts_authorized(
  p_organization_id uuid,p_start_at timestamptz,p_end_at timestamptz
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_org_permission(p_organization_id,'finance.metrics.read') then
    raise exception 'Finance metrics permission required';
  end if;
  return public.get_product_analytics_facts(p_organization_id,p_start_at,p_end_at);
end
$$;
create or replace function public.get_product_catalog_items_authorized(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare catalog_items jsonb;
begin
  if not private.has_org_permission(p_organization_id,'finance.metrics.read') then
    raise exception 'Finance metrics permission required';
  end if;
  catalog_items:=public.get_product_catalog_items(p_organization_id);
  return coalesce((select jsonb_agg(item.value||jsonb_build_object(
      'sourceMappingId',variation_map.id,'expectedSquareVersion',variation_map.source_version,
      'itemSourceMappingId',item_map.id,'itemExpectedSquareVersion',item_map.source_version)
      order by item.ordinality)
    from jsonb_array_elements(coalesce(catalog_items,'[]'::jsonb)) with ordinality as item(value,ordinality)
    left join public.domain_source_mappings variation_map on variation_map.organization_id=p_organization_id
      and variation_map.provider='square' and variation_map.source_type='ITEM_VARIATION'
      and variation_map.source_id=item.value->>'id' and variation_map.active
    left join public.domain_source_mappings item_map on item_map.organization_id=p_organization_id
      and item_map.provider='square' and item_map.source_type='ITEM'
      and item_map.source_id=item.value->>'squareItemId' and item_map.active),'[]'::jsonb);
end
$$;
create or replace function public.get_inventory_snapshot_authorized(
  p_organization_id uuid,p_start_at timestamptz,p_end_at timestamptz,p_currency text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not private.has_org_permission(p_organization_id,'inventory.read') then
    raise exception 'Inventory read permission required';
  end if;
  result:=public.get_inventory_snapshot(p_organization_id,p_start_at,p_end_at,p_currency);
  if not private.has_org_permission(p_organization_id,'finance.metrics.read') then
    result:=jsonb_set(result,'{items}',coalesce((select jsonb_agg(item.value-'unit_cost_minor'-'unitCostMinor')
      from jsonb_array_elements(coalesce(result->'items','[]'::jsonb)) as item(value)),'[]'::jsonb),true);
    result:=jsonb_set(result,'{movements}',coalesce((select jsonb_agg(movement.value-'unit_cost_minor'-'unitCostMinor'-'line_cost_minor'-'cost_minor')
      from jsonb_array_elements(coalesce(result->'movements','[]'::jsonb)) as movement(value)),'[]'::jsonb),true);
  end if;
  return result;
end
$$;
revoke all on function public.get_product_analytics_facts(uuid,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.get_product_catalog_items(uuid) from public,anon,authenticated;
revoke all on function public.get_inventory_snapshot(uuid,timestamptz,timestamptz,text) from public,anon,authenticated;
revoke all on function public.get_product_analytics_facts_authorized(uuid,timestamptz,timestamptz) from public,anon;
revoke all on function public.get_product_catalog_items_authorized(uuid) from public,anon;
revoke all on function public.get_inventory_snapshot_authorized(uuid,timestamptz,timestamptz,text) from public,anon;
grant execute on function public.get_product_analytics_facts_authorized(uuid,timestamptz,timestamptz) to authenticated;
grant execute on function public.get_product_catalog_items_authorized(uuid) to authenticated;
grant execute on function public.get_inventory_snapshot_authorized(uuid,timestamptz,timestamptz,text) to authenticated;

-- Inventory employees can view quantities and evidence, but the table's
-- acquisition-cost column is available only through finance-gated RPCs.
drop policy if exists inventory_movements_read on public.inventory_movements;
create policy inventory_movements_read on public.inventory_movements for select to authenticated
  using (private.has_org_permission(organization_id,'inventory.read'));
revoke select on public.inventory_movements from authenticated;
grant select (id,organization_id,item_definition_id,inventory_item_id,item_name,square_catalog_object_id,
  movement_type,quantity_delta,currency,occurred_at,cash_movement_id,evidence_file_id,reason,
  idempotency_key,created_by,created_at) on public.inventory_movements to authenticated;

-- Membership administrators can manage non-owner assignments. Owner transfer
-- remains a separate guarded process and cannot be performed through this RPC.
create or replace function public.set_membership_role(
  p_organization_id uuid,p_user_id uuid,p_role text,p_custom_role_id uuid,
  p_location_scope_mode text,p_location_ids uuid[]
) returns boolean language plpgsql security definer set search_path = '' as $$
declare actor uuid:=(select auth.uid()); old_row public.memberships%rowtype; before_data jsonb;
begin
  if actor is null or not private.has_org_permission(p_organization_id,'people.manage') then
    raise exception 'People management permission required';
  end if;
  if p_role not in ('owner','administrator','manager','employee','operator','reviewer','read_only','custom')
    or (p_role='custom')<>(p_custom_role_id is not null) or p_location_scope_mode not in ('all','selected')
    or coalesce(array_length(p_location_ids,1),0)>100
    or (p_location_scope_mode='selected' and coalesce(array_length(p_location_ids,1),0)=0)
    or (p_location_scope_mode='all' and coalesce(array_length(p_location_ids,1),0)>0) then
    raise exception 'Invalid membership role assignment';
  end if;
  select * into old_row from public.memberships m where m.organization_id=p_organization_id and m.user_id=p_user_id for update;
  if not found then raise exception 'Organization membership not found'; end if;
  if old_row.role='owner' or p_role='owner' then
    if not private.has_org_role(p_organization_id,array['owner']) then raise exception 'Organization owner role required'; end if;
  end if;
  if p_custom_role_id is not null and not exists(select 1 from public.organization_custom_roles r
      where r.organization_id=p_organization_id and r.id=p_custom_role_id) then raise exception 'Custom role not found'; end if;
  if exists(select 1 from unnest(coalesce(p_location_ids,array[]::uuid[])) x
      where not exists(select 1 from public.business_locations l where l.organization_id=p_organization_id and l.id=x)) then
    raise exception 'Location scope includes a different organization'; end if;
  if old_row.role='owner' and p_role<>'owner'
      and (select count(*) from public.memberships m where m.organization_id=p_organization_id and m.role='owner')<=1 then
    raise exception 'The organization must retain an owner';
  end if;
  before_data:=jsonb_build_object('role',old_row.role,'customRoleId',old_row.custom_role_id,'locationScopeMode',old_row.location_scope_mode);
  update public.memberships set role=p_role,custom_role_id=p_custom_role_id,location_scope_mode=p_location_scope_mode
    where organization_id=p_organization_id and user_id=p_user_id;
  delete from public.membership_location_scopes where organization_id=p_organization_id and user_id=p_user_id;
  if p_location_scope_mode='selected' then
    insert into public.membership_location_scopes(organization_id,user_id,location_id)
      select p_organization_id,p_user_id,x from unnest(p_location_ids) x;
  end if;
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','update_role','membership',p_user_id,before_data,
      jsonb_build_object('role',p_role,'customRoleId',p_custom_role_id,'locationScopeMode',p_location_scope_mode,
        'locations',to_jsonb(coalesce(p_location_ids,array[]::uuid[]))),
      'Membership permissions updated','membership:'||p_user_id::text);
  return true;
end
$$;
create or replace function public.set_role_permission(
  p_organization_id uuid,p_role text,p_permission_key text,p_allowed boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
declare actor uuid:=(select auth.uid());
begin
  if actor is null or not private.has_org_permission(p_organization_id,'people.manage') then
    raise exception 'People management permission required';
  end if;
  if p_role not in ('administrator','manager','employee','operator','reviewer','read_only')
    or p_permission_key !~ '^[a-z][a-z0-9_.-]{1,99}$'
    or p_permission_key in ('organization.owner_transfer','people.manage') then raise exception 'Invalid role permission'; end if;
  insert into public.organization_role_permission_overrides(organization_id,role_key,permission_key,allowed,changed_by)
    values(p_organization_id,p_role,p_permission_key,p_allowed,actor)
    on conflict (organization_id,role_key,permission_key) do update set allowed=excluded.allowed,changed_by=excluded.changed_by,changed_at=now();
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','set_permission','organization_role',
      jsonb_build_object('role',p_role,'permission',p_permission_key,'allowed',p_allowed),
      'Role permission policy updated','role-permission:'||p_role||':'||p_permission_key);
  return true;
end
$$;

-- Materialize immutable, versioned event rows from authoritative Square facts.
-- Missing money remains NULL/incomplete; payouts never become sales revenue.
create or replace function public.materialize_square_financial_events(p_organization_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare spec record; prior_id uuid; event_id uuid; mapped_location uuid; mapped_variation uuid;
  event_version text; line_quantity numeric; inserted_count integer:=0; line_amount bigint;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
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
        l.fact->>'name' description,coalesce(o.fact->>'locationId',l.fact->>'locationId') square_location_id,
        jsonb_build_object('squareOrderId',l.fact->>'orderId','squareLineId',l.object_id,'lineItemUid',l.fact->>'lineItemUid',
          'squareCatalogObjectId',l.fact->>'catalogObjectId','quantity',l.fact->>'quantity','grossStatus',l.fact->>'grossStatus') details,
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
        coalesce(l.fact->>'name','Cost of goods sold'),coalesce(ord.fact->>'locationId',l.fact->>'locationId'),
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
    select * from event_specs where nullif(occurred_at,'') is not null
      and currency ~ '^[A-Z]{3}$'
    order by occurred_at,source_type,source_id
  loop
    select m.entity_id into mapped_location from public.domain_source_mappings m
      where m.organization_id=p_organization_id and m.provider='square' and m.source_type='LOCATION'
        and m.source_id=spec.square_location_id;
    event_version:=spec.source_version||'|location:'||coalesce(mapped_location::text,'unmapped');
    if exists(select 1 from public.financial_events e where e.organization_id=p_organization_id
        and e.source_provider='square' and e.source_type=spec.source_type and e.source_id=spec.source_id
        and e.source_version=event_version) then continue; end if;
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
      f.fact->>'occurredAt' occurred_at,o.fact->>'locationId' square_location_id
    from public.refund_cost_reviews r
    join private.square_fact_current c on c.organization_id=r.organization_id and c.fact_kind='refund' and c.object_id=r.square_refund_id
    join private.square_fact_versions f using(organization_id,fact_kind,object_id,object_version)
    left join private.square_fact_current oc on oc.organization_id=f.organization_id and oc.fact_kind='order' and oc.object_id=f.fact->>'orderId'
    left join private.square_fact_versions o on o.organization_id=oc.organization_id and o.fact_kind=oc.fact_kind
      and o.object_id=oc.object_id and o.object_version=oc.object_version
    where r.organization_id=p_organization_id and upper(coalesce(f.fact->>'status',''))='COMPLETED'
      and nullif(f.fact->>'occurredAt','') is not null
  loop
    event_version:='review:'||spec.id::text||':'||spec.updated_at::text;
    if exists(select 1 from public.financial_events e where e.organization_id=p_organization_id
        and e.source_provider='vernius' and e.source_type='refund.cogs_reversal'
        and e.source_id=spec.square_refund_id and e.source_version=event_version) then continue; end if;
    select e.id into prior_id from public.financial_events e where e.organization_id=p_organization_id
      and e.source_provider='vernius' and e.source_type='refund.cogs_reversal' and e.source_id=spec.square_refund_id
      order by e.ingested_at desc,e.created_at desc limit 1;
    mapped_location:=null;
    select m.entity_id into mapped_location from public.domain_source_mappings m
      where m.organization_id=p_organization_id and m.provider='square' and m.source_type='LOCATION' and m.source_id=spec.square_location_id;
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

create or replace function public.list_financial_events(
  p_organization_id uuid,p_start_at timestamptz,p_end_at timestamptz
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_start_at is null or p_end_at is null or p_end_at<=p_start_at or p_end_at-p_start_at>interval '366 days' then
    raise exception 'Invalid financial event window';
  end if;
  if not private.has_org_permission(p_organization_id,'finance.metrics.read') then
    raise exception 'Finance metrics permission required';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'eventType',e.event_type,'status',e.status,
      'occurredAt',e.occurred_at,'amountMinor',e.amount_minor,'currency',e.currency,'description',e.description,
      'locationId',e.location_id,'sourceProvider',e.source_provider,'sourceType',e.source_type,'sourceId',e.source_id,
      'sourceVersion',e.source_version,'supersedesEventId',e.supersedes_event_id,'details',e.details,
      'lines',coalesce(l.lines,'[]'::jsonb)) order by e.occurred_at,e.created_at,e.id),'[]'::jsonb)
    into result from public.financial_events e left join lateral (
      select jsonb_agg(jsonb_build_object('lineNumber',x.line_number,'variationId',x.variation_id,'description',x.description,
        'quantity',x.quantity,'unitAmountMinor',x.unit_amount_minor,'amountMinor',x.amount_minor,'currency',x.currency)
        order by x.line_number) lines from public.financial_event_lines x
      where x.organization_id=e.organization_id and x.financial_event_id=e.id
    ) l on true where e.organization_id=p_organization_id and e.occurred_at>=p_start_at and e.occurred_at<p_end_at
      and private.has_org_permission(e.organization_id,'finance.metrics.read',e.location_id)
      and not exists(select 1 from public.financial_events newer where newer.organization_id=e.organization_id
        and newer.supersedes_event_id=e.id);
  return result;
end
$$;
revoke all on function public.list_financial_events(uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.list_financial_events(uuid,timestamptz,timestamptz) to authenticated;

create or replace function private.materialize_cash_movement_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare event_id uuid; prior_id uuid; version_value text; type_value text; event_status text; details_value jsonb;
begin
  version_value:=new.created_at::text||':'||new.approval_status||':'||coalesce(new.approved_by::text,'');
  if exists(select 1 from public.financial_events e where e.organization_id=new.organization_id
      and e.source_provider='vernius' and e.source_type='cash_movement' and e.source_id=new.id::text
      and e.source_version=version_value) then return new; end if;
  select e.id into prior_id from public.financial_events e where e.organization_id=new.organization_id
    and e.source_provider='vernius' and e.source_type='cash_movement' and e.source_id=new.id::text
    order by e.ingested_at desc,e.created_at desc limit 1;
  type_value:=case new.kind when 'square_payout' then 'payout' when 'purchase' then 'purchase'
    when 'pay' then 'operating_expense' when 'misc_spend' then 'operating_expense' when 'transfer' then 'transfer'
    when 'adjustment' then 'adjustment' else 'other' end;
  event_status:=case when new.approval_status='pending' then 'draft' else 'posted' end;
  details_value:=jsonb_build_object('cashMovementId',new.id,'accountId',new.account_id,'kind',new.kind,
    'approvalStatus',new.approval_status,'approvedBy',new.approved_by,'evidenceFileId',new.evidence_file_id);
  insert into public.financial_events(organization_id,event_type,status,occurred_at,amount_minor,currency,description,
    source_provider,source_type,source_id,source_version,source_event_id,idempotency_key,supersedes_event_id,recorded_by,details)
  values(new.organization_id,type_value,event_status,new.occurred_at,new.amount_minor,new.currency,new.description,
    'vernius','cash_movement',new.id::text,version_value,new.source_event_id,
    'vernius:'||private.sha256_hex('cash_movement:'||new.id::text||':'||version_value),prior_id,new.created_by,details_value)
  returning id into event_id;
  if new.evidence_file_id is not null then
    insert into public.financial_event_documents(organization_id,financial_event_id,evidence_file_id,relationship,linked_by)
      values(new.organization_id,event_id,new.evidence_file_id,'supporting',new.created_by) on conflict do nothing;
  end if;
  insert into public.domain_source_mappings(organization_id,provider,source_type,source_id,entity_type,entity_id,
    source_version,source_hash,ingestion_actor_kind,originating_user_id,active)
  values(new.organization_id,'vernius','cash_movement',new.id::text,'financial_event',event_id,version_value,
    private.sha256_hex(details_value::text),'human',new.created_by,true)
  on conflict (organization_id,provider,source_type,source_id) do update set entity_id=excluded.entity_id,
    source_version=excluded.source_version,source_hash=excluded.source_hash,observed_at=now(),active=true;
  return new;
end
$$;
revoke all on function private.materialize_cash_movement_event() from public,anon,authenticated;
create trigger cash_movements_financial_event after insert or update of approval_status,approved_by on public.cash_movements
  for each row execute function private.materialize_cash_movement_event();

create or replace function private.materialize_inventory_acquisition_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare event_id uuid; mapped_variation uuid; amount_value numeric; status_value text; details_value jsonb; version_value text;
begin
  if new.movement_type<>'purchase_receipt' then return new; end if;
  version_value:=new.created_at::text;
  amount_value:=new.unit_cost_minor*new.quantity_delta;
  status_value:=case when amount_value=trunc(amount_value) and amount_value<1000000000000000 then 'posted' else 'incomplete' end;
  select m.entity_id into mapped_variation from public.domain_source_mappings m where m.organization_id=new.organization_id
    and m.provider='square' and m.source_type='ITEM_VARIATION' and m.source_id=new.square_catalog_object_id;
  details_value:=jsonb_build_object('inventoryMovementId',new.id,'itemName',new.item_name,'quantity',new.quantity_delta,
    'unitCostMinor',new.unit_cost_minor,'evidenceFileId',new.evidence_file_id,'cashMovementId',new.cash_movement_id);
  insert into public.financial_events(organization_id,event_type,status,occurred_at,amount_minor,currency,description,
    source_provider,source_type,source_id,source_version,idempotency_key,recorded_by,details)
  values(new.organization_id,'inventory_acquisition',status_value,new.occurred_at,
    case when status_value='posted' then amount_value::bigint end,new.currency,new.item_name,
    'vernius','inventory_movement',new.id::text,version_value,
    'vernius:'||private.sha256_hex('inventory_movement:'||new.id::text||':'||version_value),new.created_by,details_value)
  returning id into event_id;
  if new.evidence_file_id is not null then
    insert into public.financial_event_documents(organization_id,financial_event_id,evidence_file_id,relationship,linked_by)
      values(new.organization_id,event_id,new.evidence_file_id,'receipt',new.created_by) on conflict do nothing;
  end if;
  insert into public.financial_event_lines(organization_id,financial_event_id,line_number,variation_id,description,quantity,
    unit_amount_minor,amount_minor,currency)
  values(new.organization_id,event_id,1,mapped_variation,new.item_name,new.quantity_delta,new.unit_cost_minor,
    case when status_value='posted' then amount_value::bigint end,new.currency);
  insert into public.domain_source_mappings(organization_id,provider,source_type,source_id,entity_type,entity_id,
    source_version,source_hash,ingestion_actor_kind,originating_user_id,active)
  values(new.organization_id,'vernius','inventory_movement',new.id::text,'financial_event',event_id,version_value,
    private.sha256_hex(details_value::text),'human',new.created_by,true);
  return new;
end
$$;
revoke all on function private.materialize_inventory_acquisition_event() from public,anon,authenticated;
create trigger inventory_movements_financial_event after insert on public.inventory_movements
  for each row execute function private.materialize_inventory_acquisition_event();
