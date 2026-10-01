# Finance Loop web app

Production oriented Next.js workspace UI. This app has no fixture data or browser persistence. It signs users in with Supabase Auth and requests all financial projections through authenticated server API handlers.

## Configuration

Create `web/.env.local` with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Use only the publishable key in the browser. Set the server-side variables in the repository [environment template](../.env.example), including Square OAuth client credentials, webhook settings, a separate 32-byte base64 token-encryption key, Supabase secret key, and OpenRouter key. Install the pinned dependencies with `pnpm install`, then run `pnpm dev` or `pnpm build`. The production build passed locally on Next.js 16.3.8; no live service connection was tested.

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
- `POST /api/evidence` accepts multipart `organizationId` and `file` fields from an owner or operator. It stores a private PDF, JPEG, or PNG (up to 10 MiB), records its SHA-256 and metadata, and returns the evidence UUID used by the cash entry forms.
- `GET /api/evidence?organizationId=&evidenceId=` checks organization membership and returns a private Storage link that expires after 60 seconds.
- `POST /api/square/oauth/start` returns a Square authorization URL for an authenticated owner; `GET /api/square/oauth/callback` consumes single-use state and stores encrypted tokens server side.

The shell reads organization memberships with the signed in user's Supabase session. Data access and role enforcement remain server side. The API uploads evidence through the server secret into the private `finance-evidence` Storage bucket; clients have no direct bucket access. Cash records can open their evidence through a 60-second signed link. Malware scanning, retention/deletion, and account settings that require policy decisions remain to be implemented.
