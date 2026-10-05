-- Keep a failed receipt's unused reservation available for its explicit retry.
alter table private.receipt_agent_budget_reservations
  add column released_at timestamptz;

create index receipt_agent_budget_active_day_idx
  on private.receipt_agent_budget_reservations(organization_id,budget_day)
  where released_at is null;

create or replace function public.reprocess_failed_purchase_receipt(
  p_organization_id uuid,p_receipt_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  today date := (now() at time zone 'UTC')::date;
  s public.purchase_receipt_submissions%rowtype;
  active_job_id uuid;
  job_id uuid;
  retry_key text;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner','reviewer']) then
    raise exception 'Organization owner or reviewer role required';
  end if;

  select * into s from public.purchase_receipt_submissions
    where organization_id=p_organization_id and id=p_receipt_id and deleted_at is null for update;
  if not found then raise exception 'Receipt not found or already deleted'; end if;

  select j.id into active_job_id
    from private.durable_jobs j
    where j.organization_id=p_organization_id and j.job_type='receipt.process'
      and j.payload->>'receiptId'=p_receipt_id::text and j.status in ('queued','running')
    order by j.created_at desc limit 1;
  if active_job_id is not null then
    if s.status='failed' then raise exception 'Receipt processing job is still active; wait before reprocessing'; end if;
    if s.status in ('queued','processing') then
      return jsonb_build_object('receiptId',p_receipt_id,'status',s.status,'jobId',active_job_id,'alreadyQueued',true);
    end if;
  end if;

  if s.status<>'failed' or s.active_draft_version is not null
    or exists(select 1 from public.purchase_receipt_draft_versions where organization_id=p_organization_id and receipt_id=p_receipt_id)
    or exists(select 1 from public.purchase_receipt_decisions where organization_id=p_organization_id and receipt_id=p_receipt_id)
    or exists(select 1 from public.purchase_receipt_effects where organization_id=p_organization_id and receipt_id=p_receipt_id) then
    raise exception 'Only failed receipts without drafts, decisions or effects can be reprocessed';
  end if;
  if s.evidence_file_id is null or not exists(select 1 from public.evidence_files e
    where e.organization_id=p_organization_id and e.id=s.evidence_file_id) then
    raise exception 'Receipt source evidence is unavailable';
  end if;

  retry_key:='receipt:'||p_receipt_id::text||':retry:'||gen_random_uuid()::text;
  insert into private.durable_jobs(organization_id,requested_by,job_type,idempotency_key,payload)
    values(p_organization_id,actor,'receipt.process',retry_key,
      jsonb_build_object('receiptId',p_receipt_id,'evidenceFileId',s.evidence_file_id))
    returning id into job_id;

  -- Release this receipt's current-day allocations from completed failed runs.
  -- Keep the reservation and usage rows as history; the retry receives a new
  -- job-scoped reservation of the same fixed amount.
  update private.receipt_agent_budget_reservations r
    set released_at=now()
    where r.organization_id=p_organization_id and r.budget_day=today and r.released_at is null
      and (
        r.run_id=p_receipt_id
        or exists(select 1 from private.durable_jobs old_job
          where old_job.id=r.run_id and old_job.organization_id=p_organization_id
            and old_job.job_type='receipt.process' and old_job.status in ('failed','dead_letter')
            and old_job.payload->>'receiptId'=p_receipt_id::text)
      );

  update public.purchase_receipt_submissions set status='queued',last_error_code=null,updated_at=now()
    where organization_id=p_organization_id and id=p_receipt_id;
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','reprocess','purchase_receipt',p_receipt_id,
      jsonb_build_object('status',s.status,'lastErrorCode',s.last_error_code,'evidenceFileId',s.evidence_file_id),
      jsonb_build_object('status','queued','jobId',job_id,'evidenceFileId',s.evidence_file_id),
      'Requeued failed receipt extraction using the retained source evidence and reallocated its token reservation',
      'purchase-receipt:'||p_receipt_id::text||':reprocess:'||job_id::text);

  return jsonb_build_object('receiptId',p_receipt_id,'status','queued','jobId',job_id,'alreadyQueued',false);
end $$;

revoke all on function public.reprocess_failed_purchase_receipt(uuid,uuid) from public,anon,service_role;
grant execute on function public.reprocess_failed_purchase_receipt(uuid,uuid) to authenticated;

