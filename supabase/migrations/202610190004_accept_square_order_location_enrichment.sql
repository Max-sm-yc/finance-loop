-- Square can return an order without location_id and later include it without
-- changing the provider order version. Preserve the original fact and append
-- a distinct normalized enrichment version only for null-to-known locationId.
-- All other same-version content conflicts remain rejected.
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
  v_existing_sort text;
  v_existing_fact jsonb;
  v_conflicting_fields text;
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
    v_conflicting_fields := null;
    v_existing_fact := null;
    v_existing_sort := null;
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
      select stored.fact, stored.version_sort
        into v_existing_fact, v_existing_sort
        from private.square_fact_versions stored
        where stored.organization_id = p_organization_id
          and stored.fact_kind = v_fact_kind
          and stored.object_id = v_object_id
          and stored.object_version = v_object_version;
      if v_existing_fact is distinct from v_fact_value or v_existing_sort is distinct from v_sort_key then
        select string_agg(keys.key, ',' order by keys.key)
          into v_conflicting_fields
          from (
            select jsonb_object_keys(v_existing_fact) as key
            union
            select jsonb_object_keys(v_fact_value) as key
          ) keys
          where (v_existing_fact -> keys.key) is distinct from (v_fact_value -> keys.key);
        if v_existing_sort is distinct from v_sort_key then
          v_conflicting_fields := concat_ws(',', nullif(v_conflicting_fields, ''), 'version_sort');
        end if;

        if v_fact_kind = 'order'
           and v_conflicting_fields = 'locationId'
           and v_existing_fact->'locationId' = 'null'::jsonb
           and jsonb_typeof(v_fact_value->'locationId') = 'string'
           and length(btrim(v_fact_value->>'locationId')) between 1 and 200
           and length(v_object_version || '|location-enrichment-1') <= 200
           and length(v_sort_key || '|location-enrichment-1') <= 220 then
          v_object_version := v_object_version || '|location-enrichment-1';
          v_sort_key := v_sort_key || '|location-enrichment-1';
          insert into private.square_fact_versions
            (organization_id,fact_kind,object_id,object_version,version_sort,fact,cause)
          values (p_organization_id,v_fact_kind,v_object_id,v_object_version,v_sort_key,v_fact_value,p_cause)
          on conflict (organization_id,fact_kind,object_id,object_version) do nothing;
          if not found then
            select stored.fact, stored.version_sort
              into v_existing_fact, v_existing_sort
              from private.square_fact_versions stored
              where stored.organization_id = p_organization_id
                and stored.fact_kind = v_fact_kind
                and stored.object_id = v_object_id
                and stored.object_version = v_object_version;
            if v_existing_fact is distinct from v_fact_value or v_existing_sort is distinct from v_sort_key then
              select string_agg(keys.key, ',' order by keys.key)
                into v_conflicting_fields
                from (
                  select jsonb_object_keys(v_existing_fact) as key
                  union
                  select jsonb_object_keys(v_fact_value) as key
                ) keys
                where (v_existing_fact -> keys.key) is distinct from (v_fact_value -> keys.key);
              if v_existing_sort is distinct from v_sort_key then
                v_conflicting_fields := concat_ws(',', nullif(v_conflicting_fields, ''), 'version_sort');
              end if;
            else
              v_conflicting_fields := null;
            end if;
          else
            v_conflicting_fields := null;
          end if;
        end if;

        if v_conflicting_fields is not null then
          raise exception using
            errcode = 'P0001',
            message = 'Square returned conflicting content for the same object version',
            detail = format(
              'fact_kind=%s; object_key_sha256=%s; version_key_sha256=%s; differing_fields=%s; stored_fact_sha256=%s; incoming_fact_sha256=%s',
              v_fact_kind,
              substr(private.sha256_hex(v_object_id), 1, 20),
              substr(private.sha256_hex(v_object_version), 1, 20),
              coalesce(nullif(v_conflicting_fields, ''), 'unknown'),
              case when v_existing_fact is null then 'missing' else private.sha256_hex(v_existing_fact::text) end,
              private.sha256_hex(v_fact_value::text)
            );
        end if;
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
