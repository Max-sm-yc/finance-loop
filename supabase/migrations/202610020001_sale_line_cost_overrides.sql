-- A Square line without a catalog variation can receive an audited cost for
-- that exact order line without inventing a reusable catalog mapping.
alter table private.finance_correction_requests
  drop constraint if exists finance_correction_requests_entity_type_check;
alter table private.finance_correction_requests
  add constraint finance_correction_requests_entity_type_check
  check (entity_type in ('item_definition','refund_cost_review','sale_line_cost_override'));

create table public.sale_line_cost_overrides (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  square_order_id text not null,
  square_line_uid text not null,
  unit_cost_minor bigint not null check (unit_cost_minor >= 0),
  currency char(3) not null,
  approval_reason text not null check (length(btrim(approval_reason)) >= 10),
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id,square_order_id,square_line_uid)
);
alter table public.sale_line_cost_overrides enable row level security;
revoke all on public.sale_line_cost_overrides from public,anon,authenticated;

-- Preserve the projection payload redaction added by worker_persistence, while
-- retaining the human decision reason for all supported cost-review rows.
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
  elsif tg_table_name in ('item_definitions','sale_line_cost_overrides') and tg_op <> 'DELETE' then
    event_reason := new.approval_reason;
  elsif tg_table_name = 'refund_cost_reviews' and tg_op <> 'DELETE' then
    event_reason := new.decision_reason;
  end if;
  insert into public.audit_events (organization_id,actor_user_id,actor_kind,action,entity_type,
    entity_id,before_state,after_state,reason,correlation_id)
  values (org_id,actor,case when actor is null then 'system' else 'human' end,action_name,
    tg_table_name,row_id,before_value,after_value,event_reason,gen_random_uuid()::text);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
create trigger sale_line_cost_overrides_audit after insert or update on public.sale_line_cost_overrides
  for each row execute function private.write_audit_event();

create or replace function public.record_sale_line_cost_override(
  p_organization_id uuid,p_issue_id uuid,p_sale_line_id uuid,p_unit_cost_minor bigint,
  p_currency text,p_approval_reason text,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  issue_row public.issues%rowtype;
  source_line public.sale_lines%rowtype;
  request_row private.finance_correction_requests%rowtype;
  result_id uuid;
  request_body jsonb;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner','reviewer']) then
    raise exception 'Organization owner or reviewer role required';
  end if;
  if p_sale_line_id is null or p_unit_cost_minor is null or p_unit_cost_minor < 0
     or p_unit_cost_minor >= 1000000000000 or p_currency is null or p_currency !~ '^[A-Z]{3}$'
     or length(btrim(coalesce(p_approval_reason,''))) < 10
     or length(btrim(coalesce(p_idempotency_key,''))) < 8 then
    raise exception 'Invalid sale line cost override';
  end if;
  select * into source_line from public.sale_lines l
   where l.organization_id=p_organization_id and l.id=p_sale_line_id and l.currency=p_currency;
  if not found or source_line.square_catalog_object_id is not null then
    raise exception 'The selected Square sale line has a catalog mapping or no longer exists';
  end if;
  request_body := jsonb_build_object('issueId',p_issue_id,'saleLineId',p_sale_line_id,
    'orderId',source_line.square_order_id,'lineUid',source_line.square_line_uid,
    'unitCostMinor',p_unit_cost_minor,'currency',p_currency,'reason',btrim(p_approval_reason));
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_idempotency_key,0));
  select * into request_row from private.finance_correction_requests r
   where r.organization_id=p_organization_id and r.idempotency_key=p_idempotency_key;
  if found then
    if request_row.request_payload is distinct from request_body or request_row.entity_type <> 'sale_line_cost_override' then
      raise exception 'Sale line cost idempotency key was used with different data';
    end if;
    return jsonb_build_object('id',request_row.entity_id,'orderId',source_line.square_order_id,
      'lineUid',source_line.square_line_uid);
  end if;

  select * into issue_row from public.issues i
   where i.organization_id=p_organization_id and i.id=p_issue_id for update;
  if not found or issue_row.code <> 'UNKNOWN_ITEM' or issue_row.state='resolved'
     or not exists (select 1 from jsonb_array_elements_text(issue_row.source_refs) r(value)
       where r.value=concat(source_line.square_order_id,':',source_line.square_line_uid)) then
    raise exception 'Open unknown-item issue must reference the selected sale line';
  end if;
  insert into public.sale_line_cost_overrides (organization_id,square_order_id,square_line_uid,
    unit_cost_minor,currency,approval_reason,approved_by)
  values (p_organization_id,source_line.square_order_id,source_line.square_line_uid,
    p_unit_cost_minor,p_currency,btrim(p_approval_reason),actor)
  on conflict (organization_id,square_order_id,square_line_uid) do update set
    unit_cost_minor=excluded.unit_cost_minor,currency=excluded.currency,
    approval_reason=excluded.approval_reason,approved_by=excluded.approved_by,
    approved_at=now(),updated_at=now()
  returning id into result_id;
  insert into private.finance_correction_requests (organization_id,idempotency_key,request_payload,entity_type,entity_id)
  values (p_organization_id,p_idempotency_key,request_body,'sale_line_cost_override',result_id);
  return jsonb_build_object('id',result_id,'orderId',source_line.square_order_id,
    'lineUid',source_line.square_line_uid);
end
$$;

