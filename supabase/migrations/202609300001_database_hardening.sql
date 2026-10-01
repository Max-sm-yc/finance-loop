-- Database hardening for the proposed baseline in ../schema.sql.
-- Apply after the baseline schema. All corrections to facts are represented by
-- new rows; closed periods require an explicit reopen before changing them.

create table public.accounting_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'open' check (status in ('open','closed')),
  closed_by uuid references auth.users(id),
  closed_at timestamptz,
  close_reason text,
  unique (organization_id, id),
  check (ends_at > starts_at),
  check ((status = 'open' and closed_by is null and closed_at is null)
      or (status = 'closed' and closed_by is not null and closed_at is not null))
);
create index accounting_periods_lookup_idx
  on public.accounting_periods (organization_id, starts_at, ends_at);

-- Evidence is private metadata only; bytes belong in a private Storage bucket.
create table public.evidence_files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  object_key text not null,
  sha256_hex text not null check (sha256_hex ~ '^[0-9a-f]{64}$'),
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0),
  original_filename text,
  uploaded_by uuid not null references auth.users(id),
  uploaded_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, object_key)
);
alter table public.cash_movements add column evidence_file_id uuid;
alter table public.cash_movements add constraint cash_evidence_org_fk
  foreign key (organization_id, evidence_file_id)
  references public.evidence_files(organization_id, id);
alter table public.balance_observations add column evidence_file_id uuid;
alter table public.balance_observations add column idempotency_key text not null;
alter table public.balance_observations add constraint balance_observation_key_len
  check (length(btrim(idempotency_key)) >= 8);
alter table public.balance_observations add constraint balance_observation_key_unique
  unique (organization_id, idempotency_key);
alter table public.balance_observations add constraint balance_evidence_org_fk
  foreign key (organization_id, evidence_file_id)
  references public.evidence_files(organization_id, id);
alter table public.proposals add column created_by uuid references auth.users(id);
alter table public.proposals add column revision integer not null default 1 check (revision > 0);
alter table public.proposals add column decision_idempotency_key text;
alter table public.proposals add constraint proposal_decision_idempotency_key_len
  check (decision_idempotency_key is null or length(btrim(decision_idempotency_key)) >= 8);
alter table public.proposals add constraint proposal_decision_idempotency_key_unique
  unique (organization_id, decision_idempotency_key);
alter table public.cash_movements add column approval_status text not null default 'approved'
  check (approval_status in ('pending','approved'));
alter table public.cash_movements add column approval_reason text;
alter table public.proposals add column if not exists evidence_file_id uuid;
alter table public.proposals add constraint proposal_evidence_org_fk
  foreign key (organization_id, evidence_file_id)
  references public.evidence_files(organization_id, id);

create or replace function private.reject_row_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only; write a superseding/correction row', tg_table_name
    using errcode = '55000';
end
$$;

create trigger source_events_append_only
  before update or delete on private.source_events
  for each row execute function private.reject_row_change();
create trigger sale_lines_append_only
  before update or delete on public.sale_lines
  for each row execute function private.reject_row_change();
create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function private.reject_row_change();
create trigger evidence_files_append_only
  before update or delete on public.evidence_files
  for each row execute function private.reject_row_change();

create or replace function private.reject_closed_period_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  event_time timestamptz;
begin
  if tg_table_name = 'cash_movements' then
    if tg_op <> 'INSERT' then event_time := old.occurred_at; end if;
    if tg_op = 'INSERT' then event_time := new.occurred_at; end if;
  elsif tg_table_name = 'balance_observations' then
    if tg_op <> 'INSERT' then event_time := old.observed_at; end if;
    if tg_op = 'INSERT' then event_time := new.observed_at; end if;
  elsif tg_table_name = 'sale_lines' then
    if tg_op <> 'INSERT' then event_time := old.sold_at; end if;
    if tg_op = 'INSERT' then event_time := new.sold_at; end if;
  end if;
  if tg_op <> 'INSERT' and exists (
    select 1 from public.accounting_periods p where p.organization_id = old.organization_id
      and p.status = 'closed' and event_time >= p.starts_at and event_time < p.ends_at
  ) then
    raise exception 'PERIOD_CLOSED: reopen the accounting period with a reason before changing facts' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    if tg_table_name = 'cash_movements' then event_time := new.occurred_at;
    elsif tg_table_name = 'balance_observations' then event_time := new.observed_at;
    else event_time := new.sold_at; end if;
  end if;
  if tg_op <> 'DELETE' and exists (
    select 1 from public.accounting_periods p where p.organization_id = new.organization_id
      and p.status = 'closed' and event_time >= p.starts_at and event_time < p.ends_at
  ) then
    raise exception 'PERIOD_CLOSED: reopen the accounting period with a reason before changing facts' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
create trigger cash_movements_period_guard before insert or update or delete
  on public.cash_movements for each row execute function private.reject_closed_period_write();
create trigger balance_observations_period_guard before insert or update or delete
  on public.balance_observations for each row execute function private.reject_closed_period_write();
create trigger sale_lines_period_guard before insert or update or delete
  on public.sale_lines for each row execute function private.reject_closed_period_write();

create or replace function private.guard_period_transition()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'closed' and new.status = 'open' then
    if new.close_reason is null or length(btrim(new.close_reason)) < 10 then
      raise exception 'Reopening a period requires a reason of at least 10 characters';
    end if;
    if (select auth.uid()) is null then raise exception 'Reopening requires an authenticated actor'; end if;
    new.closed_by := null;
    new.closed_at := null;
  elsif old.status = 'open' and new.status = 'closed' then
    if new.closed_by is null then new.closed_by := (select auth.uid()); end if;
    if new.closed_at is null then new.closed_at := now(); end if;
    if new.closed_by is null then raise exception 'Closing a period requires an actor'; end if;
  elsif old.status = 'closed' and new.status = 'closed'
        and (new.starts_at, new.ends_at) is distinct from (old.starts_at, old.ends_at) then
    raise exception 'Closed period boundaries are immutable; reopen first';
  end if;
  return new;
end
$$;
create trigger accounting_period_transition_guard before update on public.accounting_periods
  for each row execute function private.guard_period_transition();

create or replace function private.guard_cash_approval()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.kind = 'adjustment' and new.approval_status = 'approved' and
     (new.approved_by is null or new.approved_by = new.created_by
      or nullif(btrim(new.approval_reason), '') is null) then
    raise exception 'Approved adjustments require a distinct approver and a reason';
  end if;
  if new.kind = 'adjustment' and new.approval_status = 'pending' and new.approved_by is not null then
    raise exception 'Pending adjustments cannot have an approver';
  end if;
  if new.kind <> 'adjustment' and new.approval_status <> 'approved' then
    raise exception 'Only adjustments can be pending';
  end if;
  if new.approved_by is not null and new.approved_by = new.created_by then
    raise exception 'An entry creator cannot approve their own entry';
  end if;
  return new;
