-- The inventory OAuth flow adds inventory scopes to the standard read grant.
-- Keep the durable OAuth-state validator in step with the scopes requested by
-- the application so state can be saved before redirecting the owner to Square.
alter table private.square_oauth_states
  alter column requested_scopes set default array[
    'ORDERS_READ', 'PAYMENTS_READ', 'ITEMS_READ', 'INVENTORY_READ',
    'PAYOUTS_READ', 'MERCHANT_PROFILE_READ', 'GIFTCARDS_READ'
  ];

create or replace function public.save_square_oauth_state(
  p_state_sha256 text,
  p_organization_id uuid,
  p_user_id uuid,
  p_redirect_uri text,
  p_expires_at timestamptz,
  p_scopes text[]
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_state_sha256 !~ '^[0-9a-f]{64}$'
     or p_expires_at <= now()
     or p_expires_at > now() + interval '15 minutes'
     or coalesce(cardinality(p_scopes), 0) < 1
     or cardinality(p_scopes) > 20
     or exists (
       select 1
       from unnest(p_scopes) as requested(scope_name)
       where requested.scope_name not in (
         'ORDERS_READ', 'PAYMENTS_READ', 'ITEMS_READ', 'INVENTORY_READ',
         'PAYOUTS_READ', 'MERCHANT_PROFILE_READ', 'GIFTCARDS_READ',
         'ITEMS_WRITE', 'INVENTORY_WRITE'
       )
     )
     or (select count(distinct scope_name) from unnest(p_scopes) as requested(scope_name)) <> cardinality(p_scopes) then
    raise exception 'Invalid OAuth state or requested scopes';
  end if;

  delete from private.square_oauth_states s where s.expires_at <= now();
  insert into private.square_oauth_states
    (state_sha256, organization_id, user_id, redirect_uri, expires_at, requested_scopes)
  values
    (p_state_sha256, p_organization_id, p_user_id, p_redirect_uri, p_expires_at, p_scopes);
  return true;
end
$$;