create or replace function public.record_refund_cost_review(
  p_organization_id uuid,p_issue_id uuid,p_square_refund_id text,
  p_square_order_id text,p_disposition text,p_approved_cogs_reversal_minor bigint,
  p_currency text,p_decision_reason text,p_idempotency_key text
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
  if not found or issue_row.code <> 'REFUND_COGS_REVIEW' or issue_row.state='resolved'
     or not exists (select 1 from jsonb_array_elements_text(issue_row.source_refs) r(value) where r.value=p_square_refund_id)
     or not exists (select 1 from jsonb_array_elements_text(issue_row.source_refs) r(value) where r.value=p_square_order_id) then
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
  select coalesce(sum(round(l.quantity*coalesce(o.unit_cost_minor,d.unit_cost_minor))),0)
    into known_order_cogs
   from (select distinct on (organization_id,square_order_id,square_line_uid) *
     from public.sale_lines where organization_id=p_organization_id and square_order_id=p_square_order_id
       and currency=p_currency order by organization_id,square_order_id,square_line_uid,source_version desc) l
   left join public.sale_line_cost_overrides o on o.organization_id=l.organization_id
     and o.square_order_id=l.square_order_id and o.square_line_uid=l.square_line_uid
     and o.currency=l.currency
   left join public.item_definitions d on d.organization_id=l.organization_id
     and d.square_catalog_object_id=l.square_catalog_object_id and d.currency=l.currency
     and d.effective_from <= l.sold_at and (d.effective_until is null or d.effective_until > l.sold_at)
   where l.organization_id=p_organization_id and l.square_order_id=p_square_order_id
     and l.currency=p_currency and coalesce(o.unit_cost_minor,d.unit_cost_minor) is not null;
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

create or replace function public.get_square_projection_snapshot(
  p_organization_id uuid,p_source_revision bigint,p_start_at timestamptz default null,p_end_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_revision bigint;
  fact_rows jsonb;
  policy_row jsonb;
  account_rows jsonb;
  item_definition_rows jsonb;
  line_cost_override_rows jsonb;
  refund_review_rows jsonb;
  observation_rows jsonb;
  movement_rows jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Service role required'; end if;
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
    or v.fact_kind='catalog' or (nullif(v.fact->>'occurredAt','') is not null
      and (v.fact->>'occurredAt')::timestamptz >= p_start_at
      and (v.fact->>'occurredAt')::timestamptz < p_end_at));
  select coalesce(to_jsonb(p),'{}'::jsonb) into policy_row
   from public.organization_accounting_policies p where p.organization_id=p_organization_id;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.name),'[]'::jsonb) into account_rows
   from public.accounts a where a.organization_id=p_organization_id and a.active;
  select coalesce(jsonb_agg(jsonb_build_object('square_catalog_object_id',d.square_catalog_object_id,
    'unit_cost_minor',d.unit_cost_minor,'currency',d.currency,'effective_from',d.effective_from,
    'effective_until',d.effective_until) order by d.effective_from),'[]'::jsonb) into item_definition_rows
   from public.item_definitions d where d.organization_id=p_organization_id
    and (p_start_at is null or d.effective_from < p_end_at)
    and (p_end_at is null or d.effective_until is null or d.effective_until > p_start_at);
  select coalesce(jsonb_agg(jsonb_build_object('square_order_id',o.square_order_id,
    'square_line_uid',o.square_line_uid,'unit_cost_minor',o.unit_cost_minor,'currency',o.currency)
    order by o.square_order_id,o.square_line_uid),'[]'::jsonb) into line_cost_override_rows
   from public.sale_line_cost_overrides o where o.organization_id=p_organization_id
    and (p_start_at is null or p_end_at is null or exists (
      select 1 from public.sale_lines l where l.organization_id=o.organization_id
       and l.square_order_id=o.square_order_id and l.square_line_uid=o.square_line_uid
       and l.sold_at >= p_start_at and l.sold_at < p_end_at));
  select coalesce(jsonb_agg(jsonb_build_object('square_refund_id',r.square_refund_id,
    'square_order_id',r.square_order_id,'disposition',r.disposition,
    'approved_cogs_reversal_minor',r.approved_cogs_reversal_minor,'currency',r.currency)
    order by r.reviewed_at),'[]'::jsonb) into refund_review_rows
   from public.refund_cost_reviews r where r.organization_id=p_organization_id;
  select coalesce(jsonb_agg(to_jsonb(b) order by b.account_id,b.observed_at),'[]'::jsonb) into observation_rows
   from public.balance_observations b where b.organization_id=p_organization_id
    and (p_start_at is null or b.observed_at >= p_start_at)
    and (p_end_at is null or b.observed_at < p_end_at);
  select coalesce(jsonb_agg(to_jsonb(m) order by m.occurred_at),'[]'::jsonb) into movement_rows
   from public.cash_movements m where m.organization_id=p_organization_id
    and (p_start_at is null or m.occurred_at >= p_start_at)
    and (p_end_at is null or m.occurred_at < p_end_at);
  return jsonb_build_object('sourceRevision',current_revision,'facts',fact_rows,'policy',policy_row,
    'accounts',account_rows,'itemDefinitions',item_definition_rows,'lineCostOverrides',line_cost_override_rows,
    'refundReviews',refund_review_rows,'observations',observation_rows,'movements',movement_rows,
    'periodStart',p_start_at,'periodEnd',p_end_at);
end
$$;

revoke all on function public.record_sale_line_cost_override(uuid,uuid,uuid,bigint,text,text,text) from public,anon;
grant execute on function public.record_sale_line_cost_override(uuid,uuid,uuid,bigint,text,text,text) to authenticated;
revoke all on function public.record_refund_cost_review(uuid,uuid,text,text,text,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.record_refund_cost_review(uuid,uuid,text,text,text,bigint,text,text,text) to authenticated;
revoke all on function public.get_square_projection_snapshot(uuid,bigint,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.get_square_projection_snapshot(uuid,bigint,timestamptz,timestamptz) to service_role;