-- Preserve the old receipt-scoped overload for compatible deployments while
-- making released reservations available in its capacity calculation.
create or replace function public.reserve_purchase_receipt_model_budget(
  p_organization_id uuid,p_receipt_id uuid,p_model_id text,
  p_max_input_tokens integer,p_max_output_tokens integer,p_max_attempts integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'UTC')::date;
  reserve_count integer := 4096;
  daily_limit integer;
  reservation uuid;
  was_released timestamptz;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if not exists(select 1 from public.purchase_receipt_submissions s
    where s.organization_id=p_organization_id and s.id=p_receipt_id and s.evidence_file_id is not null)
    then raise exception 'Purchase receipt not found'; end if;
  if not exists(select 1 from public.organization_feature_flags f
    where f.organization_id=p_organization_id and f.inventory_tracking)
    then raise exception 'FEATURE_DISABLED: inventory_tracking'; end if;
  if p_model_id<>'openai/gpt-6-luna' or p_max_input_tokens not between 1 and 12000
    or p_max_output_tokens not between 1 and 1500 or p_max_attempts not between 1 and 2 then
    raise exception 'Invalid receipt model budget request';
  end if;
  insert into private.ai_model_budgets(organization_id)
    values(p_organization_id) on conflict do nothing;
  perform 1 from private.ai_model_budgets b
    where b.organization_id=p_organization_id for update;
  select b.daily_token_limit into daily_limit from private.ai_model_budgets b
    where b.organization_id=p_organization_id;
  select r.id,r.released_at into reservation,was_released
    from private.receipt_agent_budget_reservations r
    where r.organization_id=p_organization_id and r.run_id=p_receipt_id
      and r.model_id=p_model_id and r.budget_day=today for update;
  if reservation is not null and was_released is null then return false; end if;
  if coalesce((select sum(r.reserved_tokens) from private.ai_budget_reservations r
      where r.organization_id=p_organization_id and r.budget_day=today),0)
     +coalesce((select sum(r.reserved_tokens) from private.receipt_agent_budget_reservations r
      where r.organization_id=p_organization_id and r.budget_day=today and r.released_at is null),0)
     +reserve_count>daily_limit then return false; end if;
  if reservation is null then
    insert into private.receipt_agent_budget_reservations(
      organization_id,run_id,model_id,budget_day,reserved_tokens,max_attempts
    ) values(p_organization_id,p_receipt_id,p_model_id,today,reserve_count,p_max_attempts);
  else
    update private.receipt_agent_budget_reservations
      set released_at=null,reserved_tokens=reserve_count,max_attempts=p_max_attempts
      where id=reservation;
  end if;
  return true;
end $$;

create or replace function public.reserve_purchase_receipt_model_budget(
  p_organization_id uuid,p_receipt_id uuid,p_run_id uuid,p_model_id text,
  p_max_input_tokens integer,p_max_output_tokens integer,p_max_attempts integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'UTC')::date;
  reserve_count integer := 4096;
  daily_limit integer;
  reservation uuid;
  was_released timestamptz;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if not exists(select 1 from public.purchase_receipt_submissions s
    where s.organization_id=p_organization_id and s.id=p_receipt_id
      and s.evidence_file_id is not null and s.deleted_at is null and s.status='processing')
    then raise exception 'Purchase receipt not found'; end if;
  if not exists(select 1 from private.durable_jobs j
    where j.id=p_run_id and j.organization_id=p_organization_id
      and j.job_type='receipt.process' and j.status='running'
      and j.payload->>'receiptId'=p_receipt_id::text)
    then raise exception 'Active purchase receipt job not found'; end if;
  if not exists(select 1 from public.organization_feature_flags f
    where f.organization_id=p_organization_id and f.inventory_tracking)
    then raise exception 'FEATURE_DISABLED: inventory_tracking'; end if;
  if p_model_id<>'openai/gpt-6-luna' or p_max_input_tokens not between 1 and 12000
    or p_max_output_tokens not between 1 and 1500 or p_max_attempts not between 1 and 2 then
    raise exception 'Invalid receipt model budget request';
  end if;
  insert into private.ai_model_budgets(organization_id)
    values(p_organization_id) on conflict do nothing;
  perform 1 from private.ai_model_budgets b
    where b.organization_id=p_organization_id for update;
  select b.daily_token_limit into daily_limit from private.ai_model_budgets b
    where b.organization_id=p_organization_id;
  select r.id,r.released_at into reservation,was_released
    from private.receipt_agent_budget_reservations r
    where r.organization_id=p_organization_id and r.run_id=p_run_id
      and r.model_id=p_model_id and r.budget_day=today for update;
  if reservation is not null and was_released is null then return false; end if;
  if coalesce((select sum(r.reserved_tokens) from private.ai_budget_reservations r
      where r.organization_id=p_organization_id and r.budget_day=today),0)
     +coalesce((select sum(r.reserved_tokens) from private.receipt_agent_budget_reservations r
      where r.organization_id=p_organization_id and r.budget_day=today and r.released_at is null),0)
     +reserve_count>daily_limit then return false; end if;
  if reservation is null then
    insert into private.receipt_agent_budget_reservations(
      organization_id,run_id,model_id,budget_day,reserved_tokens,max_attempts
    ) values(p_organization_id,p_run_id,p_model_id,today,reserve_count,p_max_attempts);
  else
    update private.receipt_agent_budget_reservations
      set released_at=null,reserved_tokens=reserve_count,max_attempts=p_max_attempts
      where id=reservation;
  end if;
  return true;
