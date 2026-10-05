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
| `OPENROUTER_API_KEY` | Worker-only key for bounded diagnosis and supplier receipt extraction; drafts still require human approval |
| `OPENROUTER_MODEL` | Agent model (default `openai/gpt-6-luna`) |
| `PURCHASE_RECEIPT_MAX_OUTPUT_TOKENS` | Agent response limit for worker diagnosis and receipt extraction (default 1400, maximum 3000); organization budget reservations still apply |

Receipt extraction failures use sanitized provider categories in the failed
receipt's error code. `MODEL_AUTH_FAILED`, `MODEL_ACCESS_DENIED`, and
`MODEL_NOT_FOUND` point to worker credentials or model configuration;
`MODEL_REQUEST_REJECTED` points to an unsupported request or schema;
`MODEL_RATE_LIMITED` and `MODEL_PROVIDER_UNAVAILABLE` are retried. Correct the
Render worker configuration before retrying intake. A terminal failed receipt
can be retried by an owner or reviewer with **Reprocess document** after the
underlying issue is corrected. Reprocessing keeps the same evidence and receipt
ID but creates a fresh durable job and spends the organization's receipt model
budget. Failed receipts with drafts, decisions, or financial effects cannot be
reprocessed.

`SUPABASE_PUBLISHABLE_KEY` is not used by worker requests. The image installs
Poppler and Tesseract for searchable/scanned PDFs and JPEG/PNG receipts. Each
document is limited to 8 MiB, 20 PDF pages, 40 megapixels for image uploads,
24,000 extracted characters, and three minutes of native extraction time.
Receipt model calls reserve the organization budget and produce review drafts;
they never approve or post financial effects. Webhook signing secrets belong
on the web/API deployment, not this worker.

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

## Deploy on Render

The worker is a continuously running queue consumer, so deploy it as a Render
**Background Worker**. The root `render.yaml` defines this service and its
Docker build settings.

1. Apply the worker database migration from the repository root:

   ```powershell
   npx supabase db push
   ```

2. In Render, create a **Blueprint** from the GitHub repository
   `Max-sm-yc/finance-loop`, branch `main`, and review the `finance-loop-worker`
   service before applying it.
3. The Blueprint selects the Docker runtime, Dockerfile path
   `./ops/worker/Dockerfile`, repository-root build context, and one Background
   Worker instance. The image's `CMD` starts `node src/worker/run.mjs`.
4. During the initial Blueprint setup, provide the variables marked `sync: false`
   in `render.yaml` using the required values below. Keep `SQUARE_ENVIRONMENT`
   on `sandbox` for this first deploy. For later-added secrets, set them on the
   Render worker's Environment page.
5. The worker has no inbound endpoint, so no port, public URL, or Cloudflare DNS
   record is needed. Deploy and check the service logs for startup/idle polling
   messages.
6. Enqueue the initial sync below and verify the job completes before treating
   the worker as operational.

The browser app and webhook stay on Vercel. The webhook URL remains
`https://operations.ccdsinvest.com/api/square/webhook`; it does not change when
the worker runs on Render. Do not run this infinite poll loop in a Vercel
request or cron invocation.

Render does not offer a Free compute plan for Background Workers. The Blueprint
uses Render's smallest listed Background Worker plan (`0.5c-512mb`); check the
current price in Render before applying it.

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
