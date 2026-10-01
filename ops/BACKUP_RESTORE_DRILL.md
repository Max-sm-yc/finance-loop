# Backup and restore drill

This procedure is a template for a future Supabase-backed deployment. It has not been run against a live or test project. Set and approve recovery point objective (RPO), recovery time objective (RTO), retention, encryption, and backup ownership with the merchant before launch.

## What must be recoverable

- Postgres schema and rows, including organization memberships, immutable source versions, normalized facts, cash events, approvals, audit events, and migration history.
- Private evidence objects **and** their metadata and organization-to-object mapping. A database-only dump does not restore Storage bytes.
- Encrypted Square connection material and required application secrets through the approved secret manager process. Never include raw secrets in a database dump or drill notes.
- Application/worker release identifier, environment configuration names, migration version, and calculation policy versions needed to replay projections.

## Before a drill

1. Create a disposable isolated restore project in the approved region. Confirm access is restricted to named drill participants and that it contains no production data.
2. Verify the backup timestamp, coverage, encryption, retention, and whether it includes Storage objects. Record backup ID and checksum/manifest in the drill record, not credentials.
3. Confirm a separate test evidence object exists and has a known expected checksum. Use synthetic organization, account, movement, source, approval, and audit records.
4. Notify the application, database, and security owners of the drill window. Keep the source project untouched.

## Restore and validate

1. Restore database and Storage backup into the separate project using the supported Supabase recovery method. If the platform restore cannot target a new project, take an approved encrypted export and restore into the disposable project; verify this path before launch.
2. Apply no new migration until the restored schema and migration history are inventoried. Compare the restored migration version to the application release expected to run against it.
3. Compare row counts by organization and table against the backup manifest, including source events, cash movements, observations, proposals, audit events, and evidence metadata. Verify a selection of object IDs and timestamps.
4. Download the synthetic evidence object through an authenticated test path and compare its SHA-256 with the manifest. Confirm unauthenticated and cross-organization access is denied.
5. Run the database authorization and trigger checks, then two-organization reads and RPC-denial checks. Verify source/audit immutability and closed-period rules on synthetic rows.
6. Rebuild a projection from source facts using the recorded calculation version. Compare output hash and totals with the expected synthetic result. Confirm incomplete-source flags remain visible.
7. Start the application against the restored project in isolated mode. Verify health endpoints, auth, read paths, and one synthetic idempotent write. Do not reconnect a real Square merchant during a drill.
8. Stop the isolated application, preserve drill evidence, and dispose of test credentials/data using the approved retention process.

## Recovery decision after a real incident

1. Incident lead pauses writes and captures current deployment, database migration, and provider cursor state.
2. Restore to a new project. Never overwrite the suspect project as the first recovery action.
3. Validate the same row-count, evidence checksum, cross-organization access, audit, and deterministic replay checks above.
4. Identify writes after the backup point from durable webhook inboxes and external provider records. Re-ingest with idempotency from a documented cutoff; do not hand-edit restored totals.
5. Obtain independent data-integrity and security review. Switch application connection only after explicit operational sign-off; retain the original project and backup until acceptance.
6. Reconcile every affected account and period against Square exports and bank evidence before enabling close or normal writes.

## Drill record

For each drill record date/time UTC, participants, backup ID/time, migration and app versions, measured RPO/RTO, row counts/checksums, authorization results, replay results, failures, corrective action owner/due date, and sign-off. A drill is successful only when evidence bytes, tenant isolation, audit history, and deterministic replay all pass.

## Not yet verified

Supabase backup schedule/retention, point-in-time recovery eligibility, Storage object backup coverage, secret recovery, cross-project restore path, and actual RPO/RTO are infrastructure/account-plan specific and must be tested. This document records no completed restore drill.
