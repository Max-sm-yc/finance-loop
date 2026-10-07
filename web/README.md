# Finance Loop web app

Production oriented Next.js workspace UI. This app has no fixture data or browser persistence. It signs users in with Supabase Auth and requests all financial projections through authenticated server API handlers.

## Configuration

Create `web/.env.local` with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Use only the publishable key in the browser. Set the server-side variables in the repository [environment template](../.env.example), including Square OAuth client credentials, webhook settings, a separate 32-byte base64 token-encryption key, Supabase secret key, and OpenRouter key. Install the pinned dependencies with `pnpm install`, then run `pnpm dev` or `pnpm build`. The production build passed locally on Next.js 16.3.8; live application integration behavior still needs deployment verification.

The server-side `OPENROUTER_API_KEY` enables automatic Jev inventory matching after receipt extraction and the optional reviewer retry through OpenRouter's Decisions API. Keep the key server-side; do not use a `NEXT_PUBLIC_` prefix.

## API contract

The browser adapter sends `Authorization: Bearer <Supabase access token>` on every request. All read routes include the selected `organizationId`, and date ranges are ISO timestamps. Successful routes may return a direct object or `{ data: object }`; the adapter accepts both. Errors should use `{ error: string }` or `{ error: { code: string } }`.

- `GET /api/dashboard?organizationId=&accountId=&from=&to=` returns organization, period, calculation version, sync freshness, income, cash reconciliation, account list, and flags.
- `GET /api/issues?organizationId=&state=open` returns `{ issues: [...] }` with `id`, `code`, `state`, `title`, and `details`.
- `GET /api/manual-movements?organizationId=&accountId=&from=&to=` returns `{ movements: [...] }` with signed integer `amount_minor`, currency, date, account, description, kind, and evidence reference.
- `GET /api/audit?organizationId=&limit=200` returns `{ events: [...] }` with action, actor, entity, timestamp, and details.
- `POST /api/proposals` asks the server to draft a bounded proposal for `{ organizationId, issueId }`; it remains pending for human review.
- `POST /api/proposals/:proposalId/decision` records an authorized approve/reject decision with issue, revision, reason, and idempotency key.
- `POST /api/manual-movements` records an audited cash movement. The request includes `organizationId`, `accountId`, `kind`, signed `amountMinor`, `currency`, `occurredAt`, `description`, and `evidenceRef` (an uploaded evidence file UUID); it also has an `Idempotency-Key` header.
- `POST /api/observations` records an audited observed account balance with `organizationId`, `accountId`, integer `amountMinor`, `currency`, `observedAt`, and `evidenceRef` (an uploaded evidence file UUID), plus an `Idempotency-Key` header.
- `POST /api/evidence` accepts multipart `organizationId` and `file` fields from an owner, operator, or reviewer. It stores a private PDF, JPEG, or PNG (up to 10 MiB), records its SHA-256 and metadata, and returns the evidence UUID used by the cash entry forms.
- `POST /api/inventory/receipt-drafts` accepts `{ organizationId, currency, text }` and returns a bounded model extraction draft plus exact candidates from synced Square sale facts and catalog variations, including items without completed sales. The model does not see candidates, read uploaded files, match items, or write financial data; the inventory feature gates and organization AI token budget apply.
- `POST /api/purchase-receipts/:receiptId/match` accepts `{ organizationId, expectedVersion, currency }` from an owner or reviewer and reruns TypeSafe AI's Jev through OpenRouter when automatic matching needs a retry. Initial matching runs in the receipt worker after extraction; suggestions are stored on the immutable draft version, fill empty selectors, and remain editable. Reviewers still approve all receipt effects.
- `POST /api/inventory/receipt-costs` accepts an evidence UUID, a human reason, and mapped `{ catalogObjectId, name, unitCostMinor, currency, effectiveFrom }` updates. An owner or reviewer approves the effective-dated item costs; the database audits and idempotently records them, then the server queues a projection replay.
- `POST /api/square/catalog-items` creates a Square item with fixed-price or variable-price variations. An owner can manage the item in Vernius; costs remain separate, evidence-backed approvals.
- `PATCH /api/square/catalog-items` edits an item name/description or a variation name/SKU/price, adds a variation, and archives/restores the parent item. Every change requires an owner, an explanation, an idempotency key, versioned Square facts, and an audit event. Hard deletion is not offered so historical item links stay intact.
- `GET /api/evidence?organizationId=&evidenceId=` checks organization membership and returns a private Storage link that expires after 60 seconds.
- `POST /api/square/oauth/start` returns a Square authorization URL for an authenticated owner; `GET /api/square/oauth/callback` consumes single-use state and stores encrypted tokens server side.

The shell reads organization memberships with the signed in user's Supabase session. Data access and role enforcement remain server side. The API uploads evidence through the server secret into the private `finance-evidence` Storage bucket; clients have no direct bucket access. Cash records can open their evidence through a 60-second signed link. Receipt deletion only hides the record from the inbox; original evidence and accounting history remain retained. Automated evidence retention/deletion, malware scanning, and account settings that require policy decisions remain to be implemented.

Inventory tracking and product analytics are enabled by default in the server
environment examples. Configure both variables as `true` in Vercel's production
project settings as well; changing those values requires a new deployment.
