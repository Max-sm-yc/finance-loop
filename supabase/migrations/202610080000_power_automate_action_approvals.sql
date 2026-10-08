-- Power Automate approval credentials are owner-managed and bound to one
-- active Teams identity. The flow may relay a decision, but the existing
-- approval state machine remains the authority for every decision.

create table private.power_automate_approval_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mapping_id uuid not null,
  reviewer_user_id uuid not null,
  display_name text not null check (length(btrim(display_name)) between 1 and 100),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  revoked_by uuid references auth.users(id),
  revoked_at timestamptz,
  unique (organization_id,id),
  foreign key (organization_id,mapping_id) references public.external_identity_mappings(organization_id,id),
  foreign key (organization_id,reviewer_user_id) references public.memberships(organization_id,user_id),
  check ((revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_by is not null))
);
create unique index power_automate_approval_one_active_mapping
  on private.power_automate_approval_integrations(organization_id,mapping_id) where revoked_at is null;
revoke all on private.power_automate_approval_integrations from public,anon,authenticated,service_role;

create or replace function private.revoke_power_automate_approval_on_identity_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  integration record;
  actor uuid := (select auth.uid());
begin
  if old.status='active' and (new.status<>'active' or new.user_id is distinct from old.user_id) then
    for integration in select i.id,i.organization_id,i.created_by
      from private.power_automate_approval_integrations i
      where i.organization_id=old.organization_id and i.mapping_id=old.id and i.revoked_at is null
    loop
      update private.power_automate_approval_integrations set revoked_by=coalesce(actor,integration.created_by),revoked_at=now()
        where organization_id=integration.organization_id and id=integration.id and revoked_at is null;
      insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,
          before_state,after_state,reason,correlation_id)
        values(integration.organization_id,actor,case when actor is null then 'system' else 'human' end,
          'revoke','power_automate_approval_integration',integration.id,
          jsonb_build_object('mappingId',old.id,'status','active'),jsonb_build_object('mappingId',old.id,'status','revoked'),
          'Teams identity was unlinked or remapped',
          'teams-identity-revoke:'||old.id::text||':'||integration.id::text);
    end loop;
  end if;
  return new;
end
$$;
revoke all on function private.revoke_power_automate_approval_on_identity_change() from public,anon,authenticated,service_role;
create trigger revoke_power_automate_approval_on_identity_change
  after update of status,user_id on public.external_identity_mappings
  for each row execute function private.revoke_power_automate_approval_on_identity_change();

create table private.power_automate_approval_deliveries (
  integration_id uuid not null,
  organization_id uuid not null,
  proposal_id uuid not null,
  claimed_at timestamptz not null default now(),
  lease_until timestamptz not null,
  released_at timestamptz,
  completed_at timestamptz,
  primary key (integration_id,proposal_id),
  foreign key (organization_id,integration_id)
    references private.power_automate_approval_integrations(organization_id,id) on delete cascade,
  foreign key (organization_id,proposal_id)
    references public.action_proposals(organization_id,id) on delete cascade
);
create index power_automate_approval_delivery_claims
  on private.power_automate_approval_deliveries(integration_id,lease_until) where completed_at is null;
revoke all on private.power_automate_approval_deliveries from public,anon,authenticated,service_role;

create or replace function public.register_power_automate_approval_integration(
  p_organization_id uuid,p_mapping_id uuid,p_name text,p_token_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  mapping public.external_identity_mappings%rowtype;
  integration_id uuid;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner']) then
    raise exception 'Organization owner role required';
  end if;
  if p_mapping_id is null or length(btrim(coalesce(p_name,''))) not between 1 and 100
      or coalesce(p_token_sha256,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid Power Automate approval integration';
  end if;
  select * into mapping from public.external_identity_mappings x
    where x.organization_id=p_organization_id and x.id=p_mapping_id and x.provider='microsoft_teams' and x.status='active';
  if not found or mapping.external_email is null then
    raise exception 'Active Teams identity with directory email required';
  end if;
  insert into private.power_automate_approval_integrations(
    organization_id,mapping_id,reviewer_user_id,display_name,token_sha256,created_by
  ) values (p_organization_id,p_mapping_id,mapping.user_id,btrim(p_name),p_token_sha256,actor)
  returning id into integration_id;
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','create','power_automate_approval_integration',integration_id,
      jsonb_build_object('name',btrim(p_name),'mappingId',mapping.id,'reviewerUserId',mapping.user_id),
      'Created Power Automate approval integration','power-automate-approval-integration:'||integration_id::text);
  return jsonb_build_object('id',integration_id,'name',btrim(p_name),'createdAt',now());
end
$$;

create or replace function public.list_power_automate_approval_integrations(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); rows jsonb;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner']) then
    raise exception 'Organization owner role required';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',i.id,'name',i.display_name,'mappingId',i.mapping_id,'userId',i.reviewer_user_id,
    'email',x.external_email,'tenantId',x.tenant_id,'teamsUserId',x.external_user_id,
    'createdAt',i.created_at,'revokedAt',i.revoked_at
  ) order by i.created_at desc),'[]'::jsonb) into rows
  from private.power_automate_approval_integrations i
  join public.external_identity_mappings x on x.organization_id=i.organization_id and x.id=i.mapping_id
  where i.organization_id=p_organization_id;
  return rows;
