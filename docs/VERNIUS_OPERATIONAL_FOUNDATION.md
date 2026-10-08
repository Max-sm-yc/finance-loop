# Vernius Phase 1 operational foundation

Migration `202610060000_operational_foundation.sql` adds a provider-independent
business layer beside the existing Square facts, accounting projections, and
inventory records. Apply it only after confirming the intended Supabase project
and migration history. It has not been applied remotely as part of this work.

## Canonical records and provenance

Organizations remain the tenant root. The migration adds stable UUID records for
locations, employees, suppliers, catalog categories, catalog items, variations,
purchase orders, and purchase order lines. Variations have separate SKU,
barcode, unit-of-measure, price, and status fields. Availability is scoped by
variation and location. Draft catalog items and purchase orders can exist before
they have a Square mapping.

Authenticated domain commands create catalog drafts through
`POST /api/domain/catalog` and create/list purchase orders through
`POST`/`GET /api/domain/purchase-orders`. These use the caller JWT, enforce
catalog or location-scoped purchase permissions in both the API and database,
record the caller's reason, and require an idempotency key for creation. Draft
catalog items remain Vernius-owned records and do not mutate Square.

`domain_source_mappings` connects an internal UUID to a provider, source type,
and opaque source ID. It retains source version/hash, provider update time,
observation time, and ingestion actor information. Square IDs are not used as
internal primary keys. The worker imports Square locations and categories/items/
variations into these records while retaining the existing versioned normalized
Square facts as source evidence. Current Square inventory counts are stored as
append-only observations by variation, location, and stock state; `IN_STOCK`
also updates the canonical availability snapshot. Unknown mappings and equal-time
conflicting versions remain visible as sync gaps rather than being treated as zero.

`financial_events` and `financial_event_lines` are the normalized, append-only
event layer. They retain source version, source event linkage, location, details,
and supersession links; `financial_event_documents` links private evidence.
Square sales, discounts, taxes, refunds, processing fees, and payout entries
materialize separately. A payout remains a cash settlement event and is not
counted as sales revenue. Missing fee or unit-cost evidence produces an
incomplete event with a null amount. Cash movements and evidenced inventory
purchase receipts also create linked financial events. The projection engine
remains a separate derived view.

## Permissions, audit, and approvals

The database permission RPC resolves built-in or custom role grants and
location scopes. API handlers check the same permission, and RLS plus guarded
RPCs enforce it again at the data boundary. Finance reads, inventory quantities,
catalog reads, people management, and audit reads use separate permissions.
Inventory table grants omit unit-cost columns, and the inventory snapshot RPC
removes cost fields for callers without finance access.

Canonical mutations emit before/after audit events. Financial event records,
lines, supporting-document links, approval decisions, and audit records are
append-only. Approval proposals keep an immutable payload and hash, expire after
seven days, require a different user to decide, and use configured role,
permission, amount, location, and approval-count policies. The durable worker
rechecks the exact mapped Square object/version before execution and stores each
attempt and outcome. Catalog item and variation create/update/archive actions,
and approved Square physical counts, execute through this path. Each count proposal
is pinned to its mapped item, location, and current Square count version; the
worker fetches the current count immediately before writing and records the
confirmed Square result. Rejections, expirations, conflicts, failures, and retries
remain visible.

Users may cancel their own pending proposals. Revisions create a new immutable
proposal that references and atomically cancels an eligible pending proposal;
the revised payload receives a new hash and approval. The worker expires stale
proposals every minute and records the expiry as a system action. Amount policies
include an explicit currency, so a threshold is never interpreted in another
currency. Audit history can be filtered by employee, action, record ID, and date,
and the filtered results can be exported as CSV.

People management records an administrator-attested Microsoft Teams tenant,
user-object ID, and directory email for a Vernius member. Power Automate posts
the adaptive card to that reviewer and relays the Teams connector's responder
ID to the API. The integration credential is bound to one active identity
mapping; the callback checks the supplied responder ID against that mapping and
reuses the existing transactional
approval RPC, including its role, permission, location, source-version, expiry,
and idempotency checks. See
[`POWER_AUTOMATE_APPROVALS_SETUP.md`](POWER_AUTOMATE_APPROVALS_SETUP.md). This
approval route needs no Azure Bot resource, bot app registration, bot messaging
endpoint, or bot credentials.

## Current integration boundary

Square location, catalog, and inventory count reads are synchronized through the
durable sync/webhook worker. Periodic sync reads current counts for active mapped
variations and locations; `inventory.count.updated` webhooks trigger a fresh
Square read before persistence. Configure that event type on the Square webhook
subscription. OAuth read access includes `INVENTORY_READ`; Square physical-count
writes require an owner to reauthorize with `INVENTORY_WRITE` as well.

The approved-action worker uses a Square `PHYSICAL_COUNT` for the `IN_STOCK`
state. It does not turn Vernius purchases, openings, or local corrections into
Square adjustments. Those remain separate ledgers until an explicit operation is
proposed and approved. Square count history and the Vernius evidence-backed stock
ledger therefore retain distinct source-of-truth labels.

## Verification and rollout

Run `node --test tests/*.test.mjs` after application changes. For SQL validation,
run a disposable local Supabase reset and `supabase test db`; the
`operational_foundation.sql` and `teams_approval_bot.sql` pgTAP files check the
tables, grants, state machine, Teams RPC permissions, and protected read/write
paths. No local database check or remote migration was run in this workspace
because the Supabase CLI/Postgres toolchain is unavailable.
Web TypeScript checks also depend on a functioning project package-manager
install; no production deployment or external data was changed.

Coordinate deployment of the web/API and Render worker from the same compatible
commit after the migration is applied in the intended environment. The worker
requires the already documented server-only Square and Supabase credentials.
Keep evidence private, and use the pilot reconciliation and security review
before treating the normalized events or projections as production accounting.
