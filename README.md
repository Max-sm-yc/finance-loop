# Finance Loop

Finance Loop is a supervised operational accounting and cash reconciliation project for Square merchants. It keeps sales and margin calculations separate from account cash movements, uses integer currency minor units, and requires human decisions for exceptions. The accounting boundary and unresolved merchant policy choices are in [PROJECT_PLAN.md](./PROJECT_PLAN.md).

## What is in this repository

| Path | Purpose |
|---|---|
| `index.html`, `app.js`, `styles.css` | Browser-local workflow demo with sample data. It makes no external calls. |
| `web/` | Authenticated Next.js UI and API route wrapper. It has no seeded financial records. |
| `src/engine/` | Deterministic, versioned income and account reconciliation calculations. |
| `src/square/` | Square OAuth, signed webhook, API client, pagination, and normalization primitives. |
| `src/agent/` | Bounded OpenRouter diagnosis that returns evidence-linked draft proposals only. |
| `src/server/`, `src/adapters/` | Authenticated API handlers and Supabase REST/RPC adapters. |
| `src/worker/` | Durable Square sync/webhook/replay processor and standalone worker entry point. |
| `supabase/migrations/` | Initial and hardening migrations with RLS, audit, approval, and idempotency controls. |
| `tests/` | Dependency-free Node tests for the pure and adapter boundaries. |
| `ops/`, `docs/` | Worker container/run instructions, operational readiness, and pilot procedures. |

## Run the local demo

Serve this folder with `python -m http.server 4173` and open `http://localhost:4173`. **Reset demo** restores the sample records. Its data remains in browser local storage and is unrelated to the production UI.

## Production setup and verification

1. Resolve the merchant-specific policy choices in [PROJECT_PLAN.md](./PROJECT_PLAN.md), especially account opening balances, currency, cutoffs, tax/tip/refund treatment, approval roles, and tolerance.
2. Create a Supabase project, apply `supabase/migrations/` in order, then execute the RLS, cross-organization, replay, and restore checks in [supabase/README.md](./supabase/README.md).
3. Configure server secrets from [.env.example](./.env.example). Only `NEXT_PUBLIC_*` values belong in the browser. Set up Square OAuth, webhook notification URL, and the OpenRouter key in the server environment.
4. In `web/`, run `pnpm install` and `pnpm dev` for local UI development, or `pnpm build` for a production build. The UI requires a real Supabase Auth user and organization membership. It displays an explicit unavailable state when no projection exists.
5. Run the dependency-free focused suite with `node --test tests/*.test.mjs` from the repository root.

The API route wrapper and database RPCs cover authenticated reads, cash entries, balance observations, proposal decisions, webhook intake, OAuth state and encrypted-token storage, and queued sync requests. The standalone worker is in [ops/worker/README.md](./ops/worker/README.md); its new migration must be applied and its end-to-end Sandbox behavior verified before live use. Worker-side automated issue investigations remain disabled until their durable model-budget and proposal persistence methods are implemented. An evidence record must exist before a cash entry can reference it. The account opening balance and cutoff remain configuration input. Local unit tests pass; the new SQL migration, live integrations, restore drill, pilot, and accountant sign-off have not been verified.

## Deploy the web app with Vercel and Cloudflare DNS

Import this GitHub repository into Vercel and set the project Root Directory to `web`. Enable **Include source files outside of the Root Directory** because the API route imports shared code from the repository's `src/` directory. Add the variables from `.env.example` to the appropriate Vercel environment; keep only the two `NEXT_PUBLIC_*` Supabase values public and store all other credentials as server-side environment variables. Apply Supabase migrations and complete the Sandbox integration checks before promoting a deployment to Production.

For a custom domain managed by Cloudflare, first add the domain in Vercel's project settings. Vercel will show the DNS records required for that specific project. Add those exact records in Cloudflare DNS and wait until Vercel verifies the domain and provisions HTTPS. Use the resulting HTTPS hostname for `SQUARE_OAUTH_REDIRECT_URI` (`/api/square/oauth/callback`) and `SQUARE_WEBHOOK_NOTIFICATION_URL` (`/api/square/webhook`). The local browser demo at the repository root is not the deployed app.

## Controls and limits

Square payouts are account inflows and never sales revenue. COGS is an income analysis input and is not deducted from account cash again. A missing approved cost leaves margin incomplete; an unexplained balance difference cannot post itself. Model output is validated against cited source IDs and remains a draft until a separate reviewer decides. Review [ops/INCIDENT_RUNBOOK.md](./ops/INCIDENT_RUNBOOK.md) and [docs/SECURITY_REVIEW.md](./docs/SECURITY_REVIEW.md) before a pilot.
