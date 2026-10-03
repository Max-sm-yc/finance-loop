-- Finance Loop creates sellable Square items through the authenticated owner
-- flow. Keep the provider's catalog fact, creation ticket, and approved COGS
-- definition linked by the same idempotency key.

alter table private.square_oauth_states
  add column requested_scopes text[] not null default array['ORDERS_READ','PAYMENTS_READ','ITEMS_READ','PAYOUTS_READ','MERCHANT_PROFILE_READ','GIFTCARDS_READ'];

create or replace function public.save_square_oauth_state(p_state_sha256 text,p_organization_id uuid,
  p_user_id uuid,p_redirect_uri text,p_expires_at timestamptz,p_scopes text[])
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_state_sha256 !~ '^[0-9a-f]{64}$' or p_expires_at<=now()
     or p_expires_at>now()+interval '15 minutes'
     or coalesce(cardinality(p_scopes),0)<1 or cardinality(p_scopes)>20
     or exists(select 1 from unnest(p_scopes) as requested(scope_name) where scope_name not in
       ('ORDERS_READ','PAYMENTS_READ','ITEMS_READ','PAYOUTS_READ','MERCHANT_PROFILE_READ','GIFTCARDS_READ','ITEMS_WRITE'))
     or (select count(distinct scope_name) from unnest(p_scopes) as requested(scope_name))<>cardinality(p_scopes) then
    raise exception 'Invalid OAuth state or requested scopes';
  end if;
  delete from private.square_oauth_states s where s.expires_at<=now();
  insert into private.square_oauth_states(state_sha256,organization_id,user_id,redirect_uri,expires_at,requested_scopes)
    values(p_state_sha256,p_organization_id,p_user_id,p_redirect_uri,p_expires_at,p_scopes);
  return true;
end
$$;

create or replace function public.consume_square_oauth_state(p_state_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved private.square_oauth_states%rowtype;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Service role required'; end if;
  delete from private.square_oauth_states s where s.state_sha256=p_state_sha256 returning s.* into saved;
  if saved.state_sha256 is null then return null; end if;
  return jsonb_build_object('organizationId',saved.organization_id,'userId',saved.user_id,
    'redirectUri',saved.redirect_uri,'expiresAt',saved.expires_at,'scopes',to_jsonb(saved.requested_scopes));
end
$$;

revoke all on function public.save_square_oauth_state(text,uuid,uuid,text,timestamptz,text[]) from public,anon,authenticated;
revoke all on function public.consume_square_oauth_state(text) from public,anon,authenticated;
grant execute on function public.save_square_oauth_state(text,uuid,uuid,text,timestamptz,text[]) to service_role;
grant execute on function public.consume_square_oauth_state(text) to service_role;

create table private.square_catalog_creation_tickets (
  organization_id uuid not null references public.organizations(id),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 8 and 200),
  request_payload jsonb not null check (jsonb_typeof(request_payload)='object'),
  square_item_id text not null,
  square_catalog_object_id text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id,idempotency_key),
  unique (organization_id,square_catalog_object_id)
);
revoke all on table private.square_catalog_creation_tickets from public,anon,authenticated;
create trigger square_catalog_creation_tickets_append_only before update or delete
  on private.square_catalog_creation_tickets for each row execute function private.reject_row_change();

create table private.square_catalog_item_requests (
  organization_id uuid not null references public.organizations(id),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 8 and 200),
  request_payload jsonb not null check (jsonb_typeof(request_payload)='object'),
  item_definition_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id,idempotency_key),
  foreign key (organization_id,item_definition_id)
    references public.item_definitions(organization_id,id)
);
revoke all on table private.square_catalog_item_requests from public,anon,authenticated;
create trigger square_catalog_item_requests_append_only before update or delete
  on private.square_catalog_item_requests for each row execute function private.reject_row_change();

