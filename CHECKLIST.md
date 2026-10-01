# Finance Loop checklist

## Completed

- [x] Document the product scope, accounting boundaries, deterministic formulas, agent states, safeguards, and failure states in `PROJECT_PLAN.md`.
- [x] Map the intended Square Orders, Payments, Refunds, Catalog, and Payouts data flows.
- [x] Define the target Vercel, Supabase, and OpenRouter architecture, including the `openai/gpt-6-luna` model identifier.
- [x] Draft a Supabase schema with organization membership, source records, item definitions, cash movements, observations, issues, proposals, audit events, and read-only browser policies.
- [x] Add an agent diagnosis JSON schema and planned server environment variable names.
- [x] Build a responsive, browser-local frontend with Overview, Income & inventory, Cash flow, Review queue, and Activity ledger screens.
- [x] Demonstrate Square sync, item cost approval, transaction classification, manual cash entries, observed balance entry, candidate approval or rejection, recalculation, and human escalation using sample data.
- [x] Verify JavaScript syntax, JSON validity, local HTTP loading, and the main approval and recovery flows in the browser.
- [x] Implement and test a versioned deterministic income and account reconciliation engine, including missing costs, refund treatment, paired transfers, replay, and explicit observation cutoffs.
- [x] Add Square OAuth, signed webhook, paginated backfill, normalization, and durable worker interfaces with duplicate/reordered event tests.
- [x] Add authenticated API handlers, a Supabase REST/RPC adapter, an evidence-bound OpenRouter diagnosis client, and bounded proposal decision routes.
- [x] Create an authenticated Next.js UI scaffold and Supabase migrations for RLS, organization-scoped references, audited writes, and reviewer separation.
- [x] Write pilot, monitoring, incident, restore, and security procedures without claiming they have run.
- [x] Record the merchant's USD/Eastern/no-sales-tax, inventory cost, gift-card liability, and designated correction-admin policy choices; leave the opening balance and remaining treatments for configuration.
- [x] Pass the focused Node suite and a local Next.js production build.
- [x] Upgrade the web app to patched Next.js 16.3.8 and confirm the installed production dependency audit reports zero advisories.
- [x] Add membership-checked, size-limited private PDF/JPEG/PNG evidence upload, SHA-256 metadata, and 60-second signed reads without direct browser bucket access.
- [x] Include unresolved worker issue states in the review queue and wire the configured OpenRouter model and output-token limit into interactive and worker diagnosis.

## Still to do

### Accounting policy decisions

- [ ] Configure the central checking account nickname, opening USD balance, dated cutoff, evidence, and Square payout destination.
- [ ] Confirm period cutoff and remaining reporting basis details with worked examples. USD/Eastern, excluded tax, and purchase cost excluding tax/misc charges are recorded.
- [ ] Define tips, discounts, refunds, chargebacks, holds, failed payouts, and transfer rules. Gift cards are issuance cash inflow/liability and item sale/COGS at redemption.
- [ ] Set a numeric reconciliation tolerance, name the designated correction administrators, and set approval thresholds and closed-period correction examples.

### Backend and data

- [ ] Apply migrations to a real Supabase project; execute RLS, organization isolation, cross-organization reference, and restore tests. The SQL has not run locally.
- [x] Implement a standalone container worker, durable versioned Square fact persistence, source health/issues, and replayable projection snapshots; validate core mappings with local tests.
- [ ] Apply the worker migration and verify durable claim/ack/retry, Sandbox ingestion, source freshness, and projection persistence against the linked Supabase project.
- [ ] Verify production source-to-projection mappings with merchant records, especially refunds, fees, gift cards, and account opening/observed balances.
- [ ] Add evidence malware scanning and retention/deletion policy; run the documented database-and-Storage backup/restore drill.

### Integrations and agent

- [ ] Configure and run Square OAuth/token vault, webhook URL, sandbox ingestion, and export reconciliation end to end. The modules have only fixture tests.
- [ ] Configure OpenRouter and implement/verify worker-side durable budget accounting, issue investigation, model/schema compatibility, and human approval with real exceptions. The first worker container deliberately leaves investigation jobs unclaimed.
- [ ] Verify the authenticated Next.js UI and Supabase API against a deployed project. The local demo still intentionally uses sample data.
- [ ] Add human notifications for unresolved cases and integration failures.

### Product and launch

- [ ] Build and deploy the Next.js application after package installation, accessibility QA, and live API checks.
- [ ] Test edge cases: duplicate or reordered webhooks, missing item costs, partial refunds, mixed currencies, stale data, rejected candidates, and repeated balance mismatches.
- [ ] Run a pilot in parallel with Square reports and bank statements; have an accountant review differences.
- [ ] Complete security review, operational alerts, incident runbook, and production deployment.
