-- Receipt processing receives one fixed 4,096-token reservation per job.
-- Keep both overloads aligned while older callers may still use the legacy
-- receipt-scoped signature.
create or replace function public.reserve_purchase_receipt_model_budget(
  p_organization_id uuid,p_receipt_id uuid,p_model_id text,
  p_max_input_tokens integer,p_max_output_tokens integer,p_max_attempts integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'UTC')::date;
  reserve_count integer := 4096;
  daily_limit integer;
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
  if exists(select 1 from private.receipt_agent_budget_reservations r
    where r.organization_id=p_organization_id and r.run_id=p_receipt_id
      and r.model_id=p_model_id and r.budget_day=today) then return false; end if;
  if coalesce((select sum(r.reserved_tokens) from private.ai_budget_reservations r
      where r.organization_id=p_organization_id and r.budget_day=today),0)
     +coalesce((select sum(r.reserved_tokens) from private.receipt_agent_budget_reservations r
      where r.organization_id=p_organization_id and r.budget_day=today),0)
     +reserve_count>daily_limit then return false; end if;
  insert into private.receipt_agent_budget_reservations(
    organization_id,run_id,model_id,budget_day,reserved_tokens,max_attempts
  ) values(p_organization_id,p_receipt_id,p_model_id,today,reserve_count,p_max_attempts);
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
  if exists(select 1 from private.receipt_agent_budget_reservations r
    where r.organization_id=p_organization_id and r.run_id=p_run_id
      and r.model_id=p_model_id and r.budget_day=today) then return false; end if;
  if coalesce((select sum(r.reserved_tokens) from private.ai_budget_reservations r
      where r.organization_id=p_organization_id and r.budget_day=today),0)
     +coalesce((select sum(r.reserved_tokens) from private.receipt_agent_budget_reservations r
      where r.organization_id=p_organization_id and r.budget_day=today),0)
     +reserve_count>daily_limit then return false; end if;
  insert into private.receipt_agent_budget_reservations(
    organization_id,run_id,model_id,budget_day,reserved_tokens,max_attempts
  ) values(p_organization_id,p_run_id,p_model_id,today,reserve_count,p_max_attempts);
  return true;
end $$;
