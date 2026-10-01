begin;
select plan(43);

select has_table('public', 'accounting_periods', 'period table exists');
select has_table('public', 'evidence_files', 'evidence metadata exists');
select has_function('public', 'record_cash_movement', array['uuid','uuid','text','bigint','character','timestamp with time zone','text','uuid','text','uuid'], 'cash write RPC exists');
select has_function('public', 'record_balance_observation', array['uuid','uuid','bigint','character','timestamp with time zone','uuid','text'], 'observation RPC exists');
select has_function('public', 'approve_adjustment', array['uuid','uuid','text'], 'adjustment approval RPC exists');
select has_function('public', 'decide_proposal', array['uuid','uuid','text','text','integer','text'], 'proposal decision RPC exists');
select has_function('public', 'set_accounting_period_status', array['uuid','uuid','text','text'], 'period status RPC exists');
select has_column('public', 'proposals', 'revision', 'proposals carry an optimistic concurrency revision');
select has_column('public', 'proposals', 'decision_idempotency_key', 'proposal decisions retain idempotency key');
select has_constraint('public', 'proposals', 'proposal_decision_idempotency_key_unique', 'decision idempotency keys are unique per organization');
select has_function('public', 'create_proposal_atomic', array['uuid','uuid','jsonb','text','text','text','text','text'], 'proposal creation RPC exists');
select has_function('public', 'reserve_model_budget', array['uuid','uuid','text','integer','integer','integer'], 'budget reservation RPC exists');
select has_function('public', 'record_model_usage', array['uuid','uuid','text','jsonb','integer'], 'model usage RPC exists');
select has_function('public', 'save_projection_run', array['uuid','uuid','text','jsonb','text','text'], 'projection replay save RPC exists');
select has_function('public', 'enqueue_square_sync', array['uuid','timestamp with time zone','timestamp with time zone','jsonb','text','uuid'], 'sync enqueue RPC exists');
select has_function('public', 'claim_durable_jobs', array['text','integer','text[]'], 'durable claim RPC exists');
select has_function('public', 'save_square_oauth_state', array['text','uuid','uuid','text','timestamp with time zone'], 'OAuth state RPC exists');
select has_function('public', 'store_square_tokens', array['jsonb'], 'encrypted token RPC exists');
select has_function('public', 'get_square_webhook_notification', array['uuid','text'], 'tenant-scoped webhook lookup exists');
select has_function('public', 'set_reconciliation_tolerance', array['uuid','bigint','text','text'], 'tolerance configuration RPC exists');
select has_function('public', 'set_correction_authority', array['uuid','uuid','boolean','uuid'], 'correction authority provisioning RPC exists');
select has_table('public', 'organization_accounting_policies', 'accounting policy exists');
select has_column('public', 'organization_accounting_policies', 'gift_card_treatment', 'gift card accounting treatment is explicit');
select has_column('public', 'accounts', 'opening_balance_minor', 'opening balance is explicitly configured');
select has_function('public', 'configure_account_opening_balance', array['uuid','uuid','bigint','timestamp with time zone','uuid','text'], 'opening balance setup RPC exists');
select has_table('private', 'durable_jobs', 'durable jobs exist in private schema');
select has_column('private', 'durable_jobs', 'lease_token', 'queue lease fencing token is stored');
select has_column('private', 'square_webhook_inbox', 'raw_body_sha256', 'verified webhook raw body hash is retained');
select has_function('public', 'ack_durable_job', array['uuid','text','uuid'], 'ack requires fencing token');
select has_function('public', 'retry_durable_job', array['uuid','text','uuid','integer','text'], 'retry requires fencing token');
select has_function('public', 'dead_letter_durable_job', array['uuid','text','uuid','text','text'], 'dead letter requires fencing token');
select has_table('private', 'square_oauth_states', 'OAuth state is stored privately');
select ok(not has_table_privilege('authenticated', 'private.durable_jobs', 'SELECT'), 'authenticated cannot read durable queue');
select ok(not has_table_privilege('authenticated', 'private.square_merchant_connections', 'SELECT'), 'authenticated cannot read token ciphertext');

select ok(not has_table_privilege('authenticated', 'public.cash_movements', 'INSERT'), 'browser role cannot insert movements directly');
select ok(not has_table_privilege('authenticated', 'public.proposals', 'UPDATE'), 'browser role cannot edit proposals directly');
select ok(has_function_privilege('authenticated', 'public.record_cash_movement(uuid,uuid,text,bigint,character,timestamptz,text,uuid,text,uuid)', 'EXECUTE'), 'authenticated can call cash RPC');
select ok(has_function_privilege('authenticated', 'public.decide_proposal(uuid,uuid,text,text,integer,text)', 'EXECUTE'), 'authenticated can call decision RPC');

select ok((select count(*) = 4 from pg_trigger where tgname in (
  'source_events_append_only','sale_lines_append_only','audit_events_append_only','evidence_files_append_only') and not tgisinternal), 'append-only guards installed');
select ok((select count(*) = 3 from pg_trigger where tgname in (
  'cash_movements_period_guard','balance_observations_period_guard','sale_lines_period_guard') and not tgisinternal), 'period guards installed');
select ok((select relrowsecurity from pg_class where oid = 'public.accounting_periods'::regclass), 'period RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.evidence_files'::regclass), 'evidence RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.organization_accounting_policies'::regclass), 'accounting policy RLS enabled');

select * from finish();
rollback;
