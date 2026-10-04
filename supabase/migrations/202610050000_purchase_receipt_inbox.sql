-- Durable, evidence-linked supplier receipt intake. Integrations can submit
-- documents and read status; only an authenticated owner/reviewer can approve.

alter table public.evidence_files alter column uploaded_by drop not null;
alter table public.evidence_files add column uploaded_via text not null default 'human'
  check (uploaded_via in ('human','integration'));
alter table public.evidence_files add column integration_id uuid;
alter table public.evidence_files add constraint evidence_upload_actor_check
  check ((uploaded_via='human' and uploaded_by is not null and integration_id is null)
      or (uploaded_via='integration' and uploaded_by is null and integration_id is not null));

create table private.purchase_receipt_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 100),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  revoked_by uuid references auth.users(id),
  revoked_at timestamptz,
  unique (organization_id,id),
  check ((revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_by is not null))
);
revoke all on private.purchase_receipt_integrations from public,anon,authenticated;
alter table public.evidence_files add constraint evidence_integration_org_fk
  foreign key (organization_id,integration_id) references private.purchase_receipt_integrations(organization_id,id);

create table public.purchase_receipt_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  integration_id uuid,
  external_submission_id text not null check (length(btrim(external_submission_id)) between 1 and 200),
  original_filename text not null check (length(btrim(original_filename)) between 1 and 512),
  declared_mime_type text not null check (length(btrim(declared_mime_type)) between 1 and 128),
  status text not null default 'awaiting_upload' check (status in
    ('awaiting_upload','queued','processing','needs_review','approved','projection_pending','posted','rejected','failed','duplicate')),
  duplicate_of uuid,
  evidence_file_id uuid,
  active_draft_version integer,
  uploaded_at timestamptz,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (organization_id,id),
  unique (organization_id,external_submission_id),
  foreign key (organization_id,integration_id) references private.purchase_receipt_integrations(organization_id,id),
  foreign key (organization_id,evidence_file_id) references public.evidence_files(organization_id,id),
  foreign key (organization_id,duplicate_of) references public.purchase_receipt_submissions(organization_id,id),
  check ((integration_id is null and created_by is not null) or (integration_id is not null and created_by is null))
);
create index purchase_receipt_inbox_idx on public.purchase_receipt_submissions(organization_id,status,submitted_at desc);
alter table public.purchase_receipt_submissions add column last_error_code text;
alter table public.purchase_receipt_submissions enable row level security;
revoke all on public.purchase_receipt_submissions from public,anon,authenticated;
grant select on public.purchase_receipt_submissions to authenticated;
grant select on public.purchase_receipt_submissions to service_role;
create policy purchase_receipt_submission_read on public.purchase_receipt_submissions
  for select to authenticated using (public.is_org_member(organization_id));

create table public.purchase_receipt_draft_versions (
  organization_id uuid not null,
  receipt_id uuid not null,
  version integer not null check (version > 0),
  draft jsonb not null check (jsonb_typeof(draft)='object'),
  created_at timestamptz not null default now(),
  primary key (organization_id,receipt_id,version),
  foreign key (organization_id,receipt_id) references public.purchase_receipt_submissions(organization_id,id)
);
alter table public.purchase_receipt_draft_versions enable row level security;
revoke all on public.purchase_receipt_draft_versions from public,anon,authenticated;
grant select on public.purchase_receipt_draft_versions to authenticated;
grant select on public.purchase_receipt_draft_versions to service_role;
create policy purchase_receipt_draft_read on public.purchase_receipt_draft_versions
  for select to authenticated using (public.is_org_member(organization_id));
create trigger purchase_receipt_drafts_append_only before update or delete on public.purchase_receipt_draft_versions
  for each row execute function private.reject_row_change();

create table public.purchase_receipt_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  receipt_id uuid not null,
  draft_version integer not null,
  decision text not null check (decision in ('approved','rejected')),
  selections jsonb not null check (jsonb_typeof(selections)='object'),
  reason text not null check (length(btrim(reason)) between 10 and 1000),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 8 and 200),
  decided_by uuid not null references auth.users(id),
  decided_at timestamptz not null default now(),
  unique (organization_id,id),
  unique (organization_id,idempotency_key),
  foreign key (organization_id,receipt_id,draft_version)
    references public.purchase_receipt_draft_versions(organization_id,receipt_id,version),
  foreign key (organization_id,receipt_id) references public.purchase_receipt_submissions(organization_id,id)
);
alter table public.purchase_receipt_decisions enable row level security;
revoke all on public.purchase_receipt_decisions from public,anon,authenticated;
grant select on public.purchase_receipt_decisions to authenticated;
grant select on public.purchase_receipt_decisions to service_role;
create policy purchase_receipt_decision_read on public.purchase_receipt_decisions
  for select to authenticated using (public.is_org_member(organization_id));
create trigger purchase_receipt_decisions_append_only before update or delete on public.purchase_receipt_decisions
  for each row execute function private.reject_row_change();

create table public.purchase_receipt_effects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  receipt_id uuid not null,
  source_line_id text not null,
  effect_type text not null check (effect_type in ('cost_update','stock_receipt','payment')),
  effect_key text not null check (length(btrim(effect_key)) between 1 and 200),
  decision_id uuid not null,
  effect_payload jsonb not null check (jsonb_typeof(effect_payload)='object'),
  inventory_movement_id uuid,
  cash_movement_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id,id),
  unique (organization_id,receipt_id,effect_type,effect_key),
  foreign key (organization_id,receipt_id) references public.purchase_receipt_submissions(organization_id,id),
  foreign key (organization_id,decision_id) references public.purchase_receipt_decisions(organization_id,id),
  foreign key (organization_id,inventory_movement_id) references public.inventory_movements(organization_id,id),
  foreign key (organization_id,cash_movement_id) references public.cash_movements(organization_id,id)
);
alter table public.purchase_receipt_effects enable row level security;
revoke all on public.purchase_receipt_effects from public,anon,authenticated;
grant select on public.purchase_receipt_effects to authenticated;
grant select on public.purchase_receipt_effects to service_role;
create policy purchase_receipt_effect_read on public.purchase_receipt_effects
  for select to authenticated using (public.is_org_member(organization_id));
create unique index purchase_receipt_effect_cash_unique on public.purchase_receipt_effects(organization_id,cash_movement_id)
  where cash_movement_id is not null and effect_type='payment';
create trigger purchase_receipt_effects_append_only before update or delete on public.purchase_receipt_effects
  for each row execute function private.reject_row_change();

-- Preserve the original identity-XOR constraint; replace only the old
-- movement-type shape check to permit a supplier receipt without payment.
alter table public.inventory_movements drop constraint inventory_movements_check1;
alter table public.inventory_movements drop constraint inventory_movements_movement_type_check;
alter table public.inventory_movements add constraint inventory_movements_type_check
  check (movement_type in ('purchase_receipt','supplier_receipt','manual_correction','opening_balance'));
alter table public.inventory_movements add constraint inventory_movements_shape_check
  check ((movement_type='purchase_receipt' and quantity_delta>0 and unit_cost_minor is not null and cash_movement_id is not null)
    or (movement_type='supplier_receipt' and quantity_delta>0 and unit_cost_minor is not null and cash_movement_id is null)
    or (movement_type='manual_correction' and quantity_delta<>0 and unit_cost_minor is null and cash_movement_id is null)
    or (movement_type='opening_balance' and quantity_delta>=0 and unit_cost_minor is null and cash_movement_id is null));

