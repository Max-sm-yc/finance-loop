-- Durable, version-aware Square facts and projection support for the external
-- worker. Normalized facts intentionally omit Square's unnecessary raw payloads.
create table private.square_worker_state (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  source_revision bigint not null default 0 check (source_revision >= 0),
  updated_at timestamptz not null default now()
);

create table private.square_fact_versions (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  fact_kind text not null,
  object_id text not null,
  object_version text not null,
  version_sort text collate "C" not null,
  fact jsonb not null check (jsonb_typeof(fact) = 'object'),
  cause text not null,
  received_at timestamptz not null default now(),
  primary key (organization_id, fact_kind, object_id, object_version)
);
create index square_fact_versions_lookup_idx on private.square_fact_versions
  (organization_id, fact_kind, object_id, received_at desc);

create table private.square_fact_current (
  organization_id uuid not null,
  fact_kind text not null,
  object_id text not null,
  object_version text not null,
  version_sort text collate "C" not null,
  source_revision bigint not null,
  primary key (organization_id, fact_kind, object_id),
  foreign key (organization_id, fact_kind, object_id, object_version)
    references private.square_fact_versions(organization_id, fact_kind, object_id, object_version)
);

create table private.square_worker_health (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  resource text not null,
  status text not null check (status in ('fresh','incomplete','stale','failed')),
  last_successful_sync_at timestamptz,
  gap jsonb,
  sync_result jsonb,
  processed_notification_id text,
  source_revision bigint,
  checked_at timestamptz not null default now(),
  primary key (organization_id, resource)
);

