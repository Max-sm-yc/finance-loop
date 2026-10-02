-- Keep human corrections aligned with the versioned Square facts written by the worker.
-- The worker does not populate the legacy public.sale_lines table.

create or replace function public.get_issue_square_evidence(
  p_organization_id uuid, p_issue_code text, p_source_refs text[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  fact_rows jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_issue_code is null or p_issue_code not in ('UNKNOWN_ITEM','REFUND_COGS_REVIEW')
     or coalesce(array_length(p_source_refs,1),0) > 20 then
    raise exception 'Invalid issue evidence request';
  end if;

  with current_facts as (
    select c.fact_kind,c.object_id,v.fact
      from private.square_fact_current c
      join private.square_fact_versions v using (organization_id,fact_kind,object_id,object_version)
     where c.organization_id=p_organization_id
  ), target_refunds as (
    select * from current_facts f
     where f.fact_kind='refund' and f.object_id=any(coalesce(p_source_refs,array[]::text[]))
  ), target_lines as (
    select * from current_facts f
     where f.fact_kind='order_line' and (
       f.object_id=any(coalesce(p_source_refs,array[]::text[]))
       or f.fact->>'orderId'=any(coalesce(p_source_refs,array[]::text[]))
       or exists (select 1 from unnest(coalesce(p_source_refs,array[]::text[])) r(value)
         where split_part(r.value,':',1)=f.fact->>'orderId'
           and split_part(r.value,':',2)=f.fact->>'lineItemUid')
     )
     order by f.object_id limit 200
  ), order_ids as (
    select f.fact->>'orderId' as id from target_refunds f where nullif(f.fact->>'orderId','') is not null
    union select f.fact->>'orderId' from target_lines f where nullif(f.fact->>'orderId','') is not null
    union select unnest(coalesce(p_source_refs,array[]::text[]))
  ), target_orders as (
    select * from current_facts f where f.fact_kind='order' and f.object_id in (select id from order_ids)
  ), variation_ids as (
    select distinct f.fact->>'catalogObjectId' as id from target_lines f
     where nullif(f.fact->>'catalogObjectId','') is not null
  ), catalog_ids as (
    select id from variation_ids
    union
    select f.fact->>'itemId' from current_facts f
     where f.fact_kind='catalog' and f.object_id in (select id from variation_ids)
       and nullif(f.fact->>'itemId','') is not null
  ), selected_facts as (
    select * from target_refunds
    union select * from target_lines
    union select * from target_orders
    union select * from current_facts f where f.fact_kind='catalog' and f.object_id in (select id from catalog_ids)
  )
  select coalesce(jsonb_agg(s.fact order by s.fact_kind,s.object_id),'[]'::jsonb)
    into fact_rows from selected_facts s;
  return jsonb_build_object('facts',fact_rows);
end
$$;

create or replace function public.record_item_definition(
  p_organization_id uuid, p_issue_id uuid, p_square_catalog_object_id text,
  p_name text, p_unit_cost_minor numeric, p_currency text,
  p_effective_from timestamptz, p_approval_reason text, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  issue_row public.issues%rowtype;
  source_fact jsonb;
  request_row private.finance_correction_requests%rowtype;
  covering public.item_definitions%rowtype;
  new_id uuid;
  next_version integer;
  next_start timestamptz;
  has_covering boolean;
  request_body jsonb;
begin
  if actor is null or not private.has_org_role(p_organization_id, array['owner','reviewer']) then
    raise exception 'Organization owner or reviewer role required';
  end if;
  if p_square_catalog_object_id is null or length(btrim(p_square_catalog_object_id)) not between 1 and 200
     or p_name is null or length(btrim(p_name)) not between 1 and 200
     or p_unit_cost_minor is null or p_unit_cost_minor <> trunc(p_unit_cost_minor)
     or p_unit_cost_minor < 0 or p_unit_cost_minor >= 1000000000000
     or p_currency is null or p_currency !~ '^[A-Z]{3}$' or p_effective_from is null
     or length(btrim(coalesce(p_approval_reason,''))) < 10
     or length(btrim(coalesce(p_idempotency_key,''))) < 8 then
    raise exception 'Invalid approved item definition';
  end if;

  request_body := jsonb_build_object('issueId',p_issue_id,'catalogObjectId',btrim(p_square_catalog_object_id),
    'name',btrim(p_name),'unitCostMinor',p_unit_cost_minor,'currency',p_currency,
    'effectiveFrom',p_effective_from,'reason',btrim(p_approval_reason));
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_idempotency_key,0));
  select * into request_row from private.finance_correction_requests r
   where r.organization_id=p_organization_id and r.idempotency_key=p_idempotency_key;
  if found then
    if request_row.request_payload is distinct from request_body or request_row.entity_type <> 'item_definition' then
      raise exception 'Item correction idempotency key was used with different data';
    end if;
    select d.version into next_version from public.item_definitions d where d.organization_id=p_organization_id and d.id=request_row.entity_id;
    return jsonb_build_object('id',request_row.entity_id,'version',next_version);
  end if;

  select * into issue_row from public.issues i
   where i.organization_id=p_organization_id and i.id=p_issue_id for update;
  if not found or issue_row.code <> 'UNKNOWN_ITEM' or issue_row.state='resolved' then
    raise exception 'Open unknown-item issue is required';
  end if;
  select v.fact into source_fact
   from private.square_fact_current c
   join private.square_fact_versions v using (organization_id,fact_kind,object_id,object_version)
   where c.organization_id=p_organization_id and c.fact_kind='order_line'
     and v.fact->>'catalogObjectId'=p_square_catalog_object_id
     and v.fact->>'currency'=p_currency
     and (v.fact->>'occurredAt')::timestamptz >= p_effective_from
     and (exists (select 1 from jsonb_array_elements_text(coalesce(issue_row.source_refs,'[]'::jsonb)) r(value)
       where r.value=v.fact->>'objectId')
       or position('missing for ' || (v.fact->>'objectId') || '.' in coalesce(issue_row.details->>'message','')) > 0)
   order by (v.fact->>'occurredAt')::timestamptz limit 1;
  if source_fact is null then raise exception 'Catalog ID, currency, or effective date does not match issue evidence'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_square_catalog_object_id,0));
  select coalesce(max(d.version),0)+1 into next_version from public.item_definitions d
   where d.organization_id=p_organization_id and d.square_catalog_object_id=p_square_catalog_object_id;
  select * into covering from public.item_definitions d
   where d.organization_id=p_organization_id and d.square_catalog_object_id=p_square_catalog_object_id
     and d.effective_from <= p_effective_from
     and (d.effective_until is null or d.effective_until > p_effective_from)
   order by d.effective_from desc limit 1 for update;
  has_covering := found;
  select min(d.effective_from) into next_start from public.item_definitions d
   where d.organization_id=p_organization_id and d.square_catalog_object_id=p_square_catalog_object_id
     and d.effective_from > p_effective_from;

  if has_covering and covering.effective_from=p_effective_from then
    update public.item_definitions d set name=btrim(p_name),unit_cost_minor=p_unit_cost_minor,
      currency=p_currency,approved_by=actor,approved_at=now(),approval_reason=btrim(p_approval_reason),
      version=next_version
     where d.id=covering.id returning d.id into new_id;
  else
    if covering.id is not null then
      update public.item_definitions d set effective_until=p_effective_from where d.id=covering.id;
      next_start := least(coalesce(next_start,covering.effective_until),covering.effective_until);
    end if;
    insert into public.item_definitions (organization_id,square_catalog_object_id,name,
      unit_cost_minor,currency,effective_from,effective_until,approved_by,approved_at,version,
      approval_reason)
    values (p_organization_id,p_square_catalog_object_id,btrim(p_name),p_unit_cost_minor,
      p_currency,p_effective_from,next_start,actor,now(),next_version,btrim(p_approval_reason))
    returning id into new_id;
  end if;
  insert into private.finance_correction_requests (organization_id,idempotency_key,request_payload,entity_type,entity_id)
  values (p_organization_id,p_idempotency_key,request_body,'item_definition',new_id);
  return jsonb_build_object('id',new_id,'version',next_version,'sourceObjectId',source_fact->>'objectId');
