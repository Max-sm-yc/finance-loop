# Finance Loop worker

The web/API deployment accepts Square webhooks and enqueues work. This separate
Node process leases those durable jobs, fetches authoritative Square records,
stores versioned normalized facts, updates source health/issues, and writes a
replayable accounting projection. It has no inbound HTTP endpoint and needs no
Cloudflare DNS record; it makes outbound requests to Supabase and Square.

Completed refunds reduce net sales. Since a Square refund alone does not prove
whether goods returned to inventory, the projection raises `REFUND_COGS_REVIEW`
and withholds the operational margin until a human decides the cost treatment.

## Required worker environment

Set these in the worker host's secret/environment settings. Do not commit them
or paste secret values into chat.

| Variable | Value |
| --- | --- |
| `SQUARE_ENVIRONMENT` | `sandbox` while testing; `production` only after the pilot is approved |
| `SQUARE_API_VERSION` | Same supported version configured for the app |
| `SQUARE_CLIENT_ID` | Square application client ID |
| `SQUARE_CLIENT_SECRET` | Square application client secret; used to refresh OAuth grants |
| `SQUARE_TOKEN_ENCRYPTION_KEY` | The same base64-encoded 32-byte key used by the web deployment; existing stored OAuth tokens depend on it |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Supabase service/secret key; grants the worker privileged RPC access |

`SUPABASE_PUBLISHABLE_KEY` is not used by worker requests. OpenRouter is not
enabled in this first worker process; issue-investigation jobs remain unclaimed
until its durable budget/proposal adapter is implemented. Webhook signing
secrets belong on the web/API deployment, not this worker.

Optional tuning: `WORKER_POLL_MS` (default 3000, range 250–60000),
`WORKER_LEASE_SECONDS` (120), `WORKER_MAX_JOB_ATTEMPTS` (5),
`WORKER_MAX_BACKFILL_PAGES` (10000), `WORKER_FRESHNESS_TARGET_MS` (24 hours),
and `ACCOUNTING_TIMEZONE` (default `America/New_York`).

## Local run

First apply the new migration from the repository root:

```powershell
npx supabase db push
```

With Node.js 22 installed and the required worker variables in the ignored root
`.env` file, run:

```powershell
node --env-file=.env src/worker/run.mjs
```

The process prints structured job lifecycle logs without tokens or payment
payloads. Ctrl+C or a container stop signal lets the current job finish before
it exits.

## Deploy on Northflank

The worker is a continuously running queue consumer, so create a Northflank
**service** (not a one-off or scheduled job). Northflank's background-task guide
uses services for continuous workers and jobs for tasks that end.

1. Apply the worker database migration from the repository root:

   ```powershell
   npx supabase db push
   ```

2. In Northflank, create a project and a **Service** connected to the GitHub
   repository `Max-sm-yc/finance-loop`, branch `main`.
3. Choose Dockerfile build, set the Dockerfile location to
   `/ops/worker/Dockerfile`, and the build context to `/` (the repository root).
   The Dockerfile runs `node src/worker/run.mjs` by default.
4. Add the required environment variables below in the service's runtime
   variables/secrets. Mark credentials and keys as secrets. Set
   `SQUARE_ENVIRONMENT=sandbox` for the first deploy.
5. Configure one instance initially. Do not add a port, public domain, or
   Cloudflare DNS record; this worker only makes outbound calls to Supabase and
   Square. Keep automatic deploys from `main` enabled if desired.
6. Deploy, then check the service logs for its startup/idle polling messages.
   Enqueue the initial sync below and verify the job completes before treating
   the worker as operational.

The browser app and webhook stay on Vercel. The webhook URL remains
`https://operations.ccdsinvest.com/api/square/webhook`; it does not change when
the worker moves to Northflank. Do not run this infinite poll loop in a Vercel
request or cron invocation.

Northflank's Developer Sandbox advertises always-on compute and includes free
service resources, but Northflank explicitly says the Sandbox should not be
used for production applications. Use it for the Square Sandbox integration
test; move to an appropriate paid plan before processing live merchant data.

## First backfill and verification

After the worker is healthy, enqueue a sync using the signed-in organization
owner's Supabase Auth access token. Use a real date window and the organization
UUID. This request only enqueues work; the running worker processes it.

```powershell
$body = @{
  organizationId = "YOUR_ORGANIZATION_UUID"
  startAt = "2026-09-01T04:00:00.000Z"
  endAt = "2026-10-01T04:00:00.000Z"
  locationIds = @()
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri "https://operations.ccdsinvest.com/api/sync" `
  -Headers @{
    Authorization = "Bearer YOUR_SIGNED_IN_SUPABASE_ACCESS_TOKEN"
    "Idempotency-Key" = "sandbox-initial-sync-2026-09"
  } `
  -ContentType "application/json" -Body $body
```

Expect a `201` response with a queued job. Follow the worker logs until it
reports completion, then check the app's reporting status and `projection_runs`,
`issues`, and the private Square fact tables. Square Developer Explorer test
events verify webhook receipt, but can carry sample object IDs that Square will
not allow the worker to fetch. For the full path, create a real Sandbox payment
and confirm the corresponding webhook job completes.