create or replace function public.extend_durable_job_lease(
  p_job_id uuid,p_worker_id text,p_lease_token uuid,p_lease_seconds integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_worker_id is null or length(p_worker_id)>200 or p_lease_seconds<30 or p_lease_seconds>900 then
    raise exception 'Invalid worker lease renewal';
  end if;
  update private.durable_jobs set claimed_at=now()
    where id=p_job_id and status='running' and locked_by=p_worker_id and lease_token=p_lease_token;
  get diagnostics affected = row_count;
  return affected=1;
end
$$;

-- Projection source snapshots can be large. Keep audit entries to projection
-- metadata while retaining the full replay inputs in projection_runs itself.
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
    if tg_table_name = 'projection_runs' then after_value := after_value - 'source_snapshot' - 'result'; end if;
    if tg_op = 'UPDATE' then
      before_value := to_jsonb(old);
      if tg_table_name = 'projection_runs' then before_value := before_value - 'source_snapshot' - 'result'; end if;
    end if;
  end if;
  if tg_table_name = 'proposals' and tg_op <> 'DELETE' then
    event_reason := new.decision_reason;
  elsif tg_table_name = 'accounting_periods' and tg_op <> 'DELETE' then
    event_reason := new.close_reason;
  end if;
  insert into public.audit_events (organization_id, actor_user_id, actor_kind,
    action, entity_type, entity_id, before_state, after_state, reason, correlation_id)
  values (org_id, actor, case when actor is null then 'system' else 'human' end,
    action_name, tg_table_name, row_id, before_value, after_value, event_reason, gen_random_uuid()::text);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create or replace function public.upsert_square_facts(
  p_organization_id uuid, p_facts jsonb, p_cause text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  fact_value jsonb;
  fact_kind text;
  object_id text;
  object_version text;
  sort_key text;
  current_sort text;
  current_version text;
  changed boolean := false;
  next_revision bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_organization_id is null or jsonb_typeof(p_facts) <> 'array'
     or jsonb_array_length(p_facts) > 1000 or length(btrim(coalesce(p_cause,''))) not between 1 and 300 then
    raise exception 'Invalid worker fact batch';
  end if;
  insert into private.square_worker_state (organization_id) values (p_organization_id) on conflict do nothing;
  perform 1 from private.square_worker_state s where s.organization_id = p_organization_id for update;

  for item in select value from jsonb_array_elements(p_facts) loop
    fact_value := item->'fact';
    fact_kind := item->>'kind';
    object_id := item->>'objectId';
    object_version := item->>'version';
    sort_key := item->>'versionSort';
    if jsonb_typeof(fact_value) <> 'object'
       or fact_kind not in ('order','order_line','payment','refund','catalog','payout','payout_entry','gift_card_activity')
       or object_id is null or length(object_id) not between 1 and 300
       or object_version is null or length(object_version) not between 1 and 200
       or sort_key is null or length(sort_key) not between 1 and 220 then
      raise exception 'Invalid normalized Square fact';
    end if;
    insert into private.square_fact_versions
      (organization_id,fact_kind,object_id,object_version,version_sort,fact,cause)
    values (p_organization_id,fact_kind,object_id,object_version,sort_key,fact_value,p_cause)
    on conflict (organization_id,fact_kind,object_id,object_version) do nothing;
    if not found then
      if exists (select 1 from private.square_fact_versions v
          where v.organization_id=p_organization_id and v.fact_kind=fact_kind
            and v.object_id=object_id and v.object_version=object_version
            and (v.fact is distinct from fact_value or v.version_sort is distinct from sort_key)) then
        raise exception 'Square returned conflicting content for the same object version';
      end if;
    end if;

    select c.version_sort, c.object_version into current_sort, current_version
      from private.square_fact_current c
      where c.organization_id=p_organization_id and c.fact_kind=fact_kind and c.object_id=object_id;
    if current_version is null or sort_key collate "C" > current_sort collate "C" then
      insert into private.square_fact_current
        (organization_id,fact_kind,object_id,object_version,version_sort,source_revision)
      values (p_organization_id,fact_kind,object_id,object_version,sort_key,0)
      on conflict (organization_id,fact_kind,object_id) do update set
        object_version=excluded.object_version, version_sort=excluded.version_sort;
      changed := true;
    end if;
  end loop;

  if changed then
    update private.square_worker_state s set source_revision=s.source_revision+1, updated_at=now()
      where s.organization_id=p_organization_id returning s.source_revision into next_revision;
    update private.square_fact_current c set source_revision=next_revision
      where c.organization_id=p_organization_id;
  else
    select s.source_revision into next_revision from private.square_worker_state s where s.organization_id=p_organization_id;
  end if;
  return jsonb_build_object('changed',changed,'revision',next_revision);
end
$$;

create or replace function public.get_square_projection_snapshot(
  p_organization_id uuid, p_source_revision bigint, p_start_at timestamptz default null, p_end_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_revision bigint;
  fact_rows jsonb;
  policy_row jsonb;
  account_rows jsonb;
  item_definition_rows jsonb;
  observation_rows jsonb;
  movement_rows jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  select s.source_revision into current_revision from private.square_worker_state s
    where s.organization_id=p_organization_id for share;
  current_revision := coalesce(current_revision,0);
  if (p_start_at is null) <> (p_end_at is null) or (p_start_at is not null and p_end_at <= p_start_at) then
    raise exception 'Invalid projection window';
  end if;

  select coalesce(jsonb_agg(v.fact order by v.fact_kind,v.object_id),'[]'::jsonb) into fact_rows
    from private.square_fact_current c join private.square_fact_versions v
      using (organization_id,fact_kind,object_id,object_version)
    where c.organization_id=p_organization_id and (p_start_at is null or p_end_at is null
      or v.fact_kind='catalog' or (
        nullif(v.fact->>'occurredAt','') is not null
        and (v.fact->>'occurredAt')::timestamptz >= p_start_at
        and (v.fact->>'occurredAt')::timestamptz < p_end_at));
  select coalesce(to_jsonb(p),'{}'::jsonb) into policy_row
    from public.organization_accounting_policies p where p.organization_id=p_organization_id;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.name),'[]'::jsonb) into account_rows
    from public.accounts a where a.organization_id=p_organization_id and a.active;
  select coalesce(jsonb_agg(to_jsonb(d) order by d.effective_from),'[]'::jsonb) into item_definition_rows
    from public.item_definitions d where d.organization_id=p_organization_id
      and (p_start_at is null or d.effective_from < p_end_at)
      and (p_end_at is null or d.effective_until is null or d.effective_until > p_start_at);
  select coalesce(jsonb_agg(to_jsonb(b) order by b.account_id,b.observed_at),'[]'::jsonb) into observation_rows
    from public.balance_observations b where b.organization_id=p_organization_id
      and (p_start_at is null or b.observed_at >= p_start_at)
      and (p_end_at is null or b.observed_at < p_end_at);
  select coalesce(jsonb_agg(to_jsonb(m) order by m.occurred_at),'[]'::jsonb) into movement_rows
    from public.cash_movements m where m.organization_id=p_organization_id
      and (p_start_at is null or m.occurred_at >= p_start_at)
      and (p_end_at is null or m.occurred_at < p_end_at);
  return jsonb_build_object('sourceRevision',current_revision,'facts',fact_rows,
    'policy',policy_row,'accounts',account_rows,'itemDefinitions',item_definition_rows,
    'observations',observation_rows,'movements',movement_rows,
    'periodStart',p_start_at,'periodEnd',p_end_at);
end
$$;

create or replace function public.record_square_worker_health(
  p_organization_id uuid, p_record jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_record->>'resource' is null or p_record->>'status' not in ('fresh','incomplete','stale','failed') then
    raise exception 'Invalid worker health record';
  end if;
  insert into private.square_worker_health (organization_id,resource,status,last_successful_sync_at,gap,
    sync_result,processed_notification_id,source_revision,checked_at)
  values (p_organization_id,p_record->>'resource',p_record->>'status',
    nullif(p_record->>'lastSuccessfulSyncAt','')::timestamptz,p_record->'gap',p_record->'syncResult',
    p_record->>'processedNotificationId',nullif(p_record->>'sourceRevision','')::bigint,
    coalesce(nullif(p_record->>'checkedAt','')::timestamptz,now()))
  on conflict (organization_id,resource) do update set
    status=excluded.status,last_successful_sync_at=coalesce(excluded.last_successful_sync_at,private.square_worker_health.last_successful_sync_at),
    gap=excluded.gap,sync_result=excluded.sync_result,
    processed_notification_id=coalesce(excluded.processed_notification_id,private.square_worker_health.processed_notification_id),
    source_revision=coalesce(excluded.source_revision,private.square_worker_health.source_revision),checked_at=excluded.checked_at;
  return true;
end
$$;

create or replace function public.get_square_worker_health(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare last_sync timestamptz; revision bigint; overall_status text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  select max(h.last_successful_sync_at) into last_sync from private.square_worker_health h
    where h.organization_id=p_organization_id;
  select h.status into overall_status from private.square_worker_health h
    where h.organization_id=p_organization_id and h.resource='square';
  select coalesce(s.source_revision,0) into revision from private.square_worker_state s where s.organization_id=p_organization_id;
  return jsonb_build_object('lastSuccessfulSyncAt',last_sync,'sourceRevision',coalesce(revision,0),
    'status',case when overall_status='failed' then 'failed'
      when overall_status='incomplete' then 'incomplete'
      when last_sync is null or last_sync < now()-interval '24 hours' then 'stale' else 'fresh' end);
end
$$;

create or replace function public.upsert_square_worker_issue(
  p_organization_id uuid,p_code text,p_state text,p_revision bigint,p_details jsonb,p_source_refs jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare issue_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_code is null or length(p_code)>100 or p_state not in ('monitoring','diagnosing','awaiting_human','failed')
     or jsonb_typeof(coalesce(p_source_refs,'[]'::jsonb))<>'array' then raise exception 'Invalid worker issue'; end if;
  select i.id into issue_id from public.issues i where i.organization_id=p_organization_id
    and i.code=p_code and i.state <> 'resolved' order by i.updated_at desc limit 1 for update;
  if issue_id is null then
    insert into public.issues (organization_id,code,state,source_refs,details)
      values (p_organization_id,p_code,p_state,coalesce(p_source_refs,'[]'::jsonb),
        coalesce(p_details,'{}'::jsonb) || jsonb_build_object('origin','worker','source_revision',p_revision)) returning id into issue_id;
  else
    update public.issues i set state=case when i.state='proposal_pending' then i.state else p_state end,
      source_refs=coalesce(p_source_refs,'[]'::jsonb),
      details=coalesce(p_details,'{}'::jsonb) || jsonb_build_object('origin','worker','source_revision',p_revision),updated_at=now()
      where i.id=issue_id;
  end if;
  return issue_id;
end
$$;

create or replace function public.resolve_square_worker_issue(
  p_organization_id uuid,p_code text,p_resolved_at timestamptz default now(),p_source_refs text[] default null
) returns integer language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  update public.issues i set state='resolved',updated_at=coalesce(p_resolved_at,now())
    where i.organization_id=p_organization_id and i.code=p_code and i.state<>'resolved'
      and (p_source_refs is null or exists (
        select 1 from jsonb_array_elements_text(i.source_refs) r(value) where r.value=any(p_source_refs)));
  get diagnostics affected = row_count;
  return affected;
end
$$;

create or replace function public.save_projection_run_system(
  p_organization_id uuid,p_source_revision bigint,p_calculation_version text,p_result jsonb,
  p_source_snapshot jsonb,p_source_snapshot_hash text,p_cause text,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare existing public.projection_runs%rowtype; inserted_id uuid; start_time timestamptz; end_time timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if jsonb_typeof(p_result)<>'object' or jsonb_typeof(p_source_snapshot)<>'object'
     or p_source_snapshot_hash !~ '^[0-9a-f]{64}$'
     or length(btrim(coalesce(p_idempotency_key,'')))<8 then raise exception 'Invalid projection run'; end if;
  start_time := coalesce(nullif(p_source_snapshot->>'periodStart','')::timestamptz,date_trunc('month',now()));
  end_time := coalesce(nullif(p_source_snapshot->>'periodEnd','')::timestamptz,date_trunc('month',now())+interval '1 month');
  if end_time<=start_time then raise exception 'Projection period must have positive duration'; end if;
  insert into public.projection_runs (organization_id,period_start,period_end,calculation_version,
    source_snapshot_hash,status,result,idempotency_key,source_snapshot)
  values (p_organization_id,start_time,end_time,p_calculation_version,
    p_source_snapshot_hash,
    case when p_result->>'status' in ('complete','incomplete','failed') then p_result->>'status' else 'incomplete' end,
    p_result,p_idempotency_key,p_source_snapshot)
  on conflict (organization_id,idempotency_key) do nothing returning id into inserted_id;
  if inserted_id is not null then return jsonb_build_object('id',inserted_id); end if;
  select * into existing from public.projection_runs r where r.organization_id=p_organization_id and r.idempotency_key=p_idempotency_key;
  if existing.source_snapshot is distinct from p_source_snapshot or existing.result is distinct from p_result then
    raise exception 'Projection idempotency key was used with different data'; end if;
  return jsonb_build_object('id',existing.id);
end
$$;

create or replace function public.sync_square_projection_issues(
  p_organization_id uuid,p_source_revision bigint,p_calculation_version text,
  p_period_start timestamptz,p_period_end timestamptz,p_issues jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare item jsonb; issue_id uuid; current_codes text[] := array[]::text[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if jsonb_typeof(p_issues)<>'array' then raise exception 'Projection issues must be an array'; end if;
  for item in select value from jsonb_array_elements(p_issues) loop
    current_codes := array_append(current_codes,item->>'code');
    select i.id into issue_id from public.issues i where i.organization_id=p_organization_id
      and i.code=item->>'code' and i.details->>'origin'='projection' and i.state<>'resolved'
      and nullif(i.details->>'period_start','')::timestamptz is not distinct from p_period_start
      and nullif(i.details->>'period_end','')::timestamptz is not distinct from p_period_end
      order by i.updated_at desc limit 1 for update;
    if issue_id is null then
      insert into public.issues(organization_id,code,state,source_refs,details)
      values(p_organization_id,item->>'code',coalesce(item->>'state','awaiting_human'),
        coalesce(item->'sourceRefs','[]'::jsonb),jsonb_build_object('message',item->>'message',
          'origin','projection','source_revision',p_source_revision,'calculation_version',p_calculation_version,
          'period_start',p_period_start,'period_end',p_period_end));
    else
      update public.issues set state=case when state='proposal_pending' then state else coalesce(item->>'state','awaiting_human') end,source_refs=coalesce(item->'sourceRefs','[]'::jsonb),
        details=jsonb_build_object('message',item->>'message','origin','projection','source_revision',p_source_revision,
          'calculation_version',p_calculation_version,'period_start',p_period_start,'period_end',p_period_end),updated_at=now() where id=issue_id;
    end if;
    issue_id := null;
  end loop;
  update public.issues i set state='resolved',updated_at=now()
    where i.organization_id=p_organization_id and i.details->>'origin'='projection'
      and i.state in ('monitoring','diagnosing','awaiting_human','failed')
      and nullif(i.details->>'period_start','')::timestamptz is not distinct from p_period_start
      and nullif(i.details->>'period_end','')::timestamptz is not distinct from p_period_end
      and not (i.code=any(current_codes));
  return true;
end
$$;

revoke all on function public.extend_durable_job_lease(uuid,text,uuid,integer) from public,anon,authenticated;
revoke all on function public.upsert_square_facts(uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.get_square_projection_snapshot(uuid,bigint,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.record_square_worker_health(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.get_square_worker_health(uuid) from public,anon,authenticated;
revoke all on function public.upsert_square_worker_issue(uuid,text,text,bigint,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.resolve_square_worker_issue(uuid,text,timestamptz,text[]) from public,anon,authenticated;
revoke all on function public.save_projection_run_system(uuid,bigint,text,jsonb,jsonb,text,text,text) from public,anon,authenticated;
revoke all on function public.sync_square_projection_issues(uuid,bigint,text,timestamptz,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.extend_durable_job_lease(uuid,text,uuid,integer) to service_role;
grant execute on function public.upsert_square_facts(uuid,jsonb,text) to service_role;
grant execute on function public.get_square_projection_snapshot(uuid,bigint,timestamptz,timestamptz) to service_role;
grant execute on function public.record_square_worker_health(uuid,jsonb) to service_role;
grant execute on function public.get_square_worker_health(uuid) to service_role;
grant execute on function public.upsert_square_worker_issue(uuid,text,text,bigint,jsonb,jsonb) to service_role;
grant execute on function public.resolve_square_worker_issue(uuid,text,timestamptz,text[]) to service_role;
grant execute on function public.save_projection_run_system(uuid,bigint,text,jsonb,jsonb,text,text,text) to service_role;
grant execute on function public.sync_square_projection_issues(uuid,bigint,text,timestamptz,timestamptz,jsonb) to service_role;
