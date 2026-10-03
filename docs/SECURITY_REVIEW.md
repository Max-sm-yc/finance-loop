# Finance Loop security review checklist

Use this checklist before connecting a merchant, before production launch, and after material auth, database, storage, or integration changes. Current repository UI is a browser-local demo; checklist items describe controls that must be verified in the deployed architecture, not controls already demonstrated by the prototype.

## Tenant identity and authorization

- [ ] Authenticated requests derive actor identity from the verified session/JWT; never accept a caller-supplied actor ID as authority.
- [ ] Organization membership is checked server-side for every read/write and organization IDs are not treated as secrets or authorization.
- [ ] PostgreSQL RLS is enabled on every tenant table; policies are tested with at least two organizations and roles owner, operator, reviewer, and read-only.
- [ ] Cross-organization references fail at database constraints for account, evidence, source, and linked movement references.
- [ ] The authenticated browser cannot write tables directly; narrowly scoped RPCs/routes enforce actor, role, reason, evidence, idempotency, and transaction boundaries.
- [ ] Operator cannot approve own adjustment/proposal; reviewer cannot edit immutable provider facts; read-only cannot mutate; close/reopen requires authorized role and reason.
- [ ] Service-role credentials exist only in server/worker secret storage, are rotated, scoped, and never included in frontend bundles, logs, error output, or client responses.

## Square and webhook boundary

- [ ] OAuth requests only the needed scopes; `ITEMS_WRITE` is limited to owner-authorized Square catalog creation, with no other Square write scopes. API version is pinned; refresh/access tokens are encrypted and access logged.
- [ ] Webhook verification covers the exact raw body and configured notification URL before any persistence or queue action. Invalid signatures never mutate source facts.
- [ ] Notification IDs and object versions are idempotent; authoritative object fetch handles partial, duplicated, delayed, and out-of-order events.
- [ ] Backfill pagination, overlap, cursors, rate limits, revoked access, gaps, and retry bounds are tested in Square sandbox.
- [ ] Payouts remain cash movements and are not counted as sales; currency, fees, refund, reversal, hold, and failed payout behavior is explicit.

## Financial integrity and review

- [ ] Money uses integer minor units plus currency; mixed currencies fail closed; policy version, timezone, cutoff, source freshness, and evidence are visible with each projection.
- [ ] Source payloads, normalized versions, and audit events are append-only. Corrections are new versions/rows with actor, reason, evidence, and approval where needed.
- [ ] Idempotency keys reject reuse with changed payload. Transactions keep the business row and audit event atomic.
- [ ] Closed periods block writes. Reopen has authorized actor/reason; subsequent close requires complete source sync and unresolved-issue review.
- [ ] Inventory cost, tax, tips, discounts, gift cards, refunds, chargebacks, transfers, and COGS cash treatment have signed-off examples before they affect reporting.
- [ ] Agent output is schema-validated, uses allowlisted source IDs/categories, has per-org rate/cost caps, and can only create a draft. No model output chooses arithmetic or writes canonical ledger facts.
- [ ] Receipt extraction sends only bounded pasted text after common identifier redaction; a person selects the exact catalog identity and approves an evidence-linked, idempotent COGS write through the owner/reviewer RPC.
- [ ] Sellable item creation is owner-only, uses the caller JWT for authorization, writes to Square with an idempotency key, preserves normalized catalog facts, and records an evidence-linked unit cost against the returned variation ID.
- [ ] Projection replay from source facts and policy version is deterministic. Golden fixtures include duplicate/reordered events, partial refunds, missing costs, and payout fees.

## Evidence, privacy, and application security

- [ ] Evidence uses a private storage bucket, tenant-scoped object keys and policies, short-lived signed URLs, malware/content checks as appropriate, MIME/size limits, and checksum verification.
- [ ] Data minimization, retention/deletion, export handling, and customer notification responsibilities are documented with the merchant.
- [ ] Logs and traces omit credentials, webhook secrets, card data, unnecessary PII, full signed URLs, and raw evidence. Access is restricted and retention set.
- [ ] Browser inputs are validated server-side; HTML output is escaped; CSRF/origin protections and rate limits are configured for state-changing routes.
- [ ] Dependency, build, secret scanning, security headers, TLS, CSP, session expiry, password/MFA policy, and account recovery settings are reviewed for the deployed stack.
- [ ] Error responses avoid leaking tenant existence, database details, secrets, or provider payloads.

## Operations and approval

- [ ] Incident and alert ownership are assigned; alert routing is exercised; incident evidence can be exported without exposing unrelated tenants.
- [ ] Backup covers Postgres, private evidence bytes, migration history, and secret recovery plan. Restore drill proves cross-tenant isolation and projection replay.
- [ ] Deploy/rollback process validates schema compatibility and does not use destructive migration rollback as data recovery.
- [ ] Reviewer approvals, high-risk thresholds, manual adjustment policy, service-account actions, and separation-of-duties exceptions are approved by the merchant.
- [ ] Pilot exit includes independent comparison to Square and bank evidence and sign-off by merchant/accounting adviser.

## Review record

Record reviewer, date, release/commit, environment, evidence links, findings by severity, exception owner, due date, and re-review date. Mark each checkbox only after examining evidence in the target environment. Do not mark this checklist complete based on local prototype behavior.
