-- Proposed initial Supabase migration. Review accounting policy and authorization
-- requirements before applying to a production project.
create extension if not exists pgcrypto;
create schema if not exists private;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_currency char(3) not null default 'USD',
  timezone text not null default 'America/New_York',
  created_at timestamptz not null default now()
);

create table public.memberships (
  organization_id uuid not null references public.organizations(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('owner','operator','reviewer','read_only')),
  created_at timestamptz not null default now(),
  primary key (organization_id,user_id)
);

-- Security-definer helper avoids recursive membership policies. Search path fixed.
create or replace function public.is_org_member(org uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (
  select 1 from public.memberships m
  where m.organization_id = org and m.user_id = (select auth.uid())
) $$;
revoke all on function public.is_org_member(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated;

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null,
  kind text not null check (kind in ('bank','cash_drawer','square_balance','reserve')),
  currency char(3) not null,
  active boolean not null default true,
  unique (organization_id,name),
  unique (organization_id,id)
);

create table private.source_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  provider text not null,
  notification_id text,
  object_type text not null,
  provider_object_id text not null,
  object_version text not null,
  payload jsonb not null,
  payload_sha256 text not null,
  signature_verified boolean not null,
  received_at timestamptz not null default now(),
  unique (organization_id,provider,object_type,provider_object_id,object_version),
  unique (organization_id,provider,notification_id),
  unique (organization_id,id)
);
create index source_events_object_idx on private.source_events
  (organization_id,provider,object_type,provider_object_id,received_at desc);

create table public.item_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  square_catalog_object_id text not null,
  sku text,
  name text not null,
  category text,
  unit_cost_minor numeric(18,6) not null check (unit_cost_minor >= 0),
  currency char(3) not null,
  effective_from timestamptz not null,
  effective_until timestamptz,
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null default now(),
  version integer not null check (version > 0),
  unique (organization_id,square_catalog_object_id,version),
  check (effective_until is null or effective_until > effective_from)
);
create index item_definitions_effective_idx on public.item_definitions
  (organization_id,square_catalog_object_id,effective_from desc);

create table public.sale_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  square_order_id text not null,
  square_line_uid text not null,
  square_catalog_object_id text,
  item_name text not null,
  quantity numeric(18,6) not null check (quantity >= 0),
  gross_minor bigint not null,
  discount_minor bigint not null default 0,
  refund_minor bigint not null default 0,
  tax_minor bigint not null default 0,
  tip_minor bigint not null default 0,
  currency char(3) not null,
  sold_at timestamptz not null,
  source_event_id uuid not null,
  source_version text not null,
  unique (organization_id,square_order_id,square_line_uid,source_version),
  foreign key (organization_id,source_event_id) references private.source_events(organization_id,id)
);
create index sale_lines_period_idx on public.sale_lines (organization_id,sold_at);

create table public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  account_id uuid not null,
  kind text not null check (kind in ('square_payout','cash_deposit','purchase','pay','misc_spend','transfer','adjustment','other_inflow')),
  amount_minor bigint not null check (amount_minor <> 0),
  currency char(3) not null,
  occurred_at timestamptz not null,
  description text not null,
  evidence_ref text,
  provider_object_id text,
  source_event_id uuid,
  linked_transfer_id uuid,
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (organization_id,idempotency_key),
  unique (organization_id,kind,provider_object_id),
  unique (organization_id,id),
  foreign key (organization_id,account_id) references public.accounts(organization_id,id),
  foreign key (organization_id,source_event_id) references private.source_events(organization_id,id),
  foreign key (organization_id,linked_transfer_id) references public.cash_movements(organization_id,id)
);
create index cash_movements_account_period_idx on public.cash_movements
  (organization_id,account_id,occurred_at);

create table public.balance_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  account_id uuid not null,
  amount_minor bigint not null,
  currency char(3) not null,
  observed_at timestamptz not null,
  evidence_ref text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (organization_id,account_id) references public.accounts(organization_id,id)
);

create table public.projection_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  account_id uuid,
  period_start timestamptz not null,
  period_end timestamptz not null,
  calculation_version text not null,
  source_snapshot_hash text not null,
  status text not null check (status in ('complete','incomplete','failed')),
  result jsonb not null,
  created_at timestamptz not null default now(),
  check (period_end > period_start),
  unique (organization_id,id),
  foreign key (organization_id,account_id) references public.accounts(organization_id,id)
);

create table public.issues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  projection_run_id uuid,
  code text not null,
  state text not null check (state in ('monitoring','diagnosing','awaiting_human','proposal_pending','resolved','failed')),
  source_refs jsonb not null default '[]'::jsonb,
  details jsonb not null default '{}'::jsonb,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id,id),
  foreign key (organization_id,projection_run_id) references public.projection_runs(organization_id,id)
);

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  issue_id uuid not null,
  proposal_type text not null,
  payload jsonb not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  model_id text,
  prompt_version text,
  validation_status text not null check (validation_status in ('valid','invalid')),
  decision text not null default 'pending' check (decision in ('pending','approved','rejected')),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz not null default now(),
  foreign key (organization_id,issue_id) references public.issues(organization_id,id)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  actor_user_id uuid references auth.users(id),
  actor_kind text not null check (actor_kind in ('human','system','agent')),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_state jsonb,
  after_state jsonb,
  reason text,
  correlation_id text not null,
  created_at timestamptz not null default now()
);
create index audit_events_org_time_idx on public.audit_events (organization_id,created_at desc);

-- Browser clients are read-only. All writes go through authorized server routes
-- that enforce role, evidence, idempotency and append-only rules in transactions.
revoke all on schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on public.organizations,public.memberships,public.accounts,
  public.item_definitions,public.sale_lines,public.cash_movements,
  public.balance_observations,public.projection_runs,public.issues,
  public.proposals,public.audit_events from anon, authenticated;
grant select on public.organizations,public.memberships,public.accounts,
  public.item_definitions,public.sale_lines,public.cash_movements,
  public.balance_observations,public.projection_runs,public.issues,
  public.proposals,public.audit_events to authenticated;

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.accounts enable row level security;
alter table public.item_definitions enable row level security;
alter table public.sale_lines enable row level security;
alter table public.cash_movements enable row level security;
alter table public.balance_observations enable row level security;
alter table public.projection_runs enable row level security;
alter table public.issues enable row level security;
alter table public.proposals enable row level security;
alter table public.audit_events enable row level security;

create policy org_read on public.organizations for select to authenticated
  using (public.is_org_member(id));
create policy membership_read on public.memberships for select to authenticated
  using (public.is_org_member(organization_id));
create policy account_read on public.accounts for select to authenticated
  using (public.is_org_member(organization_id));
create policy item_read on public.item_definitions for select to authenticated
  using (public.is_org_member(organization_id));
create policy sale_read on public.sale_lines for select to authenticated
  using (public.is_org_member(organization_id));
create policy cash_read on public.cash_movements for select to authenticated
  using (public.is_org_member(organization_id));
create policy balance_read on public.balance_observations for select to authenticated
  using (public.is_org_member(organization_id));
create policy projection_read on public.projection_runs for select to authenticated
  using (public.is_org_member(organization_id));
create policy issue_read on public.issues for select to authenticated
  using (public.is_org_member(organization_id));
create policy proposal_read on public.proposals for select to authenticated
  using (public.is_org_member(organization_id));
create policy audit_read on public.audit_events for select to authenticated
  using (public.is_org_member(organization_id));
