-- The Square worker persists current sales as versioned facts and does not
-- populate the legacy public.sale_lines table. Match approved line costs to
-- the order-line facts in this projection window instead.
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
      select 1 from jsonb_array_elements(fact_rows) f(fact)
       where f.fact->>'kind'='order_line'
         and f.fact->>'orderId'=o.square_order_id
         and f.fact->>'lineItemUid'=o.square_line_uid));
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

revoke all on function public.get_square_projection_snapshot(uuid,bigint,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.get_square_projection_snapshot(uuid,bigint,timestamptz,timestamptz) to service_role;
