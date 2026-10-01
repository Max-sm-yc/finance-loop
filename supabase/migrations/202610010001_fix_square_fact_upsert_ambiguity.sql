-- The original upsert used PL/pgSQL variables named fact_kind/object_id/
-- object_version, which collide with the ON CONFLICT column lists and can
-- raise SQLSTATE 42702 at runtime. Keep local identifiers distinct.
create or replace function public.upsert_square_facts(
  p_organization_id uuid, p_facts jsonb, p_cause text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  v_fact_value jsonb;
  v_fact_kind text;
  v_object_id text;
  v_object_version text;
  v_sort_key text;
  v_current_sort text;
  v_current_version text;
  v_changed boolean := false;
  v_next_revision bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_organization_id is null or jsonb_typeof(p_facts) <> 'array'
     or jsonb_array_length(p_facts) > 1000 or length(btrim(coalesce(p_cause,''))) not between 1 and 300 then
    raise exception 'Invalid worker fact batch';
  end if;
  insert into private.square_worker_state (organization_id) values (p_organization_id) on conflict do nothing;
  perform 1 from private.square_worker_state s where s.organization_id = p_organization_id for update;

  for item in select elements.value from jsonb_array_elements(p_facts) as elements(value) loop
    v_fact_value := item->'fact';
    v_fact_kind := item->>'kind';
    v_object_id := item->>'objectId';
    v_object_version := item->>'version';
    v_sort_key := item->>'versionSort';
    if jsonb_typeof(v_fact_value) <> 'object'
       or v_fact_kind not in ('order','order_line','payment','refund','catalog','payout','payout_entry','gift_card_activity')
       or v_object_id is null or length(v_object_id) not between 1 and 300
       or v_object_version is null or length(v_object_version) not between 1 and 200
       or v_sort_key is null or length(v_sort_key) not between 1 and 220 then
      raise exception 'Invalid normalized Square fact';
    end if;
    insert into private.square_fact_versions
      (organization_id,fact_kind,object_id,object_version,version_sort,fact,cause)
    values (p_organization_id,v_fact_kind,v_object_id,v_object_version,v_sort_key,v_fact_value,p_cause)
    on conflict (organization_id,fact_kind,object_id,object_version) do nothing;
    if not found then
      if exists (select 1 from private.square_fact_versions v
          where v.organization_id=p_organization_id and v.fact_kind=v_fact_kind
            and v.object_id=v_object_id and v.object_version=v_object_version
            and (v.fact is distinct from v_fact_value or v.version_sort is distinct from v_sort_key)) then
        raise exception 'Square returned conflicting content for the same object version';
      end if;
    end if;

    select c.version_sort, c.object_version into v_current_sort, v_current_version
      from private.square_fact_current c
      where c.organization_id=p_organization_id and c.fact_kind=v_fact_kind and c.object_id=v_object_id;
    if v_current_version is null or v_sort_key collate "C" > v_current_sort collate "C" then
      insert into private.square_fact_current
        (organization_id,fact_kind,object_id,object_version,version_sort,source_revision)
      values (p_organization_id,v_fact_kind,v_object_id,v_object_version,v_sort_key,0)
      on conflict (organization_id,fact_kind,object_id) do update set
        object_version=excluded.object_version, version_sort=excluded.version_sort;
      v_changed := true;
    end if;
  end loop;

  if v_changed then
    update private.square_worker_state s set source_revision=s.source_revision+1, updated_at=now()
      where s.organization_id=p_organization_id returning s.source_revision into v_next_revision;
    update private.square_fact_current c set source_revision=v_next_revision
      where c.organization_id=p_organization_id;
  else
    select s.source_revision into v_next_revision from private.square_worker_state s where s.organization_id=p_organization_id;
  end if;
  return jsonb_build_object('changed',v_changed,'revision',v_next_revision);
end
$$;