end
$$;

create or replace function public.revoke_power_automate_approval_integration(
  p_organization_id uuid,p_integration_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid());
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner']) then
    raise exception 'Organization owner role required';
  end if;
  update private.power_automate_approval_integrations set revoked_by=actor,revoked_at=now()
    where organization_id=p_organization_id and id=p_integration_id and revoked_at is null;
  if not found and not exists(select 1 from private.power_automate_approval_integrations
      where organization_id=p_organization_id and id=p_integration_id and revoked_at is not null) then
    raise exception 'Power Automate approval integration not found';
  end if;
  if found then
    insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,after_state,reason,correlation_id)
      values(p_organization_id,actor,'human','revoke','power_automate_approval_integration',p_integration_id,
        jsonb_build_object('revokedAt',now()),'Revoked Power Automate approval integration',
        'power-automate-approval-integration:'||p_integration_id::text);
  end if;
end
$$;

create or replace function public.authorize_power_automate_approval_integration(p_token_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' or coalesce(p_token_sha256,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'Service role required';
  end if;
  select jsonb_build_object(
    'organizationId',i.organization_id,'integrationId',i.id,'mappingId',i.mapping_id,
    'reviewerUserId',i.reviewer_user_id,'tenantId',x.tenant_id,'teamsUserId',x.external_user_id,
    'email',x.external_email
  ) into result
  from private.power_automate_approval_integrations i
  join public.external_identity_mappings x on x.organization_id=i.organization_id and x.id=i.mapping_id
  where i.token_sha256=p_token_sha256 and i.revoked_at is null and x.status='active'
    and x.user_id=i.reviewer_user_id and x.external_email is not null
    and exists(select 1 from public.memberships m where m.organization_id=i.organization_id and m.user_id=i.reviewer_user_id);
  return result;
end
$$;

create or replace function public.claim_power_automate_action_proposal(p_integration_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  integration record;
  proposal public.action_proposals%rowtype;
  active_proposal_id uuid;
  organization_name text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  select i.organization_id,i.id,i.mapping_id,i.reviewer_user_id,x.tenant_id,x.external_user_id,x.external_email
    into integration
  from private.power_automate_approval_integrations i
  join public.external_identity_mappings x on x.organization_id=i.organization_id and x.id=i.mapping_id
  where i.id=p_integration_id and i.revoked_at is null and x.status='active'
    and x.user_id=i.reviewer_user_id and x.external_email is not null;
  if not found then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended(integration.id::text,0));
  perform set_config('request.jwt.claim.sub',integration.reviewer_user_id::text,true);
  -- Keep one in-flight card per reviewer. The lease accommodates a long-lived
  -- Power Automate wait action and is reset on connector failure via release.
  -- Returning an existing claim makes a retried GET safe if its first response
  -- was lost after the claim committed.
  update private.power_automate_approval_deliveries d set completed_at=coalesce(d.completed_at,now())
    from public.action_proposals p
    where d.integration_id=integration.id and d.proposal_id=p.id and d.organization_id=p.organization_id
      and d.completed_at is null and (p.status<>'pending_approval' or p.expires_at<=now());
  select d.proposal_id into active_proposal_id
  from private.power_automate_approval_deliveries d
  join public.action_proposals p on p.organization_id=d.organization_id and p.id=d.proposal_id
  where d.integration_id=integration.id and d.completed_at is null and d.lease_until>now()
    and p.status='pending_approval' and p.expires_at>now()
    and p.proposed_by<>integration.reviewer_user_id
    and private.has_org_permission(p.organization_id,'approvals.read',p.location_id)
    and private.has_org_permission(p.organization_id,'approvals.decide',p.location_id)
  order by d.claimed_at asc
  for update of d,p skip locked limit 1;
  if found then
    select * into proposal from public.action_proposals p
      where p.organization_id=integration.organization_id and p.id=active_proposal_id;
  else
    select p.* into proposal
    from public.action_proposals p
    left join private.power_automate_approval_deliveries d
      on d.integration_id=integration.id and d.proposal_id=p.id
    where p.organization_id=integration.organization_id and p.status='pending_approval' and p.expires_at>now()
      and p.proposed_by<>integration.reviewer_user_id
      and (d.integration_id is null or (d.completed_at is null and d.lease_until<=now()))
      and private.has_org_permission(p.organization_id,'approvals.read',p.location_id)
      and private.has_org_permission(p.organization_id,'approvals.decide',p.location_id)
    order by p.created_at asc,p.id asc
    for update of p skip locked limit 1;
    if not found then return null; end if;

    insert into private.power_automate_approval_deliveries(integration_id,organization_id,proposal_id,claimed_at,lease_until)
      values(integration.id,integration.organization_id,proposal.id,now(),now()+interval '29 days')
    on conflict(integration_id,proposal_id) do update
      set claimed_at=now(),lease_until=now()+interval '29 days',released_at=null
      where private.power_automate_approval_deliveries.completed_at is null
        and private.power_automate_approval_deliveries.lease_until<=now();
    if not found then return null; end if;
  end if;
  select o.name into organization_name from public.organizations o where o.id=proposal.organization_id;
  return jsonb_build_object(
    'recipientEmail',integration.external_email,
    'expectedResponder',jsonb_build_object('tenantId',integration.tenant_id,'teamsUserId',integration.external_user_id),
    'proposal',jsonb_build_object(
      'id',proposal.id,'organizationId',proposal.organization_id,'organizationName',organization_name,
      'actionType',proposal.action_type,'status',proposal.status,'payload',proposal.payload,
      'payloadSha256',proposal.payload_sha256,'locationId',proposal.location_id,
      'amountMinor',proposal.amount_minor,'currency',proposal.currency,'evidenceRefs',proposal.evidence_refs,
      'createdAt',proposal.created_at,'expiresAt',proposal.expires_at
    )
  );
end
$$;

create or replace function public.release_power_automate_action_proposal(
  p_integration_id uuid,p_proposal_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  update private.power_automate_approval_deliveries d set lease_until=now(),released_at=now()
    from private.power_automate_approval_integrations i
    where d.integration_id=p_integration_id and d.proposal_id=p_proposal_id and d.completed_at is null
      and i.id=d.integration_id and i.revoked_at is null;
  return found;
end
$$;

create or replace function public.decide_action_from_power_automate(
  p_integration_id uuid,p_organization_id uuid,p_proposal_id uuid,
  p_responder_tenant_id uuid,p_responder_teams_user_id uuid,
  p_decision text,p_reason text,p_expected_payload_sha256 text,p_idempotency_key text,p_source_message_ref text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare integration record; result jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  select i.organization_id,i.id,i.mapping_id,i.reviewer_user_id,x.tenant_id,x.external_user_id
    into integration
  from private.power_automate_approval_integrations i
  join public.external_identity_mappings x on x.organization_id=i.organization_id and x.id=i.mapping_id
  where i.id=p_integration_id and i.organization_id=p_organization_id and i.revoked_at is null
    and x.status='active' and x.user_id=i.reviewer_user_id;
  if not found or integration.tenant_id<>p_responder_tenant_id or integration.external_user_id<>p_responder_teams_user_id then
    return jsonb_build_object('status','unauthorized');
  end if;
  if not exists(select 1 from private.power_automate_approval_deliveries d
      where d.integration_id=p_integration_id and d.organization_id=p_organization_id and d.proposal_id=p_proposal_id) then
    return jsonb_build_object('status','not_found');
  end if;
  select public.decide_action_from_teams(
    p_organization_id,p_proposal_id,p_responder_tenant_id,p_responder_teams_user_id,
    p_decision,p_reason,p_expected_payload_sha256,p_idempotency_key,p_source_message_ref
  ) into result;
  if coalesce(result->>'status','') not in ('decision_not_applied','unauthorized','not_found') then
    update private.power_automate_approval_deliveries set completed_at=coalesce(completed_at,now())
      where integration_id=p_integration_id and proposal_id=p_proposal_id;
  end if;
  return result;
end
$$;

revoke all on function public.register_power_automate_approval_integration(uuid,uuid,text,text) from public,anon;
revoke all on function public.list_power_automate_approval_integrations(uuid) from public,anon;
revoke all on function public.revoke_power_automate_approval_integration(uuid,uuid) from public,anon;
revoke all on function public.authorize_power_automate_approval_integration(text) from public,anon,authenticated;
revoke all on function public.claim_power_automate_action_proposal(uuid) from public,anon,authenticated;
revoke all on function public.release_power_automate_action_proposal(uuid,uuid) from public,anon,authenticated;
revoke all on function public.decide_action_from_power_automate(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.register_power_automate_approval_integration(uuid,uuid,text,text) to authenticated;
grant execute on function public.list_power_automate_approval_integrations(uuid) to authenticated;
grant execute on function public.revoke_power_automate_approval_integration(uuid,uuid) to authenticated;
grant execute on function public.authorize_power_automate_approval_integration(text) to service_role;
grant execute on function public.claim_power_automate_action_proposal(uuid) to service_role;
grant execute on function public.release_power_automate_action_proposal(uuid,uuid) to service_role;
grant execute on function public.decide_action_from_power_automate(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) to service_role;
