-- Private evidence bytes are uploaded by the authenticated API after checking
-- organization membership. Clients receive metadata IDs, never public object URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'finance-evidence',
  'finance-evidence',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.audit_evidence_file_upload()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_events (
    organization_id, actor_user_id, actor_kind, action, entity_type, entity_id,
    after_state, correlation_id
  ) values (
    new.organization_id, new.uploaded_by, 'human', 'upload', 'evidence_file', new.id,
    jsonb_build_object('sha256_hex', new.sha256_hex, 'mime_type', new.mime_type, 'byte_size', new.byte_size),
    gen_random_uuid()::text
  );
  return new;
end
$$;
revoke all on function private.audit_evidence_file_upload() from public, anon, authenticated;
create trigger evidence_file_upload_audit after insert on public.evidence_files
  for each row execute function private.audit_evidence_file_upload();

-- Intentionally add no storage.objects policies for anon/authenticated. The
-- server API uses the service key only after verifying the caller's membership.