end
$$;

create or replace function public.record_square_sale_line_cost_override(
  p_organization_id uuid, p_issue_id uuid, p_square_order_id text, p_square_line_uid text,
  p_unit_cost_minor bigint, p_currency text, p_approval_reason text, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  issue_row public.issues%rowtype;
  source_fact jsonb;
  request_row private.finance_correction_requests%rowtype;
  request_body jsonb;
  result_id uuid;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner','reviewer']) then
    raise exception 'Organization owner or reviewer role required';
  end if;
  if p_issue_id is null or p_square_order_id is null or p_square_order_id !~ '^[A-Za-z0-9_-]{1,200}$'
     or p_square_line_uid is null or p_square_line_uid !~ '^[A-Za-z0-9_-]{1,200}$'
     or p_unit_cost_minor is null or p_unit_cost_minor < 0 or p_unit_cost_minor >= 1000000000000
     or p_currency is null or p_currency !~ '^[A-Z]{3}$'
     or length(btrim(coalesce(p_approval_reason,''))) < 10
     or length(btrim(coalesce(p_idempotency_key,''))) < 8 then
    raise exception 'Invalid sale line cost override';
  end if;

  select v.fact into source_fact
   from private.square_fact_current c
   join private.square_fact_versions v using (organization_id,fact_kind,object_id,object_version)
   where c.organization_id=p_organization_id and c.fact_kind='order_line'
     and v.fact->>'orderId'=p_square_order_id and v.fact->>'lineItemUid'=p_square_line_uid;
  if source_fact is null or source_fact->>'currency' is distinct from p_currency
     or nullif(source_fact->>'catalogObjectId','') is not null then
    raise exception 'The selected Square sale line has a catalog mapping or no longer exists';
  end if;

  request_body := jsonb_build_object('issueId',p_issue_id,'orderId',p_square_order_id,
    'lineUid',p_square_line_uid,'unitCostMinor',p_unit_cost_minor,'currency',p_currency,
    'reason',btrim(p_approval_reason));
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_idempotency_key,0));
  select * into request_row from private.finance_correction_requests r
   where r.organization_id=p_organization_id and r.idempotency_key=p_idempotency_key;
  if found then
    if request_row.request_payload is distinct from request_body or request_row.entity_type <> 'sale_line_cost_override' then
      raise exception 'Sale line cost idempotency key was used with different data';
    end if;
    return jsonb_build_object('id',request_row.entity_id,'orderId',p_square_order_id,'lineUid',p_square_line_uid);
  end if;

  select * into issue_row from public.issues i
   where i.organization_id=p_organization_id and i.id=p_issue_id for update;
  if not found or issue_row.code <> 'UNKNOWN_ITEM' or issue_row.state='resolved'
     or not (exists (select 1 from jsonb_array_elements_text(coalesce(issue_row.source_refs,'[]'::jsonb)) r(value)
       where r.value=source_fact->>'objectId')
       or position('missing for ' || (source_fact->>'objectId') || '.' in coalesce(issue_row.details->>'message','')) > 0) then
    raise exception 'Open unknown-item issue must reference the selected sale line';
  end if;
  insert into public.sale_line_cost_overrides (organization_id,square_order_id,square_line_uid,
    unit_cost_minor,currency,approval_reason,approved_by)
  values (p_organization_id,p_square_order_id,p_square_line_uid,
    p_unit_cost_minor,p_currency,btrim(p_approval_reason),actor)
  on conflict (organization_id,square_order_id,square_line_uid) do update set
    unit_cost_minor=excluded.unit_cost_minor,currency=excluded.currency,
    approval_reason=excluded.approval_reason,approved_by=excluded.approved_by,
    approved_at=now(),updated_at=now()
  returning id into result_id;
  insert into private.finance_correction_requests (organization_id,idempotency_key,request_payload,entity_type,entity_id)
  values (p_organization_id,p_idempotency_key,request_body,'sale_line_cost_override',result_id);
  return jsonb_build_object('id',result_id,'orderId',p_square_order_id,'lineUid',p_square_line_uid);