end $$;

create or replace function public.record_purchase_receipt_model_usage(
  p_organization_id uuid,p_receipt_id uuid,p_model_id text,p_usage jsonb,p_attempt integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare reservation uuid; allowed_attempts integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if not exists(select 1 from public.purchase_receipt_submissions s
    where s.organization_id=p_organization_id and s.id=p_receipt_id)
    then raise exception 'Purchase receipt not found'; end if;
  if p_attempt not between 1 and 2 or jsonb_typeof(coalesce(p_usage,'{}'::jsonb))<>'object'
    or length(coalesce(p_usage,'{}'::jsonb)::text)>2000 then raise exception 'Invalid receipt model usage'; end if;
  select r.id,r.max_attempts into reservation,allowed_attempts
    from private.receipt_agent_budget_reservations r
    where r.organization_id=p_organization_id and r.run_id=p_receipt_id
      and r.model_id=p_model_id and r.budget_day=(now() at time zone 'UTC')::date
      and r.released_at is null;
  if reservation is null or p_attempt>allowed_attempts then raise exception 'No valid receipt model budget reservation exists'; end if;
  insert into private.receipt_agent_model_usage(reservation_id,attempt,usage)
    values(reservation,p_attempt,coalesce(p_usage,'{}'::jsonb)) on conflict do nothing;
  return true;
end $$;

create or replace function public.record_purchase_receipt_model_usage(
  p_organization_id uuid,p_receipt_id uuid,p_run_id uuid,p_model_id text,p_usage jsonb,p_attempt integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare reservation uuid; allowed_attempts integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if not exists(select 1 from public.purchase_receipt_submissions s
    where s.organization_id=p_organization_id and s.id=p_receipt_id
      and s.deleted_at is null and s.status='processing')
    then raise exception 'Purchase receipt not found'; end if;
  if not exists(select 1 from private.durable_jobs j
    where j.id=p_run_id and j.organization_id=p_organization_id
      and j.job_type='receipt.process' and j.status='running'
      and j.payload->>'receiptId'=p_receipt_id::text)
    then raise exception 'Active purchase receipt job not found'; end if;
  if p_attempt not between 1 and 2 or jsonb_typeof(coalesce(p_usage,'{}'::jsonb))<>'object'
    or length(coalesce(p_usage,'{}'::jsonb)::text)>2000 then raise exception 'Invalid receipt model usage'; end if;
  select r.id,r.max_attempts into reservation,allowed_attempts
    from private.receipt_agent_budget_reservations r
    where r.organization_id=p_organization_id and r.run_id=p_run_id and r.model_id=p_model_id
      and r.budget_day=(now() at time zone 'UTC')::date and r.released_at is null;
  if reservation is null or p_attempt>allowed_attempts then raise exception 'No valid receipt model budget reservation exists'; end if;
  insert into private.receipt_agent_model_usage(reservation_id,attempt,usage)
    values(reservation,p_attempt,coalesce(p_usage,'{}'::jsonb)) on conflict do nothing;
  return true;
end $$;

revoke all on function public.reserve_purchase_receipt_model_budget(uuid,uuid,text,integer,integer,integer) from public,anon,authenticated;
revoke all on function public.reserve_purchase_receipt_model_budget(uuid,uuid,uuid,text,integer,integer,integer) from public,anon,authenticated;
revoke all on function public.record_purchase_receipt_model_usage(uuid,uuid,text,jsonb,integer) from public,anon,authenticated;
revoke all on function public.record_purchase_receipt_model_usage(uuid,uuid,uuid,text,jsonb,integer) from public,anon,authenticated;
grant execute on function public.reserve_purchase_receipt_model_budget(uuid,uuid,text,integer,integer,integer) to service_role;
grant execute on function public.reserve_purchase_receipt_model_budget(uuid,uuid,uuid,text,integer,integer,integer) to service_role;
grant execute on function public.record_purchase_receipt_model_usage(uuid,uuid,text,jsonb,integer) to service_role;
grant execute on function public.record_purchase_receipt_model_usage(uuid,uuid,uuid,text,jsonb,integer) to service_role;
