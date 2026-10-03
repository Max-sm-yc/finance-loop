# Inventory tracking and product analytics rollout

This release enables inventory tracking, product analytics, and the receipt text
helper. The root browser-local demo remains separate from the authenticated app.
Activation requires both server-side environment flags and the organization
database flags; this file does not claim pilot reconciliation or accountant
sign-off.

## Feature gates

`INVENTORY_TRACKING_ENABLED=true` and `PRODUCT_ANALYTICS_ENABLED=true` are
server-only defaults in both environment examples. Production Vercel settings
must also set them to `true`; environment changes require a new deployment. A
capability additionally requires its organization's database flag. Migration
`202610020006_enable_inventory_and_product_analytics.sql` enables every existing
organization and sets both flags on for future organizations. Authenticated
users cannot change organization flags. Setting either server flag to `false`
or clearing an organization flag disables the corresponding capability.

Routes still fail closed unless both layers are enabled. Keep production
environment values consistent with the database migration.

## Inventory and cash

Supply purchases record the actual account cash outflow once and create receipt
quantity records and a durable accounting replay job in the same database
transaction. A receipt can contain multiple item lines with one total paid.
Acquisition unit cost excludes
purchase tax and miscellaneous charges; the recorded cash paid may include them.
Receipt costs do not silently replace effective-dated approved sale costs.

The receipt text helper accepts user-pasted receipt text and returns a bounded,
editable extraction draft. It does not read uploaded receipt files, identify
Square catalog items, or write financial records. A human must map each line to
an exact catalog variation, attach receipt evidence, review the unit cost and
effective date, and approve. Approval can create a first approved cost for a
variation or revise an existing cost; it writes an audited effective-dated item
cost and queues a projection replay for effective dates that can affect current
reports. A future-dated approval takes effect on that date. The helper does not record the purchase
cash outflow or stock receipt; those remain a separate receipt entry. Model
requests use the organization's daily AI token budget. Common email, phone,
card-number, and tax-identifier patterns are redacted before extraction; users
should still avoid pasting unrelated personal or payment details. Effective
dates that require replaying more than 370 days are rejected; older cost
corrections require a separately planned historical replay.

Opening stock and corrections require evidence, an authorized owner or reviewer,
a reason, and an idempotency key. Corrections append signed quantity deltas; they
do not create cash entries or balancing plugs. Closed periods reject writes.
Stock is replayed from opening records, receipts, completed sales, and explicit
corrections through the report cutoff. A refund amount or COGS approval alone
does not prove a restocked quantity; record a supported stock correction separately.

The first version supports whole units and exact Square catalog variation
identities backed by item definitions. New standalone supplies can be registered
with a SKU, currency, reason, and evidence; they have no invented Square identity
and do not establish costs for sales. Usage of standalone supplies is a manual
stock correction supported by records. Recipe/BOM consumption and fractional
units require additional rules. Catalog-less sale lines remain exceptions;
names are not used to infer item identity. Missing openings, missing evidence,
negative stock, source gaps, and mixed currencies remain visible.

## Product analytics

Reports use integer minor-unit arithmetic and a bounded UTC interval with an
inclusive start and exclusive end. Product revenue, approved COGS, quantities,
and contribution before processing fees retain source references and a
calculation version. Reports also include aggregate Square processing fees,
UTC daily/monthly trends, product rankings, revenue share, margin ratios, and
CSV export. Product net and margin are before fees; report-wide net deducts
COGS and aggregate fees from revenue. Net is an operational margin, not an
accounting net-income statement.

Order-level refunds remain unallocated when their sources do not identify a
product. Processing fees are always treated as an aggregate operating cost
after product-level COGS; they are never allocated to a product, even when an
order contains only one product. Stale fee health can leave known aggregate
fees visible while report-wide net remains incomplete. Missing fee amounts or
an uncovered source window make fee totals incomplete, but do not change
product contribution before fees. Product analytics does not use model-inferred
amounts or create agent jobs. The receipt helper is a user-triggered extraction
request only; it cannot approve or post a cost.
Source readiness requires fresh health for the required resources and payout
entries, plus a completed sync window
covering the requested period. Stock additionally requires source coverage from
its opening baseline through the cutoff; fresh health alone does not prove
historical coverage.

## Review and future rollout

The ordered migrations include `202610020003_inventory_tracking.sql`,
`202610020004_snapshot_sale_line_cost_overrides_from_facts.sql`,
`202610020005_receipt_agent_cost_approval.sql`, and
`202610020006_enable_inventory_and_product_analytics.sql`. Run the full
migration chain and pgTAP tests on a disposable Supabase stack, then exercise
two organizations and every role. Verify atomic
purchase rollback, identical and conflicting retries, evidence isolation,
immutable audit rows, closed periods, stock roll-forward, and report totals
against independent source records. For receipt cost approval, also verify
catalog candidate tenant isolation, no writes during extraction, owner/reviewer
authorization, initial and revised effective-dated costs, changed retries, and
projection replay after approval. Compare UI reports and exported data.

Production rollout also requires confirming the linked project, current migration
history, both Vercel environment values, deployment health, and pilot readiness.
Applying migrations does not establish a completed pilot or accounting sign-off.

## Verification status

The previous inventory and analytics update documented a Next.js production
build and Node results of 96/99 tests, with three pre-existing failures. Those
checks predate the receipt helper and do not verify it. The new migration,
receipt parsing route, approval RPC, and UI have not been run through automated
tests, a local Supabase stack, or live merchant integration. No remote migration
was applied and neither feature flag was enabled for this implementation.