end
$$;
create trigger cash_approval_guard before insert or update on public.cash_movements
  for each row execute function private.guard_cash_approval();

create or replace function private.guard_proposal_decision()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.decision is distinct from old.decision and new.decision <> 'pending' then
    if new.decided_by is null then new.decided_by := (select auth.uid()); end if;
    if new.decided_at is null then new.decided_at := now(); end if;
    if new.decided_by is null or new.created_by is null or new.decided_by = new.created_by then
      raise exception 'Proposal decision requires a reviewer distinct from its creator';
    end if;
    if nullif(btrim(new.decision_reason), '') is null then
      raise exception 'Proposal decision requires a reason';
    end if;
  end if;
  if old.decision <> 'pending' and
     (new.decision, new.decided_by, new.decided_at, new.decision_reason)
       is distinct from (old.decision, old.decided_by, old.decided_at, old.decision_reason) then
    raise exception 'Proposal decisions are immutable; create a new proposal';
  end if;
  return new;
end
$$;
create trigger proposal_decision_guard before update on public.proposals
  for each row execute function private.guard_proposal_decision();

create or replace function private.write_audit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  org_id uuid;
  row_id uuid;
  action_name text;
  event_reason text;
  before_value jsonb;
  after_value jsonb;
begin
  actor := (select auth.uid());
  action_name := lower(tg_op);
  if tg_op = 'DELETE' then
    org_id := old.organization_id;
    row_id := old.id;
    before_value := to_jsonb(old);
  else
    org_id := new.organization_id;
    row_id := new.id;
    after_value := to_jsonb(new);
    if tg_op = 'UPDATE' then before_value := to_jsonb(old); end if;
  end if;
  if tg_table_name = 'proposals' and tg_op <> 'DELETE' then
    event_reason := new.decision_reason;
  elsif tg_table_name = 'accounting_periods' and tg_op <> 'DELETE' then
    event_reason := new.close_reason;
  end if;
  insert into public.audit_events (organization_id, actor_user_id, actor_kind,
    action, entity_type, entity_id, before_state, after_state, reason, correlation_id)
  values (org_id, actor, case when actor is null then 'system' else 'human' end,
    action_name, tg_table_name, row_id,
    before_value,
    after_value,
    event_reason,
    gen_random_uuid()::text);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
create trigger cash_movements_audit after insert or update or delete on public.cash_movements
  for each row execute function private.write_audit_event();
create trigger balance_observations_audit after insert or update or delete on public.balance_observations
  for each row execute function private.write_audit_event();
create trigger proposal_audit after update on public.proposals
  for each row when (old.decision is distinct from new.decision)
  execute function private.write_audit_event();
create trigger accounting_periods_audit after insert or update on public.accounting_periods
  for each row execute function private.write_audit_event();

create or replace function private.has_org_role(org uuid, allowed_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
    where m.organization_id = org and m.user_id = (select auth.uid())
      and m.role = any(allowed_roles))
$$;

create table private.correction_authorities (
  organization_id uuid not null references public.organizations(id),
  user_id uuid not null references auth.users(id),
  designated_by uuid not null references auth.users(id),
  designated_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  foreign key (organization_id, user_id) references public.memberships(organization_id, user_id)
);

create or replace function private.is_correction_authority(org uuid, actor uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.correction_authorities a
    where a.organization_id = org and a.user_id = actor)
$$;

