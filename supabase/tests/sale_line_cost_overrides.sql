begin;
select plan(4);
select has_table('public', 'sale_line_cost_overrides', 'line-specific cost approvals are stored separately');
select has_function('public', 'record_sale_line_cost_override', array['uuid','uuid','uuid','bigint','text','text','text'], 'authorized one-line cost override RPC exists');
select has_function('public', 'record_refund_cost_review', array['uuid','uuid','text','text','text','bigint','text','text','text'], 'refund cost guard also recognizes approved one-line costs');
select has_function('public', 'get_square_projection_snapshot', array['uuid','bigint','timestamp with time zone','timestamp with time zone'], 'projection snapshots include exact-line cost overrides');
select * from finish();
rollback;
