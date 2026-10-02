# Staged inventory and product analytics

This update is staged for review while the current product is being debugged.
Neither capability is enabled, deployed, or migrated by this change. The root
browser-local demo and the existing accounting worker retain their current behavior.

## Disabled by default

`INVENTORY_TRACKING_ENABLED=false` and `PRODUCT_ANALYTICS_ENABLED=false` are
server-only settings in both environment examples. A capability also requires
its organization's database flag. The new migration initializes every flag to
false, including for future organizations. Authenticated users cannot change
flags. There is no feature activation control in the app.

With server flags absent or false, feature availability does not query the new
tables. New routes fail closed and new navigation/forms stay hidden. Keeping the
server flags off allows the existing app to run before the new migration is applied.

## Inventory and cash

Supply purchases record the actual account cash outflow once and create receipt
quantity records and a durable accounting replay job in the same database
transaction. A receipt can contain multiple item lines with one total paid.
Acquisition unit cost excludes
purchase tax and miscellaneous charges; the recorded cash paid may include them.
Receipt costs do not silently replace effective-dated approved sale costs.

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
and operational net retain source references and a calculation version. Reports
also include UTC daily/monthly trends, product rankings, revenue share, margin
ratios, and CSV export. Net is
an operational margin, not an accounting net-income statement.

Order-level refunds and payment-level fees remain explicitly unallocated when
their sources do not identify a product. Missing cost, processing fee, return
review, or source-health evidence makes affected results incomplete. No amounts
are inferred by a model and no agent jobs are created by either capability.
Source readiness requires fresh health for the required resources and payout
entries, plus a completed sync window
covering the requested period. Stock additionally requires source coverage from
its opening baseline through the cutoff; fresh health alone does not prove
historical coverage.

## Review and future rollout

The new ordered migration is `202610020003_inventory_tracking.sql`. Before any
future activation, run the full migration chain and pgTAP tests on a disposable
Supabase stack, then exercise two organizations and every role. Verify atomic
purchase rollback, identical and conflicting retries, evidence isolation,
immutable audit rows, closed periods, stock roll-forward, and report totals
against independent source records. Compare UI reports and exported data.

Applying this migration to production and changing feature flags require a
separate explicit rollout instruction. Confirm the linked project and migration
history then; this document is not authorization to push a schema or enable a
feature. Keep both flags off throughout the current debugging work.

## Verification of this staged change

The Next.js type check and production build pass. The Node suite passes 96 of
99 tests; the same three adapter/server failures were present before this update.
The 25 newly added tests pass. The migration and its 40 pgTAP assertions remain
unexecuted because a disposable local Docker/Supabase stack is unavailable.
Neither database execution nor live merchant integration is verified by these
code checks.