alter table private.durable_jobs drop constraint durable_jobs_job_type_check;
alter table private.durable_jobs add constraint durable_jobs_job_type_check
  check (job_type in ('square.sync','square.webhook','projection.replay','issue.investigate','receipt.process'));
create unique index durable_jobs_receipt_key on private.durable_jobs(job_type,organization_id,idempotency_key)
  where job_type='receipt.process' and organization_id is not null;

create or replace function private.purchase_receipt_usd_minor(p_amount text,p_currency text)
returns bigint language plpgsql immutable set search_path = '' as $$
declare amount numeric;
begin
  if p_currency is distinct from 'USD' or coalesce(p_amount,'') !~ '^[0-9]+(\.[0-9]{1,2})?$' then return null; end if;
  amount:=p_amount::numeric*100;
  if amount<>trunc(amount) or amount>9223372036854775807 then return null; end if;
  return amount::bigint;
end $$;
revoke all on function private.purchase_receipt_usd_minor(text,text) from public,anon,authenticated;

create or replace function public.register_purchase_receipt_integration(
  p_organization_id uuid,p_name text,p_token_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); integration_id uuid;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner']) then raise exception 'Organization owner role required'; end if;
  if length(btrim(coalesce(p_name,''))) not between 1 and 100 or coalesce(p_token_sha256,'') !~ '^[0-9a-f]{64}$' then raise exception 'Invalid integration'; end if;
  insert into private.purchase_receipt_integrations(organization_id,display_name,token_sha256,created_by)
    values(p_organization_id,btrim(p_name),p_token_sha256,actor) returning id into integration_id;
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','create','purchase_receipt_integration',integration_id,
      jsonb_build_object('name',btrim(p_name)),'Created purchase receipt integration','purchase-receipt-integration:'||integration_id::text);
  return jsonb_build_object('id',integration_id,'name',btrim(p_name),'createdAt',now());
end $$;

create or replace function public.list_purchase_receipt_integrations(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); rows jsonb;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner']) then raise exception 'Organization owner role required'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'name',i.display_name,'createdAt',i.created_at,'revokedAt',i.revoked_at)
    order by i.created_at desc),'[]'::jsonb) into rows from private.purchase_receipt_integrations i where i.organization_id=p_organization_id;
  return rows;
end $$;

create or replace function public.revoke_purchase_receipt_integration(p_organization_id uuid,p_integration_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid());
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner']) then raise exception 'Organization owner role required'; end if;
  update private.purchase_receipt_integrations set revoked_by=actor,revoked_at=now()
   where organization_id=p_organization_id and id=p_integration_id and revoked_at is null;
  if not found and not exists(select 1 from private.purchase_receipt_integrations where organization_id=p_organization_id and id=p_integration_id and revoked_at is not null)
    then raise exception 'Integration not found'; end if;
  if found then
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','revoke','purchase_receipt_integration',p_integration_id,
      jsonb_build_object('revokedAt',now()),'Revoked purchase receipt integration','purchase-receipt-integration:'||p_integration_id::text);
  end if;
end $$;