-- The only browser write entry points. All validate organization role and use
-- the caller's JWT identity; callers cannot supply an actor ID.
create or replace function public.record_cash_movement(
  p_organization_id uuid, p_account_id uuid, p_kind text, p_amount_minor bigint,
  p_currency char(3), p_occurred_at timestamptz, p_description text,
  p_evidence_file_id uuid, p_idempotency_key text, p_approved_by uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  account_currency char(3);
  result_id uuid;
  existing public.cash_movements%rowtype;
begin
  if actor is null or not private.has_org_role(p_organization_id, array['owner','operator']) then
    raise exception 'Organization operator role required';
  end if;
  if p_amount_minor = 0 or length(btrim(p_idempotency_key)) < 8 then
    raise exception 'Non-zero amount and idempotency key (8+ chars) required';
  end if;
  if p_kind = 'transfer' then
    raise exception 'Single-leg transfers are disabled until paired transfer RPC is available';
  end if;
  select a.currency into account_currency from public.accounts a
   where a.organization_id = p_organization_id and a.id = p_account_id and a.active;
  if not found or account_currency <> p_currency then
    raise exception 'Account not found or currency does not match';
  end if;
  if p_evidence_file_id is null or not exists (
    select 1 from public.evidence_files e where e.organization_id = p_organization_id
      and e.id = p_evidence_file_id
  ) then raise exception 'Organization evidence file required'; end if;
  if p_kind = 'adjustment' then
    if p_approved_by is not null then
      raise exception 'Adjustments are created pending and require separate approval';
    end if;
  elsif p_approved_by is not null then
    raise exception 'Approval identity is assigned by the reviewer RPC';
  end if;
  insert into public.cash_movements (organization_id, account_id, kind, amount_minor,
    currency, occurred_at, description, evidence_ref, evidence_file_id, created_by,
    approved_by, idempotency_key, approval_status)
  values (p_organization_id, p_account_id, p_kind, p_amount_minor, p_currency,
    p_occurred_at, p_description, p_evidence_file_id::text, p_evidence_file_id,
    actor, null, p_idempotency_key,
    case when p_kind = 'adjustment' then 'pending' else 'approved' end)
  on conflict (organization_id, idempotency_key) do nothing returning id into result_id;
  if result_id is not null then return result_id; end if;
  select * into existing from public.cash_movements m
   where m.organization_id = p_organization_id and m.idempotency_key = p_idempotency_key;
  if (existing.account_id, existing.kind, existing.amount_minor, existing.currency,
      existing.occurred_at, existing.description, existing.evidence_file_id)
     is distinct from (p_account_id, p_kind, p_amount_minor, p_currency,
      p_occurred_at, p_description, p_evidence_file_id) then
    raise exception 'Idempotency key was already used with different data';
  end if;
  return existing.id;
end
$$;

create or replace function public.approve_adjustment(
  p_organization_id uuid, p_movement_id uuid, p_reason text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  result_id uuid;
begin
  if actor is null or not private.has_org_role(p_organization_id, array['owner','reviewer']) then
    raise exception 'Organization reviewer role required';
  end if;
  if not private.is_correction_authority(p_organization_id, actor) then
    raise exception 'Designated correction authority required';
  end if;
  if length(btrim(p_reason)) < 10 then raise exception 'Approval reason of 10+ characters required'; end if;
  update public.cash_movements m set approved_by = actor, approval_status = 'approved',
    approval_reason = p_reason
   where m.organization_id = p_organization_id and m.id = p_movement_id
     and m.kind = 'adjustment' and m.approval_status = 'pending'
     and m.created_by is distinct from actor
  returning m.id into result_id;
  if result_id is null then raise exception 'Adjustment unavailable, already approved, or self-approval'; end if;
  return result_id;
end
$$;

create or replace function public.record_balance_observation(
  p_organization_id uuid, p_account_id uuid, p_amount_minor bigint,
  p_currency char(3), p_observed_at timestamptz, p_evidence_file_id uuid,
  p_idempotency_key text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  account_currency char(3);
  result_id uuid;
  existing public.balance_observations%rowtype;
begin
  if actor is null or not private.has_org_role(p_organization_id, array['owner','operator']) then
    raise exception 'Organization operator role required';
  end if;
  select a.currency into account_currency from public.accounts a
   where a.organization_id = p_organization_id and a.id = p_account_id and a.active;
  if not found or account_currency <> p_currency then
    raise exception 'Account not found or currency does not match';
  end if;
  if not exists (select 1 from public.evidence_files e
      where e.organization_id = p_organization_id and e.id = p_evidence_file_id) then
    raise exception 'Organization evidence file required';
  end if;
  if length(btrim(p_idempotency_key)) < 8 then raise exception 'Idempotency key (8+ chars) required'; end if;
  insert into public.balance_observations (organization_id, account_id, amount_minor,
    currency, observed_at, evidence_ref, evidence_file_id, created_by, idempotency_key)
  values (p_organization_id, p_account_id, p_amount_minor, p_currency,
    p_observed_at, p_evidence_file_id::text, p_evidence_file_id, actor, p_idempotency_key)
  on conflict (organization_id, idempotency_key) do nothing returning id into result_id;
  if result_id is not null then return result_id; end if;
  select * into existing from public.balance_observations b
   where b.organization_id = p_organization_id and b.idempotency_key = p_idempotency_key;
  if (existing.account_id, existing.amount_minor, existing.currency,
      existing.observed_at, existing.evidence_file_id)
     is distinct from (p_account_id, p_amount_minor, p_currency,
      p_observed_at, p_evidence_file_id) then
    raise exception 'Idempotency key was already used with different data';
  end if;
  return existing.id;
end
$$;

create or replace function public.decide_proposal(
  p_organization_id uuid, p_proposal_id uuid, p_decision text, p_reason text,
  p_expected_revision integer, p_idempotency_key text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  result_id uuid;
  current_row public.proposals%rowtype;
begin
  if actor is null or not private.has_org_role(p_organization_id, array['owner','reviewer']) then
    raise exception 'Organization reviewer role required';
  end if;
  if p_decision not in ('approved','rejected') or length(btrim(p_reason)) < 10
     or p_expected_revision < 1 or length(btrim(p_idempotency_key)) < 8 then
    raise exception 'Valid decision, reason, expected revision, and idempotency key required';
  end if;
  select * into current_row from public.proposals p
   where p.organization_id = p_organization_id and p.id = p_proposal_id
   for update;
  if not found then raise exception 'Proposal not found'; end if;
  -- A network retry after commit returns the original result only for an exact
  -- same-user/same-decision/same-reason replay with the original idempotency key.
  if current_row.decision <> 'pending'
     and current_row.decision_idempotency_key = p_idempotency_key
     and current_row.decision = p_decision and current_row.decided_by = actor
     and current_row.decision_reason = p_reason then
    return current_row.id;
  end if;
  if current_row.decision <> 'pending' then
    raise exception 'Proposal already decided';
  end if;
  if current_row.revision <> p_expected_revision then
    raise exception 'Proposal revision conflict: expected %, found %', p_expected_revision, current_row.revision
      using errcode = '40001';
  end if;
  if current_row.created_by is null or current_row.created_by = actor then
    raise exception 'Proposal creator cannot decide their own proposal';
  end if;
  if exists (select 1 from public.proposals p where p.organization_id = p_organization_id
      and p.decision_idempotency_key = p_idempotency_key and p.id <> p_proposal_id) then
    raise exception 'Decision idempotency key was already used for another proposal';
  end if;
  update public.proposals p set decision = p_decision, decided_by = actor,
    decided_at = now(), decision_reason = p_reason,
    decision_idempotency_key = p_idempotency_key, revision = p.revision + 1
   where p.organization_id = p_organization_id and p.id = p_proposal_id
     and p.decision = 'pending' and p.revision = p_expected_revision
  returning p.id into result_id;
  if result_id is null then raise exception 'Proposal revision conflict or already decided' using errcode = '40001'; end if;
  return result_id;
end
$$;

create or replace function public.set_accounting_period_status(
  p_organization_id uuid, p_period_id uuid, p_status text, p_reason text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  result_id uuid;
begin
  if actor is null or p_status not in ('open','closed') or length(btrim(p_reason)) < 10 then
    raise exception 'Authenticated actor, valid status, and reason of 10+ characters required';
  end if;
  if p_status = 'closed' and not private.has_org_role(p_organization_id, array['owner']) then
    raise exception 'Organization owner role required to close a period';
  elsif p_status = 'open' and not private.has_org_role(p_organization_id, array['owner','reviewer']) then
    raise exception 'Organization reviewer role required to reopen a period';
  end if;
  if p_status = 'open' and not private.is_correction_authority(p_organization_id, actor) then
    raise exception 'Designated correction authority required to reopen a period';
  end if;
  update public.accounting_periods p set status = p_status, close_reason = p_reason,
    closed_by = case when p_status = 'closed' then actor else null end,
    closed_at = case when p_status = 'closed' then now() else null end
   where p.organization_id = p_organization_id and p.id = p_period_id
     and p.status is distinct from p_status
  returning p.id into result_id;
  if result_id is null then raise exception 'Period unavailable or already in requested state'; end if;
  return result_id;
end
$$;

alter table public.accounting_periods enable row level security;
alter table public.evidence_files enable row level security;
create policy period_read on public.accounting_periods for select to authenticated
  using (public.is_org_member(organization_id));
create policy evidence_read on public.evidence_files for select to authenticated
  using (public.is_org_member(organization_id));
revoke all on public.accounting_periods, public.evidence_files from anon, authenticated;
grant select on public.accounting_periods, public.evidence_files to authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function public.is_org_member(uuid) to authenticated;
revoke all on function private.has_org_role(uuid,text[]) from public, anon, authenticated;
revoke all on function public.record_cash_movement(uuid,uuid,text,bigint,char,timestamptz,text,uuid,text,uuid) from public, anon;
revoke all on function public.record_balance_observation(uuid,uuid,bigint,char,timestamptz,uuid,text) from public, anon;
revoke all on function public.decide_proposal(uuid,uuid,text,text,integer,text) from public, anon;
revoke all on function public.approve_adjustment(uuid,uuid,text) from public, anon;
revoke all on function public.set_accounting_period_status(uuid,uuid,text,text) from public, anon;
grant execute on function public.record_cash_movement(uuid,uuid,text,bigint,char,timestamptz,text,uuid,text,uuid) to authenticated;
grant execute on function public.record_balance_observation(uuid,uuid,bigint,char,timestamptz,uuid,text) to authenticated;
grant execute on function public.decide_proposal(uuid,uuid,text,text,integer,text) to authenticated;
grant execute on function public.approve_adjustment(uuid,uuid,text) to authenticated;
grant execute on function public.set_accounting_period_status(uuid,uuid,text,text) to authenticated;

-- Durable adapter support. Private tables are accessible only through the
-- narrow authenticated or service-role RPCs defined below.
alter table public.proposals add column creation_idempotency_key text;
alter table public.proposals add column correlation_id text;
alter table public.proposals add constraint proposal_creation_key_len
  check (creation_idempotency_key is null or length(btrim(creation_idempotency_key)) >= 8);
alter table public.proposals add constraint proposal_creation_key_unique
  unique (organization_id, creation_idempotency_key);
alter table public.projection_runs add column idempotency_key text;
alter table public.projection_runs add constraint projection_run_key_len
  check (idempotency_key is null or length(btrim(idempotency_key)) >= 8);
alter table public.projection_runs add constraint projection_run_key_unique
  unique (organization_id, idempotency_key);
alter table public.projection_runs add column source_snapshot jsonb;

create table private.ai_model_budgets (
  organization_id uuid primary key references public.organizations(id),
  daily_token_limit integer not null default 50000 check (daily_token_limit > 0),
  updated_at timestamptz not null default now()
);
create table private.ai_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  issue_id uuid not null,
  model_id text not null,
  budget_day date not null,
  reserved_tokens integer not null check (reserved_tokens > 0),
  max_attempts integer not null check (max_attempts between 1 and 3),
  created_at timestamptz not null default now(),
  unique (organization_id, issue_id, model_id, budget_day)
);
create table private.ai_model_usage (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references private.ai_budget_reservations(id),
  attempt integer not null check (attempt > 0),
  usage jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  unique (reservation_id, attempt)
);
create table public.organization_accounting_policies (
  organization_id uuid primary key references public.organizations(id),
  currency char(3) not null default 'USD' check (currency = 'USD'),
  timezone text not null default 'America/New_York' check (timezone = 'America/New_York'),
  tax_treatment text not null default 'exclude' check (tax_treatment = 'exclude'),
  inventory_cost_method text not null default 'purchase_cost_excluding_tax_and_misc_charges'
    check (inventory_cost_method = 'purchase_cost_excluding_tax_and_misc_charges'),
  gift_card_treatment text not null default 'issuance_cash_inflow_liability_until_redemption'
    check (gift_card_treatment = 'issuance_cash_inflow_liability_until_redemption'),
  reconciliation_tolerance_minor bigint not null default 0 check (reconciliation_tolerance_minor >= 0),
  configured_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
create table private.square_merchant_connections (
  organization_id uuid not null references public.organizations(id),
  square_merchant_id text not null,
  active boolean not null default true,
  connected_by uuid references auth.users(id),
  access_ciphertext text,
  access_nonce text,
  access_tag text,
  refresh_ciphertext text,
  refresh_nonce text,
  refresh_tag text,
  expires_at timestamptz,
  scopes text[] not null default '{}',
  token_type text,
  updated_at timestamptz not null default now(),
  primary key (organization_id, square_merchant_id),
  unique (square_merchant_id)
);
create table private.square_oauth_states (
  state_sha256 text primary key check (state_sha256 ~ '^[0-9a-f]{64}$'),
  organization_id uuid not null references public.organizations(id),
  user_id uuid not null references auth.users(id),
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create or replace function private.seed_org_accounting_policy()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.organization_accounting_policies (organization_id, currency, timezone)
    values (new.id, 'USD', 'America/New_York');
  return new;
end
$$;
create trigger organization_policy_defaults after insert on public.organizations
  for each row execute function private.seed_org_accounting_policy();
insert into public.organization_accounting_policies (organization_id, currency, timezone)
  select o.id, 'USD', 'America/New_York' from public.organizations o
  on conflict (organization_id) do nothing;
create table private.square_webhook_inbox (
  notification_id text primary key,
  event_type text,
  merchant_id text,
  location_id text,
  received_at timestamptz not null,
  signature_verified boolean not null check (signature_verified),
  raw_body_sha256 text not null check (raw_body_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  inserted_at timestamptz not null default now()
);
create table private.durable_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id),
  requested_by uuid references auth.users(id),
  job_type text not null check (job_type in ('square.sync','square.webhook','projection.replay','issue.investigate')),
  idempotency_key text not null,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued','running','complete','failed','dead_letter')),
  result jsonb,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  retry_at timestamptz,
  locked_by text,
  lease_token uuid,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  last_error_code text
);
create unique index durable_jobs_sync_key on private.durable_jobs (job_type, organization_id, idempotency_key)
  where organization_id is not null;
create unique index durable_jobs_webhook_key on private.durable_jobs (job_type, idempotency_key)
  where organization_id is null;
create index durable_jobs_claim_idx on private.durable_jobs (status, created_at);

create or replace function public.create_proposal_atomic(
  p_organization_id uuid, p_issue_id uuid, p_payload jsonb, p_model_id text,
  p_prompt_version text, p_validation_status text, p_idempotency_key text,
  p_correlation_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  new_id uuid;
  existing public.proposals%rowtype;
begin
  if actor is null or not private.has_org_role(p_organization_id, array['owner','operator']) then
    raise exception 'Organization operator role required';
  end if;
  if p_validation_status <> 'valid' or p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or length(btrim(p_idempotency_key)) < 8 then
    raise exception 'Validated proposal and idempotency key required';
  end if;
  if not exists (select 1 from public.issues i where i.organization_id = p_organization_id and i.id = p_issue_id) then
    raise exception 'Issue not found in organization';
  end if;
  insert into public.proposals (organization_id, issue_id, proposal_type, payload,
    model_id, prompt_version, validation_status, decision, created_by,
    creation_idempotency_key, correlation_id)
  values (p_organization_id, p_issue_id, coalesce(p_payload->>'issue_type','unknown'), p_payload,
    p_model_id, p_prompt_version, p_validation_status, 'pending', actor,
    p_idempotency_key, p_correlation_id)
  on conflict (organization_id, creation_idempotency_key) do nothing returning id into new_id;
  if new_id is not null then return jsonb_build_object('id', new_id, 'revision', 1); end if;
  select * into existing from public.proposals p
   where p.organization_id = p_organization_id and p.creation_idempotency_key = p_idempotency_key;
  if (existing.issue_id, existing.payload, existing.model_id, existing.prompt_version, existing.created_by)
     is distinct from (p_issue_id, p_payload, p_model_id, p_prompt_version, actor) then
    raise exception 'Proposal idempotency key was used with different data';
  end if;
  return jsonb_build_object('id', existing.id, 'revision', existing.revision);
end
$$;
create trigger proposal_creation_audit after insert on public.proposals
  for each row execute function private.write_audit_event();

create or replace function public.reserve_model_budget(
  p_organization_id uuid, p_issue_id uuid, p_model_id text,
  p_max_input_tokens integer, p_max_output_tokens integer, p_max_attempts integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'UTC')::date;
  reserve_count integer := (p_max_input_tokens + p_max_output_tokens) * p_max_attempts;
  daily_limit integer;
  already_reserved boolean;
begin
  if auth.uid() is null or not private.has_org_role(p_organization_id, array['owner','operator']) then
    raise exception 'Organization operator role required';
  end if;
  if not exists (select 1 from public.issues i where i.organization_id = p_organization_id and i.id = p_issue_id) then
    raise exception 'Issue not found in organization';
  end if;
  if p_max_input_tokens < 1 or p_max_input_tokens > 12000 or p_max_output_tokens < 1
     or p_max_attempts < 1 or p_max_attempts > 3 or p_model_id <> 'openai/gpt-6-luna' then
    raise exception 'Invalid model budget request';
  end if;
  insert into private.ai_model_budgets (organization_id) values (p_organization_id)
    on conflict (organization_id) do nothing;
  perform 1 from private.ai_model_budgets b where b.organization_id = p_organization_id for update;
  select b.daily_token_limit into daily_limit from private.ai_model_budgets b where b.organization_id = p_organization_id;
  select exists (select 1 from private.ai_budget_reservations r where r.organization_id = p_organization_id
    and r.issue_id = p_issue_id and r.model_id = p_model_id and r.budget_day = today) into already_reserved;
  if already_reserved then return false; end if;
  if coalesce((select sum(r.reserved_tokens) from private.ai_budget_reservations r
    where r.organization_id = p_organization_id and r.budget_day = today), 0) + reserve_count > daily_limit then
    return false;
  end if;
  insert into private.ai_budget_reservations (organization_id, issue_id, model_id, budget_day, reserved_tokens, max_attempts)
    values (p_organization_id, p_issue_id, p_model_id, today, reserve_count, p_max_attempts);
  return true;
end
$$;

create or replace function public.record_model_usage(
  p_organization_id uuid, p_issue_id uuid, p_model_id text, p_usage jsonb, p_attempt integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare reservation uuid; allowed_attempts integer;
begin
  if auth.uid() is null or not private.has_org_role(p_organization_id, array['owner','operator']) then
    raise exception 'Organization operator role required';
  end if;
  if p_attempt < 1 or p_attempt > 3 then raise exception 'Invalid attempt'; end if;
  select r.id, r.max_attempts into reservation, allowed_attempts from private.ai_budget_reservations r
   where r.organization_id = p_organization_id and r.issue_id = p_issue_id
     and r.model_id = p_model_id and r.budget_day = (now() at time zone 'UTC')::date;
  if reservation is null then raise exception 'No model budget reservation exists'; end if;
  if p_attempt > allowed_attempts then raise exception 'Attempt exceeds reserved model budget'; end if;
  insert into private.ai_model_usage (reservation_id, attempt, usage)
    values (reservation, p_attempt, coalesce(p_usage, '{}'::jsonb))
    on conflict (reservation_id, attempt) do nothing;
  return true;
end
$$;

create or replace function public.save_projection_run(
  p_organization_id uuid, p_source_run_id uuid, p_calculation_version text,
  p_result jsonb, p_idempotency_key text, p_correlation_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  source public.projection_runs%rowtype;
  new_id uuid;
  existing public.projection_runs%rowtype;
  run_status text;
begin
  if actor is null or not private.has_org_role(p_organization_id, array['owner','reviewer']) then
    raise exception 'Organization reviewer role required';
  end if;
  if length(btrim(p_idempotency_key)) < 8 or p_result is null or jsonb_typeof(p_result) <> 'object' then
    raise exception 'Replay result and idempotency key required';
  end if;
  select * into source from public.projection_runs r
   where r.organization_id = p_organization_id and r.id = p_source_run_id;
  if not found then raise exception 'Source projection run not found'; end if;
  select case when p_result->>'status' in ('complete','incomplete','failed') then p_result->>'status' else 'incomplete' end into run_status;
  insert into public.projection_runs (organization_id, account_id, period_start, period_end,
    calculation_version, source_snapshot_hash, status, result, idempotency_key, source_snapshot)
  values (p_organization_id, source.account_id, source.period_start, source.period_end,
    p_calculation_version, source.source_snapshot_hash, run_status, p_result, p_idempotency_key, source.source_snapshot)
  on conflict (organization_id, idempotency_key) do nothing returning id into new_id;
  if new_id is not null then return jsonb_build_object('id', new_id); end if;
  select * into existing from public.projection_runs r
   where r.organization_id = p_organization_id and r.idempotency_key = p_idempotency_key;
  if (existing.account_id, existing.period_start, existing.period_end, existing.calculation_version,
      existing.source_snapshot_hash, existing.result)
     is distinct from (source.account_id, source.period_start, source.period_end, p_calculation_version,
      source.source_snapshot_hash, p_result) then
    raise exception 'Projection idempotency key was used with different data';
  end if;
  return jsonb_build_object('id', existing.id);
end
$$;
create trigger projection_run_audit after insert on public.projection_runs
  for each row execute function private.write_audit_event();

create or replace function public.persist_square_webhook(p_notification_id text, p_record jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare inserted boolean; existing private.square_webhook_inbox%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_record->>'notificationId' is distinct from p_notification_id
     or p_record->>'signatureVerified' <> 'true' or p_record->'payload' is null
     or p_record->>'rawBodySha256' !~ '^[0-9a-f]{64}$' then
    raise exception 'Verified webhook record required';
  end if;
  insert into private.square_webhook_inbox (notification_id, event_type, merchant_id,
    location_id, received_at, signature_verified, raw_body_sha256, payload)
  values (p_notification_id, p_record->>'eventType', p_record->>'merchantId',
    p_record->>'locationId', (p_record->>'receivedAt')::timestamptz, true,
    p_record->>'rawBodySha256', p_record->'payload')
  on conflict (notification_id) do nothing returning true into inserted;
  if coalesce(inserted, false) then return true; end if;
  select * into existing from private.square_webhook_inbox w where w.notification_id = p_notification_id;
  if (existing.event_type, existing.merchant_id, existing.location_id, existing.raw_body_sha256, existing.payload)
     is distinct from (p_record->>'eventType', p_record->>'merchantId', p_record->>'locationId', p_record->>'rawBodySha256', p_record->'payload') then
    raise exception 'Square notification ID was reused with different payload';
  end if;
  return false;
end
$$;

create or replace function public.enqueue_square_sync(
  p_organization_id uuid, p_start_at timestamptz, p_end_at timestamptz,
  p_location_ids jsonb, p_idempotency_key text, p_requested_by uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare job_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_end_at <= p_start_at or length(btrim(p_idempotency_key)) < 8
     or not exists (select 1 from public.memberships m where m.organization_id = p_organization_id
       and m.user_id = p_requested_by and m.role = 'owner') then
    raise exception 'Authorized bounded sync request required';
  end if;
  insert into private.durable_jobs (organization_id, requested_by, job_type, idempotency_key, payload)
  values (p_organization_id, p_requested_by, 'square.sync', p_idempotency_key,
    jsonb_build_object('startAt', p_start_at, 'endAt', p_end_at, 'locationIds', coalesce(p_location_ids, '[]'::jsonb)))
  on conflict (job_type, organization_id, idempotency_key) where organization_id is not null do nothing returning id into job_id;
  if job_id is null then
    select j.id into job_id from private.durable_jobs j where j.job_type = 'square.sync'
      and j.organization_id = p_organization_id and j.idempotency_key = p_idempotency_key
      and j.requested_by = p_requested_by
      and j.payload = jsonb_build_object('startAt', p_start_at, 'endAt', p_end_at, 'locationIds', coalesce(p_location_ids, '[]'::jsonb));
    if job_id is null then raise exception 'Sync idempotency key was used with different data'; end if;
  end if;
  return jsonb_build_object('id', job_id);
end
$$;

create or replace function public.enqueue_square_webhook(p_notification_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job_id uuid; inbox private.square_webhook_inbox%rowtype; org uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  select * into inbox from private.square_webhook_inbox w where w.notification_id = p_notification_id;
  if not found or not inbox.signature_verified then raise exception 'Verified inbox notification not found'; end if;
  select c.organization_id into org from private.square_merchant_connections c
   where c.square_merchant_id = inbox.merchant_id and c.active;
  if org is null then raise exception 'Square merchant is not mapped to an active organization'; end if;
  insert into private.durable_jobs (organization_id, job_type, idempotency_key, payload)
  values (org, 'square.webhook', p_notification_id, jsonb_build_object('notificationId', p_notification_id))
  on conflict (job_type, organization_id, idempotency_key) where organization_id is not null do nothing returning id into job_id;
  if job_id is null then
    select j.id into job_id from private.durable_jobs j where j.job_type = 'square.webhook'
      and j.organization_id = org and j.idempotency_key = p_notification_id;
  end if;
  return jsonb_build_object('id', job_id);
end
$$;

create or replace function public.claim_durable_jobs(p_worker_id text, p_lease_seconds integer, p_types text[])
returns setof private.durable_jobs language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_worker_id is null or length(p_worker_id) > 200 or p_lease_seconds < 30 or p_lease_seconds > 900
     or coalesce(cardinality(p_types), 0) = 0 then raise exception 'Invalid worker lease request'; end if;
  return query with selected as (
    select j.id from private.durable_jobs j where j.job_type = any(p_types)
     and ((j.status = 'queued' and (j.retry_at is null or j.retry_at <= now()))
       or (j.status = 'running' and j.claimed_at < now() - make_interval(secs => p_lease_seconds)))
     and j.attempts < j.max_attempts
     order by j.created_at for update skip locked limit 1
  ) update private.durable_jobs j set status = 'running', claimed_at = now(), locked_by = p_worker_id,
    lease_token = gen_random_uuid(),
    attempts = j.attempts + 1
    from selected s where j.id = s.id returning j.*;
end
$$;

create or replace function public.ack_durable_job(p_job_id uuid, p_worker_id text, p_lease_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  update private.durable_jobs set status = 'complete', finished_at = now(), locked_by = null, lease_token = null
   where id = p_job_id and status = 'running' and locked_by = p_worker_id and lease_token = p_lease_token;
  get diagnostics affected = row_count;
  return affected = 1;
end
$$;

create or replace function public.retry_durable_job(p_job_id uuid, p_worker_id text,
  p_lease_token uuid, p_delay_ms integer, p_error_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_delay_ms < 0 or p_delay_ms > 900000 then raise exception 'Invalid retry delay'; end if;
  update private.durable_jobs set status = 'queued', retry_at = now() + make_interval(secs => p_delay_ms / 1000.0),
    locked_by = null, lease_token = null, last_error_code = left(p_error_code, 100)
   where id = p_job_id and status = 'running' and locked_by = p_worker_id
     and lease_token = p_lease_token and attempts < max_attempts;
  get diagnostics affected = row_count;
  return affected = 1;
end
$$;

create or replace function public.dead_letter_durable_job(p_job_id uuid, p_worker_id text,
  p_lease_token uuid, p_error_code text, p_message text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  update private.durable_jobs set status = 'dead_letter', finished_at = now(), locked_by = null, lease_token = null,
    last_error_code = left(p_error_code, 100), result = jsonb_build_object('message', left(p_message, 500))
   where id = p_job_id and status = 'running' and locked_by = p_worker_id and lease_token = p_lease_token;
  get diagnostics affected = row_count;
  return affected = 1;
end
$$;

create or replace function public.save_square_oauth_state(p_state_sha256 text, p_organization_id uuid,
  p_user_id uuid, p_redirect_uri text, p_expires_at timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_state_sha256 !~ '^[0-9a-f]{64}$' or p_expires_at <= now()
     or p_expires_at > now() + interval '15 minutes' then raise exception 'Invalid OAuth state'; end if;
  delete from private.square_oauth_states s where s.expires_at <= now();
  insert into private.square_oauth_states (state_sha256, organization_id, user_id, redirect_uri, expires_at)
    values (p_state_sha256, p_organization_id, p_user_id, p_redirect_uri, p_expires_at);
  return true;
end
$$;

create or replace function public.consume_square_oauth_state(p_state_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved private.square_oauth_states%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  delete from private.square_oauth_states s where s.state_sha256 = p_state_sha256 returning s.* into saved;
  if saved.state_sha256 is null then return null; end if;
  return jsonb_build_object('organizationId', saved.organization_id, 'userId', saved.user_id,
    'redirectUri', saved.redirect_uri, 'expiresAt', saved.expires_at);
end
$$;

create or replace function public.store_square_tokens(p_record jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_record->>'organizationId' is null or p_record->>'merchantId' is null
     or p_record->>'connectedBy' is null or p_record->>'accessCiphertext' is null
     or p_record->>'refreshCiphertext' is null or p_record->>'accessNonce' is null
     or p_record->>'refreshNonce' is null or p_record->>'accessTag' is null
     or p_record->>'refreshTag' is null then raise exception 'Encrypted token fields required'; end if;
  insert into private.square_merchant_connections (organization_id, square_merchant_id, active,
    connected_by, access_ciphertext, access_nonce, access_tag, refresh_ciphertext,
    refresh_nonce, refresh_tag, expires_at, scopes, token_type, updated_at)
  values ((p_record->>'organizationId')::uuid, p_record->>'merchantId', true,
    (p_record->>'connectedBy')::uuid, p_record->>'accessCiphertext', p_record->>'accessNonce',
    p_record->>'accessTag', p_record->>'refreshCiphertext', p_record->>'refreshNonce',
    p_record->>'refreshTag', (p_record->>'expiresAt')::timestamptz,
    array(select jsonb_array_elements_text(p_record->'scopes')), p_record->>'tokenType', now())
  on conflict (organization_id, square_merchant_id) do update set active = true,
    connected_by = excluded.connected_by, access_ciphertext = excluded.access_ciphertext,
    access_nonce = excluded.access_nonce, access_tag = excluded.access_tag,
    refresh_ciphertext = excluded.refresh_ciphertext, refresh_nonce = excluded.refresh_nonce,
    refresh_tag = excluded.refresh_tag, expires_at = excluded.expires_at,
    scopes = excluded.scopes, token_type = excluded.token_type, updated_at = now();
  insert into public.audit_events (organization_id, actor_user_id, actor_kind, action, entity_type,
    before_state, after_state, reason, correlation_id)
  values ((p_record->>'organizationId')::uuid, (p_record->>'connectedBy')::uuid, 'human', 'connect',
    'square_connection', null,
    jsonb_build_object('merchantId', p_record->>'merchantId', 'scopes', p_record->'scopes', 'expiresAt', p_record->>'expiresAt'),
    'Square read-only OAuth connection stored with encrypted credentials', gen_random_uuid()::text);
  return true;
end
$$;

create or replace function public.get_square_tokens(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved private.square_merchant_connections%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  select * into saved from private.square_merchant_connections c
   where c.organization_id = p_organization_id and c.active;
  if not found then return null; end if;
  return jsonb_build_object('organizationId', saved.organization_id, 'merchantId', saved.square_merchant_id,
    'connectedBy', saved.connected_by, 'accessCiphertext', saved.access_ciphertext,
    'accessNonce', saved.access_nonce, 'accessTag', saved.access_tag,
    'refreshCiphertext', saved.refresh_ciphertext, 'refreshNonce', saved.refresh_nonce,
    'refreshTag', saved.refresh_tag, 'expiresAt', saved.expires_at, 'scopes', to_jsonb(saved.scopes),
    'tokenType', saved.token_type);
end
$$;

create or replace function public.get_square_webhook_notification(p_organization_id uuid, p_notification_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved private.square_webhook_inbox%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  select w.* into saved from private.square_webhook_inbox w
   join private.square_merchant_connections c on c.square_merchant_id = w.merchant_id
   where c.organization_id = p_organization_id and c.active and w.notification_id = p_notification_id;
  if not found then return null; end if;
  return jsonb_build_object('notificationId', saved.notification_id, 'eventType', saved.event_type,
    'merchantId', saved.merchant_id, 'locationId', saved.location_id,
    'receivedAt', saved.received_at, 'signatureVerified', saved.signature_verified, 'payload', saved.payload);
end
$$;

create or replace function public.set_reconciliation_tolerance(
  p_organization_id uuid, p_tolerance_minor bigint, p_reason text, p_correlation_id text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); before_row jsonb; after_row jsonb;
begin
  if actor is null or not private.has_org_role(p_organization_id, array['owner']) then
    raise exception 'Organization owner role required';
  end if;
  if p_tolerance_minor < 0 or length(btrim(p_reason)) < 10 then raise exception 'Tolerance and reason are invalid'; end if;
  select to_jsonb(p) into before_row from public.organization_accounting_policies p where p.organization_id = p_organization_id for update;
  if before_row is null then raise exception 'Organization accounting policy not found'; end if;
  update public.organization_accounting_policies p set reconciliation_tolerance_minor = p_tolerance_minor,
    configured_by = actor, updated_at = now() where p.organization_id = p_organization_id returning to_jsonb(p) into after_row;
  insert into public.audit_events (organization_id, actor_user_id, actor_kind, action, entity_type,
    before_state, after_state, reason, correlation_id)
  values (p_organization_id, actor, 'human', 'update', 'organization_accounting_policy',
    before_row, after_row, p_reason, coalesce(p_correlation_id, gen_random_uuid()::text));
  return true;
end
$$;

create or replace function public.set_correction_authority(
  p_organization_id uuid, p_user_id uuid, p_authorized boolean, p_designated_by uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_user_id = p_designated_by or not exists (select 1 from public.memberships m
      where m.organization_id = p_organization_id and m.user_id = p_designated_by and m.role = 'owner') then
    raise exception 'A different organization owner must designate correction authority';
  end if;
  if p_authorized then
    if not exists (select 1 from public.memberships m where m.organization_id = p_organization_id
        and m.user_id = p_user_id and m.role = 'owner') then
      raise exception 'Correction authority must be an organization owner';
    end if;
    insert into private.correction_authorities (organization_id, user_id, designated_by)
      values (p_organization_id, p_user_id, p_designated_by)
      on conflict (organization_id, user_id) do update set designated_by = excluded.designated_by, designated_at = now();
  else
    delete from private.correction_authorities a where a.organization_id = p_organization_id and a.user_id = p_user_id;
  end if;
  insert into public.audit_events (organization_id, actor_user_id, actor_kind, action, entity_type,
    entity_id, after_state, reason, correlation_id)
  values (p_organization_id, p_designated_by, 'human', case when p_authorized then 'grant' else 'revoke' end,
    'correction_authority', p_user_id,
    jsonb_build_object('userId', p_user_id, 'authorized', p_authorized),
    'Designated correction authority updated by organization owner', gen_random_uuid()::text);
  return true;
end
$$;

-- Opening balance setup is explicit, evidence-linked, and never defaults to zero.
alter table public.accounts add column opening_balance_minor bigint;
alter table public.accounts add column opening_balance_at timestamptz;
alter table public.accounts add column opening_evidence_file_id uuid;
alter table public.accounts add constraint accounts_opening_balance_fields_check check (
  (opening_balance_minor is null and opening_balance_at is null and opening_evidence_file_id is null)
  or (opening_balance_minor is not null and opening_balance_minor >= 0
      and opening_balance_at is not null and opening_evidence_file_id is not null)
);
alter table public.accounts add constraint accounts_opening_evidence_org_fk
  foreign key (organization_id, opening_evidence_file_id)
  references public.evidence_files(organization_id, id);

create or replace function public.configure_account_opening_balance(
  p_organization_id uuid, p_account_id uuid, p_amount_minor bigint,
  p_observed_at timestamptz, p_evidence_file_id uuid, p_reason text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  before_row jsonb;
  result_id uuid;
begin
  if actor is null or not private.has_org_role(p_organization_id, array['owner']) then
    raise exception 'Organization owner role required';
  end if;
  if p_amount_minor < 0 or p_observed_at is null or length(btrim(p_reason)) < 10 then
    raise exception 'Nonnegative opening balance, timestamp, and reason of 10+ characters required';
  end if;
  select jsonb_build_object('openingBalanceMinor', a.opening_balance_minor,
    'openingBalanceAt', a.opening_balance_at, 'openingEvidenceFileId', a.opening_evidence_file_id)
    into before_row
    from public.accounts a
   where a.organization_id = p_organization_id and a.id = p_account_id
     and a.kind = 'bank' and a.active
   for update;
  if not found then raise exception 'Active bank account not found'; end if;
  if not exists (select 1 from public.evidence_files e
      where e.organization_id = p_organization_id and e.id = p_evidence_file_id) then
    raise exception 'Organization evidence file required';
  end if;
  update public.accounts a set opening_balance_minor = p_amount_minor,
    opening_balance_at = p_observed_at, opening_evidence_file_id = p_evidence_file_id
   where a.organization_id = p_organization_id and a.id = p_account_id
  returning a.id into result_id;
  insert into public.audit_events (organization_id, actor_user_id, actor_kind, action,
    entity_type, entity_id, before_state, after_state, reason, correlation_id)
  values (p_organization_id, actor, 'human', 'configure_opening_balance', 'account', result_id,
    before_row, jsonb_build_object('openingBalanceMinor', p_amount_minor,
      'openingBalanceAt', p_observed_at, 'openingEvidenceFileId', p_evidence_file_id),
    p_reason, gen_random_uuid()::text);
  return result_id;
end
$$;

revoke all on table private.ai_model_budgets, private.ai_budget_reservations,
  private.ai_model_usage, private.square_merchant_connections, private.square_webhook_inbox,
  private.square_oauth_states, private.correction_authorities, private.durable_jobs from public, anon, authenticated;
revoke all on function private.seed_org_accounting_policy() from public, anon, authenticated;
revoke all on function public.configure_account_opening_balance(uuid,uuid,bigint,timestamptz,uuid,text) from public, anon;
revoke all on function public.create_proposal_atomic(uuid,uuid,jsonb,text,text,text,text,text) from public, anon;
revoke all on function public.reserve_model_budget(uuid,uuid,text,integer,integer,integer) from public, anon;
revoke all on function public.record_model_usage(uuid,uuid,text,jsonb,integer) from public, anon;
revoke all on function public.save_projection_run(uuid,uuid,text,jsonb,text,text) from public, anon;
revoke all on function public.persist_square_webhook(text,jsonb) from public, anon, authenticated;
revoke all on function public.enqueue_square_sync(uuid,timestamptz,timestamptz,jsonb,text,uuid) from public, anon, authenticated;
revoke all on function public.enqueue_square_webhook(text) from public, anon, authenticated;
revoke all on function public.claim_durable_jobs(text,integer,text[]) from public, anon, authenticated;
revoke all on function public.ack_durable_job(uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.retry_durable_job(uuid,text,uuid,integer,text) from public, anon, authenticated;
revoke all on function public.dead_letter_durable_job(uuid,text,uuid,text,text) from public, anon, authenticated;
revoke all on function public.save_square_oauth_state(text,uuid,uuid,text,timestamptz) from public, anon, authenticated;
revoke all on function public.consume_square_oauth_state(text) from public, anon, authenticated;
revoke all on function public.store_square_tokens(jsonb) from public, anon, authenticated;
revoke all on function public.get_square_tokens(uuid) from public, anon, authenticated;
revoke all on function public.get_square_webhook_notification(uuid,text) from public, anon, authenticated;
revoke all on function public.set_reconciliation_tolerance(uuid,bigint,text,text) from public, anon;
revoke all on function public.set_correction_authority(uuid,uuid,boolean,uuid) from public, anon, authenticated;
grant execute on function public.create_proposal_atomic(uuid,uuid,jsonb,text,text,text,text,text) to authenticated;
grant execute on function public.reserve_model_budget(uuid,uuid,text,integer,integer,integer) to authenticated;
grant execute on function public.record_model_usage(uuid,uuid,text,jsonb,integer) to authenticated;
grant execute on function public.save_projection_run(uuid,uuid,text,jsonb,text,text) to authenticated;
grant execute on function public.persist_square_webhook(text,jsonb) to service_role;
grant execute on function public.enqueue_square_sync(uuid,timestamptz,timestamptz,jsonb,text,uuid) to service_role;
grant execute on function public.enqueue_square_webhook(text) to service_role;
grant execute on function public.claim_durable_jobs(text,integer,text[]) to service_role;
grant execute on function public.ack_durable_job(uuid,text,uuid) to service_role;
grant execute on function public.retry_durable_job(uuid,text,uuid,integer,text) to service_role;
grant execute on function public.dead_letter_durable_job(uuid,text,uuid,text,text) to service_role;
grant execute on function public.save_square_oauth_state(text,uuid,uuid,text,timestamptz) to service_role;
grant execute on function public.consume_square_oauth_state(text) to service_role;
grant execute on function public.store_square_tokens(jsonb) to service_role;
grant execute on function public.get_square_tokens(uuid) to service_role;
grant execute on function public.get_square_webhook_notification(uuid,text) to service_role;
grant execute on function public.set_reconciliation_tolerance(uuid,bigint,text,text) to authenticated;
grant execute on function public.set_correction_authority(uuid,uuid,boolean,uuid) to service_role;
grant execute on function public.configure_account_opening_balance(uuid,uuid,bigint,timestamptz,uuid,text) to authenticated;

alter table public.organization_accounting_policies enable row level security;
create policy accounting_policy_read on public.organization_accounting_policies for select to authenticated
  using (public.is_org_member(organization_id));
revoke all on public.organization_accounting_policies from anon, authenticated;
grant select on public.organization_accounting_policies to authenticated;
