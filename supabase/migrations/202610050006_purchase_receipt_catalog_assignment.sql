-- Allow supplier receipt stock mappings to target a Square variation directly.
-- Stock remains blocked until an effective, evidence-backed cost definition exists.
create or replace function public.list_purchase_receipt_catalog_candidates(p_organization_id uuid,p_currency text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare candidates jsonb;
begin
  if auth.uid() is null or not private.has_org_role(p_organization_id,array['owner','operator','reviewer','read_only']) then
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

create or replace function public.approve_purchase_receipt(
  p_organization_id uuid,p_receipt_id uuid,p_expected_version integer,p_selections jsonb,p_reason text,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); s public.purchase_receipt_submissions%rowtype; draft jsonb; decision_id uuid;
  entry jsonb; line jsonb; line_id text; effect_key text; item_id uuid; def public.item_definitions%rowtype;
  inventory_item public.inventory_items%rowtype; movement_id uuid; cash_id uuid; account_currency char(3);
  cost_minor bigint; receipt_effective_from timestamptz; next_start timestamptz; next_version integer;
  item_name_value text; item_sku text; item_category text; before_value jsonb; cost_id uuid; catalog_id text;
  confirmed_currency text; package_qty numeric; units_per_package numeric; ordered_units numeric; prior_received numeric;
  total_minor bigint; currency_value text; occurred timestamptz; org_timezone text; paid_total numeric; prior_effect jsonb;
  prior_item_key text; selected_item_key text; stock_catalog_id text;
  prior_decision public.purchase_receipt_decisions%rowtype;
  result jsonb := jsonb_build_object('stockMovementIds','[]'::jsonb,'cashMovementIds','[]'::jsonb,'costUpdates','[]'::jsonb);
  start_at timestamptz; end_at timestamptz; replay_start timestamptz; replay_end timestamptz; replay_id uuid; revision bigint;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner','reviewer']) then raise exception 'Organization owner or reviewer role required'; end if;
  if not exists(select 1 from public.organization_feature_flags f where f.organization_id=p_organization_id and f.inventory_tracking) then raise exception 'FEATURE_DISABLED: inventory_tracking'; end if;
  if length(btrim(coalesce(p_reason,''))) not between 10 and 1000 or length(btrim(coalesce(p_idempotency_key,''))) not between 8 and 200
    or jsonb_typeof(p_selections)<>'object' or (p_selections - array['costUpdates','stockReceipts','payments','currency','confirmPurchaseDocument'])<>'{}'::jsonb
    or (p_selections ? 'currency' and p_selections->>'currency' is not null and p_selections->>'currency' !~ '^[A-Z]{3}$') then raise exception 'Invalid purchase receipt decision'; end if;
  if coalesce(p_selections->>'confirmPurchaseDocument','false') not in ('true','false') then raise exception 'Invalid document confirmation'; end if;
  if exists(select 1 from jsonb_each(p_selections) e where e.key not in ('currency','confirmPurchaseDocument') and jsonb_typeof(e.value)<>'array') then raise exception 'Invalid purchase receipt selections'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_idempotency_key,0));
  select * into s from public.purchase_receipt_submissions where organization_id=p_organization_id and id=p_receipt_id for update;
  if not found then raise exception 'Receipt not found'; end if;
  select d.draft into draft from public.purchase_receipt_draft_versions d where d.organization_id=p_organization_id and d.receipt_id=p_receipt_id and d.version=p_expected_version;
  select * into prior_decision from public.purchase_receipt_decisions d where d.organization_id=p_organization_id and d.idempotency_key=p_idempotency_key;
  if found then
    if prior_decision.receipt_id is distinct from p_receipt_id or prior_decision.draft_version is distinct from p_expected_version or prior_decision.decision<>'approved'
      or prior_decision.selections is distinct from p_selections or prior_decision.reason is distinct from btrim(p_reason) or prior_decision.decided_by is distinct from actor then
      raise exception 'Receipt decision idempotency key collision'; end if;
    return jsonb_build_object('receiptId',p_receipt_id,'decisionId',prior_decision.id,'status',s.status,'replayed',true);
  end if;
  if s.status not in ('needs_review','approved','projection_pending','posted') or s.active_draft_version is distinct from p_expected_version then raise exception 'Receipt version conflict'; end if;
  if draft->>'documentKind' in ('unsupported','unclear') and coalesce((p_selections->>'confirmPurchaseDocument')::boolean,false) is not true
    then raise exception 'Confirm that this is a supplier purchase document before approval'; end if;
  confirmed_currency:=coalesce(draft->>'currency',p_selections->>'currency');
  if draft->>'currency' is not null and p_selections->>'currency' is not null and draft->>'currency'<>p_selections->>'currency' then raise exception 'Confirmed currency conflicts with receipt'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(draft->'lines','[]'::jsonb)) l where coalesce(l->>'lineId','')='') then raise exception 'Invalid source line identifiers'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_selections->'costUpdates','[]'::jsonb)) x group by x.value->>'catalogObjectId' having count(*)>1)
    then raise exception 'A catalog variation can be updated only once per receipt approval'; end if;
  insert into public.purchase_receipt_decisions(organization_id,receipt_id,draft_version,decision,selections,reason,idempotency_key,decided_by)
   values(p_organization_id,p_receipt_id,p_expected_version,'approved',p_selections,btrim(p_reason),p_idempotency_key,actor)
   on conflict(organization_id,idempotency_key) do nothing returning id into decision_id;
  if decision_id is null then
    select id into decision_id from public.purchase_receipt_decisions where organization_id=p_organization_id and idempotency_key=p_idempotency_key
      and receipt_id=p_receipt_id and draft_version=p_expected_version and selections=p_selections and reason=btrim(p_reason);
    if decision_id is null then raise exception 'Receipt decision idempotency key collision'; end if;
    return jsonb_build_object('receiptId',p_receipt_id,'decisionId',decision_id,'status',s.status,'replayed',true);
  end if;
  for entry in select value from jsonb_array_elements(coalesce(p_selections->'costUpdates','[]'::jsonb)) loop
    line_id:=entry->>'lineId';
    select value into line from jsonb_array_elements(draft->'lines') where value->>'lineId'=line_id;
    if not found then raise exception 'Cost update references unknown receipt line'; end if;
    if length(btrim(coalesce(entry->>'catalogObjectId',''))) not between 1 and 200
      or length(btrim(coalesce(entry->>'name',''))) not between 1 and 200
      or coalesce(entry->>'unitCostMinor','') !~ '^[0-9]+$' or coalesce(entry->>'currency','') !~ '^[A-Z]{3}$'
      or coalesce(entry->>'effectiveFrom','')='' then raise exception 'Invalid receipt cost update'; end if;
    if not exists(select 1 from private.square_fact_current c
      join private.square_fact_versions v using(organization_id,fact_kind,object_id,object_version)
      where c.organization_id=p_organization_id and c.fact_kind='catalog' and c.object_id=entry->>'catalogObjectId'
        and v.fact->>'objectType'='ITEM_VARIATION'
        and v.fact->>'isDeleted' is distinct from 'true'
        and not exists(select 1 from private.square_fact_current pc
          join private.square_fact_versions pv using(organization_id,fact_kind,object_id,object_version)
          where pc.organization_id=c.organization_id and pc.fact_kind='catalog' and pc.object_id=v.fact->>'itemId'
            and pv.fact->'raw'->'item_data'->>'product_type'='GIFT_CARD')
        and (coalesce(v.fact->>'currency','') !~ '^[A-Z]{3}$' or v.fact->>'currency'=entry->>'currency')) then
      raise exception 'Square catalog variation not found in organization'; end if;
    cost_minor:=(entry->>'unitCostMinor')::bigint; receipt_effective_from:=(entry->>'effectiveFrom')::timestamptz;
    if cost_minor<0 or cost_minor>=1000000000000 or receipt_effective_from is null
      or receipt_effective_from<=transaction_timestamp()-interval '369 days' then raise exception 'Invalid receipt cost amount or effective date'; end if;
    if entry->>'currency' is distinct from coalesce(line->>'currency',confirmed_currency) then raise exception 'Receipt cost currency does not match source line'; end if;
    perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||(entry->>'catalogObjectId'),0));
    select * into def from public.item_definitions d where d.organization_id=p_organization_id
      and d.square_catalog_object_id=entry->>'catalogObjectId' and d.currency=entry->>'currency'
      and d.effective_from<=receipt_effective_from and (d.effective_until is null or d.effective_until>receipt_effective_from)
      order by d.effective_from desc limit 1 for update;
    before_value:=case when found then jsonb_build_object('id',def.id,'unitCostMinor',def.unit_cost_minor,
      'effectiveFrom',def.effective_from,'effectiveUntil',def.effective_until) else null end;
    item_name_value:=coalesce(nullif(btrim(entry->>'name'),''),def.name);
    item_sku:=def.sku; item_category:=def.category;
    select coalesce(max(d.version),0)+1 into next_version from public.item_definitions d where d.organization_id=p_organization_id
      and d.square_catalog_object_id=entry->>'catalogObjectId';
    select min(d.effective_from) into next_start from public.item_definitions d where d.organization_id=p_organization_id
      and d.square_catalog_object_id=entry->>'catalogObjectId' and d.effective_from>receipt_effective_from;
    if exists(select 1 from public.accounting_periods p where p.organization_id=p_organization_id and p.status='closed'
      and p.starts_at<coalesce(next_start,def.effective_until,'infinity'::timestamptz) and p.ends_at>receipt_effective_from)
      then raise exception 'PERIOD_CLOSED'; end if;
    if def.id is not null then
      if def.effective_from=receipt_effective_from then
        update public.item_definitions set unit_cost_minor=cost_minor,approved_by=actor,approved_at=now(),
          approval_reason='Supplier receipt '||p_receipt_id::text||': '||btrim(p_reason),version=next_version,name=item_name_value
          where organization_id=p_organization_id and id=def.id returning id into cost_id;
      else
        update public.item_definitions set effective_until=receipt_effective_from where organization_id=p_organization_id and id=def.id;
        next_start:=def.effective_until;
        insert into public.item_definitions(organization_id,square_catalog_object_id,sku,name,category,unit_cost_minor,currency,effective_from,effective_until,approved_by,approved_at,version,approval_reason)
          values(p_organization_id,entry->>'catalogObjectId',item_sku,item_name_value,item_category,cost_minor,entry->>'currency',receipt_effective_from,
            coalesce(def.effective_until,next_start),actor,now(),next_version,'Supplier receipt '||p_receipt_id::text||': '||btrim(p_reason)) returning id into cost_id;
      end if;
    else
      insert into public.item_definitions(organization_id,square_catalog_object_id,sku,name,category,unit_cost_minor,currency,effective_from,effective_until,approved_by,approved_at,version,approval_reason)
        values(p_organization_id,entry->>'catalogObjectId',null,item_name_value,null,cost_minor,entry->>'currency',receipt_effective_from,next_start,
          actor,now(),next_version,'Supplier receipt '||p_receipt_id::text||': '||btrim(p_reason)) returning id into cost_id;
    end if;
    insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id)
      values(p_organization_id,actor,'human',case when before_value is null then 'insert' else 'update' end,'item_definition',cost_id,before_value,
        jsonb_build_object('catalogObjectId',entry->>'catalogObjectId','unitCostMinor',cost_minor,'currency',entry->>'currency','effectiveFrom',receipt_effective_from,'receiptId',p_receipt_id),
        btrim(p_reason),'purchase-receipt:'||p_receipt_id::text||':cost:'||line_id);
    effect_key:=line_id;
    insert into public.purchase_receipt_effects(organization_id,receipt_id,source_line_id,effect_type,effect_key,decision_id,effect_payload)
      values(p_organization_id,p_receipt_id,line_id,'cost_update',effect_key,decision_id,entry);
    result:=jsonb_set(result,'{costUpdates}',(result->'costUpdates')||jsonb_build_array(jsonb_build_object('itemDefinitionId',cost_id,'catalogObjectId',entry->>'catalogObjectId','unitCostMinor',cost_minor,'currency',entry->>'currency','effectiveFrom',receipt_effective_from)));
    if receipt_effective_from<=now() then start_at:=least(coalesce(start_at,receipt_effective_from),receipt_effective_from); end_at:=greatest(coalesce(end_at,now()+interval '1 second'),now()+interval '1 second'); end if;
  end loop;
  for entry in select value from jsonb_array_elements(coalesce(p_selections->'stockReceipts','[]'::jsonb)) loop
    line_id:=entry->>'lineId'; effect_key:=entry->>'eventKey';
    select value into line from jsonb_array_elements(draft->'lines') where value->>'lineId'=line_id;
    if not found or length(btrim(coalesce(effect_key,''))) not between 1 and 200 then raise exception 'Stock receipt references unknown line or event key'; end if;
    if (entry ? 'catalogObjectId')=(entry ? 'itemId')
      or (entry ? 'catalogObjectId' and length(btrim(coalesce(entry->>'catalogObjectId',''))) not between 1 and 200) then
      raise exception 'Invalid stock receipt item identity'; end if;
    stock_catalog_id:=nullif(btrim(entry->>'catalogObjectId'),'');
    if (coalesce(entry->>'quantity','') !~ '^[0-9]+$' or (entry->>'quantity')::numeric<=0 or (entry->>'quantity')::numeric>1000000
      or (entry->>'unitCostMinor') !~ '^[0-9]+$' or (entry->>'unitCostMinor')::numeric>999999999999
      or coalesce(entry->>'currency',confirmed_currency) !~ '^[A-Z]{3}$' or (entry->>'occurredAt') is null) then raise exception 'Invalid stock receipt'; end if;
    currency_value:=coalesce(entry->>'currency',confirmed_currency);
    if stock_catalog_id is not null and not exists(select 1 from private.square_fact_current c
      join private.square_fact_versions v using(organization_id,fact_kind,object_id,object_version)
      where c.organization_id=p_organization_id and c.fact_kind='catalog' and c.object_id=stock_catalog_id
        and v.fact->>'objectType'='ITEM_VARIATION' and v.fact->>'isDeleted' is distinct from 'true'
        and not exists(select 1 from private.square_fact_current pc
          join private.square_fact_versions pv using(organization_id,fact_kind,object_id,object_version)
          where pc.organization_id=c.organization_id and pc.fact_kind='catalog' and pc.object_id=v.fact->>'itemId'
            and pv.fact->'raw'->'item_data'->>'product_type'='GIFT_CARD')
        and (coalesce(v.fact->>'currency','') !~ '^[A-Z]{3}$' or v.fact->>'currency'=currency_value)) then
      raise exception 'Square catalog variation not found in organization or currency'; end if;
    if coalesce(line->>'currency',draft->>'currency') is not null and coalesce(line->>'currency',draft->>'currency')<>currency_value then raise exception 'Stock receipt currency conflicts with source'; end if;
    package_qty:=coalesce(nullif(entry->>'packageQuantity','')::numeric,nullif(line->>'packageQuantity','')::numeric,nullif(line->>'quantity','')::numeric,0);
    units_per_package:=coalesce(nullif(entry->>'unitsPerPackage','')::numeric,nullif(line->>'unitsPerPackage','')::numeric,1);
    if package_qty<=0 or units_per_package<=0 or units_per_package<>trunc(units_per_package) then raise exception 'Purchase quantity and package conversion are required'; end if;
    ordered_units:=package_qty*units_per_package;
    select coalesce(sum((e.effect_payload->>'quantity')::numeric),0) into prior_received from public.purchase_receipt_effects e
      where e.organization_id=p_organization_id and e.receipt_id=p_receipt_id and e.effect_type='stock_receipt' and e.source_line_id=line_id;
    select e.effect_payload into prior_effect from public.purchase_receipt_effects e where e.organization_id=p_organization_id
      and e.receipt_id=p_receipt_id and e.effect_type='stock_receipt' and e.source_line_id=line_id order by e.created_at limit 1;
    if prior_effect is not null and (prior_effect->>'packageQuantity')::numeric<>package_qty
      or prior_effect is not null and (prior_effect->>'unitsPerPackage')::numeric<>units_per_package
      or prior_effect is not null and prior_effect->>'currency' is distinct from currency_value then
      raise exception 'Partial receipt must retain the confirmed item, currency and package conversion';
    end if;
    if prior_effect is not null then
      if prior_effect->>'catalogObjectId' is not null then
        prior_item_key:='square:'||(prior_effect->>'catalogObjectId');
      else
        select 'square:'||d.square_catalog_object_id into prior_item_key
          from public.item_definitions d where d.organization_id=p_organization_id and d.id=(prior_effect->>'itemId')::uuid;
        if prior_item_key is null then prior_item_key:='manual:'||(prior_effect->>'itemId'); end if;
      end if;
      if stock_catalog_id is not null then selected_item_key:='square:'||stock_catalog_id;
      else
        select 'square:'||d.square_catalog_object_id into selected_item_key
          from public.item_definitions d where d.organization_id=p_organization_id and d.id=(entry->>'itemId')::uuid;
        if selected_item_key is null then selected_item_key:='manual:'||(entry->>'itemId'); end if;
      end if;
      if prior_item_key is distinct from selected_item_key then raise exception 'Partial receipt must retain the confirmed item identity'; end if;
    end if;
    if prior_received+(entry->>'quantity')::numeric>ordered_units then raise exception 'Received inventory exceeds confirmed purchased quantity'; end if;
    occurred:=(entry->>'occurredAt')::timestamptz;
    if not private.inventory_period_is_open(p_organization_id,occurred) then raise exception 'PERIOD_CLOSED'; end if;
    if stock_catalog_id is not null then
      select * into def from public.item_definitions d where d.organization_id=p_organization_id and d.square_catalog_object_id=stock_catalog_id
        and d.currency=currency_value and d.effective_from<=occurred and (d.effective_until is null or d.effective_until>occurred)
        order by d.effective_from desc limit 1;
      if not found then raise exception 'No effective item cost definition exists for stock receipt date'; end if;
    else
      item_id:=(entry->>'itemId')::uuid;
      select * into def from public.item_definitions d where d.organization_id=p_organization_id and d.id=item_id and d.currency=currency_value;
      if found then
        catalog_id:=def.square_catalog_object_id;
        select * into def from public.item_definitions d where d.organization_id=p_organization_id and d.square_catalog_object_id=catalog_id
          and d.currency=currency_value and d.effective_from<=occurred and (d.effective_until is null or d.effective_until>occurred)
          order by d.effective_from desc limit 1;
        if not found then raise exception 'No effective item cost definition exists for stock receipt date'; end if;
      end if;
    end if;
    if def.id is not null then
      insert into public.inventory_movements(organization_id,item_definition_id,item_name,square_catalog_object_id,movement_type,quantity_delta,unit_cost_minor,currency,occurred_at,evidence_file_id,reason,idempotency_key,created_by)
      values(p_organization_id,def.id,def.name,def.square_catalog_object_id,'supplier_receipt',(entry->>'quantity')::numeric,(entry->>'unitCostMinor')::bigint,currency_value,occurred,s.evidence_file_id,btrim(p_reason),'purchase-receipt:'||p_receipt_id||':'||effect_key,actor) returning id into movement_id;
    else
      select * into inventory_item from public.inventory_items i where i.organization_id=p_organization_id and i.id=item_id and i.currency=currency_value;
      if not found then raise exception 'Inventory item not found in organization or currency'; end if;
      insert into public.inventory_movements(organization_id,inventory_item_id,item_name,movement_type,quantity_delta,unit_cost_minor,currency,occurred_at,evidence_file_id,reason,idempotency_key,created_by)
      values(p_organization_id,inventory_item.id,inventory_item.name,'supplier_receipt',(entry->>'quantity')::numeric,(entry->>'unitCostMinor')::bigint,currency_value,occurred,s.evidence_file_id,btrim(p_reason),'purchase-receipt:'||p_receipt_id||':'||effect_key,actor) returning id into movement_id;
    end if;
    insert into public.purchase_receipt_effects(organization_id,receipt_id,source_line_id,effect_type,effect_key,decision_id,effect_payload,inventory_movement_id)
      values(p_organization_id,p_receipt_id,line_id,'stock_receipt',effect_key,decision_id,
        entry||jsonb_build_object('currency',currency_value,'packageQuantity',package_qty,'unitsPerPackage',units_per_package),movement_id);
    result:=jsonb_set(result,'{stockMovementIds}',(result->'stockMovementIds')||jsonb_build_array(movement_id));
    start_at:=least(coalesce(start_at,occurred),occurred); end_at:=greatest(coalesce(end_at,occurred),occurred);
  end loop;
  for entry in select value from jsonb_array_elements(coalesce(p_selections->'payments','[]'::jsonb)) loop
    effect_key:=entry->>'paymentKey';
    if length(btrim(coalesce(effect_key,''))) not between 1 and 200 or (entry->>'amountMinor') !~ '^[1-9][0-9]*$'
      or (entry->>'currency') !~ '^[A-Z]{3}$' or entry->>'occurredAt' is null then raise exception 'Invalid receipt payment'; end if;
    if confirmed_currency is null or entry->>'currency' is distinct from confirmed_currency then raise exception 'Payment currency requires human confirmation matching source currency'; end if;
    occurred:=(entry->>'occurredAt')::timestamptz;
    if not private.inventory_period_is_open(p_organization_id,occurred) then raise exception 'PERIOD_CLOSED'; end if;
    start_at:=least(coalesce(start_at,occurred),occurred); end_at:=greatest(coalesce(end_at,occurred),occurred);
    cash_id:=null;
    if entry ? 'existingMovementId' then
      cash_id:=(entry->>'existingMovementId')::uuid;
      if not exists(select 1 from public.cash_movements c where c.organization_id=p_organization_id and c.id=cash_id and c.kind='purchase'
        and c.approval_status='approved' and c.amount_minor=-(entry->>'amountMinor')::bigint and c.currency=entry->>'currency'
        and c.occurred_at=occurred and (entry->>'accountId' is null or c.account_id=(entry->>'accountId')::uuid)) then raise exception 'Existing payment movement does not match receipt'; end if;
    else
      select a.currency into account_currency from public.accounts a where a.organization_id=p_organization_id and a.id=(entry->>'accountId')::uuid and a.active;
      if not found or account_currency<>entry->>'currency' then raise exception 'Payment account not found or currency mismatch'; end if;
      insert into public.cash_movements(organization_id,account_id,kind,amount_minor,currency,occurred_at,description,evidence_ref,evidence_file_id,created_by,approved_by,idempotency_key,approval_status,approval_reason)
        values(p_organization_id,(entry->>'accountId')::uuid,'purchase',-(entry->>'amountMinor')::bigint,entry->>'currency',occurred,'Supplier receipt payment',s.evidence_file_id::text,s.evidence_file_id,
          s.created_by,case when s.created_by is null or s.created_by<>actor then actor else null end,
          'purchase-receipt:'||p_receipt_id||':payment:'||effect_key,'approved',btrim(p_reason)) returning id into cash_id;
    end if;
    total_minor:=case when coalesce(draft->'totals'->>'totalMinor','') ~ '^[0-9]+$'
      then (draft->'totals'->>'totalMinor')::bigint else private.purchase_receipt_usd_minor(draft->'totals'->'rawAmounts'->>'total',confirmed_currency) end;
    if total_minor is null then raise exception 'Confirm a supported receipt total before approving payment'; end if;
    select coalesce(sum((e.effect_payload->>'amountMinor')::numeric),0) into paid_total from public.purchase_receipt_effects e
      where e.organization_id=p_organization_id and e.receipt_id=p_receipt_id and e.effect_type='payment';
    if paid_total+(entry->>'amountMinor')::numeric>total_minor then raise exception 'Payments exceed receipt total'; end if;
    insert into public.purchase_receipt_effects(organization_id,receipt_id,source_line_id,effect_type,effect_key,decision_id,effect_payload,cash_movement_id)
      values(p_organization_id,p_receipt_id,'payment:'||effect_key,'payment',effect_key,decision_id,entry,cash_id);
    result:=jsonb_set(result,'{cashMovementIds}',(result->'cashMovementIds')||jsonb_build_array(cash_id));
  end loop;
  update public.purchase_receipt_submissions set status=case when start_at is not null then 'projection_pending'
      when s.status='needs_review' then 'approved' else s.status end,updated_at=now()
    where organization_id=p_organization_id and id=p_receipt_id;
  if start_at is not null then
    replay_start:=start_at; replay_end:=coalesce(end_at,start_at+interval '1 second');
    if replay_end<=replay_start then replay_end:=replay_start+interval '1 second'; end if;
    if replay_end-replay_start>interval '370 days' then raise exception 'Receipt replay window exceeds supported limit'; end if;
    select coalesce(source_revision,0) into revision from private.square_worker_state where organization_id=p_organization_id;
    insert into private.durable_jobs(organization_id,requested_by,job_type,idempotency_key,payload)
      values(p_organization_id,actor,'projection.replay','purchase-receipt:'||p_receipt_id||':'||p_idempotency_key,
        jsonb_build_object('sourceRevision',coalesce(revision,0),'startAt',replay_start,'endAt',replay_end,'requestedBy',actor,'receiptId',p_receipt_id,'decisionId',decision_id))
      returning id into replay_id;
  end if;
  result:=result||jsonb_build_object('receiptId',p_receipt_id,'decisionId',decision_id,'projectionJobId',replay_id,
    'status',case when replay_id is null then (case when s.status='needs_review' then 'approved' else s.status end) else 'projection_pending' end);
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','approve','purchase_receipt',p_receipt_id,result,btrim(p_reason),'purchase-receipt:'||p_receipt_id::text);
  return result;
end $$;
