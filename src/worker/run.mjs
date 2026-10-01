import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createSupabaseAdapters } from '../adapters/supabase.mjs';
import { SquareApiClient } from '../square/client.mjs';
import { createWorker } from './index.mjs';

const required = name => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable ${name} is missing`);
  return value;
};
const integer = (name, fallback, min, max) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
};

const squareEnvironment = required('SQUARE_ENVIRONMENT');
if (!['sandbox', 'production'].includes(squareEnvironment)) throw new Error('SQUARE_ENVIRONMENT must be sandbox or production');
const accountingTimezone = process.env.ACCOUNTING_TIMEZONE?.trim() || 'America/New_York';
try { new Intl.DateTimeFormat('en-US', { timeZone: accountingTimezone }).format(new Date()); }
catch { throw new Error('ACCOUNTING_TIMEZONE must be a valid IANA time zone'); }
const squareBaseUrl = squareEnvironment === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';
const adapters = createSupabaseAdapters({
  url: required('SUPABASE_URL'),
  publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  secretKey: required('SUPABASE_SECRET_KEY'),
  tokenEncryptionKey: required('SQUARE_TOKEN_ENCRYPTION_KEY'),
});
const worker = createWorker({
  ...adapters,
  config: {
    squareApiVersion: required('SQUARE_API_VERSION'),
    squareBaseUrl,
    squareClientId: required('SQUARE_CLIENT_ID'),
    squareClientSecret: required('SQUARE_CLIENT_SECRET'),
    accountingTimezone,
    enabledJobTypes: ['square.webhook', 'square.sync', 'projection.replay'],
    leaseSeconds: integer('WORKER_LEASE_SECONDS', 120, 30, 900),
    maxJobAttempts: integer('WORKER_MAX_JOB_ATTEMPTS', 5, 1, 12),
    maxBackfillPages: integer('WORKER_MAX_BACKFILL_PAGES', 10000, 1, 20000),
    freshnessTargetMs: integer('WORKER_FRESHNESS_TARGET_MS', 86400000, 60000, 2592000000),
  },
  makeSquareClient: options => new SquareApiClient({ ...options, fetchImpl: fetch }),
  fetchImpl: fetch,
});

const workerId = process.env.WORKER_ID?.trim() || `${hostname()}:${process.pid}:${randomUUID()}`;
const pollMs = integer('WORKER_POLL_MS', 3000, 250, 60000);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
const log = (level, event, fields = {}) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level, event, workerId, ...fields })}\n`);

log('info', 'worker_started', { squareEnvironment, enabledJobTypes: ['square.webhook', 'square.sync', 'projection.replay'] });
while (!stopping) {
  try {
    const result = await worker.runOne({ workerId });
    if (result.status !== 'idle') log(result.status === 'completed' ? 'info' : 'warn', 'job_finished', {
      status: result.status, jobId: result.jobId, code: result.code,
      failureStatus: result.failureStatus, failureCode: result.failureCode,
      gapWriteStatus: result.gapWriteStatus, gapWriteCode: result.gapWriteCode,
    });
    if (result.status !== 'completed' && !stopping) await new Promise(resolve => setTimeout(resolve, pollMs));
  } catch (error) {
    log('error', 'worker_poll_failed', { status: error?.status ?? null, code: error?.code ?? 'WORKER_POLL_FAILED' });
    if (!stopping) await new Promise(resolve => setTimeout(resolve, Math.min(30000, pollMs * 3)));
  }
}
log('info', 'worker_stopped');
