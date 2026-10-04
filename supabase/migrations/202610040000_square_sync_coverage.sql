-- Lightweight, tenant-scoped metadata for deciding whether a requested Square
-- period needs a provider backfill. The caller never receives durable job data.
create or replace function public.get_square_sync_coverage(
  p_organization_id uuid, p_start_at timestamptz, p_end_at timestamptz
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  sync_windows jsonb;
  pending_windows jsonb;
  required_health_fresh boolean;
  missing_parent_count bigint;
  missing_payout_health_count bigint;
  stale_period_payout_health boolean;
begin
  if not public.is_org_member(p_organization_id) then
    raise exception 'Organization membership required';
  end if;
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at
     or p_end_at - p_start_at > interval '366 days' then
    raise exception 'Invalid sync coverage window';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('from',j.payload->>'startAt','to',j.payload->>'endAt') order by j.created_at),'[]'::jsonb)
    into sync_windows
    from private.durable_jobs j
   where j.organization_id=p_organization_id and j.job_type='square.sync' and j.status='complete'
     and nullif(j.payload->>'startAt','') is not null and nullif(j.payload->>'endAt','') is not null
     and (j.payload->>'startAt')::timestamptz < p_end_at
     and (j.payload->>'endAt')::timestamptz > p_start_at;

  select coalesce(jsonb_agg(jsonb_build_object('from',j.payload->>'startAt','to',j.payload->>'endAt') order by j.created_at),'[]'::jsonb)
    into pending_windows
    from private.durable_jobs j
   where j.organization_id=p_organization_id and j.job_type='square.sync' and j.status in ('queued','running')
     and nullif(j.payload->>'startAt','') is not null and nullif(j.payload->>'endAt','') is not null
     and (j.payload->>'startAt')::timestamptz < p_end_at
     and (j.payload->>'endAt')::timestamptz > p_start_at;

  select not exists (
    select 1 from unnest(array['square','orders','payments','refunds','catalog','payouts']::text[]) required(resource)
     where not exists (
       select 1 from private.square_worker_health h
        where h.organization_id=p_organization_id and h.resource=required.resource
          and h.status='fresh' and coalesce(h.gap,'null'::jsonb)='null'::jsonb
          and h.last_successful_sync_at >= now()-interval '24 hours'
     )
  ) into required_health_fresh;

  select count(*) into missing_parent_count
    from private.square_fact_current c
    join private.square_fact_versions v using(organization_id,fact_kind,object_id,object_version)
   where c.organization_id=p_organization_id and v.fact_kind='order_line'
     and nullif(v.fact->>'occurredAt','') is not null
     and (v.fact->>'occurredAt')::timestamptz >= p_start_at
     and (v.fact->>'occurredAt')::timestamptz < p_end_at
     and not exists (
       select 1 from private.square_fact_current oc
        where oc.organization_id=v.organization_id and oc.fact_kind='order'
          and oc.object_id=v.fact->>'orderId'
     );

  select count(*) into missing_payout_health_count
    from private.square_fact_current c
    join private.square_fact_versions v using(organization_id,fact_kind,object_id,object_version)
   where c.organization_id=p_organization_id and v.fact_kind='payout'
     and nullif(v.fact->>'occurredAt','') is not null
     and (v.fact->>'occurredAt')::timestamptz >= p_start_at
     and (v.fact->>'occurredAt')::timestamptz < p_end_at
     and not exists (
       select 1 from private.square_worker_health h
        where h.organization_id=p_organization_id and h.resource='payout_entries:'||v.object_id
     );

  select exists (
    select 1 from private.square_fact_current c
    join private.square_fact_versions v using(organization_id,fact_kind,object_id,object_version)
    left join private.square_worker_health h
      on h.organization_id=p_organization_id and h.resource='payout_entries:'||v.object_id
   where c.organization_id=p_organization_id and v.fact_kind='payout'
     and nullif(v.fact->>'occurredAt','') is not null
     and (v.fact->>'occurredAt')::timestamptz >= p_start_at
     and (v.fact->>'occurredAt')::timestamptz < p_end_at
     and (h.resource is null or h.status is distinct from 'fresh'
       or coalesce(h.gap,'null'::jsonb)<>'null'::jsonb
       or h.last_successful_sync_at is null
       or h.last_successful_sync_at < now()-interval '24 hours')
  ) into stale_period_payout_health;

  return jsonb_build_object(
    'windows',sync_windows,
    'pendingWindows',pending_windows,
    'sourceHealthFresh',required_health_fresh and not stale_period_payout_health,
    'sourceGaps',jsonb_build_object(
      'missingParentOrderLineCount',missing_parent_count,
      'missingPayoutEntryHealthCount',missing_payout_health_count
    )
  );
end $$;

revoke all on function public.get_square_sync_coverage(uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.get_square_sync_coverage(uuid,timestamptz,timestamptz) to authenticated;
