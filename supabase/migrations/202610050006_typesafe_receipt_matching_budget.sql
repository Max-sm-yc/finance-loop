-- Allow the on-demand TypeSafe Jev inventory matcher to share the existing
-- per-organization receipt-agent daily token budget.
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
