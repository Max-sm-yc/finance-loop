-- Secure Teams approval access through Bot Connector-authenticated identities
-- and the existing Vernius membership, role, location, and approval policies.

create unique index audit_events_teams_attempt_once on public.audit_events(organization_id,source_message_ref)
  where action='teams_decision_not_applied' and source_message_ref is not null;

create or replace function public.list_teams_action_proposals(
  p_tenant_id uuid,p_teams_user_id uuid,p_limit integer default 3
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare mapping record; proposal record; result jsonb:='[]'::jsonb; remaining integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if p_tenant_id is null or p_teams_user_id is null or p_limit not between 1 and 3 then raise exception 'Invalid Teams approval query'; end if;
  for mapping in
    select x.organization_id,x.user_id from public.external_identity_mappings x
      where x.provider='microsoft_teams' and x.tenant_id=p_tenant_id and x.external_user_id=p_teams_user_id and x.status='active'
      order by x.organization_id limit 100
  loop
    if jsonb_array_length(result)>=p_limit then exit; end if;
    perform set_config('request.jwt.claim.sub',mapping.user_id::text,true);
    remaining:=p_limit-jsonb_array_length(result);
    for proposal in
      select p.id,p.organization_id,o.name organization_name,p.action_type,p.status,p.payload,p.payload_sha256,
        p.location_id,p.amount_minor,p.currency,p.created_at,p.expires_at
      from public.action_proposals p join public.organizations o on o.id=p.organization_id
      where p.organization_id=mapping.organization_id and p.status='pending_approval' and p.expires_at>now()
        and p.proposed_by<>mapping.user_id
        and private.has_org_permission(p.organization_id,'approvals.read',p.location_id)
      order by p.created_at asc,p.id asc limit remaining
    loop
      result:=result||jsonb_build_array(jsonb_build_object(
        'id',proposal.id,'organization_id',proposal.organization_id,'organization_name',proposal.organization_name,
        'action_type',proposal.action_type,'status',proposal.status,'payload',proposal.payload,
        'payload_sha256',proposal.payload_sha256,'location_id',proposal.location_id,
        'amount_minor',proposal.amount_minor,'currency',proposal.currency,
        'created_at',proposal.created_at,'expires_at',proposal.expires_at));
    end loop;
  end loop;
  return result;
end
$$;

create or replace function public.decide_action_from_teams(
  p_organization_id uuid,p_proposal_id uuid,p_tenant_id uuid,p_teams_user_id uuid,
  p_decision text,p_reason text,p_expected_payload_sha256 text,p_idempotency_key text,p_source_message_ref text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid; prior_decision uuid; current_proposal public.action_proposals%rowtype; result jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if p_organization_id is null or p_proposal_id is null or p_tenant_id is null or p_teams_user_id is null
      or p_decision not in ('approved','rejected') or length(btrim(coalesce(p_reason,''))) not between 10 and 1000
      or coalesce(p_expected_payload_sha256,'') !~ '^[0-9a-f]{64}$'
      or length(btrim(coalesce(p_idempotency_key,''))) not between 8 and 200
      or length(btrim(coalesce(p_source_message_ref,''))) not between 1 and 300 then
    raise exception 'Invalid Teams approval decision';
  end if;
  select x.user_id into actor from public.external_identity_mappings x
    where x.organization_id=p_organization_id and x.provider='microsoft_teams' and x.tenant_id=p_tenant_id
      and x.external_user_id=p_teams_user_id and x.status='active' for update;
  if actor is null then return jsonb_build_object('status','unauthorized'); end if;

  -- Only this service-role RPC can translate the Bot Connector-verified AAD
  -- identity into the auth.uid() consumed by the existing approval state machine.
  perform set_config('request.jwt.claim.sub',actor::text,true);
  select d.id into prior_decision from public.action_approval_decisions d
    where d.organization_id=p_organization_id and d.idempotency_key=p_idempotency_key;
  if prior_decision is null then
    select * into current_proposal from public.action_proposals p
      where p.organization_id=p_organization_id and p.id=p_proposal_id;
    if not found then return jsonb_build_object('status','not_found'); end if;
    if not private.has_org_permission(p_organization_id,'approvals.decide',current_proposal.location_id) then
      insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,
        before_state,after_state,reason,correlation_id,source_message_ref,execution_status,outcome_code)
        values(p_organization_id,actor,'human','teams_decision_not_applied','action_proposal',p_proposal_id,
          jsonb_build_object('status',current_proposal.status),jsonb_build_object('status',current_proposal.status),btrim(p_reason),
          'proposal:'||p_proposal_id::text,p_source_message_ref,'failed','APPROVAL_PERMISSION_REQUIRED') on conflict do nothing;
      return jsonb_build_object('status','unauthorized');
    end if;
    if current_proposal.status<>'pending_approval' then
      insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,
        before_state,after_state,reason,correlation_id,source_message_ref,execution_status,outcome_code)
        values(p_organization_id,actor,'human','teams_decision_not_applied','action_proposal',p_proposal_id,
          jsonb_build_object('status',current_proposal.status),jsonb_build_object('status',current_proposal.status),btrim(p_reason),
          'proposal:'||p_proposal_id::text,p_source_message_ref,'failed','PROPOSAL_NOT_PENDING') on conflict do nothing;
      return jsonb_build_object('status','not_pending','currentStatus',current_proposal.status);
    end if;
  end if;
  begin
    select public.decide_action(p_organization_id,p_proposal_id,p_decision,p_reason,
      p_expected_payload_sha256,p_idempotency_key) into result;
  exception when raise_exception or unique_violation then
    if prior_decision is null then
      insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,
        before_state,after_state,reason,correlation_id,source_message_ref,execution_status,outcome_code)
        values(p_organization_id,actor,'human','teams_decision_not_applied','action_proposal',p_proposal_id,
          jsonb_build_object('status',current_proposal.status),jsonb_build_object('status',current_proposal.status),btrim(p_reason),
          'proposal:'||p_proposal_id::text,p_source_message_ref,'failed','APPROVAL_DECISION_NOT_APPLIED') on conflict do nothing;
    end if;
    return jsonb_build_object('status','decision_not_applied');
  end;
  if prior_decision is null then
    insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,
      before_state,after_state,reason,correlation_id,source_message_ref,execution_status,outcome_code)
      values(p_organization_id,actor,'human',
        case result->>'status' when 'conflicted' then 'teams_decision_not_applied' when 'expired' then 'teams_decision_not_applied' else 'teams_'||p_decision end,
        'action_proposal',p_proposal_id,
        jsonb_build_object('status','pending_approval'),
        jsonb_build_object('status',result->>'status','channel','msteams'),btrim(p_reason),
        'proposal:'||p_proposal_id::text,p_source_message_ref,
        case when result->>'status' in ('conflicted','expired') then 'failed' else 'succeeded' end,
        case result->>'status' when 'conflicted' then 'SOURCE_VERSION_CONFLICT' when 'expired' then 'PROPOSAL_EXPIRED' else null end)
      on conflict do nothing;
  end if;
  return result;
end
$$;

revoke all on function public.list_teams_action_proposals(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.decide_action_from_teams(uuid,uuid,uuid,uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.list_teams_action_proposals(uuid,uuid,integer) to service_role;
grant execute on function public.decide_action_from_teams(uuid,uuid,uuid,uuid,text,text,text,text,text) to service_role;