create or replace function public.authorize_purchase_receipt_integration(p_token_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' or coalesce(p_token_sha256,'') !~ '^[0-9a-f]{64}$' then raise exception 'Service role required'; end if;
  select jsonb_build_object('organizationId',i.organization_id,'integrationId',i.id)
    into result from private.purchase_receipt_integrations i where i.token_sha256=p_token_sha256 and i.revoked_at is null;
  return result;
end $$;

create or replace function public.create_purchase_receipt_submission(
  p_organization_id uuid,p_integration_id uuid,p_external_submission_id text,p_filename text,p_mime_type text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare receipt_id uuid; existing public.purchase_receipt_submissions%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if not exists(select 1 from private.purchase_receipt_integrations i where i.organization_id=p_organization_id and i.id=p_integration_id and i.revoked_at is null)
    then raise exception 'Integration is not active for organization'; end if;
  if length(btrim(coalesce(p_external_submission_id,''))) not between 1 and 200 or length(btrim(coalesce(p_filename,''))) not between 1 and 512
     or p_mime_type not in ('application/pdf','image/jpeg','image/png') then raise exception 'Invalid purchase receipt submission'; end if;
  insert into public.purchase_receipt_submissions(organization_id,integration_id,external_submission_id,original_filename,declared_mime_type)
    values(p_organization_id,p_integration_id,btrim(p_external_submission_id),btrim(p_filename),p_mime_type)
    on conflict(organization_id,external_submission_id) do nothing returning id into receipt_id;
  if receipt_id is null then
    select * into existing from public.purchase_receipt_submissions s where s.organization_id=p_organization_id and s.external_submission_id=btrim(p_external_submission_id);
    if existing.integration_id is distinct from p_integration_id or existing.original_filename is distinct from btrim(p_filename)
      or existing.declared_mime_type is distinct from p_mime_type then raise exception 'External submission id was reused with different metadata'; end if;
    receipt_id:=existing.id;
  end if;
  return jsonb_build_object('receiptId',receipt_id,'status',(select s.status from public.purchase_receipt_submissions s where s.id=receipt_id),
    'objectKey',p_organization_id::text||'/purchase-receipts/'||receipt_id::text||'/'||btrim(p_filename));
end $$;

create or replace function public.create_manual_purchase_receipt_submission(
  p_organization_id uuid,p_submission_id text,p_filename text,p_mime_type text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); receipt_id uuid;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner','operator','reviewer']) then raise exception 'Organization member role required'; end if;
  if length(btrim(coalesce(p_submission_id,''))) not between 1 and 194 or length(btrim(coalesce(p_filename,''))) not between 1 and 512
    or p_mime_type not in ('application/pdf','image/jpeg','image/png') then raise exception 'Invalid purchase receipt submission'; end if;
  insert into public.purchase_receipt_submissions(organization_id,external_submission_id,original_filename,declared_mime_type,created_by)
    values(p_organization_id,'manual:'||btrim(p_submission_id),btrim(p_filename),p_mime_type,actor)
    on conflict(organization_id,external_submission_id) do nothing returning id into receipt_id;
  if receipt_id is null then
    select id into receipt_id from public.purchase_receipt_submissions where organization_id=p_organization_id
      and external_submission_id='manual:'||btrim(p_submission_id) and original_filename=btrim(p_filename)
      and declared_mime_type=p_mime_type and created_by=actor;
    if receipt_id is null then raise exception 'Manual submission id was reused with different metadata'; end if;
  end if;
  return jsonb_build_object('receiptId',receipt_id,'status',(select s.status from public.purchase_receipt_submissions s where s.id=receipt_id),
    'objectKey',p_organization_id::text||'/purchase-receipts/'||receipt_id::text||'/'||btrim(p_filename));
end $$;

create or replace function public.complete_purchase_receipt_upload(
  p_organization_id uuid,p_receipt_id uuid,p_object_key text,p_sha256_hex text,p_byte_size bigint,p_mime_type text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.purchase_receipt_submissions%rowtype; evidence_id uuid; job_id uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  select * into s from public.purchase_receipt_submissions where organization_id=p_organization_id and id=p_receipt_id for update;
  if not found then raise exception 'Receipt submission not found'; end if;
  if s.status<>'awaiting_upload' then
    if s.evidence_file_id is null or not exists(select 1 from public.evidence_files e where e.organization_id=p_organization_id
      and e.id=s.evidence_file_id and e.object_key=p_object_key and e.sha256_hex=p_sha256_hex and e.byte_size=p_byte_size and e.mime_type=p_mime_type)
      then raise exception 'Completed receipt upload cannot be replaced'; end if;
    return jsonb_build_object('receiptId',s.id,'status',s.status,'evidenceFileId',s.evidence_file_id,'duplicateOf',s.duplicate_of);
  end if;
  if p_object_key is null or p_object_key !~ ('^'||p_organization_id::text||'/purchase-receipts/'||p_receipt_id::text||'/[^/]+$')
    or coalesce(p_sha256_hex,'') !~ '^[0-9a-f]{64}$' or p_byte_size not between 1 and 25000000
    or p_mime_type not in ('application/pdf','image/jpeg','image/png') or p_mime_type<>s.declared_mime_type then raise exception 'Invalid uploaded receipt evidence'; end if;
  if not exists(select 1 from public.organization_feature_flags f where f.organization_id=p_organization_id and f.inventory_tracking)
    then raise exception 'FEATURE_DISABLED: inventory_tracking'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':purchase-receipt-sha:'||p_sha256_hex,0));
  insert into public.evidence_files(organization_id,object_key,sha256_hex,mime_type,byte_size,original_filename,uploaded_by,uploaded_via,integration_id)
    values(p_organization_id,p_object_key,p_sha256_hex,p_mime_type,p_byte_size,s.original_filename,s.created_by,
      case when s.integration_id is null then 'human' else 'integration' end,s.integration_id)
    returning id into evidence_id;
  select r.id into job_id from public.purchase_receipt_submissions r
    join public.evidence_files prior on prior.organization_id=r.organization_id and prior.id=r.evidence_file_id
    where r.organization_id=p_organization_id and r.id<>s.id and prior.sha256_hex=p_sha256_hex
    order by r.submitted_at limit 1;
  if job_id is not null then
    update public.purchase_receipt_submissions set evidence_file_id=evidence_id,status='duplicate',duplicate_of=job_id,uploaded_at=now(),updated_at=now()
      where organization_id=p_organization_id and id=p_receipt_id;
    return jsonb_build_object('receiptId',s.id,'evidenceFileId',evidence_id,'duplicateOf',job_id,'status','duplicate');
  end if;
  job_id:=null;
  insert into private.durable_jobs(organization_id,job_type,idempotency_key,payload)
    values(p_organization_id,'receipt.process','receipt:'||s.id::text,jsonb_build_object('receiptId',s.id,'evidenceFileId',evidence_id))
    on conflict (job_type,organization_id,idempotency_key) where job_type='receipt.process' and organization_id is not null do nothing returning id into job_id;
  if job_id is null then select id into job_id from private.durable_jobs where organization_id=p_organization_id and job_type='receipt.process' and idempotency_key='receipt:'||s.id::text; end if;
  update public.purchase_receipt_submissions set evidence_file_id=evidence_id,status='queued',uploaded_at=now(),updated_at=now()
   where organization_id=p_organization_id and id=p_receipt_id;
  return jsonb_build_object('receiptId',s.id,'evidenceFileId',evidence_id,'jobId',job_id,'status','queued');
end $$;

create or replace function public.get_purchase_receipt_for_processing(p_organization_id uuid,p_receipt_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  select jsonb_build_object('receiptId',s.id,'organizationId',s.organization_id,'evidenceFileId',s.evidence_file_id,
    'objectKey',e.object_key,'sha256Hex',e.sha256_hex,'mimeType',e.mime_type,'filename',e.original_filename,
    'activeDraftVersion',s.active_draft_version,'status',s.status) into result
  from public.purchase_receipt_submissions s join public.evidence_files e on e.organization_id=s.organization_id and e.id=s.evidence_file_id
  where s.organization_id=p_organization_id and s.id=p_receipt_id and s.status in ('queued','processing');
  if result is not null then update public.purchase_receipt_submissions set status='processing',updated_at=now() where organization_id=p_organization_id and id=p_receipt_id; end if;
  return result;
end $$;

create or replace function public.save_purchase_receipt_draft(
  p_organization_id uuid,p_receipt_id uuid,p_expected_version integer,p_draft jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.purchase_receipt_submissions%rowtype; next_version integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if jsonb_typeof(p_draft)<>'object' or p_draft->>'documentKind' not in ('receipt','invoice','unsupported','unclear')
    or jsonb_typeof(p_draft->'lines')<>'array' or jsonb_array_length(p_draft->'lines')>200
    or exists(select 1 from jsonb_array_elements(p_draft->'lines') l where jsonb_typeof(l)<>'object' or length(btrim(coalesce(l->>'lineId','')))=0)
    or (select count(distinct l->>'lineId') from jsonb_array_elements(p_draft->'lines') l)<>jsonb_array_length(p_draft->'lines') then raise exception 'Invalid extracted receipt draft'; end if;
  select * into s from public.purchase_receipt_submissions where organization_id=p_organization_id and id=p_receipt_id for update;
  if not found or s.status not in ('processing','queued') or coalesce(s.active_draft_version,0) is distinct from p_expected_version then raise exception 'Receipt draft version conflict'; end if;
  next_version:=coalesce(s.active_draft_version,0)+1;
  insert into public.purchase_receipt_draft_versions(organization_id,receipt_id,version,draft) values(p_organization_id,p_receipt_id,next_version,p_draft);
  update public.purchase_receipt_submissions set active_draft_version=next_version,status='needs_review',updated_at=now()
    where organization_id=p_organization_id and id=p_receipt_id;
  return jsonb_build_object('receiptId',p_receipt_id,'version',next_version,'status','needs_review');
end $$;

create or replace function public.fail_purchase_receipt_processing(p_organization_id uuid,p_receipt_id uuid,p_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' or length(btrim(coalesce(p_code,''))) not between 1 and 100 then raise exception 'Service role required and failure code required'; end if;
  update public.purchase_receipt_submissions set status='failed',last_error_code=btrim(p_code),updated_at=now()
   where organization_id=p_organization_id and id=p_receipt_id and status in ('queued','processing');
end $$;

create or replace function public.reserve_purchase_receipt_model_budget(
  p_organization_id uuid,p_receipt_id uuid,p_model_id text,p_max_input_tokens integer,p_max_output_tokens integer,p_max_attempts integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare today date := (now() at time zone 'UTC')::date; reserve_count integer; daily_limit integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if not exists(select 1 from public.purchase_receipt_submissions s where s.organization_id=p_organization_id and s.id=p_receipt_id and s.evidence_file_id is not null)
    then raise exception 'Purchase receipt not found'; end if;
  if not exists(select 1 from public.organization_feature_flags f where f.organization_id=p_organization_id and f.inventory_tracking)
    then raise exception 'FEATURE_DISABLED: inventory_tracking'; end if;
  if p_model_id<>'openai/gpt-6-luna' or p_max_input_tokens not between 1 and 12000 or p_max_output_tokens not between 1 and 1500
    or p_max_attempts not between 1 and 2 then raise exception 'Invalid receipt model budget request'; end if;
  reserve_count:=(p_max_input_tokens+p_max_output_tokens)*p_max_attempts;
  insert into private.ai_model_budgets(organization_id) values(p_organization_id) on conflict do nothing;
  perform 1 from private.ai_model_budgets b where b.organization_id=p_organization_id for update;
  select b.daily_token_limit into daily_limit from private.ai_model_budgets b where b.organization_id=p_organization_id;
  if exists(select 1 from private.receipt_agent_budget_reservations r where r.organization_id=p_organization_id and r.run_id=p_receipt_id
    and r.model_id=p_model_id and r.budget_day=today) then return false; end if;
  if coalesce((select sum(r.reserved_tokens) from private.ai_budget_reservations r where r.organization_id=p_organization_id and r.budget_day=today),0)
     +coalesce((select sum(r.reserved_tokens) from private.receipt_agent_budget_reservations r where r.organization_id=p_organization_id and r.budget_day=today),0)+reserve_count>daily_limit then return false; end if;
  insert into private.receipt_agent_budget_reservations(organization_id,run_id,model_id,budget_day,reserved_tokens,max_attempts)
    values(p_organization_id,p_receipt_id,p_model_id,today,reserve_count,p_max_attempts);
  return true;
end $$;

create or replace function public.record_purchase_receipt_model_usage(
  p_organization_id uuid,p_receipt_id uuid,p_model_id text,p_usage jsonb,p_attempt integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare reservation uuid; allowed_attempts integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if not exists(select 1 from public.purchase_receipt_submissions s where s.organization_id=p_organization_id and s.id=p_receipt_id)
    then raise exception 'Purchase receipt not found'; end if;
  if p_attempt not between 1 and 2 or jsonb_typeof(coalesce(p_usage,'{}'::jsonb))<>'object' or length(coalesce(p_usage,'{}'::jsonb)::text)>2000 then raise exception 'Invalid receipt model usage'; end if;
  select r.id,r.max_attempts into reservation,allowed_attempts from private.receipt_agent_budget_reservations r
   where r.organization_id=p_organization_id and r.run_id=p_receipt_id and r.model_id=p_model_id and r.budget_day=(now() at time zone 'UTC')::date;
  if reservation is null or p_attempt>allowed_attempts then raise exception 'No valid receipt model budget reservation exists'; end if;
  insert into private.receipt_agent_model_usage(reservation_id,attempt,usage) values(reservation,p_attempt,coalesce(p_usage,'{}'::jsonb)) on conflict do nothing;
  return true;
end $$;

create or replace function public.reject_purchase_receipt(
  p_organization_id uuid,p_receipt_id uuid,p_expected_version integer,p_reason text,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); s public.purchase_receipt_submissions%rowtype; decision_id uuid;
  prior_decision public.purchase_receipt_decisions%rowtype;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner','reviewer']) then raise exception 'Organization owner or reviewer role required'; end if;
  if length(btrim(coalesce(p_reason,''))) not between 10 and 1000 or length(btrim(coalesce(p_idempotency_key,''))) not between 8 and 200 then raise exception 'Reason and idempotency key required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_idempotency_key,0));
  select * into s from public.purchase_receipt_submissions where organization_id=p_organization_id and id=p_receipt_id for update;
  if not found then raise exception 'Receipt not found'; end if;
  select * into prior_decision from public.purchase_receipt_decisions where organization_id=p_organization_id and idempotency_key=p_idempotency_key;
  if found then
    if prior_decision.receipt_id is distinct from p_receipt_id or prior_decision.draft_version is distinct from p_expected_version
      or prior_decision.decision<>'rejected' or prior_decision.reason is distinct from btrim(p_reason) or prior_decision.decided_by is distinct from actor then
      raise exception 'Receipt decision idempotency key collision'; end if;
    return jsonb_build_object('receiptId',p_receipt_id,'decisionId',prior_decision.id,'status',s.status,'replayed',true);
  end if;
  if s.status<>'needs_review' or s.active_draft_version is distinct from p_expected_version then raise exception 'Receipt cannot be rejected in current state'; end if;
  if exists(select 1 from public.purchase_receipt_effects e where e.organization_id=p_organization_id and e.receipt_id=p_receipt_id) then raise exception 'Receipt already has posted effects'; end if;
  insert into public.purchase_receipt_decisions(organization_id,receipt_id,draft_version,decision,selections,reason,idempotency_key,decided_by)
    values(p_organization_id,p_receipt_id,p_expected_version,'rejected','{}'::jsonb,btrim(p_reason),p_idempotency_key,actor)
    on conflict(organization_id,idempotency_key) do nothing returning id into decision_id;
  if decision_id is null then
    select id into decision_id from public.purchase_receipt_decisions where organization_id=p_organization_id and idempotency_key=p_idempotency_key
      and receipt_id=p_receipt_id and decision='rejected' and reason=btrim(p_reason);
    if decision_id is null then raise exception 'Receipt decision idempotency key collision'; end if;
    return jsonb_build_object('receiptId',p_receipt_id,'decisionId',decision_id,'status','rejected','replayed',true);
  end if;
  update public.purchase_receipt_submissions set status='rejected',updated_at=now() where organization_id=p_organization_id and id=p_receipt_id;
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','reject','purchase_receipt',p_receipt_id,jsonb_build_object('decisionId',decision_id,'draftVersion',p_expected_version),btrim(p_reason),'purchase-receipt:'||p_receipt_id::text);
  return jsonb_build_object('receiptId',p_receipt_id,'decisionId',decision_id,'status','rejected');
end $$;

create or replace function public.approve_purchase_receipt(
  p_organization_id uuid,p_receipt_id uuid,p_expected_version integer,p_selections jsonb,p_reason text,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); s public.purchase_receipt_submissions%rowtype; draft jsonb; decision_id uuid;
  entry jsonb; line jsonb; line_id text; effect_key text; item_id uuid; def public.item_definitions%rowtype;
  inventory_item public.inventory_items%rowtype; movement_id uuid; cash_id uuid; account_currency char(3);
  cost_minor bigint; receipt_effective_from timestamptz; next_start timestamptz; next_version integer;
  item_name_value text; item_sku text; item_category text; before_value jsonb; cost_id uuid; catalog_id text;
  confirmed_currency text; package_qty numeric; units_per_package numeric; ordered_units numeric; prior_received numeric;
  total_minor bigint; currency_value text; occurred timestamptz; org_timezone text; paid_total numeric; prior_effect jsonb;
  prior_item_key text; selected_item_key text;
  prior_decision public.purchase_receipt_decisions%rowtype;
  result jsonb := jsonb_build_object('stockMovementIds','[]'::jsonb,'cashMovementIds','[]'::jsonb,'costUpdates','[]'::jsonb);
  start_at timestamptz; end_at timestamptz; replay_start timestamptz; replay_end timestamptz; replay_id uuid; revision bigint;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner','reviewer']) then raise exception 'Organization owner or reviewer role required'; end if;
  if not exists(select 1 from public.organization_feature_flags f where f.organization_id=p_organization_id and f.inventory_tracking) then raise exception 'FEATURE_DISABLED: inventory_tracking'; end if;
  if length(btrim(coalesce(p_reason,''))) not between 10 and 1000 or length(btrim(coalesce(p_idempotency_key,''))) not between 8 and 200
    or jsonb_typeof(p_selections)<>'object' or (p_selections - array['costUpdates','stockReceipts','payments','currency','confirmPurchaseDocument'])<>'{}'::jsonb
    or (p_selections ? 'currency' and p_selections->>'currency' is not null and p_selections->>'currency' !~ '^[A-Z]{3}$') then raise exception 'Invalid purchase receipt decision'; end if;
  if coalesce(p_selections->>'confirmPurchaseDocument','false') not in ('true','false') then raise exception 'Invalid document confirmation'; end if;
  if exists(select 1 from jsonb_each(p_selections) e where e.key not in ('currency','confirmPurchaseDocument') and jsonb_typeof(e.value)<>'array') then raise exception 'Invalid purchase receipt selections'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_idempotency_key,0));
  select * into s from public.purchase_receipt_submissions where organization_id=p_organization_id and id=p_receipt_id for update;
  if not found then raise exception 'Receipt not found'; end if;
  select d.draft into draft from public.purchase_receipt_draft_versions d where d.organization_id=p_organization_id and d.receipt_id=p_receipt_id and d.version=p_expected_version;
  select * into prior_decision from public.purchase_receipt_decisions d where d.organization_id=p_organization_id and d.idempotency_key=p_idempotency_key;
  if found then
    if prior_decision.receipt_id is distinct from p_receipt_id or prior_decision.draft_version is distinct from p_expected_version or prior_decision.decision<>'approved'
      or prior_decision.selections is distinct from p_selections or prior_decision.reason is distinct from btrim(p_reason) or prior_decision.decided_by is distinct from actor then
      raise exception 'Receipt decision idempotency key collision'; end if;
    return jsonb_build_object('receiptId',p_receipt_id,'decisionId',prior_decision.id,'status',s.status,'replayed',true);
  end if;
  if s.status not in ('needs_review','approved','projection_pending','posted') or s.active_draft_version is distinct from p_expected_version then raise exception 'Receipt version conflict'; end if;
  if draft->>'documentKind' in ('unsupported','unclear') and coalesce((p_selections->>'confirmPurchaseDocument')::boolean,false) is not true
    then raise exception 'Confirm that this is a supplier purchase document before approval'; end if;
  confirmed_currency:=coalesce(draft->>'currency',p_selections->>'currency');
  if draft->>'currency' is not null and p_selections->>'currency' is not null and draft->>'currency'<>p_selections->>'currency' then raise exception 'Confirmed currency conflicts with receipt'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(draft->'lines','[]'::jsonb)) l where coalesce(l->>'lineId','')='') then raise exception 'Invalid source line identifiers'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_selections->'costUpdates','[]'::jsonb)) x group by x.value->>'catalogObjectId' having count(*)>1)
    then raise exception 'A catalog variation can be updated only once per receipt approval'; end if;
  insert into public.purchase_receipt_decisions(organization_id,receipt_id,draft_version,decision,selections,reason,idempotency_key,decided_by)
   values(p_organization_id,p_receipt_id,p_expected_version,'approved',p_selections,btrim(p_reason),p_idempotency_key,actor)
   on conflict(organization_id,idempotency_key) do nothing returning id into decision_id;
  if decision_id is null then
    select id into decision_id from public.purchase_receipt_decisions where organization_id=p_organization_id and idempotency_key=p_idempotency_key
      and receipt_id=p_receipt_id and draft_version=p_expected_version and selections=p_selections and reason=btrim(p_reason);
    if decision_id is null then raise exception 'Receipt decision idempotency key collision'; end if;
    return jsonb_build_object('receiptId',p_receipt_id,'decisionId',decision_id,'status',s.status,'replayed',true);
  end if;
  for entry in select value from jsonb_array_elements(coalesce(p_selections->'costUpdates','[]'::jsonb)) loop
    line_id:=entry->>'lineId';
    select value into line from jsonb_array_elements(draft->'lines') where value->>'lineId'=line_id;
    if not found then raise exception 'Cost update references unknown receipt line'; end if;
    if length(btrim(coalesce(entry->>'catalogObjectId',''))) not between 1 and 200
      or length(btrim(coalesce(entry->>'name',''))) not between 1 and 200
      or coalesce(entry->>'unitCostMinor','') !~ '^[0-9]+$' or coalesce(entry->>'currency','') !~ '^[A-Z]{3}$'
      or coalesce(entry->>'effectiveFrom','')='' then raise exception 'Invalid receipt cost update'; end if;
    if not exists(select 1 from private.square_fact_current c
      join private.square_fact_versions v using(organization_id,fact_kind,object_id,object_version)
      where c.organization_id=p_organization_id and c.fact_kind='catalog' and c.object_id=entry->>'catalogObjectId'
        and v.fact->>'objectType'='ITEM_VARIATION'
        and v.fact->>'isDeleted' is distinct from 'true'
        and (coalesce(v.fact->>'currency','') !~ '^[A-Z]{3}$' or v.fact->>'currency'=entry->>'currency')) then
      raise exception 'Square catalog variation not found in organization'; end if;
    cost_minor:=(entry->>'unitCostMinor')::bigint; receipt_effective_from:=(entry->>'effectiveFrom')::timestamptz;
    if cost_minor<0 or cost_minor>=1000000000000 or receipt_effective_from is null
      or receipt_effective_from<=transaction_timestamp()-interval '369 days' then raise exception 'Invalid receipt cost amount or effective date'; end if;
    if entry->>'currency' is distinct from coalesce(line->>'currency',confirmed_currency) then raise exception 'Receipt cost currency does not match source line'; end if;
    perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||(entry->>'catalogObjectId'),0));
    select * into def from public.item_definitions d where d.organization_id=p_organization_id
      and d.square_catalog_object_id=entry->>'catalogObjectId' and d.currency=entry->>'currency'
      and d.effective_from<=receipt_effective_from and (d.effective_until is null or d.effective_until>receipt_effective_from)
      order by d.effective_from desc limit 1 for update;
    before_value:=case when found then jsonb_build_object('id',def.id,'unitCostMinor',def.unit_cost_minor,
      'effectiveFrom',def.effective_from,'effectiveUntil',def.effective_until) else null end;
    item_name_value:=coalesce(nullif(btrim(entry->>'name'),''),def.name);
    item_sku:=def.sku; item_category:=def.category;
    select coalesce(max(d.version),0)+1 into next_version from public.item_definitions d where d.organization_id=p_organization_id
      and d.square_catalog_object_id=entry->>'catalogObjectId';
    select min(d.effective_from) into next_start from public.item_definitions d where d.organization_id=p_organization_id
      and d.square_catalog_object_id=entry->>'catalogObjectId' and d.effective_from>receipt_effective_from;
    if exists(select 1 from public.accounting_periods p where p.organization_id=p_organization_id and p.status='closed'
      and p.starts_at<coalesce(next_start,def.effective_until,'infinity'::timestamptz) and p.ends_at>receipt_effective_from)
      then raise exception 'PERIOD_CLOSED'; end if;
    if def.id is not null then
      if def.effective_from=receipt_effective_from then
        update public.item_definitions set unit_cost_minor=cost_minor,approved_by=actor,approved_at=now(),
          approval_reason='Supplier receipt '||p_receipt_id::text||': '||btrim(p_reason),version=next_version,name=item_name_value
          where organization_id=p_organization_id and id=def.id returning id into cost_id;
      else
        update public.item_definitions set effective_until=receipt_effective_from where organization_id=p_organization_id and id=def.id;
        next_start:=def.effective_until;
        insert into public.item_definitions(organization_id,square_catalog_object_id,sku,name,category,unit_cost_minor,currency,effective_from,effective_until,approved_by,approved_at,version,approval_reason)
          values(p_organization_id,entry->>'catalogObjectId',item_sku,item_name_value,item_category,cost_minor,entry->>'currency',receipt_effective_from,
            coalesce(def.effective_until,next_start),actor,now(),next_version,'Supplier receipt '||p_receipt_id::text||': '||btrim(p_reason)) returning id into cost_id;
      end if;
    else
      insert into public.item_definitions(organization_id,square_catalog_object_id,sku,name,category,unit_cost_minor,currency,effective_from,effective_until,approved_by,approved_at,version,approval_reason)
        values(p_organization_id,entry->>'catalogObjectId',null,item_name_value,null,cost_minor,entry->>'currency',receipt_effective_from,next_start,
          actor,now(),next_version,'Supplier receipt '||p_receipt_id::text||': '||btrim(p_reason)) returning id into cost_id;
    end if;
    insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id)
      values(p_organization_id,actor,'human',case when before_value is null then 'insert' else 'update' end,'item_definition',cost_id,before_value,
        jsonb_build_object('catalogObjectId',entry->>'catalogObjectId','unitCostMinor',cost_minor,'currency',entry->>'currency','effectiveFrom',receipt_effective_from,'receiptId',p_receipt_id),
        btrim(p_reason),'purchase-receipt:'||p_receipt_id::text||':cost:'||line_id);
    effect_key:=line_id;
    insert into public.purchase_receipt_effects(organization_id,receipt_id,source_line_id,effect_type,effect_key,decision_id,effect_payload)
      values(p_organization_id,p_receipt_id,line_id,'cost_update',effect_key,decision_id,entry);
    result:=jsonb_set(result,'{costUpdates}',(result->'costUpdates')||jsonb_build_array(jsonb_build_object('itemDefinitionId',cost_id,'catalogObjectId',entry->>'catalogObjectId','unitCostMinor',cost_minor,'currency',entry->>'currency','effectiveFrom',receipt_effective_from)));
    if receipt_effective_from<=now() then start_at:=least(coalesce(start_at,receipt_effective_from),receipt_effective_from); end_at:=greatest(coalesce(end_at,now()+interval '1 second'),now()+interval '1 second'); end if;
  end loop;
  for entry in select value from jsonb_array_elements(coalesce(p_selections->'stockReceipts','[]'::jsonb)) loop
    line_id:=entry->>'lineId'; effect_key:=entry->>'eventKey';
    select value into line from jsonb_array_elements(draft->'lines') where value->>'lineId'=line_id;
    if not found or length(btrim(coalesce(effect_key,''))) not between 1 and 200 then raise exception 'Stock receipt references unknown line or event key'; end if;
    if (coalesce(entry->>'quantity','') !~ '^[0-9]+$' or (entry->>'quantity')::numeric<=0 or (entry->>'quantity')::numeric>1000000
      or (entry->>'unitCostMinor') !~ '^[0-9]+$' or (entry->>'unitCostMinor')::numeric>999999999999
      or coalesce(entry->>'currency',confirmed_currency) !~ '^[A-Z]{3}$' or (entry->>'occurredAt') is null) then raise exception 'Invalid stock receipt'; end if;
    currency_value:=coalesce(entry->>'currency',confirmed_currency);
    if coalesce(line->>'currency',draft->>'currency') is not null and coalesce(line->>'currency',draft->>'currency')<>currency_value then raise exception 'Stock receipt currency conflicts with source'; end if;
    package_qty:=coalesce(nullif(entry->>'packageQuantity','')::numeric,nullif(line->>'packageQuantity','')::numeric,nullif(line->>'quantity','')::numeric,0);
    units_per_package:=coalesce(nullif(entry->>'unitsPerPackage','')::numeric,nullif(line->>'unitsPerPackage','')::numeric,1);
    if package_qty<=0 or units_per_package<=0 or units_per_package<>trunc(units_per_package) then raise exception 'Purchase quantity and package conversion are required'; end if;
    ordered_units:=package_qty*units_per_package;
    select coalesce(sum((e.effect_payload->>'quantity')::numeric),0) into prior_received from public.purchase_receipt_effects e
      where e.organization_id=p_organization_id and e.receipt_id=p_receipt_id and e.effect_type='stock_receipt' and e.source_line_id=line_id;
    select e.effect_payload into prior_effect from public.purchase_receipt_effects e where e.organization_id=p_organization_id
      and e.receipt_id=p_receipt_id and e.effect_type='stock_receipt' and e.source_line_id=line_id order by e.created_at limit 1;
    if prior_effect is not null and (prior_effect->>'packageQuantity')::numeric<>package_qty
      or prior_effect is not null and (prior_effect->>'unitsPerPackage')::numeric<>units_per_package
      or prior_effect is not null and prior_effect->>'currency' is distinct from currency_value then
      raise exception 'Partial receipt must retain the confirmed item, currency and package conversion';
    end if;
    if prior_effect is not null then
      select 'square:'||d.square_catalog_object_id into prior_item_key
        from public.item_definitions d where d.organization_id=p_organization_id and d.id=(prior_effect->>'itemId')::uuid;
      if prior_item_key is null then prior_item_key:='manual:'||(prior_effect->>'itemId'); end if;
      select 'square:'||d.square_catalog_object_id into selected_item_key
        from public.item_definitions d where d.organization_id=p_organization_id and d.id=(entry->>'itemId')::uuid;
      if selected_item_key is null then selected_item_key:='manual:'||(entry->>'itemId'); end if;
      if prior_item_key is distinct from selected_item_key then raise exception 'Partial receipt must retain the confirmed item identity'; end if;
    end if;
    if prior_received+(entry->>'quantity')::numeric>ordered_units then raise exception 'Received inventory exceeds confirmed purchased quantity'; end if;
    occurred:=(entry->>'occurredAt')::timestamptz;
    if not private.inventory_period_is_open(p_organization_id,occurred) then raise exception 'PERIOD_CLOSED'; end if;
    item_id:=(entry->>'itemId')::uuid;
    select * into def from public.item_definitions d where d.organization_id=p_organization_id and d.id=item_id and d.currency=currency_value;
    if found then
      catalog_id:=def.square_catalog_object_id;
      select * into def from public.item_definitions d where d.organization_id=p_organization_id and d.square_catalog_object_id=catalog_id
        and d.currency=currency_value and d.effective_from<=occurred and (d.effective_until is null or d.effective_until>occurred)
        order by d.effective_from desc limit 1;
      if not found then raise exception 'No effective item cost definition exists for stock receipt date'; end if;
      insert into public.inventory_movements(organization_id,item_definition_id,item_name,square_catalog_object_id,movement_type,quantity_delta,unit_cost_minor,currency,occurred_at,evidence_file_id,reason,idempotency_key,created_by)
      values(p_organization_id,def.id,def.name,def.square_catalog_object_id,'supplier_receipt',(entry->>'quantity')::numeric,(entry->>'unitCostMinor')::bigint,currency_value,occurred,s.evidence_file_id,btrim(p_reason),'purchase-receipt:'||p_receipt_id||':'||effect_key,actor) returning id into movement_id;
    else
      select * into inventory_item from public.inventory_items i where i.organization_id=p_organization_id and i.id=item_id and i.currency=currency_value;
      if not found then raise exception 'Inventory item not found in organization or currency'; end if;
      insert into public.inventory_movements(organization_id,inventory_item_id,item_name,movement_type,quantity_delta,unit_cost_minor,currency,occurred_at,evidence_file_id,reason,idempotency_key,created_by)
      values(p_organization_id,inventory_item.id,inventory_item.name,'supplier_receipt',(entry->>'quantity')::numeric,(entry->>'unitCostMinor')::bigint,currency_value,occurred,s.evidence_file_id,btrim(p_reason),'purchase-receipt:'||p_receipt_id||':'||effect_key,actor) returning id into movement_id;
    end if;
    insert into public.purchase_receipt_effects(organization_id,receipt_id,source_line_id,effect_type,effect_key,decision_id,effect_payload,inventory_movement_id)
      values(p_organization_id,p_receipt_id,line_id,'stock_receipt',effect_key,decision_id,
        entry||jsonb_build_object('currency',currency_value,'packageQuantity',package_qty,'unitsPerPackage',units_per_package),movement_id);
    result:=jsonb_set(result,'{stockMovementIds}',(result->'stockMovementIds')||jsonb_build_array(movement_id));
    start_at:=least(coalesce(start_at,occurred),occurred); end_at:=greatest(coalesce(end_at,occurred),occurred);
  end loop;
  for entry in select value from jsonb_array_elements(coalesce(p_selections->'payments','[]'::jsonb)) loop
    effect_key:=entry->>'paymentKey';
    if length(btrim(coalesce(effect_key,''))) not between 1 and 200 or (entry->>'amountMinor') !~ '^[1-9][0-9]*$'
      or (entry->>'currency') !~ '^[A-Z]{3}$' or entry->>'occurredAt' is null then raise exception 'Invalid receipt payment'; end if;
    if confirmed_currency is null or entry->>'currency' is distinct from confirmed_currency then raise exception 'Payment currency requires human confirmation matching source currency'; end if;
    occurred:=(entry->>'occurredAt')::timestamptz;
    if not private.inventory_period_is_open(p_organization_id,occurred) then raise exception 'PERIOD_CLOSED'; end if;
    start_at:=least(coalesce(start_at,occurred),occurred); end_at:=greatest(coalesce(end_at,occurred),occurred);
    cash_id:=null;
    if entry ? 'existingMovementId' then
      cash_id:=(entry->>'existingMovementId')::uuid;
      if not exists(select 1 from public.cash_movements c where c.organization_id=p_organization_id and c.id=cash_id and c.kind='purchase'
        and c.approval_status='approved' and c.amount_minor=-(entry->>'amountMinor')::bigint and c.currency=entry->>'currency'
        and c.occurred_at=occurred and (entry->>'accountId' is null or c.account_id=(entry->>'accountId')::uuid)) then raise exception 'Existing payment movement does not match receipt'; end if;
    else
      select a.currency into account_currency from public.accounts a where a.organization_id=p_organization_id and a.id=(entry->>'accountId')::uuid and a.active;
      if not found or account_currency<>entry->>'currency' then raise exception 'Payment account not found or currency mismatch'; end if;
      insert into public.cash_movements(organization_id,account_id,kind,amount_minor,currency,occurred_at,description,evidence_ref,evidence_file_id,created_by,approved_by,idempotency_key,approval_status,approval_reason)
        values(p_organization_id,(entry->>'accountId')::uuid,'purchase',-(entry->>'amountMinor')::bigint,entry->>'currency',occurred,'Supplier receipt payment',s.evidence_file_id::text,s.evidence_file_id,
          s.created_by,case when s.created_by is null or s.created_by<>actor then actor else null end,
          'purchase-receipt:'||p_receipt_id||':payment:'||effect_key,'approved',btrim(p_reason)) returning id into cash_id;
    end if;
    total_minor:=case when coalesce(draft->'totals'->>'totalMinor','') ~ '^[0-9]+$'
      then (draft->'totals'->>'totalMinor')::bigint else private.purchase_receipt_usd_minor(draft->'totals'->'rawAmounts'->>'total',confirmed_currency) end;
    if total_minor is null then raise exception 'Confirm a supported receipt total before approving payment'; end if;
    select coalesce(sum((e.effect_payload->>'amountMinor')::numeric),0) into paid_total from public.purchase_receipt_effects e
      where e.organization_id=p_organization_id and e.receipt_id=p_receipt_id and e.effect_type='payment';
    if paid_total+(entry->>'amountMinor')::numeric>total_minor then raise exception 'Payments exceed receipt total'; end if;
    insert into public.purchase_receipt_effects(organization_id,receipt_id,source_line_id,effect_type,effect_key,decision_id,effect_payload,cash_movement_id)
      values(p_organization_id,p_receipt_id,'payment:'||effect_key,'payment',effect_key,decision_id,entry,cash_id);
    result:=jsonb_set(result,'{cashMovementIds}',(result->'cashMovementIds')||jsonb_build_array(cash_id));
  end loop;
  update public.purchase_receipt_submissions set status=case when start_at is not null then 'projection_pending'
      when s.status='needs_review' then 'approved' else s.status end,updated_at=now()
    where organization_id=p_organization_id and id=p_receipt_id;
  if start_at is not null then
    replay_start:=start_at; replay_end:=coalesce(end_at,start_at+interval '1 second');
    if replay_end<=replay_start then replay_end:=replay_start+interval '1 second'; end if;
    if replay_end-replay_start>interval '370 days' then raise exception 'Receipt replay window exceeds supported limit'; end if;
    select coalesce(source_revision,0) into revision from private.square_worker_state where organization_id=p_organization_id;
    insert into private.durable_jobs(organization_id,requested_by,job_type,idempotency_key,payload)
      values(p_organization_id,actor,'projection.replay','purchase-receipt:'||p_receipt_id||':'||p_idempotency_key,
        jsonb_build_object('sourceRevision',coalesce(revision,0),'startAt',replay_start,'endAt',replay_end,'requestedBy',actor,'receiptId',p_receipt_id,'decisionId',decision_id))
      returning id into replay_id;
  end if;
  result:=result||jsonb_build_object('receiptId',p_receipt_id,'decisionId',decision_id,'projectionJobId',replay_id,
    'status',case when replay_id is null then (case when s.status='needs_review' then 'approved' else s.status end) else 'projection_pending' end);
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','approve','purchase_receipt',p_receipt_id,result,btrim(p_reason),'purchase-receipt:'||p_receipt_id::text);
  return result;
