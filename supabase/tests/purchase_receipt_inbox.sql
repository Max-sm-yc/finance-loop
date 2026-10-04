begin;
select plan(22);

select has_table('private','purchase_receipt_integrations','integration credentials are private');
select has_table('public','purchase_receipt_submissions','receipt inbox submissions persist');
select has_table('public','purchase_receipt_draft_versions','draft extraction versions are persisted');
select has_table('public','purchase_receipt_decisions','human decisions are persisted');
select has_table('public','purchase_receipt_effects','approved cost, stock and cash effects are linked');
select has_function('public','register_purchase_receipt_integration',array['uuid','text','text'],'only owners provision organization integrations');
select has_function('public','list_purchase_receipt_integrations',array['uuid'],'owners can list safe integration metadata');
select has_function('public','revoke_purchase_receipt_integration',array['uuid','uuid'],'owners can revoke integrations');
select has_function('public','authorize_purchase_receipt_integration',array['text'],'server can authorize a hashed token');
select has_function('public','create_purchase_receipt_submission',array['uuid','uuid','text','text','text'],'automation submission is organization scoped');
select has_function('public','complete_purchase_receipt_upload',array['uuid','uuid','text','text','bigint','text'],'upload completion creates evidence and work atomically');
select has_function('public','save_purchase_receipt_draft',array['uuid','uuid','integer','jsonb'],'worker persists immutable extraction versions');
select has_function('public','approve_purchase_receipt',array['uuid','uuid','integer','jsonb','text','text'],'human approval records selected effects atomically');
select has_function('public','reject_purchase_receipt',array['uuid','uuid','integer','text','text'],'owner/reviewer can reject a draft');
select has_function('public','reserve_purchase_receipt_model_budget',array['uuid','uuid','text','integer','integer','integer'],'worker extraction respects organization budget');
select has_function('public','finalize_purchase_receipt_projection',array['uuid','uuid','uuid','boolean','text'],'worker can finalize projection state');
select has_function('public','list_purchase_receipt_catalog_candidates',array['uuid','text'],'purchase review can list current Square variations even before a sale');
select ok((select relrowsecurity from pg_class where oid='public.purchase_receipt_submissions'::regclass),'submissions use row level security');
select ok((select relrowsecurity from pg_class where oid='public.purchase_receipt_effects'::regclass),'effects use row level security');
select ok(not has_table_privilege('authenticated','public.purchase_receipt_submissions','INSERT'),'human submission writes use audited RPCs');
select ok(not has_table_privilege('authenticated','public.purchase_receipt_effects','INSERT'),'human effect writes use atomic approval RPC');
select ok((select count(*)=2 from pg_trigger where tgname in ('purchase_receipt_drafts_append_only','purchase_receipt_effects_append_only') and not tgisinternal),'drafts and approved effects are append only');

select * from finish();
rollback;
