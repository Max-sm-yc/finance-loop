-- Inbox deletion is an audited tombstone: financial evidence/history remains intact.
alter table public.purchase_receipt_submissions add column deleted_at timestamptz;
alter table public.purchase_receipt_submissions add column deleted_by uuid references auth.users(id);
alter table public.purchase_receipt_submissions add constraint purchase_receipt_deletion_check
  check ((deleted_at is null and deleted_by is null)
    or (deleted_at is not null and deleted_by is not null and status='failed' and active_draft_version is null));

alter policy purchase_receipt_submission_read on public.purchase_receipt_submissions
  using (deleted_at is null and public.is_org_member(organization_id));

create or replace function public.delete_failed_purchase_receipt(p_organization_id uuid,p_receipt_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); s public.purchase_receipt_submissions%rowtype; evidence_hash text;
begin
  if actor is null or not private.has_org_role(p_organization_id,array['owner','reviewer']) then
    raise exception 'Organization owner or reviewer role required';
  end if;
  select * into s from public.purchase_receipt_submissions
    where organization_id=p_organization_id and id=p_receipt_id for update;
  if not found then raise exception 'Receipt not found'; end if;
  if s.deleted_at is not null then return jsonb_build_object('receiptId',p_receipt_id,'deleted',true); end if;
  if s.status<>'failed' or s.active_draft_version is not null
    or exists(select 1 from public.purchase_receipt_draft_versions where organization_id=p_organization_id and receipt_id=p_receipt_id)
    or exists(select 1 from public.purchase_receipt_decisions where organization_id=p_organization_id and receipt_id=p_receipt_id)
    or exists(select 1 from public.purchase_receipt_effects where organization_id=p_organization_id and receipt_id=p_receipt_id) then
    raise exception 'Only failed receipts without drafts, decisions or effects can be deleted';
  end if;
  select sha256_hex into evidence_hash from public.evidence_files where organization_id=p_organization_id and id=s.evidence_file_id;
  if evidence_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':purchase-receipt-sha:'||evidence_hash,0));
  end if;
  update public.purchase_receipt_submissions set deleted_at=now(),deleted_by=actor,updated_at=now()
    where organization_id=p_organization_id and id=p_receipt_id;
  insert into public.audit_events(organization_id,actor_user_id,actor_kind,action,entity_type,entity_id,before_state,after_state,reason,correlation_id)
    values(p_organization_id,actor,'human','delete','purchase_receipt',p_receipt_id,
      jsonb_build_object('status',s.status,'lastErrorCode',s.last_error_code,'evidenceFileId',s.evidence_file_id),
      jsonb_build_object('deleted',true),'Deleted failed receipt from the inbox','purchase-receipt:'||p_receipt_id::text);
  return jsonb_build_object('receiptId',p_receipt_id,'deleted',true);
end $$;
revoke all on function public.delete_failed_purchase_receipt(uuid,uuid) from public,anon,service_role;
grant execute on function public.delete_failed_purchase_receipt(uuid,uuid) to authenticated;

-- A fresh submission can process the same bytes after the failed original is deleted.
create or replace function public.complete_purchase_receipt_upload(
  p_organization_id uuid,p_receipt_id uuid,p_object_key text,p_sha256_hex text,p_byte_size bigint,p_mime_type text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.purchase_receipt_submissions%rowtype; evidence_id uuid; job_id uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  select * into s from public.purchase_receipt_submissions where organization_id=p_organization_id and id=p_receipt_id for update;
  if not found or s.deleted_at is not null then raise exception 'Receipt submission not found'; end if;
  if s.status<>'awaiting_upload' then
    if s.evidence_file_id is null or not exists(select 1 from public.evidence_files e where e.organization_id=p_organization_id
      and e.id=s.evidence_file_id and e.object_key=p_object_key and e.sha256_hex=p_sha256_hex and e.byte_size=p_byte_size and e.mime_type=p_mime_type)
      then raise exception 'Completed receipt upload cannot be replaced'; end if;
    return jsonb_build_object('receiptId',s.id,'status',s.status,'evidenceFileId',s.evidence_file_id,'duplicateOf',s.duplicate_of);
  end if;
  if p_object_key is null or p_object_key !~ ('^'||p_organization_id::text||'/purchase-receipts/'||p_receipt_id::text||'/[^/]+$')
    or coalesce(p_sha256_hex,'') !~ '^[0-9a-f]{64}$' or p_byte_size not between 1 and 25000000
    or p_mime_type not in ('application/pdf','image/jpeg','image/png') or p_mime_type<>s.declared_mime_type then raise exception 'Invalid uploaded receipt evidence'; end if;
  if not exists(select 1 from public.organization_feature_flags f where f.organization_id=p_organization_id and f.inventory_tracking)
    then raise exception 'FEATURE_DISABLED: inventory_tracking'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':purchase-receipt-sha:'||p_sha256_hex,0));
  insert into public.evidence_files(organization_id,object_key,sha256_hex,mime_type,byte_size,original_filename,uploaded_by,uploaded_via,integration_id)
    values(p_organization_id,p_object_key,p_sha256_hex,p_mime_type,p_byte_size,s.original_filename,s.created_by,
      case when s.integration_id is null then 'human' else 'integration' end,s.integration_id)
    returning id into evidence_id;
  select r.id into job_id from public.purchase_receipt_submissions r
    join public.evidence_files prior on prior.organization_id=r.organization_id and prior.id=r.evidence_file_id
    where r.organization_id=p_organization_id and r.id<>s.id and r.deleted_at is null and r.status<>'duplicate' and prior.sha256_hex=p_sha256_hex
    order by r.submitted_at limit 1;
  if job_id is not null then
    update public.purchase_receipt_submissions set evidence_file_id=evidence_id,status='duplicate',duplicate_of=job_id,uploaded_at=now(),updated_at=now()
      where organization_id=p_organization_id and id=p_receipt_id;
    return jsonb_build_object('receiptId',s.id,'evidenceFileId',evidence_id,'duplicateOf',job_id,'status','duplicate');
  end if;
  job_id:=null;
  insert into private.durable_jobs(organization_id,job_type,idempotency_key,payload)
    values(p_organization_id,'receipt.process','receipt:'||s.id::text,jsonb_build_object('receiptId',s.id,'evidenceFileId',evidence_id))
    on conflict (job_type,organization_id,idempotency_key) where job_type='receipt.process' and organization_id is not null do nothing returning id into job_id;
  if job_id is null then select id into job_id from private.durable_jobs where organization_id=p_organization_id and job_type='receipt.process' and idempotency_key='receipt:'||s.id::text; end if;
  update public.purchase_receipt_submissions set evidence_file_id=evidence_id,status='queued',uploaded_at=now(),updated_at=now()
   where organization_id=p_organization_id and id=p_receipt_id;
  return jsonb_build_object('receiptId',s.id,'evidenceFileId',evidence_id,'jobId',job_id,'status','queued');
end $$;