end $$;

create or replace function public.finalize_purchase_receipt_projection(p_organization_id uuid,p_receipt_id uuid,p_decision_id uuid,p_succeeded boolean,p_error_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if not exists(select 1 from public.purchase_receipt_decisions d where d.organization_id=p_organization_id and d.receipt_id=p_receipt_id and d.id=p_decision_id and d.decision='approved') then
    raise exception 'Receipt approval decision not found'; end if;
  if p_succeeded then
    if exists(select 1 from private.durable_jobs j where j.organization_id=p_organization_id and j.job_type='projection.replay'
      and j.payload->>'receiptId'=p_receipt_id::text and j.status not in ('complete')) then
      update public.purchase_receipt_submissions set status='projection_pending',updated_at=now() where organization_id=p_organization_id and id=p_receipt_id;
    else
      update public.purchase_receipt_submissions set status='posted',last_error_code=null,updated_at=now()
        where organization_id=p_organization_id and id=p_receipt_id and status='projection_pending';
    end if;
  else
    update public.purchase_receipt_submissions set last_error_code=left(coalesce(p_error_code,'PROJECTION_FAILED'),100),updated_at=now()
      where organization_id=p_organization_id and id=p_receipt_id and status='projection_pending';
  end if;
end $$;

create or replace function public.list_purchase_receipt_catalog_candidates(p_organization_id uuid,p_currency text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare candidates jsonb;
begin
  if auth.uid() is null or not private.has_org_role(p_organization_id,array['owner','operator','reviewer','read_only']) then
    raise exception 'Organization membership required';
  end if;
  if not exists(select 1 from public.organization_feature_flags f
      where f.organization_id=p_organization_id and f.inventory_tracking) then
    raise exception 'FEATURE_DISABLED: inventory_tracking';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'Invalid currency'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('catalogObjectId',q.catalog_id,'name',q.name,'sku',q.sku,'currency',p_currency)
    order by q.name,q.catalog_id),'[]'::jsonb)
    into candidates
  from (
    select v.object_id as catalog_id,
      case when nullif(btrim(parent.fact->>'name'),'') is not null then
        btrim(parent.fact->>'name')||' — '||coalesce(nullif(btrim(v.fact->>'name'),''),'Unnamed variation')
        else coalesce(nullif(btrim(v.fact->>'name'),''),'Unidentified Square item') end as name,
      nullif(btrim(v.fact->>'sku'),'') as sku
    from private.square_fact_current c
    join private.square_fact_versions v using(organization_id,fact_kind,object_id,object_version)
    left join private.square_fact_current parent_current on parent_current.organization_id=c.organization_id
      and parent_current.fact_kind='catalog' and parent_current.object_id=v.fact->>'itemId'
    left join private.square_fact_versions parent on parent.organization_id=parent_current.organization_id
      and parent.fact_kind=parent_current.fact_kind and parent.object_id=parent_current.object_id
      and parent.object_version=parent_current.object_version
    where c.organization_id=p_organization_id and c.fact_kind='catalog'
      and v.fact->>'objectType'='ITEM_VARIATION'
      and v.fact->>'isDeleted' is distinct from 'true'
      and v.fact->>'isArchived' is distinct from 'true'
      and (parent.fact is null or (parent.fact->>'isDeleted' is distinct from 'true'
        and parent.fact->>'isArchived' is distinct from 'true'))
      and (v.fact->>'currency'=p_currency or coalesce(v.fact->>'currency','') !~ '^[A-Z]{3}$')
    order by name,v.object_id
    limit 500
  ) q;
  return candidates;
