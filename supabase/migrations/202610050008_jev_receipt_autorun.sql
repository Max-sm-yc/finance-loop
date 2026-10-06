-- Run Jev after receipt extraction in the durable worker and keep the result
-- as a review-only suggestion on the immutable draft version.

create or replace function public.reserve_receipt_agent_budget(
  p_organization_id uuid,p_run_id uuid,p_model_id text,
  p_max_input_tokens integer,p_max_output_tokens integer,p_max_attempts integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'UTC')::date;
  reserve_count integer;
  daily_limit integer;
  valid_request boolean;
begin
  if auth.uid() is null or not private.has_org_role(p_organization_id,array['owner','operator','reviewer']) then
    raise exception 'Organization operator role required';
  end if;
  if not exists(select 1 from public.organization_feature_flags f
    where f.organization_id=p_organization_id and f.inventory_tracking) then
    raise exception 'FEATURE_DISABLED: inventory_tracking';
  end if;
  valid_request:=case p_model_id
    when 'openai/gpt-6-luna' then
      p_max_input_tokens between 1 and 12000 and p_max_output_tokens between 1 and 3000
      and p_max_attempts between 1 and 2
    when 'typesafe/jev-1.13' then
      p_max_input_tokens between 1 and 100000 and p_max_output_tokens between 1 and 50000
      and p_max_attempts=1
    else false
  end;
  if p_run_id is null or not coalesce(valid_request,false) then
    raise exception 'Invalid receipt model budget request';
  end if;
  reserve_count:=(p_max_input_tokens+p_max_output_tokens)*p_max_attempts;
  insert into private.ai_model_budgets(organization_id) values(p_organization_id) on conflict do nothing;
  perform 1 from private.ai_model_budgets b where b.organization_id=p_organization_id for update;
  select b.daily_token_limit into daily_limit from private.ai_model_budgets b where b.organization_id=p_organization_id;
  if exists(select 1 from private.receipt_agent_budget_reservations r where r.organization_id=p_organization_id
      and r.run_id=p_run_id and r.model_id=p_model_id and r.budget_day=today) then return false; end if;
  if coalesce((select sum(r.reserved_tokens) from private.ai_budget_reservations r
      where r.organization_id=p_organization_id and r.budget_day=today),0)
     +coalesce((select sum(r.reserved_tokens) from private.receipt_agent_budget_reservations r
      where r.organization_id=p_organization_id and r.budget_day=today and r.released_at is null),0)
     +reserve_count>daily_limit then return false; end if;
  insert into private.receipt_agent_budget_reservations(organization_id,run_id,model_id,budget_day,reserved_tokens,max_attempts)
    values(p_organization_id,p_run_id,p_model_id,today,reserve_count,p_max_attempts);
  return true;
end
$$;

-- The authenticated matching endpoint and the worker use the same inventory
-- candidates. Service-role access is restricted to the worker and remains
-- organization-scoped by the required argument.
create or replace function public.list_purchase_receipt_catalog_candidates(p_organization_id uuid,p_currency text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare candidates jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role'
      and (auth.uid() is null or not private.has_org_role(p_organization_id,array['owner','operator','reviewer','read_only'])) then
    raise exception 'Organization membership required';
  end if;
  if not exists(select 1 from public.organization_feature_flags f
      where f.organization_id=p_organization_id and f.inventory_tracking) then
    raise exception 'FEATURE_DISABLED: inventory_tracking';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'Invalid currency'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('catalogObjectId',q.catalog_id,'name',q.name,'sku',q.sku,'currency',p_currency,'archived',q.is_archived)
    order by q.name,q.catalog_id),'[]'::jsonb)
    into candidates
  from (
    select v.object_id as catalog_id,
      case when nullif(btrim(parent.fact->>'name'),'') is not null then
        btrim(parent.fact->>'name')||' — '||coalesce(nullif(btrim(v.fact->>'name'),''),'Unnamed variation')
        else coalesce(nullif(btrim(v.fact->>'name'),''),'Unidentified Square item') end as name,
      nullif(btrim(v.fact->>'sku'),'') as sku,
      (coalesce(v.fact->>'isArchived','false')='true' or coalesce(parent.fact->>'isArchived','false')='true') as is_archived
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
      and (parent.fact is null or parent.fact->>'isDeleted' is distinct from 'true')
      and coalesce(parent.fact->'raw'->'item_data'->>'product_type','REGULAR')<>'GIFT_CARD'
      and (v.fact->>'currency'=p_currency or coalesce(v.fact->>'currency','') !~ '^[A-Z]{3}$')
    order by name,v.object_id
    limit 500
  ) q;
  return candidates;
end $$;
grant execute on function public.list_purchase_receipt_catalog_candidates(uuid,text) to service_role;

