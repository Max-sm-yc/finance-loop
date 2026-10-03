-- User-triggered receipt extraction is advisory only. Cost rows are written
-- only by the separate owner/reviewer approval RPC below.
create table private.receipt_agent_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  run_id uuid not null,
  model_id text not null,
  budget_day date not null,
  reserved_tokens integer not null check (reserved_tokens > 0),
  max_attempts integer not null check (max_attempts between 1 and 2),
  created_at timestamptz not null default now(),
  unique (organization_id, run_id, model_id, budget_day)
);
create index receipt_agent_budget_day_idx on private.receipt_agent_budget_reservations(organization_id,budget_day);
create index square_fact_receipt_catalog_currency_idx
  on private.square_fact_versions(organization_id,(fact->>'currency'),(fact->>'catalogObjectId'),object_id)
  where fact_kind='order_line';
create table private.receipt_agent_model_usage (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references private.receipt_agent_budget_reservations(id),
  attempt integer not null check (attempt > 0),
  usage jsonb not null default '{}'::jsonb check (jsonb_typeof(usage) = 'object'),
  recorded_at timestamptz not null default now(),
  unique (reservation_id, attempt)
);
revoke all on table private.receipt_agent_budget_reservations,private.receipt_agent_model_usage from public,anon,authenticated;

create table private.receipt_cost_update_requests (
  organization_id uuid not null references public.organizations(id),
  idempotency_key text not null check (length(btrim(idempotency_key)) >= 8),
  request_payload jsonb not null,
  result jsonb not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (organization_id,idempotency_key)
);
revoke all on table private.receipt_cost_update_requests from public,anon,authenticated;

create or replace function public.reserve_receipt_agent_budget(
  p_organization_id uuid,p_run_id uuid,p_model_id text,
  p_max_input_tokens integer,p_max_output_tokens integer,p_max_attempts integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'UTC')::date;
  reserve_count integer := (p_max_input_tokens+p_max_output_tokens)*p_max_attempts;
  daily_limit integer;
begin
  if auth.uid() is null or not private.has_org_role(p_organization_id,array['owner','operator','reviewer']) then
    raise exception 'Organization operator role required';
  end if;
  if not exists(select 1 from public.organization_feature_flags f
    where f.organization_id=p_organization_id and f.inventory_tracking) then
    raise exception 'FEATURE_DISABLED: inventory_tracking';
  end if;
  if p_run_id is null or p_model_id<>'openai/gpt-6-luna'
     or p_max_input_tokens<1 or p_max_input_tokens>12000
     or p_max_output_tokens<1 or p_max_output_tokens>1200
     or p_max_attempts<1 or p_max_attempts>2 then raise exception 'Invalid receipt model budget request'; end if;
  insert into private.ai_model_budgets(organization_id) values(p_organization_id) on conflict do nothing;
  perform 1 from private.ai_model_budgets b where b.organization_id=p_organization_id for update;
  select b.daily_token_limit into daily_limit from private.ai_model_budgets b where b.organization_id=p_organization_id;
  if exists(select 1 from private.receipt_agent_budget_reservations r where r.organization_id=p_organization_id
      and r.run_id=p_run_id and r.model_id=p_model_id and r.budget_day=today) then return false; end if;
  if coalesce((select sum(r.reserved_tokens) from private.ai_budget_reservations r
      where r.organization_id=p_organization_id and r.budget_day=today),0)
     +coalesce((select sum(r.reserved_tokens) from private.receipt_agent_budget_reservations r
      where r.organization_id=p_organization_id and r.budget_day=today),0)+reserve_count>daily_limit then return false; end if;
  insert into private.receipt_agent_budget_reservations(organization_id,run_id,model_id,budget_day,reserved_tokens,max_attempts)
    values(p_organization_id,p_run_id,p_model_id,today,reserve_count,p_max_attempts);
  return true;
end
$$;