create or replace function public.register_square_catalog_creation_ticket(
  p_organization_id uuid,p_idempotency_key text,p_square_item_id text,
  p_square_catalog_object_id text,p_name text,p_variation_name text,p_sku text,
  p_currency text,p_price_minor bigint
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  request_body jsonb;
  existing private.square_catalog_creation_tickets%rowtype;
  item_fact jsonb;
  variation_fact jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_organization_id is null or length(btrim(coalesce(p_idempotency_key,''))) not between 8 and 200
     or length(btrim(coalesce(p_square_item_id,''))) not between 1 and 200
     or length(btrim(coalesce(p_square_catalog_object_id,''))) not between 1 and 200
     or length(btrim(coalesce(p_name,''))) not between 1 and 200
     or length(btrim(coalesce(p_variation_name,''))) not between 1 and 200
     or (p_sku is not null and length(btrim(p_sku))>100)
     or p_currency is null or p_currency !~ '^[A-Z]{3}$' or p_price_minor is null or p_price_minor<0
     or p_price_minor>=1000000000000 then raise exception 'Invalid Square catalog creation ticket'; end if;

  request_body:=jsonb_build_object('squareItemId',btrim(p_square_item_id),
    'squareCatalogObjectId',btrim(p_square_catalog_object_id),'name',btrim(p_name),
    'variationName',btrim(p_variation_name),'sku',nullif(btrim(coalesce(p_sku,'')),''),
    'currency',p_currency,'priceMinor',p_price_minor);
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_idempotency_key,0));
  select * into existing from private.square_catalog_creation_tickets t
   where t.organization_id=p_organization_id and t.idempotency_key=p_idempotency_key;
  if found then
    if existing.request_payload is distinct from request_body then
      raise exception 'Square catalog idempotency key was used with different data';
    end if;
    return true;
  end if;

  select v.fact into variation_fact from private.square_fact_current c
   join private.square_fact_versions v using (organization_id,fact_kind,object_id,object_version)
   where c.organization_id=p_organization_id and c.fact_kind='catalog'
     and c.object_id=p_square_catalog_object_id and v.fact->>'objectType'='ITEM_VARIATION'
     and v.fact->>'itemId'=p_square_item_id and v.fact->>'name'=btrim(p_variation_name)
     and (v.fact->>'sku') is not distinct from nullif(btrim(coalesce(p_sku,'')),'');
  select v.fact into item_fact from private.square_fact_current c
   join private.square_fact_versions v using (organization_id,fact_kind,object_id,object_version)
   where c.organization_id=p_organization_id and c.fact_kind='catalog'
     and c.object_id=p_square_item_id and v.fact->>'objectType'='ITEM'
     and v.fact->>'name'=btrim(p_name);
  if variation_fact is null or item_fact is null then
    raise exception 'Square catalog facts are required before recording the item';
  end if;
  insert into private.square_catalog_creation_tickets(organization_id,idempotency_key,
    request_payload,square_item_id,square_catalog_object_id)
  values(p_organization_id,p_idempotency_key,request_body,p_square_item_id,p_square_catalog_object_id);
  return true;
end
$$;
revoke all on function public.register_square_catalog_creation_ticket(uuid,text,text,text,text,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.register_square_catalog_creation_ticket(uuid,text,text,text,text,text,text,text,bigint) to service_role;

create or replace function public.record_square_catalog_item(
  p_organization_id uuid,p_idempotency_key text,p_square_catalog_object_id text,
  p_name text,p_sku text,p_unit_cost_minor bigint,p_currency text,p_effective_from timestamptz,
  p_evidence_file_id uuid,p_reason text,p_square_price_minor bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  ticket private.square_catalog_creation_tickets%rowtype;
  old_request private.square_catalog_item_requests%rowtype;
  request_body jsonb;
  definition_id uuid;
  existing_version integer;
  evidence_reason text;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner']) then
    raise exception 'Organization owner role required';
  end if;
  if not exists(select 1 from public.organization_feature_flags f
      where f.organization_id=p_organization_id and f.inventory_tracking) then
    raise exception 'FEATURE_DISABLED: inventory_tracking';
  end if;
  if length(btrim(coalesce(p_idempotency_key,''))) not between 8 and 200
     or length(btrim(coalesce(p_square_catalog_object_id,''))) not between 1 and 200
     or length(btrim(coalesce(p_name,''))) not between 1 and 200
     or (p_sku is not null and length(btrim(p_sku)) not between 1 and 100)
     or p_unit_cost_minor is null or p_unit_cost_minor<0 or p_unit_cost_minor>=1000000000000
     or p_currency is null or p_currency !~ '^[A-Z]{3}$' or p_effective_from is null
     or p_evidence_file_id is null or p_square_price_minor is null or p_square_price_minor<0
     or p_square_price_minor>=1000000000000
     or length(btrim(coalesce(p_reason,''))) not between 10 and 1000
     or not exists(select 1 from public.evidence_files e where e.organization_id=p_organization_id and e.id=p_evidence_file_id) then
    raise exception 'Invalid Square catalog item cost approval';
  end if;

  request_body:=jsonb_build_object('squareCatalogObjectId',btrim(p_square_catalog_object_id),
    'name',btrim(p_name),'sku',nullif(btrim(coalesce(p_sku,'')),''),
    'unitCostMinor',p_unit_cost_minor,'currency',p_currency,'effectiveFrom',p_effective_from,
    'evidenceFileId',p_evidence_file_id,'reason',btrim(p_reason),'squarePriceMinor',p_square_price_minor);
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_idempotency_key,0));
  select * into old_request from private.square_catalog_item_requests r
   where r.organization_id=p_organization_id and r.idempotency_key=p_idempotency_key;
  if found then
    if old_request.request_payload is distinct from request_body then
      raise exception 'Square catalog item idempotency key was used with different data';
    end if;
    select d.version into existing_version from public.item_definitions d
     where d.organization_id=p_organization_id and d.id=old_request.item_definition_id;
    return jsonb_build_object('id',old_request.item_definition_id,'version',existing_version,
      'squareCatalogObjectId',p_square_catalog_object_id);
  end if;

  select * into ticket from private.square_catalog_creation_tickets t
   where t.organization_id=p_organization_id and t.idempotency_key=p_idempotency_key;
  if not found or ticket.square_catalog_object_id<>p_square_catalog_object_id then
    raise exception 'Square catalog creation ticket is required';
  end if;
  if ticket.request_payload->>'name' is distinct from btrim(p_name)
     or ticket.request_payload->>'sku' is distinct from nullif(btrim(coalesce(p_sku,'')),'')
     or ticket.request_payload->>'currency' is distinct from p_currency
     or (ticket.request_payload->>'priceMinor')::bigint is distinct from p_square_price_minor then
    raise exception 'Finance Loop item fields must match the created Square catalog item';
  end if;
  if exists(select 1 from public.item_definitions d where d.organization_id=p_organization_id
      and d.square_catalog_object_id=p_square_catalog_object_id) then
    raise exception 'Square catalog item already has a Finance Loop cost definition';
  end if;

  evidence_reason:='Supplier evidence file '||p_evidence_file_id::text||'. '||btrim(p_reason);
  insert into public.item_definitions(organization_id,square_catalog_object_id,sku,name,
    unit_cost_minor,currency,effective_from,effective_until,approved_by,approved_at,version,approval_reason)
  values(p_organization_id,p_square_catalog_object_id,nullif(btrim(coalesce(p_sku,'')),''),
    btrim(p_name),p_unit_cost_minor,p_currency,p_effective_from,null,actor,now(),1,evidence_reason)
  returning id into definition_id;

  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,
    entity_id,after_state,reason,correlation_id)
  values(p_organization_id,actor,'human','create','square_catalog_item',definition_id,
    jsonb_build_object('squareItemId',ticket.square_item_id,
      'squareCatalogObjectId',p_square_catalog_object_id,'name',btrim(p_name),
      'sku',nullif(btrim(coalesce(p_sku,'')),''),'currency',p_currency,
      'squarePriceMinor',p_square_price_minor,'unitCostMinor',p_unit_cost_minor,
      'effectiveFrom',p_effective_from,'evidenceFileId',p_evidence_file_id,
      'itemDefinitionId',definition_id),
    evidence_reason,'square-catalog-item:'||p_idempotency_key);
  insert into private.square_catalog_item_requests(organization_id,idempotency_key,request_payload,item_definition_id)
  values(p_organization_id,p_idempotency_key,request_body,definition_id);
  return jsonb_build_object('id',definition_id,'version',1,
    'squareItemId',ticket.square_item_id,'squareCatalogObjectId',p_square_catalog_object_id);
