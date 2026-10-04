# Supabase database rollout

`schema.sql` is the reviewed initial baseline and is mirrored by `migrations/202609300000_initial_schema.sql`. Apply migrations in filename order. The hardening migration expects the baseline objects and does not create Auth users or seed merchant data. Migration `202609300002_evidence_storage.sql` creates or locks down the private `finance-evidence` bucket used by the authenticated upload API. Prefer the Supabase CLI migration workflow (`supabase db push`) against a linked project; for review, run `supabase db reset` against a disposable local instance first. Never test migrations against a production project.

## Apply the migrations to the hosted project

The repository includes `config.toml` so the Supabase CLI can use the existing migrations. From the repository root, install or run the current Supabase CLI, then:

```sh
supabase login
supabase link --project-ref <project-ref>
supabase migration list
supabase db push
supabase migration list
```

The project reference is in the Supabase Dashboard project URL. `supabase login` uses a Supabase Personal Access Token; `supabase link` may ask for the database password. These are distinct from `SUPABASE_SECRET_KEY`. Confirm the linked project and migration history before `db push`; back up and review the target first if it contains data. The migrations create the app schema and private evidence bucket, but do not create Auth users or organization rows. Migration `202610020005_receipt_agent_cost_approval.sql` adds the receipt helper's budget and owner/reviewer approval RPC. Migration `202610020006_enable_inventory_and_product_analytics.sql` enables both capabilities for current and future organizations. Migration `202610030000_square_catalog_item_creation.sql` adds the owner-only Square item creation flow and stores the requested OAuth scopes with single-use state. Migration `202610030001_product_catalog_listing.sql` adds the membership-checked read RPC used to list synced Square variations and registered supplies with current prices and approved costs. Migration `202610030002_catalog_item_management.sql` exposes Square archive state in the catalogue and adds an audited, owner-only catalog change RPC with private idempotency records. The repository may be ahead of a linked project; verify the exact target and applied history with `supabase migration list` before any push. Never use production as a migration-test database.

## Enable the first sign-in

The web app supports email/password sign-in and has no public sign-up form. Supabase email/password Auth is enabled by default. In **Authentication → URL Configuration**, set the Site URL to `https://operations.ccdsinvest.com` and allow that URL for Auth email redirects. This Supabase Auth URL is separate from the Square OAuth callback URL.

Create or invite the first account in **Authentication → Users**. Once the user exists, run this one-time bootstrap block in the Supabase SQL Editor, replacing both placeholders. It creates an organization and grants that user the `owner` role; do not put the user's password in SQL.

```sql
do $$
declare
  initial_user_id uuid;
  new_organization_id uuid;
begin
  select id into initial_user_id
  from auth.users
  where lower(email) = lower('YOUR_LOGIN_EMAIL')
  limit 1;

  if initial_user_id is null then
    raise exception 'Create the Auth user first, then rerun this block';
  end if;

  insert into public.organizations (name, base_currency, timezone)
  values ('YOUR_ORGANIZATION_NAME', 'USD', 'America/New_York')
  returning id into new_organization_id;

  insert into public.memberships (organization_id, user_id, role)
  values (new_organization_id, initial_user_id, 'owner');
end
$$;
```

The owner can then sign in at `https://operations.ccdsinvest.com`. The app will show an empty state until an account is configured and a projection is produced.

The browser role has `SELECT` only. The authenticated write contracts added by `202609300001_database_hardening.sql` are:

