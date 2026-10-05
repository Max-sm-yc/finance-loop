begin;
select plan(4);

select ok(position('p_max_output_tokens > 3000' in pg_get_functiondef(
  'public.reserve_model_budget(uuid,uuid,text,integer,integer,integer)'::regprocedure)) > 0,
  'issue diagnosis budget RPC caps output at 3000 tokens');
select ok(position('p_max_output_tokens>3000' in pg_get_functiondef(
  'public.reserve_receipt_agent_budget(uuid,uuid,text,integer,integer,integer)'::regprocedure)) > 0,
  'receipt helper budget RPC caps output at 3000 tokens');
select ok(position('p_max_output_tokens not between 1 and 3000' in pg_get_functiondef(
  'public.reserve_purchase_receipt_model_budget(uuid,uuid,text,integer,integer,integer)'::regprocedure)) > 0,
  'legacy worker budget RPC caps output at 3000 tokens');
select ok(position('p_max_output_tokens not between 1 and 3000' in pg_get_functiondef(
  'public.reserve_purchase_receipt_model_budget(uuid,uuid,uuid,text,integer,integer,integer)'::regprocedure)) > 0,
  'job-scoped worker budget RPC caps output at 3000 tokens');

select * from finish();
rollback;
