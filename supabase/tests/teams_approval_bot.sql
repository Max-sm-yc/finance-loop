begin;
select plan(7);

select has_function('public','list_teams_action_proposals',array['uuid','uuid','integer'],'Teams can list only through the mapped-identity RPC');
select has_function('public','decide_action_from_teams',array['uuid','uuid','uuid','uuid','text','text','text','text','text'],'Teams decisions reuse the approval state machine');
select ok(has_function_privilege('service_role','public.list_teams_action_proposals(uuid,uuid,integer)','EXECUTE'),'Teams list RPC is available only to the verified server');
select ok(has_function_privilege('service_role','public.decide_action_from_teams(uuid,uuid,uuid,uuid,text,text,text,text,text)','EXECUTE'),'Teams decision RPC is available only to the verified server');
select ok(not has_function_privilege('authenticated','public.list_teams_action_proposals(uuid,uuid,integer)','EXECUTE'),'browser clients cannot spoof Teams identities');
select ok(not has_function_privilege('authenticated','public.decide_action_from_teams(uuid,uuid,uuid,uuid,text,text,text,text,text)','EXECUTE'),'browser clients cannot use the Teams server identity bridge');
select ok(not has_function_privilege('anon','public.decide_action_from_teams(uuid,uuid,uuid,uuid,text,text,text,text,text)','EXECUTE'),'anonymous callers cannot decide proposals through Teams');

select * from finish();
rollback;