end $$;

create or replace function private.finalize_purchase_receipt_on_job_terminal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.job_type='projection.replay' and new.payload ? 'receiptId' and new.payload ? 'decisionId'
    and new.status in ('complete','dead_letter') and old.status is distinct from new.status then
    perform public.finalize_purchase_receipt_projection(new.organization_id,(new.payload->>'receiptId')::uuid,
      (new.payload->>'decisionId')::uuid,new.status='complete',new.last_error_code);
  end if;
  return new;
end $$;
revoke all on function private.finalize_purchase_receipt_on_job_terminal() from public,anon,authenticated;
create trigger durable_jobs_finalize_purchase_receipt
  after update of status on private.durable_jobs
  for each row execute function private.finalize_purchase_receipt_on_job_terminal();

revoke all on function public.register_purchase_receipt_integration(uuid,text,text) from public,anon;
revoke all on function public.list_purchase_receipt_integrations(uuid) from public,anon;
revoke all on function public.revoke_purchase_receipt_integration(uuid,uuid) from public,anon;
revoke all on function public.authorize_purchase_receipt_integration(text) from public,anon,authenticated;
revoke all on function public.create_purchase_receipt_submission(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.create_manual_purchase_receipt_submission(uuid,text,text,text) from public,anon;
revoke all on function public.complete_purchase_receipt_upload(uuid,uuid,text,text,bigint,text) from public,anon,authenticated;
revoke all on function public.get_purchase_receipt_for_processing(uuid,uuid) from public,anon,authenticated;
revoke all on function public.save_purchase_receipt_draft(uuid,uuid,integer,jsonb) from public,anon,authenticated;
revoke all on function public.fail_purchase_receipt_processing(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.reserve_purchase_receipt_model_budget(uuid,uuid,text,integer,integer,integer) from public,anon,authenticated;
revoke all on function public.record_purchase_receipt_model_usage(uuid,uuid,text,jsonb,integer) from public,anon,authenticated;
revoke all on function public.reject_purchase_receipt(uuid,uuid,integer,text,text) from public,anon;
revoke all on function public.approve_purchase_receipt(uuid,uuid,integer,jsonb,text,text) from public,anon;
revoke all on function public.finalize_purchase_receipt_projection(uuid,uuid,uuid,boolean,text) from public,anon,authenticated;
revoke all on function public.list_purchase_receipt_catalog_candidates(uuid,text) from public,anon;
grant execute on function public.register_purchase_receipt_integration(uuid,text,text) to authenticated;
grant execute on function public.list_purchase_receipt_integrations(uuid) to authenticated;
grant execute on function public.revoke_purchase_receipt_integration(uuid,uuid) to authenticated;
grant execute on function public.authorize_purchase_receipt_integration(text) to service_role;
grant execute on function public.create_purchase_receipt_submission(uuid,uuid,text,text,text) to service_role;
grant execute on function public.create_manual_purchase_receipt_submission(uuid,text,text,text) to authenticated;
grant execute on function public.complete_purchase_receipt_upload(uuid,uuid,text,text,bigint,text) to service_role;
grant execute on function public.get_purchase_receipt_for_processing(uuid,uuid) to service_role;
grant execute on function public.save_purchase_receipt_draft(uuid,uuid,integer,jsonb) to service_role;
grant execute on function public.fail_purchase_receipt_processing(uuid,uuid,text) to service_role;
grant execute on function public.reserve_purchase_receipt_model_budget(uuid,uuid,text,integer,integer,integer) to service_role;
grant execute on function public.record_purchase_receipt_model_usage(uuid,uuid,text,jsonb,integer) to service_role;
grant execute on function public.reject_purchase_receipt(uuid,uuid,integer,text,text) to authenticated;
grant execute on function public.approve_purchase_receipt(uuid,uuid,integer,jsonb,text,text) to authenticated;
grant execute on function public.finalize_purchase_receipt_projection(uuid,uuid,uuid,boolean,text) to service_role;
grant execute on function public.list_purchase_receipt_catalog_candidates(uuid,text) to authenticated;