create or replace function public.record_receipt_agent_usage(
  p_organization_id uuid,p_run_id uuid,p_model_id text,p_usage jsonb,p_attempt integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare reservation uuid; allowed_attempts integer;
begin
  if auth.uid() is null or not private.has_org_role(p_organization_id,array['owner','operator','reviewer']) then
    raise exception 'Organization operator role required';
  end if;
  if p_attempt<1 or p_attempt>2 or jsonb_typeof(coalesce(p_usage,'{}'::jsonb))<>'object'
     or length(coalesce(p_usage,'{}'::jsonb)::text)>2000 then raise exception 'Invalid receipt model usage'; end if;
  select r.id,r.max_attempts into reservation,allowed_attempts
    from private.receipt_agent_budget_reservations r
   where r.organization_id=p_organization_id and r.run_id=p_run_id and r.model_id=p_model_id
     and r.budget_day=(now() at time zone 'UTC')::date;
  if reservation is null then raise exception 'No receipt model budget reservation exists'; end if;
  if p_attempt>allowed_attempts then raise exception 'Attempt exceeds reserved receipt model budget'; end if;
  insert into private.receipt_agent_model_usage(reservation_id,attempt,usage)
    values(reservation,p_attempt,coalesce(p_usage,'{}'::jsonb)) on conflict do nothing;
  return true;
end
$$;

create or replace function public.list_receipt_catalog_candidates(p_organization_id uuid,p_currency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare candidates jsonb;
begin
  if auth.uid() is null or not private.has_org_role(p_organization_id,array['owner','operator','reviewer']) then
    raise exception 'Organization operator role required';
  end if;
  if not exists(select 1 from public.organization_feature_flags f
    where f.organization_id=p_organization_id and f.inventory_tracking) then raise exception 'FEATURE_DISABLED: inventory_tracking'; end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'Invalid currency'; end if;
  with candidates_by_catalog as (
    select distinct on (v.fact->>'catalogObjectId')
      v.fact->>'catalogObjectId' as catalog_id,
      coalesce(nullif(btrim(v.fact->>'name'),''),nullif(btrim(cv.fact->>'name'),''),'Unidentified Square item') as item_name,
      nullif(btrim(cv.fact->>'sku'),'') as sku,
      v.fact->>'currency' as currency,
      v.fact->>'occurredAt' as occurred_at
    from private.square_fact_current c
    join private.square_fact_versions v using (organization_id,fact_kind,object_id,object_version)
    join private.square_fact_current pc on pc.organization_id=c.organization_id
      and pc.fact_kind='order' and pc.object_id=v.fact->>'orderId'
    join private.square_fact_versions pv on pv.organization_id=pc.organization_id
      and pv.fact_kind=pc.fact_kind and pv.object_id=pc.object_id and pv.object_version=pc.object_version
    left join private.square_fact_current cc on cc.organization_id=c.organization_id
      and cc.fact_kind='catalog' and cc.object_id=v.fact->>'catalogObjectId'
    left join private.square_fact_versions cv on cv.organization_id=cc.organization_id
      and cv.fact_kind=cc.fact_kind and cv.object_id=cc.object_id and cv.object_version=cc.object_version
    where c.organization_id=p_organization_id and c.fact_kind='order_line'
      and v.fact->>'catalogObjectId' is not null and v.fact->>'currency'=p_currency
      and upper(coalesce(v.fact->>'itemType','ITEM'))<>'GIFT_CARD'
      and lower(coalesce(pv.fact->>'status',''))='completed'
    order by v.fact->>'catalogObjectId',(v.fact->>'occurredAt') desc nulls last,c.object_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('catalogObjectId',catalog_id,'name',item_name,
    'sku',sku,'currency',currency) order by item_name,catalog_id),'[]'::jsonb)
    into candidates from (select * from candidates_by_catalog
      order by occurred_at desc nulls last,catalog_id limit 500) limited_candidates;
  return candidates;
end
$$;

create or replace function public.record_receipt_item_costs(
  p_organization_id uuid,p_evidence_file_id uuid,p_reason text,p_idempotency_key text,p_updates jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  item jsonb;
  covering public.item_definitions%rowtype;
  next_version integer;
  result_rows jsonb := '[]'::jsonb;
  result_id uuid;
  cost_minor bigint;
  effective_from timestamptz;
  next_start timestamptz;
  catalog_id text;
  source_fact_id text;
  source_name text;
  source_sku text;
  request_body jsonb;
  old_request private.receipt_cost_update_requests%rowtype;
  before_value jsonb;
  evidence_label text;
  changed_action text;
  seen_catalog_ids text[] := array[]::text[];
  replay_start_at timestamptz;
  replay_end_at timestamptz;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner','reviewer']) then
    raise exception 'Organization owner or reviewer role required';
  end if;
  if not exists(select 1 from public.organization_feature_flags f
    where f.organization_id=p_organization_id and f.inventory_tracking) then raise exception 'FEATURE_DISABLED: inventory_tracking'; end if;
  if p_evidence_file_id is null or not exists(select 1 from public.evidence_files e
    where e.organization_id=p_organization_id and e.id=p_evidence_file_id) then raise exception 'Organization receipt evidence required'; end if;
  if length(btrim(coalesce(p_reason,'')))<10 or length(btrim(coalesce(p_reason,'')))>1000
     or length(btrim(coalesce(p_idempotency_key,'')))<8 or length(btrim(coalesce(p_idempotency_key,'')))>200
     or p_updates is null or jsonb_typeof(p_updates)<>'array'
     or jsonb_array_length(p_updates)<1 or jsonb_array_length(p_updates)>50 then raise exception 'Invalid receipt cost approval'; end if;
  if exists(select 1 from jsonb_array_elements(p_updates) x(value)
    group by x.value->>'catalogObjectId' having count(*)>1) then raise exception 'Duplicate item in receipt cost approval'; end if;
  request_body:=jsonb_build_object('evidenceFileId',p_evidence_file_id,'reason',btrim(p_reason),'updates',p_updates);
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_idempotency_key,0));
  select * into old_request from private.receipt_cost_update_requests r
    where r.organization_id=p_organization_id and r.idempotency_key=p_idempotency_key;
  if found then
    if old_request.request_payload is distinct from request_body then raise exception 'Receipt cost idempotency key was used with different data'; end if;
    return old_request.result;
  end if;

  for item in select value from jsonb_array_elements(p_updates) loop
    if jsonb_typeof(item)<>'object' or (select count(*) from jsonb_object_keys(item))<>5
       or not(item ?& array['catalogObjectId','name','unitCostMinor','currency','effectiveFrom'])
       or length(btrim(coalesce(item->>'catalogObjectId',''))) not between 1 and 200
       or length(btrim(coalesce(item->>'name',''))) not between 1 and 200
       or coalesce(item->>'unitCostMinor','') !~ '^[0-9]+$'
       or coalesce(item->>'currency','') !~ '^[A-Z]{3}$'
       or coalesce(item->>'effectiveFrom','')='' then raise exception 'Invalid receipt cost line'; end if;
    cost_minor:=(item->>'unitCostMinor')::bigint;
    effective_from:=(item->>'effectiveFrom')::timestamptz;
    if cost_minor<0 or cost_minor>=1000000000000 or effective_from is null
       or effective_from<=transaction_timestamp()+interval '1 second'-interval '370 days' then raise exception 'Invalid receipt cost amount or date'; end if;
    catalog_id:=btrim(item->>'catalogObjectId');
    if catalog_id=any(seen_catalog_ids) then raise exception 'Catalog item may appear only once in a receipt approval'; end if;
    seen_catalog_ids:=array_append(seen_catalog_ids,catalog_id);
    perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||catalog_id,0));
    select c.object_id,
      coalesce(nullif(btrim(v.fact->>'name'),''),nullif(btrim(cv.fact->>'name'),''),'Unidentified Square item'),
      nullif(btrim(cv.fact->>'sku'),'') into source_fact_id,source_name,source_sku
      from private.square_fact_current c
      join private.square_fact_versions v using (organization_id,fact_kind,object_id,object_version)
      join private.square_fact_current pc on pc.organization_id=c.organization_id
        and pc.fact_kind='order' and pc.object_id=v.fact->>'orderId'
      join private.square_fact_versions pv on pv.organization_id=pc.organization_id
        and pv.fact_kind=pc.fact_kind and pv.object_id=pc.object_id and pv.object_version=pc.object_version
      left join private.square_fact_current cc on cc.organization_id=c.organization_id
        and cc.fact_kind='catalog' and cc.object_id=catalog_id
      left join private.square_fact_versions cv on cv.organization_id=cc.organization_id
        and cv.fact_kind=cc.fact_kind and cv.object_id=cc.object_id and cv.object_version=cc.object_version
      where c.organization_id=p_organization_id and c.fact_kind='order_line'
        and v.fact->>'catalogObjectId'=catalog_id and v.fact->>'currency'=item->>'currency'
        and upper(coalesce(v.fact->>'itemType','ITEM'))<>'GIFT_CARD'
        and lower(coalesce(pv.fact->>'status',''))='completed'
      order by (v.fact->>'occurredAt') desc nulls last,c.object_id limit 1;
    if not found or btrim(item->>'name') is distinct from source_name then raise exception 'Receipt item must match an exact Square sale catalog variation and currency'; end if;
    select * into covering from public.item_definitions d
      where d.organization_id=p_organization_id and d.square_catalog_object_id=catalog_id
        and d.currency=item->>'currency' and d.effective_from<=effective_from
        and (d.effective_until is null or d.effective_until>effective_from)
      order by d.effective_from desc limit 1 for update;
    before_value:=null;
    if found then
      before_value:=jsonb_build_object('squareCatalogObjectId',catalog_id,'name',covering.name,
        'unitCostMinor',covering.unit_cost_minor,'currency',covering.currency,
        'effectiveFrom',covering.effective_from,'effectiveUntil',covering.effective_until);
    end if;
    select coalesce(max(d.version),0)+1 into next_version from public.item_definitions d
      where d.organization_id=p_organization_id and d.square_catalog_object_id=catalog_id;
    select min(d.effective_from) into next_start from public.item_definitions d
      where d.organization_id=p_organization_id and d.square_catalog_object_id=catalog_id
        and d.effective_from>effective_from;
    evidence_label:='Supplier receipt evidence '||p_evidence_file_id::text||'. '||btrim(p_reason);
    if covering.id is not null and covering.effective_from=effective_from then
      update public.item_definitions d set unit_cost_minor=cost_minor,approved_by=actor,approved_at=now(),
        approval_reason=evidence_label,version=next_version,name=source_name,sku=source_sku
        where d.organization_id=p_organization_id and d.id=covering.id returning d.id into result_id;
      changed_action:='update';
    else
      if covering.id is not null then
        update public.item_definitions d set effective_until=effective_from where d.organization_id=p_organization_id and d.id=covering.id;
        next_start:=covering.effective_until;
      end if;
      insert into public.item_definitions(organization_id,square_catalog_object_id,sku,name,category,
        unit_cost_minor,currency,effective_from,effective_until,approved_by,approved_at,version,approval_reason)
      values(p_organization_id,catalog_id,source_sku,source_name,covering.category,
        cost_minor,item->>'currency',effective_from,case when covering.id is not null then covering.effective_until else next_start end,actor,now(),next_version,evidence_label)
      returning id into result_id;
      changed_action:='insert';
    end if;
    insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,
      before_state,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human',changed_action,'item_definition',result_id,
      before_value,
      jsonb_build_object('squareCatalogObjectId',catalog_id,'name',source_name,
        'unitCostMinor',cost_minor,'currency',item->>'currency','effectiveFrom',effective_from,
        'effectiveUntil',case when covering.id is not null then covering.effective_until else next_start end,
        'sourceSaleFactId',source_fact_id,
        'receiptEvidenceFileId',p_evidence_file_id),
      evidence_label,'receipt-cost:'||p_idempotency_key||':'||catalog_id);
    result_rows:=result_rows||jsonb_build_array(jsonb_build_object('id',result_id,
      'squareCatalogObjectId',catalog_id,'unitCostMinor',cost_minor,
      'currency',item->>'currency','effectiveFrom',effective_from,'version',next_version,
      'sourceSaleFactId',source_fact_id,'receiptEvidenceFileId',p_evidence_file_id));
  end loop;
  select min((x.value->>'effectiveFrom')::timestamptz) into replay_start_at
    from jsonb_array_elements(p_updates) x(value)
   where (x.value->>'effectiveFrom')::timestamptz<=transaction_timestamp();
  replay_end_at:=transaction_timestamp()+interval '1 second';
  if replay_start_at is not null and replay_end_at-replay_start_at>interval '370 days' then
    raise exception 'Receipt cost replay window exceeds the supported limit';
  end if;
  result_rows:=jsonb_build_object('updates',result_rows,'replayStartAt',replay_start_at,'replayEndAt',replay_end_at);
  insert into private.receipt_cost_update_requests(organization_id,idempotency_key,request_payload,result,created_by)
    values(p_organization_id,p_idempotency_key,request_body,result_rows,actor);
  return result_rows;
end
$$;

revoke all on function public.reserve_receipt_agent_budget(uuid,uuid,text,integer,integer,integer) from public,anon;
revoke all on function public.record_receipt_agent_usage(uuid,uuid,text,jsonb,integer) from public,anon;
revoke all on function public.list_receipt_catalog_candidates(uuid,text) from public,anon;
revoke all on function public.record_receipt_item_costs(uuid,uuid,text,text,jsonb) from public,anon;
grant execute on function public.reserve_receipt_agent_budget(uuid,uuid,text,integer,integer,integer) to authenticated;
grant execute on function public.record_receipt_agent_usage(uuid,uuid,text,jsonb,integer) to authenticated;
grant execute on function public.list_receipt_catalog_candidates(uuid,text) to authenticated;
grant execute on function public.record_receipt_item_costs(uuid,uuid,text,text,jsonb) to authenticated;
