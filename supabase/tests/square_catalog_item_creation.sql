begin;
select plan(12);

select has_column('private','square_oauth_states','requested_scopes','OAuth state binds requested scopes to the single-use state');
select has_table('private','square_catalog_creation_tickets','Square writes are recorded as private service tickets');
select has_table('private','square_catalog_item_requests','Finance Loop cost writes have private idempotency records');
select has_function('public','save_square_oauth_state',array['text','uuid','uuid','text','timestamp with time zone','text[]'],'OAuth state save accepts the requested scope set');
select has_function('public','consume_square_oauth_state',array['text'],'OAuth callback consumes the state and its requested scopes once');
select has_function('public','register_square_catalog_creation_ticket',array['uuid','text','text','text','text','text','text','text','bigint'],'service catalog ticket RPC exists');
select has_function('public','record_square_catalog_item',array['uuid','text','text','text','text','bigint','text','timestamp with time zone','uuid','text','bigint'],'owner catalog item and cost approval RPC exists');
select ok(has_function_privilege('authenticated','public.record_square_catalog_item(uuid,text,text,text,text,bigint,text,timestamptz,uuid,text,bigint)','EXECUTE'),'authenticated callers use the role-checked cost approval RPC');
select ok(not has_function_privilege('anon','public.record_square_catalog_item(uuid,text,text,text,text,bigint,text,timestamptz,uuid,text,bigint)','EXECUTE'),'anonymous callers cannot approve item costs');
select ok(not has_function_privilege('authenticated','public.register_square_catalog_creation_ticket(uuid,text,text,text,text,text,text,text,bigint)','EXECUTE'),'catalog tickets are written only by the service role');
select ok(not has_table_privilege('authenticated','private.square_catalog_creation_tickets','SELECT'),'catalog creation tickets stay private');
select ok(not has_table_privilege('authenticated','private.square_catalog_item_requests','SELECT'),'catalog cost idempotency payloads stay private');

select * from finish();
rollback;
