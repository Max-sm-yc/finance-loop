# Finance Loop incident runbook

This runbook is for the production service described in `PROJECT_PLAN.md`. The repository currently contains a local browser prototype; it has no deployed API, worker, webhook endpoint, or live merchant connection. Do not interpret these procedures as evidence that production controls exist. Before launch, assign a primary and backup incident lead, on-call contacts, and escalation channels.

## First response (all incidents)

1. Record the detection time, reporter, affected organization/account/period, environment, and a short symptom summary in the incident tracker. Use opaque IDs; do not paste tokens, customer PII, or raw card data.
2. Assign an incident lead and a second person to preserve evidence and track actions. Note timestamps in UTC and keep an append-only action log.
3. Identify whether the issue is confidentiality, integrity, availability, or a financial calculation/source gap. Preserve relevant application, worker, webhook, database audit, provider, and deploy logs before retention removes them.
4. Pause the affected action at the narrowest safe boundary. Use the response table below. Do not delete or rewrite source records to make a report balance.
5. Reconcile the affected records from immutable source facts and evidence before resuming writes or closing a period.

## Incident response table

| Signal | Immediate containment | Investigation and recovery | Resume condition |
|---|---|---|---|
| Suspected cross-organization exposure, stolen credentials, public evidence object, or service key in browser | Disable affected user/session or integration; revoke/rotate the exposed credential; disable public bucket access. If scope is uncertain, block affected API access. | Identify organizations, records, and time range exposed from access logs; preserve evidence; notify the designated security/privacy lead and follow contractual/legal notification process. Restore least privilege, then test access as users from two organizations. | Credential revoked, exposure path closed, access tests pass, and security lead documents the decision. |
| Wrong, duplicate, or missing financial facts; unexplained changed projection; source replay corrupted | Pause period close and affected write/normalization job. Retain webhook inbox/source IDs and calculation version. Do not post a balancing adjustment. | Compare normalized rows with authoritative Square objects and bank evidence. Determine whether the cause is duplicate delivery, out-of-order update, mapping/policy, or code. Rebuild affected projection from source facts under a recorded version; append a correction with evidence and separate approval where required. | Independent reviewer confirms record counts, currency, totals, trace links, and reconciliation for the affected period. |
| `SOURCE_STALE`, `SOURCE_GAP`, invalid webhook signature spike, permission loss, worker backlog | Pause close for affected source window; stop retry storms. Keep the raw notification and verification result. Never accept an unverified webhook to clear the alert. | Check provider status, credentials/scopes, cursor and pagination logs, queue age, response codes, and signature URL/key configuration. Reauthorize only the required scopes; `ITEMS_WRITE` is needed only for owner-authorized catalog creation. Run bounded overlapping backfill and compare object counts/totals. | Successful sync through the cutoff, gap review complete, duplicate/reordered events harmless, queue within target. |
| Repeated balance mismatch or `REPEATED_MISMATCH` | Stop automated investigation after configured proposal limit; leave issue open and prevent silent adjustment or period close. | Compare opening balance, account, currency, cutoff/time zone, posted payouts and payout entries, human movements/evidence, transfers, and source freshness. Have a second reviewer examine any correction proposal. | The evidence explains the difference or an approved, evidence-backed correction produces a reviewed match. |
| Database/API unavailable, failed migration, backup/restore event | Stop writes that cannot be safely retried; show read-only or maintenance state. Preserve migration ID and last known backup. Do not rerun a non-idempotent migration blindly. | Follow `BACKUP_RESTORE_DRILL.md`; inspect service health and migration history. Restore to a separate project first. | Integrity checks pass and application owners approve connection switch. |
| Agent timeout, malformed output, cost/quota limit, or unsafe candidate | Disable diagnosis calls if needed; deterministic calculations and human queue remain authoritative. Never let model output write ledger facts. | Inspect request ID, model/prompt version, schema validator result, token/cost counters, and sanitized payload. Retry only within configured limit or move issue to human review. | Validated output remains a draft with source IDs checked, cost cap/rate limit restored, and no direct write path exists. |

## Data integrity safeguards

- Do not edit or delete a source event, audit row, or normalized fact to remove an incident trace. Use a new source version, correction event, or approved dated adjustment according to the data model.
- Keep source payload and evidence access restricted. Incident exports must be encrypted and stored in the approved incident location with a retention deadline.
- For a period already marked closed, use the period reopen procedure with a documented reason and authorized reviewer; then reclose after independent reconciliation.
- Record recovery action, affected object IDs, old/new calculation version, approval actor, evidence, and verification result in the audit trail and incident tracker.

## Closure checklist

- [ ] Containment and scope are documented; affected tenants, accounts, periods, and records are identified.
- [ ] Root cause and contributing controls are recorded, including unknowns.
- [ ] Source facts, calculations, audit history, and evidence remain traceable.
- [ ] A second person reviewed financial recovery and access-control recovery.
- [ ] Merchant communication and any required external reporting were handled by the designated owner.
- [ ] Follow-up actions have an owner and due date; alert thresholds or runbook changes are tracked.
- [ ] Incident is closed by the incident lead with UTC close time.

## Must verify before production

On-call ownership, notification path, response targets, data retention, provider credentials, evidence bucket controls, webhook verification, pause/maintenance switch, audit export, and migration/restore access are not implemented or verified by this prototype.