end
$$;

create or replace function public.record_refund_cost_review(
  p_organization_id uuid, p_issue_id uuid, p_square_refund_id text,
  p_square_order_id text, p_disposition text, p_approved_cogs_reversal_minor bigint,
  p_currency text, p_decision_reason text, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  issue_row public.issues%rowtype;
  refund_fact jsonb;
  request_row private.finance_correction_requests%rowtype;
  known_order_cogs numeric;
  other_reversals bigint;
  result_id uuid;
  request_body jsonb;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner','reviewer']) then
    raise exception 'Organization owner or reviewer role required';
  end if;
  if p_square_refund_id is null or length(btrim(p_square_refund_id)) not between 1 and 200
     or p_square_order_id is null or length(btrim(p_square_order_id)) not between 1 and 200
     or p_disposition is null or p_disposition not in ('returned_to_inventory','not_returned_to_inventory')
     or p_approved_cogs_reversal_minor is null or p_approved_cogs_reversal_minor < 0
     or p_currency is null or p_currency !~ '^[A-Z]{3}$'
     or length(btrim(coalesce(p_decision_reason,''))) < 10
     or length(btrim(coalesce(p_idempotency_key,''))) < 8 then
    raise exception 'Invalid refund cost review';
  end if;
  if p_disposition='not_returned_to_inventory' and p_approved_cogs_reversal_minor <> 0 then
    raise exception 'A refund without returned inventory cannot reverse COGS';
  end if;
  request_body := jsonb_build_object('issueId',p_issue_id,'refundId',btrim(p_square_refund_id),
    'orderId',btrim(p_square_order_id),'disposition',p_disposition,
    'approvedCogsReversalMinor',p_approved_cogs_reversal_minor,'currency',p_currency,
    'reason',btrim(p_decision_reason));
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_idempotency_key,0));
  select * into request_row from private.finance_correction_requests r
   where r.organization_id=p_organization_id and r.idempotency_key=p_idempotency_key;
  if found then
    if request_row.request_payload is distinct from request_body or request_row.entity_type <> 'refund_cost_review' then
      raise exception 'Refund review idempotency key was used with different data';
    end if;
    return jsonb_build_object('id',request_row.entity_id);
  end if;
  select * into issue_row from public.issues i
   where i.organization_id=p_organization_id and i.id=p_issue_id for update;
  if not found or issue_row.code <> 'REFUND_COGS_REVIEW' or issue_row.state='resolved' then
    raise exception 'Open refund review issue and linked refund/order are required';
  end if;
  select v.fact into refund_fact from private.square_fact_current c
   join private.square_fact_versions v using (organization_id,fact_kind,object_id,object_version)
   where c.organization_id=p_organization_id and c.fact_kind='refund' and c.object_id=p_square_refund_id;
  if refund_fact is null or refund_fact->>'orderId' is distinct from p_square_order_id
     or refund_fact->>'currency' is distinct from p_currency
     or lower(coalesce(refund_fact->>'status','')) <> 'completed'
     or coalesce(nullif(refund_fact->>'amountMinor','')::bigint,0) <= 0 then
    raise exception 'Refund source fact does not match the review';
  end if;
  if not (exists (select 1 from jsonb_array_elements_text(coalesce(issue_row.source_refs,'[]'::jsonb)) r(value)
       where r.value=p_square_refund_id)
       or left(coalesce(issue_row.details->>'message',''),length('Refund ' || p_square_refund_id || ' '))
         = 'Refund ' || p_square_refund_id || ' ') then
    raise exception 'Open refund review issue and linked refund/order are required';
  end if;

  select coalesce(sum(round((v.fact->>'quantity')::numeric * coalesce(o.unit_cost_minor,d.unit_cost_minor))),0)
    into known_order_cogs
   from private.square_fact_current c
   join private.square_fact_versions v using (organization_id,fact_kind,object_id,object_version)
   left join public.sale_line_cost_overrides o on o.organization_id=c.organization_id
     and o.square_order_id=v.fact->>'orderId' and o.square_line_uid=v.fact->>'lineItemUid'
     and o.currency=v.fact->>'currency'
   left join public.item_definitions d on d.organization_id=c.organization_id
     and d.square_catalog_object_id=v.fact->>'catalogObjectId' and d.currency=v.fact->>'currency'
     and d.effective_from <= (v.fact->>'occurredAt')::timestamptz
     and (d.effective_until is null or d.effective_until > (v.fact->>'occurredAt')::timestamptz)
   where c.organization_id=p_organization_id and c.fact_kind='order_line'
     and v.fact->>'orderId'=p_square_order_id and v.fact->>'currency'=p_currency
     and coalesce(o.unit_cost_minor,d.unit_cost_minor) is not null
     and exists (select 1 from private.square_fact_current oc
       join private.square_fact_versions ov using (organization_id,fact_kind,object_id,object_version)
       where oc.organization_id=p_organization_id and oc.fact_kind='order'
         and oc.object_id=p_square_order_id and lower(coalesce(ov.fact->>'status',''))='completed');
  select coalesce(sum(r.approved_cogs_reversal_minor),0) into other_reversals
   from public.refund_cost_reviews r where r.organization_id=p_organization_id
    and r.square_order_id=p_square_order_id and r.square_refund_id<>p_square_refund_id;
  if p_approved_cogs_reversal_minor+other_reversals > known_order_cogs then
    raise exception 'Approved COGS reversals exceed known costs for this order';
  end if;
  insert into public.refund_cost_reviews (organization_id,square_refund_id,square_order_id,
    disposition,approved_cogs_reversal_minor,currency,decision_reason,reviewed_by)
  values (p_organization_id,p_square_refund_id,p_square_order_id,p_disposition,
    p_approved_cogs_reversal_minor,p_currency,btrim(p_decision_reason),actor)
  on conflict (organization_id,square_refund_id) do update set
    square_order_id=excluded.square_order_id,disposition=excluded.disposition,
    approved_cogs_reversal_minor=excluded.approved_cogs_reversal_minor,currency=excluded.currency,
    decision_reason=excluded.decision_reason,reviewed_by=excluded.reviewed_by,
    reviewed_at=now(),updated_at=now()
  returning id into result_id;
  insert into private.finance_correction_requests (organization_id,idempotency_key,request_payload,entity_type,entity_id)
  values (p_organization_id,p_idempotency_key,request_body,'refund_cost_review',result_id);
  return jsonb_build_object('id',result_id,'reviewedAt',now());
end
$$;

revoke all on function public.record_item_definition(uuid,uuid,text,text,numeric,text,timestamptz,text,text) from public,anon;
grant execute on function public.record_item_definition(uuid,uuid,text,text,numeric,text,timestamptz,text,text) to authenticated;
revoke all on function public.get_issue_square_evidence(uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.get_issue_square_evidence(uuid,text,text[]) to service_role;
revoke all on function public.record_square_sale_line_cost_override(uuid,uuid,text,text,bigint,text,text,text) from public,anon;
grant execute on function public.record_square_sale_line_cost_override(uuid,uuid,text,text,bigint,text,text,text) to authenticated;
revoke all on function public.record_refund_cost_review(uuid,uuid,text,text,text,bigint,text,text,text) from public,anon;
grant execute on function public.record_refund_cost_review(uuid,uuid,text,text,text,bigint,text,text,text) to authenticated;
