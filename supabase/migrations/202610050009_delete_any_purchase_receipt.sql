-- Inbox deletion is a tombstone so evidence, review decisions, posted effects,
-- durable jobs, and audit history remain available for accounting traceability.
alter table public.purchase_receipt_submissions
  drop constraint purchase_receipt_deletion_check;

alter table public.purchase_receipt_submissions
  add constraint purchase_receipt_deletion_check
  check ((deleted_at is null and deleted_by is null)
    or (deleted_at is not null and deleted_by is not null));

create or replace function public.delete_purchase_receipt(p_organization_id uuid,p_receipt_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  s public.purchase_receipt_submissions%rowtype;
  evidence_hash text;
  decision_count bigint;
  effect_count bigint;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner','reviewer']) then
    raise exception 'Organization owner or reviewer role required';
  end if;
  select * into s from public.purchase_receipt_submissions
    where organization_id=p_organization_id and id=p_receipt_id for update;
  if not found then raise exception 'Receipt not found'; end if;
  if s.deleted_at is not null then return jsonb_build_object('receiptId',p_receipt_id,'deleted',true); end if;

  if s.evidence_file_id is not null then
    select sha256_hex into evidence_hash from public.evidence_files
      where organization_id=p_organization_id and id=s.evidence_file_id;
  end if;
  if evidence_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':purchase-receipt-sha:'||evidence_hash,0));
  end if;
  select count(*) into decision_count from public.purchase_receipt_decisions
    where organization_id=p_organization_id and receipt_id=p_receipt_id;
  select count(*) into effect_count from public.purchase_receipt_effects
    where organization_id=p_organization_id and receipt_id=p_receipt_id;

  update public.purchase_receipt_submissions set deleted_at=now(),deleted_by=actor,updated_at=now()
    where organization_id=p_organization_id and id=p_receipt_id;
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','delete','purchase_receipt',p_receipt_id,
      jsonb_build_object('status',s.status,'lastErrorCode',s.last_error_code,'evidenceFileId',s.evidence_file_id,
        'activeDraftVersion',s.active_draft_version,'decisionCount',decision_count,'effectCount',effect_count),
      jsonb_build_object('deleted',true),'Removed receipt from the inbox; retained source and accounting history',
      'purchase-receipt:'||p_receipt_id::text);
  return jsonb_build_object('receiptId',p_receipt_id,'deleted',true);
end $$;

revoke all on function public.delete_purchase_receipt(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.delete_purchase_receipt(uuid,uuid) to authenticated;
