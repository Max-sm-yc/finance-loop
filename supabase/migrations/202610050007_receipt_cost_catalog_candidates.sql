-- Receipt cost approvals can establish costs for any real catalog variation,
-- including products with no completed sale yet.
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
  with sale_candidates as (
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
  ), unsold_catalog_candidates as (
    select v.object_id as catalog_id,
      case when nullif(btrim(parent.fact->>'name'),'') is not null and nullif(btrim(v.fact->>'name'),'') is not null
          and btrim(v.fact->>'name')<>btrim(parent.fact->>'name')
        then btrim(parent.fact->>'name')||' — '||btrim(v.fact->>'name')
        else coalesce(nullif(btrim(parent.fact->>'name'),''),nullif(btrim(v.fact->>'name'),''),'Unidentified Square item') end as item_name,
      nullif(btrim(v.fact->>'sku'),'') as sku,
      p_currency as currency,
      null::text as occurred_at
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
      and not exists(select 1 from sale_candidates s where s.catalog_id=v.object_id)
  ), all_candidates as (
    select * from sale_candidates
    union all
    select * from unsold_catalog_candidates
  )
  select coalesce(jsonb_agg(jsonb_build_object('catalogObjectId',catalog_id,'name',item_name,
    'sku',sku,'currency',currency) order by item_name,catalog_id),'[]'::jsonb)
    into candidates from (select * from all_candidates order by item_name,catalog_id limit 1000) limited_candidates;
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
    if not found then
      select c.object_id,
        case when nullif(btrim(parent.fact->>'name'),'') is not null and nullif(btrim(v.fact->>'name'),'') is not null
            and btrim(v.fact->>'name')<>btrim(parent.fact->>'name')
          then btrim(parent.fact->>'name')||' — '||btrim(v.fact->>'name')
          else coalesce(nullif(btrim(parent.fact->>'name'),''),nullif(btrim(v.fact->>'name'),''),'Unidentified Square item') end,
        nullif(btrim(v.fact->>'sku'),'') into source_fact_id,source_name,source_sku
        from private.square_fact_current c
        join private.square_fact_versions v using(organization_id,fact_kind,object_id,object_version)
        left join private.square_fact_current parent_current on parent_current.organization_id=c.organization_id
          and parent_current.fact_kind='catalog' and parent_current.object_id=v.fact->>'itemId'
        left join private.square_fact_versions parent on parent.organization_id=parent_current.organization_id
          and parent.fact_kind=parent_current.fact_kind and parent.object_id=parent_current.object_id
          and parent.object_version=parent_current.object_version
        where c.organization_id=p_organization_id and c.fact_kind='catalog' and c.object_id=catalog_id
          and v.fact->>'objectType'='ITEM_VARIATION' and v.fact->>'isDeleted' is distinct from 'true'
          and (parent.fact is null or parent.fact->>'isDeleted' is distinct from 'true')
          and coalesce(parent.fact->'raw'->'item_data'->>'product_type','REGULAR')<>'GIFT_CARD'
          and (v.fact->>'currency'=item->>'currency' or coalesce(v.fact->>'currency','') !~ '^[A-Z]{3}$');
    end if;
    if not found or btrim(item->>'name') is distinct from source_name then raise exception 'Receipt item must match an exact Square catalog variation and currency'; end if;
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
        'sourceFactId',source_fact_id,
        'receiptEvidenceFileId',p_evidence_file_id),
      evidence_label,'receipt-cost:'||p_idempotency_key||':'||catalog_id);
    result_rows:=result_rows||jsonb_build_array(jsonb_build_object('id',result_id,
      'squareCatalogObjectId',catalog_id,'unitCostMinor',cost_minor,
      'currency',item->>'currency','effectiveFrom',effective_from,'version',next_version,
      'sourceFactId',source_fact_id,'receiptEvidenceFileId',p_evidence_file_id));
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
