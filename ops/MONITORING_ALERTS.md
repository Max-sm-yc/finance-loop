# Monitoring and alerts specification

Implement these monitors in the deployed API, worker, Supabase, and provider integrations. The browser prototype does not emit production telemetry. Numeric thresholds below are starting defaults; confirm them with pilot volume, merchant cutoff needs, and the person on call before enabling alerts.

## Signals to emit

Attach `environment`, opaque `organization_id`, `correlation_id`, `job_id`, provider object ID, policy/calculation version, and sanitized error code where applicable. Never log access tokens, service keys, webhook signature secrets, full evidence URLs, card data, or unnecessary customer PII. Use UTC timestamps and synchronized clocks.

| Area | Measure/event | Initial alert rule | Response |
|---|---|---|---|
| Webhook security | Signature verification failures / total received; rejected notification IDs | Any sustained failure burst (e.g. 5 in 5 min) or any accepted event without verified signature | Treat as security/config incident; verify exact URL and key. Do not process rejected payloads. |
| Webhook delivery | Time from receipt to durable inbox insert; duplicate notification count; insert failures | Any insert failure; p95 durable insert over 30 s for 10 min | Preserve request IDs, check DB health and queue handoff, ensure sender receives retry-safe response. |
| Source sync | Last successful sync by merchant/object family; cursor age; page count; permission/rate-limit errors | Sync older than 30 min while a close is active, or older than merchant freshness target at any time; any pagination gap | Mark source stale/gapped, pause close, inspect scopes/cursor/rate limiting, run overlapping backfill. Set merchant-specific target before pilot. |
| Queue/worker | Oldest pending job, ready depth, retries, dead-letter count, job duration | Oldest item over 5 min for 10 min, any dead-letter in active period, or retries exceed 3 | Stop retries if provider errors persist; inspect idempotency and worker health; replay only after cause is known. |
| Data integrity | Duplicate natural keys, conflicting idempotency payloads, FK/constraint failures, immutable-table mutation attempts | Any conflicting idempotency reuse, cross-org FK failure, or attempted append-only mutation; page security/engineering owner | Preserve actor/request context; inspect client and authorization boundary. Do not bypass constraints. |
| Calculation/reconciliation | `SOURCE_GAP`, `UNKNOWN_ITEM`, `CURRENCY_MISMATCH`, `BALANCE_MISMATCH`, `PERIOD_CLOSED`, `REPEATED_MISMATCH`; incomplete projections | Any currency/source gap blocks close; every mismatch stays visible; repeated mismatch pages after 3 proposals or one unchanged revision | Route to reviewer; show evidence and policy version. Never auto-balance. |
| Review controls | Pending proposal age; self-approval rejection; unapproved adjustment count | Pending high-risk proposal > 1 business day; any accepted self-approval attempt | Escalate review backlog; inspect role checks and audit trail. Threshold needs merchant agreement. |
| Agent | Timeout, schema rejection, unknown source ID, request rate, tokens/cost by org | Any invalid-source-ID response; >3 retries per issue; spend exceeds configured org/day cap | Disable calls for affected org/model; preserve sanitized validator trace; continue human review. Set a real budget cap before use. |
| Database/security | DB availability, connection saturation, RLS denial/error rates, privileged key use, backup status | DB unavailable > 1 min; any service key observed client-side; backup job missed its scheduled run | Invoke incident runbook; rotate exposed key and pause writes as appropriate. |
| Audit/evidence | Audit write failures, missing actor/reason/evidence metadata, storage access denial/public access check | Any audit write failure or public evidence access; repeated upload failures | Fail the initiating transaction closed; inspect DB/storage policies and preserve request IDs. |
| Application | API availability/latency, 5xx, authentication failures, deploy version | Error rate > 5% for 5 min or health check failure for 2 min | Roll back only through reviewed deployment process; preserve logs and check migration compatibility. |

## Dashboards and ownership

Create separate views for service health and financial completeness. The on-call dashboard should show sync age per source family, webhook acceptance/rejection, queue lag, DB health, error rates, and current deploy. The operator dashboard should show account/currency/cutoff, last source sync, incomplete flags, open issues, pending approvals, and calculation version. Keep financial mismatch counts visible even when the service is otherwise healthy.

Each alert needs a named owner, severity, runbook link, deduplication key, and resolved condition. Route security, data-integrity, and missed-close alerts to a human; avoid paging for normal model unavailability if the human queue is healthy. Review noisy alerts weekly during pilot and record threshold changes.

## Purchase receipt operations

Track receipt submissions awaiting upload, processing queue age, OCR/extraction
failures, budget-denied jobs, duplicate detections, human review backlog, and
approved receipts waiting for projection replay. Also track Jev inventory-match
latency, provider failures and budget denials without logging receipt descriptions,
inventory names, SKUs or returned choices. Separate document-processing
failure from financial completeness: a processed receipt may still have pending
delivery or payment. Correlate sanitized receipt/job IDs; never log document text,
integration tokens, payment identifiers, or signed upload URLs. Alert on repeated
processing failures and terminal replay failure; route unresolved financial
questions to the review inbox. Test receipt-only credentials for revocation and
cross-organization denials as part of the security gate.

## Infrastructure verification gates

- [ ] Provider webhook signature verification uses raw request bytes, configured notification URL, and secret rotation procedure.
- [ ] Metrics/logs are tenant-safe, redacted, access-controlled, retained for an approved interval, and tested with synthetic events.
- [ ] Sync/queue metrics include provider family and cursor without exposing secrets.
- [ ] Alerts actually reach primary and backup on-call; delivery and acknowledgement were exercised.
- [ ] Period-close flow blocks on stale/gapped source data and unresolved currency or reconciliation exceptions.
- [ ] Database and evidence storage backup/restore status is observable.
- [ ] Per-organization agent rate, retry, and spend limits are enforced server-side.