-- Jev makes several bounded Decisions API requests per receipt. Each request
-- gets its own run id while the durable receipt job id fences the reservation.
create or replace function public.reserve_purchase_receipt_jev_budget(
  p_organization_id uuid,p_receipt_id uuid,p_job_id uuid,p_run_id uuid,p_model_id text,
  p_max_input_tokens integer,p_max_output_tokens integer,p_max_attempts integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'UTC')::date;
  reserve_count integer;
  daily_limit integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if not exists(select 1 from public.purchase_receipt_submissions s
    where s.organization_id=p_organization_id and s.id=p_receipt_id
      and s.evidence_file_id is not null and s.deleted_at is null and s.status='processing') then
    raise exception 'Purchase receipt not found';
  end if;
  if not exists(select 1 from private.durable_jobs j
    where j.id=p_job_id and j.organization_id=p_organization_id
      and j.job_type='receipt.process' and j.status='running'
      and j.payload->>'receiptId'=p_receipt_id::text) then
    raise exception 'Active purchase receipt job not found';
  end if;
  if not exists(select 1 from public.organization_feature_flags f
    where f.organization_id=p_organization_id and f.inventory_tracking) then
    raise exception 'FEATURE_DISABLED: inventory_tracking';
  end if;
  if p_run_id is null or p_model_id<>'typesafe/jev-1.13'
      or p_max_input_tokens not between 1 and 100000
      or p_max_output_tokens not between 1 and 50000 or p_max_attempts<>1 then
    raise exception 'Invalid Jev receipt budget request';
  end if;
  reserve_count:=p_max_input_tokens+p_max_output_tokens;
  insert into private.ai_model_budgets(organization_id) values(p_organization_id) on conflict do nothing;
  perform 1 from private.ai_model_budgets b where b.organization_id=p_organization_id for update;
  select b.daily_token_limit into daily_limit from private.ai_model_budgets b where b.organization_id=p_organization_id;
  if exists(select 1 from private.receipt_agent_budget_reservations r where r.organization_id=p_organization_id
      and r.run_id=p_run_id and r.model_id=p_model_id and r.budget_day=today) then return false; end if;
  if coalesce((select sum(r.reserved_tokens) from private.ai_budget_reservations r
      where r.organization_id=p_organization_id and r.budget_day=today),0)
     +coalesce((select sum(r.reserved_tokens) from private.receipt_agent_budget_reservations r
      where r.organization_id=p_organization_id and r.budget_day=today and r.released_at is null),0)
     +reserve_count>daily_limit then return false; end if;
  insert into private.receipt_agent_budget_reservations(organization_id,run_id,model_id,budget_day,reserved_tokens,max_attempts)
    values(p_organization_id,p_run_id,p_model_id,today,reserve_count,p_max_attempts);
  return true;
end $$;

create or replace function public.record_purchase_receipt_jev_usage(
  p_organization_id uuid,p_receipt_id uuid,p_job_id uuid,p_run_id uuid,p_model_id text,p_usage jsonb,p_attempt integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare reservation uuid; allowed_attempts integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if not exists(select 1 from public.purchase_receipt_submissions s
    where s.organization_id=p_organization_id and s.id=p_receipt_id
      and s.deleted_at is null and s.status='processing') then
    raise exception 'Purchase receipt not found';
  end if;
  if not exists(select 1 from private.durable_jobs j
    where j.id=p_job_id and j.organization_id=p_organization_id
      and j.job_type='receipt.process' and j.status='running'
      and j.payload->>'receiptId'=p_receipt_id::text) then
    raise exception 'Active purchase receipt job not found';
  end if;
  if p_attempt<>1 or jsonb_typeof(coalesce(p_usage,'{}'::jsonb))<>'object'
      or length(coalesce(p_usage,'{}'::jsonb)::text)>2000 then
    raise exception 'Invalid Jev receipt model usage';
  end if;
  select r.id,r.max_attempts into reservation,allowed_attempts
    from private.receipt_agent_budget_reservations r
    where r.organization_id=p_organization_id and r.run_id=p_run_id
      and r.model_id=p_model_id and r.budget_day=(now() at time zone 'UTC')::date and r.released_at is null;
  if reservation is null or p_model_id<>'typesafe/jev-1.13' or p_attempt>allowed_attempts then
    raise exception 'No valid Jev receipt budget reservation exists';
  end if;
  insert into private.receipt_agent_model_usage(reservation_id,attempt,usage)
    values(reservation,p_attempt,coalesce(p_usage,'{}'::jsonb)) on conflict do nothing;
  return true;
end $$;

revoke all on function public.reserve_purchase_receipt_jev_budget(uuid,uuid,uuid,uuid,text,integer,integer,integer) from public,anon,authenticated;
revoke all on function public.record_purchase_receipt_jev_usage(uuid,uuid,uuid,uuid,text,jsonb,integer) from public,anon,authenticated;
grant execute on function public.reserve_purchase_receipt_jev_budget(uuid,uuid,uuid,uuid,text,integer,integer,integer) to service_role;
grant execute on function public.record_purchase_receipt_jev_usage(uuid,uuid,uuid,uuid,text,jsonb,integer) to service_role;