* `record_cash_movement(org, account, kind, amount_minor, currency, occurred_at, description, evidence_file_id, idempotency_key, approved_by)` returns the movement UUID. Owner/operator may enter a movement. The account and evidence must belong to the organization, currency must match, and replaying the same idempotency key with changed data fails. Adjustments are created pending; single-leg transfers are rejected.
* `approve_adjustment(org, movement, reason)` returns the movement UUID. A designated correction administrator may approve a pending adjustment only if they did not create it.
* `record_balance_observation(org, account, amount_minor, currency, observed_at, evidence_file_id, idempotency_key)` returns the observation UUID. Owner/operator may record it. Reusing a key with changed data fails.
* `record_receipt_item_costs(org, evidence_file_id, reason, idempotency_key, updates)` records evidence-linked, effective-dated catalog item cost changes. Owner/reviewer approval is required; item identity and currency must match a synced Square sale variation. It can create the first approved cost definition for that variation, and changed retries fail.
* `record_square_catalog_item(org, idempotency_key, variation_id, name, sku, unit_cost_minor, currency, effective_from, evidence_file_id, reason, square_price_minor)` records the supplier-evidenced cost for a newly created Square variation. The authenticated caller must be an organization owner, the service must first persist matching versioned Square catalog facts and a private creation ticket, and the RPC records the item definition plus audit event atomically. The service-only ticket RPC and private idempotency records are not directly exposed to browser roles.
* `decide_proposal(org, proposal, approved|rejected, reason, expected_revision, idempotency_key)` returns the proposal UUID. Owner/reviewer may decide a pending proposal only if they did not create it. Stale revisions and changed retries fail.
* `set_accounting_period_status(org, period, open|closed, reason)` returns the period UUID. Owner closes; a designated correction administrator reopens; both transitions require a reason of at least ten characters.
* `configure_account_opening_balance(org, account, amount_minor, observed_at, evidence_file_id, reason)` records a bank account's evidence-linked opening balance and cutoff. Only an owner can call it. No opening balance defaults to zero.
* `set_reconciliation_tolerance(org, tolerance_minor, reason, correlation_id)` and `set_correction_authority(org, user, authorized, designated_by)` provide configuration; the correction-authority designation is service-provisioned.

The application calls human-write RPCs with the user's Supabase Auth JWT. It never sends service-role credentials to a browser. The hardening migration also adds transactional draft-proposal creation, budget reservation, queue/inbox RPCs with lease fencing, expiring OAuth state, and encrypted-token metadata. The adapter encrypts Square tokens with a separate 32-byte key before storage. Migration `202610010000_worker_persistence.sql` adds service-role-only worker RPCs, append-only version history for normalized Square facts, projection snapshots, health, and issues. Migration `202610020005_receipt_agent_cost_approval.sql` adds the user-triggered receipt extraction budget and the separate owner/reviewer cost-approval RPC. Migration `202610030000_square_catalog_item_creation.sql` adds the Square catalog write ticket and audited item-cost approval; the app requests `ITEMS_WRITE` only when an owner starts that catalog-creation flow. The sale price and item identity are written to Square, while the evidenced effective-dated COGS definition remains in Finance Loop. Apply and verify the migration in the intended environment before using this route. The container and required deployment settings are documented in [ops/worker/README.md](../ops/worker/README.md). Worker-side issue-investigation persistence is still not implemented, so the first runner only leases webhook, sync, and replay jobs.

## Invariants

Composite foreign keys keep accounts, evidence, source events, and linked records inside the owning organization. Source events, normalized sale lines, evidence metadata, and audit events reject update/delete. Cash movements and observations generate audit rows. Closed periods reject changes to cash facts, observations, and sale lines; reopening requires an actor and a reason of at least ten characters. Proposal decisions are immutable and require a reason. Manual corrections should be new dated rows after an authorized reopen. Evidence bytes must live in a **private** Storage bucket; metadata stores the object key, SHA-256, MIME type, size, and uploader. Configure bucket policies to match organization membership and avoid public URLs.

## Test and restore procedure

1. On a local Supabase stack, run `supabase db reset` and then `supabase test db` (the pgTAP checks in `tests/database_hardening.sql`). These SQL checks have not been executed in this workspace because PostgreSQL, Supabase CLI, and Docker are unavailable. They confirm grants and invariant trigger installation; they do not replace seeded two-organization RLS integration tests.
2. In a disposable project, seed two Auth users, two organizations and memberships, one account/evidence row per organization. As each user, verify reads only return their organization; try cross-org account/evidence IDs in each RPC and expect failure. Verify operator cannot decide proposals, creator cannot approve their proposal/adjustment, reviewer can approve another person's proposal, duplicate identical idempotency key returns the same movement, and changed payload with that key fails.
3. Close a period, try inserting a dated movement/observation/sale line within it (expect `PERIOD_CLOSED`), then reopen with a reason and verify insertion succeeds. Try changing/deleting source events, sale lines, evidence metadata, and audit rows (expect append-only errors). Confirm each cash/observation/decision mutation has an audit event.
4. Before rollout, take a managed Supabase backup or `pg_dump` including schema and data, and record the migration version. For recovery, restore the backup to a separate project first and validate row counts and organization access. A migration rollback is **not** a substitute for restoring data: reverse schema changes can discard evidence/audit history. For an erroneous migration, stop writers, restore to a new project from the pre-migration backup, validate, then switch the application connection after review. Keep the original project and backup until the restored instance is accepted.

RLS and trigger checks can be run without production credentials using the local Supabase stack. Do not put real merchant data in fixtures.