end
$$;
revoke all on function public.record_square_catalog_item(uuid,text,text,text,text,bigint,text,timestamptz,uuid,text,bigint) from public,anon;
grant execute on function public.record_square_catalog_item(uuid,text,text,text,text,bigint,text,timestamptz,uuid,text,bigint) to authenticated;

-- The OAuth connection now includes ITEMS_WRITE as well as the existing read
-- permissions, so avoid recording a misleading "read-only" audit statement.
create or replace function public.store_square_tokens(p_record jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_record->>'organizationId' is null or p_record->>'merchantId' is null
     or p_record->>'connectedBy' is null or p_record->>'accessCiphertext' is null
     or p_record->>'refreshCiphertext' is null or p_record->>'accessNonce' is null
     or p_record->>'refreshNonce' is null or p_record->>'accessTag' is null
     or p_record->>'refreshTag' is null then raise exception 'Encrypted token fields required'; end if;
  insert into private.square_merchant_connections (organization_id, square_merchant_id, active,
    connected_by, access_ciphertext, access_nonce, access_tag, refresh_ciphertext,
    refresh_nonce, refresh_tag, expires_at, scopes, token_type, updated_at)
  values ((p_record->>'organizationId')::uuid, p_record->>'merchantId', true,
    (p_record->>'connectedBy')::uuid, p_record->>'accessCiphertext', p_record->>'accessNonce',
    p_record->>'accessTag', p_record->>'refreshCiphertext', p_record->>'refreshNonce',
    p_record->>'refreshTag', (p_record->>'expiresAt')::timestamptz,
    array(select jsonb_array_elements_text(p_record->'scopes')), p_record->>'tokenType', now())
  on conflict (organization_id, square_merchant_id) do update set active = true,
    connected_by = excluded.connected_by, access_ciphertext = excluded.access_ciphertext,
    access_nonce = excluded.access_nonce, access_tag = excluded.access_tag,
    refresh_ciphertext = excluded.refresh_ciphertext, refresh_nonce = excluded.refresh_nonce,
    refresh_tag = excluded.refresh_tag, expires_at = excluded.expires_at,
    scopes = excluded.scopes, token_type = excluded.token_type, updated_at = now();
  insert into public.audit_events (organization_id, actor_user_id, actor_kind, action, entity_type,
    before_state, after_state, reason, correlation_id)
  values ((p_record->>'organizationId')::uuid, (p_record->>'connectedBy')::uuid, 'human', 'connect',
    'square_connection', null,
    jsonb_build_object('merchantId', p_record->>'merchantId', 'scopes', p_record->'scopes', 'expiresAt', p_record->>'expiresAt'),
    'Square OAuth connection stored with encrypted credentials and scoped permissions', gen_random_uuid()::text);
  return true;
end
$$;
