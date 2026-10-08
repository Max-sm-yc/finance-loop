'use client';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { browserSupabase } from '@/lib/browser-supabase';
import { api, type AuditEvent, type Dashboard, type FinancialEvent, type Issue, type Movement } from '@/lib/api';
import PurchaseReceipts from './PurchaseReceipts';
import UiIcon, { type IconName } from './UiIcon';

type Page = 'overview' | 'income' | 'cash' | 'purchases' | 'review' | 'ledger' | 'financial' | 'settings' | 'analytics';
type Features = { inventoryTracking: boolean; productAnalytics: boolean };
type InventoryMovement = { id: string; item_id: string; item_name: string; quantity_delta: number; occurred_at: string; movement_type?: string; reason?: string };
type InventorySnapshot = { asOf: string; status?: string; issues?: Array<{ code: string }>; sourceCoverage?: unknown; sourceHealth?: unknown[]; items?: Array<{ id: string; name: string; currency: string; sku?: string | null; square_catalog_object_id?: string | null; item_kind?: string }>; balances?: Array<{ itemDefinitionId: string; itemName: string; currency: string; quantity: number | null }> };
type SquareInventoryCount = { variationId: string; itemName: string; variationName: string; sku?: string | null; locationId: string; locationName: string; state: string; quantity: number | null; calculatedAt: string | null; sourceVersion: string | null; squareVariationId: string; squareLocationId: string; sourceMappingId: string; locationMappingId: string };
type PurchaseLineInput = { itemId: string; quantity: string; unitCost: string };
type AnalyticsProduct = { productId: string; productName?: string | null; unitsSold: number; revenueMinor: number | null; costMinor: number | null; netMinor: number | null; grossMinor?: number | null; discountMinor?: number | null; refundsMinor?: number | null; revenueRank?: number | null; netRank?: number | null; revenueShareBps?: number | null; marginBps?: number | null; dailySales?: Array<{ period: string; revenueMinor: number | null }>; sourceRefs?: string[] };
type AnalyticsCatalogItem = { id: string; squareItemId?: string | null; sourceMappingId?: string | null; expectedSquareVersion?: string | null; itemSourceMappingId?: string | null; itemExpectedSquareVersion?: string | null; itemName: string; variationName?: string | null; description?: string | null; sku?: string | null; currency?: string | null; sellingPriceMinor: number | null; pricingType?: string | null; unitCostMinor: number | null; costEffectiveFrom?: string | null; archived?: boolean; itemKind: 'square' | 'supply' };
type DomainDraftCatalogItem = { itemId: string; name: string; description: string; status: string; revision: number; variations: Array<{ id: string; name: string; sku: string | null; barcode: string | null; unitOfMeasure: string; priceMinor: number | null; currency: string | null; status: string }> };
type AnalyticsSeries = { period: string; revenueMinor: number | null; costMinor: number | null; feesMinor: number | null; netMinor: number | null; unitsSold: number };
type AnalyticsReport = { calculationVersion: string; status: string; currency: string | null; sourceRevision?: number | null; products: AnalyticsProduct[]; catalogItems?: AnalyticsCatalogItem[]; catalogStatus?: 'available' | 'unavailable'; totals: { revenueMinor: number | null; costMinor: number | null; netMinor: number | null; feesMinor: number | null; refundsMinor: number | null }; unallocated: { revenueMinor: number | null; refundsMinor: number | null; feesMinor: number | null; cogsReversalMinor?: number | null }; issues: Array<{ code: string; sourceRefs?: string[] }>; daily?: AnalyticsSeries[]; monthly?: AnalyticsSeries[] };
type CatalogVariationDraft = { name: string; sku: string; pricingType: 'FIXED_PRICING' | 'VARIABLE_PRICING'; price: string; currency: string };
type CatalogDialogMode = 'create' | 'draft_create' | 'edit_item' | 'edit_variation' | 'add_variation' | 'cost' | 'archive' | 'restore';
const UUID_INPUT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Organization = { id: string; name: string; base_currency?: string; timezone?: string; role?: string };
type IssueEvidence = { id: string; type?: 'sale_line' | 'refund'; occurred_at?: string; currency?: string; quantity?: string | number; amount_minor?: string | number; gross_minor?: string | number; unit_price_minor?: string | number; discount_minor?: string | number; catalog_object_id?: string | null; item_name?: string | null; provider_object_id?: string; line_id?: string; refund_id?: string; order_id?: string; status?: string };
type IssueSourceProblem = { objectId?: string; fields?: string[] };
type IssueReviewContext = { summary: string; nextStep: string; resource: string; gapCode: string; problems: IssueSourceProblem[]; queueSync: boolean; providerCode?: string; providerStatus?: number; eventType?: string; objectId?: string; jobId?: string };
const supportsIssueEvidence = (issue: Issue) => ['UNKNOWN_ITEM', 'REFUND_COGS_REVIEW'].includes(issue.code ?? '');
const ISSUE_FIELD_LABELS: Record<string, string> = {
  missing_occurred_at: 'event date or time is missing',
  missing_currency: 'currency is missing',
  unsupported_or_missing_quantity: 'quantity is missing or unsupported',
  missing_square_sales_amount: 'sale amount is missing',
  missing_square_payment_or_fee_amount: 'payment amount or fee is missing',
  missing_square_refund_amount: 'refund amount is missing',
  missing_square_payout_amount: 'payout amount is missing',
  missing_square_gift_card_amount: 'gift card amount is missing',
  unsupported_gift_card_activity_type: 'gift card activity type is unsupported',
};
function sourceGapReviewContext(issue: Issue): IssueReviewContext | null {
  if (!['SOURCE_GAP', 'SOURCE_STALE'].includes(issue.code ?? '')) return null;
  const details = issue.details ?? {};
  const gapCode = typeof details.code === 'string' && details.code ? details.code : issue.code ?? 'SOURCE_GAP';
  const resourceValue = typeof details.resource === 'string' ? details.resource : '';
  const formattedResource = resourceValue.replace(/[._-]+/g, ' ').toLowerCase().replace(/^square\s+/, '');
  const resource = formattedResource || 'overall sync';
  const problems = Array.isArray(details.problems)
    ? details.problems.flatMap(problem => {
      if (!problem || typeof problem !== 'object' || Array.isArray(problem)) return [];
      const row = problem as IssueSourceProblem;
      return [{
        ...(typeof row.objectId === 'string' ? { objectId: row.objectId } : {}),
        ...(Array.isArray(row.fields) ? { fields: row.fields.filter((field): field is string => typeof field === 'string').slice(0, 20) } : {}),
      }];
    }).slice(0, 20)
    : [];

  let summary = `Square reported incomplete ${resource} data (${gapCode.replaceAll('_', ' ').toLowerCase()}).`;
  let nextStep = 'Sync the selected period. If the gap returns, check the Square connection and permissions with the workspace owner, then share the issue ID with support. Leave the issue open until the source data is complete.';
  if (issue.code === 'SOURCE_STALE') {
    summary = 'No recent successful Square sync is recorded, so the source data may be out of date.';
    nextStep = 'Sync the selected period; the workspace updates automatically when the worker finishes.';
  } else if (gapCode === 'NORMALIZATION_MISSING_MONEY_OR_IDENTITY') {
    summary = problems.length
      ? `${problems.length} Square source record${problems.length === 1 ? ' is' : 's are'} missing required information.`
      : `Square ${resource} records are missing required information.`;
    nextStep = 'Check the listed records in Square. Once Square has complete data, sync the selected period. If Square does not provide the missing fields, leave this open and share the issue ID with support.';
  } else if (gapCode === 'PROCESSING_FEE_UNAVAILABLE') {
    summary = 'Square has not supplied a processing fee for one or more completed payments, so fee and margin totals are incomplete.';
    nextStep = 'Sync the selected period again after Square finishes reporting payout entries. If the fee remains unavailable, leave the issue open and share it with support.';
  } else if (gapCode === 'PERMISSION_LOST') {
    summary = `Square denied access to ${resource} during sync.`;
    nextStep = 'Ask a workspace owner to reconnect Square with read access for this source, then sync the selected period.';
  } else if (gapCode === 'RATE_LIMITED') {
    summary = `Square temporarily rate-limited the ${resource} sync.`;
    nextStep = 'Wait a few minutes, then ask a workspace owner to sync the selected period again.';
  } else if (gapCode === 'BACKFILL_INCOMPLETE') {
    summary = `The Square sync did not finish loading ${resource}.`;
    nextStep = 'Ask a workspace owner to sync the selected period again. If it fails repeatedly, check the Square connection and share the issue ID with support.';
  } else if (gapCode === 'AUTHORITATIVE_OBJECT_MISSING') {
    summary = 'A Square event referred to a record that the app could not retrieve from Square.';
    nextStep = 'Confirm the transaction exists in the connected Square account, then sync the selected period. Developer Explorer sample events can refer to synthetic records that cannot be fetched.';
  } else if (gapCode === 'UNSUPPORTED_WEBHOOK_ACTIVITY') {
    summary = 'Square sent an activity type the app cannot process yet.';
    nextStep = 'A catch-up sync is queued automatically. The workspace updates when it finishes; if the issue remains, share the issue ID with support.';
  } else if (gapCode === 'GIFT_CARD_ACTIVITY_LINKAGE_MISSING') {
    summary = 'A gift card sale is missing its matching activation or load record.';
    nextStep = 'Check the related gift card activity in Square, then ask a workspace owner to sync the selected period again. Leave the issue open if the matching activity is absent.';
  } else if (gapCode === 'SOURCE_GAP' && typeof details.jobId === 'string') {
    summary = `A Square ${resource} job failed, so its source data may be incomplete.`;
    nextStep = 'Sync the selected period. If the gap returns, have the workspace owner check the Square connection and permissions, then share the issue ID and worker job with support.';
  }

  return {
    summary, nextStep, resource, gapCode, problems,
    queueSync: !['PERMISSION_LOST', 'UNSUPPORTED_WEBHOOK_ACTIVITY'].includes(gapCode),
    ...(typeof details.providerCode === 'string' ? { providerCode: details.providerCode } : {}),
    ...(Number.isSafeInteger(details.providerStatus) ? { providerStatus: Number(details.providerStatus) } : {}),
    ...(typeof details.eventType === 'string' ? { eventType: details.eventType } : {}),
    ...(typeof details.objectId === 'string' ? { objectId: details.objectId } : {}),
    ...(typeof details.jobId === 'string' ? { jobId: details.jobId } : {}),
  };
}
function issueFieldLabel(field: string) { return ISSUE_FIELD_LABELS[field] ?? field.replaceAll('_', ' ').toLowerCase(); }
const NAV: Array<{ id: Page; label: string; icon: IconName }> = [
  { id: 'overview', label: 'Overview', icon: 'overview' }, { id: 'income', label: 'Sales', icon: 'sales' },
  { id: 'cash', label: 'Cash & inventory', icon: 'cash' }, { id: 'analytics', label: 'Analytics', icon: 'analytics' }, { id: 'review', label: 'Reviews', icon: 'review' },
  { id: 'purchases', label: 'Receipts', icon: 'receipt' },
  { id: 'financial', label: 'Financial ledger', icon: 'activity' }, { id: 'ledger', label: 'Activity', icon: 'activity' }, { id: 'settings', label: 'Settings', icon: 'settings' },
];
const money = (minor?: number | null, currency = 'USD') => {
  if (minor == null) return '—';
  const fractionDigits = new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / (10 ** (fractionDigits ?? 2)));
};
function sourceMinor(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function passThroughUnitPriceMinor(line: IssueEvidence) {
  const quantity = Number(line.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1) return null;
  const gross = sourceMinor(line.gross_minor), discount = sourceMinor(line.discount_minor);
  if (gross !== null && discount !== null) {
    const chargedLineAmount = gross - discount;
    return chargedLineAmount >= 0 && chargedLineAmount % quantity === 0 ? chargedLineAmount / quantity : null;
  }
  const sourceUnitPrice = sourceMinor(line.unit_price_minor);
  if (sourceUnitPrice !== null && sourceUnitPrice >= 0) return sourceUnitPrice;
  return gross !== null && gross >= 0 && gross % quantity === 0 ? gross / quantity : null;
}
function minorInput(value: number, currency: string) {
  const digits = new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const amount = value / (10 ** digits);
  return digits ? amount.toFixed(digits) : String(amount);
}
function passThroughReason(unitPriceMinor: number, currency: string) {
  return `Square provided no item name or catalog variation. Per merchant pass-through policy, use the unit price supported by Square sale evidence (${money(unitPriceMinor, currency)}) as COGS for this exact sale line because the item cannot be matched to a supplier-backed cost.`;
}
function parseMinor(value: string, currency: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const digits = new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > digits) return null;
  const places = digits, scale = 10 ** places;
  const total = Number(whole) * scale + Number((fraction + '0'.repeat(places)).slice(0, places) || '0');
  return Number.isSafeInteger(total) ? total : null;
}
const date = (value?: string | null) => value ? new Date(value).toLocaleString() : '—';
function relativeTime(value?: string | null) {
  if (!value) return null;
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return null;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
function periodLabel(from: string, to: string) {
  if (!from || !to) return 'Select period';
  const startDate = new Date(`${from}T00:00:00.000Z`), endDate = new Date(`${to}T00:00:00.000Z`);
  const short = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (from.slice(0, 4) === to.slice(0, 4)) return `${short.format(startDate)} – ${short.format(endDate)}, ${to.slice(0, 4)}`;
  const full = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `${full.format(startDate)} – ${full.format(endDate)}`;
}
function zonedMidnight(dateText: string, timezone = 'UTC') {
  const [year, month, day] = dateText.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    instant += target - represented;
  }
  return new Date(instant).toISOString();
}
function todayInTimezone(timezone = 'UTC') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const nextDate = (dateText: string) => new Date(Date.parse(`${dateText}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const localDateTimeNow = () => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

export default function Home() {
  const [user, setUser] = useState<{ id: string; email?: string | null } | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [page, setPage] = useState<Page>('overview');
  const [visitedPages, setVisitedPages] = useState<Set<Page>>(() => new Set(['overview']));
  const [purchaseReceiptId, setPurchaseReceiptId] = useState('');
  const pendingReceiptOrganizationId = useRef('');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [features, setFeatures] = useState<Features | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncQueued, setSyncQueued] = useState(false);
  const syncQueuedRef = useRef(false);
  const syncBaselineRef = useRef<string | null>(null);
  const syncBaselineStatusRef = useRef<string | null>(null);
  const [syncStatus, setSyncStatus] = useState('');
  const [syncError, setSyncError] = useState('');
  const [, setClockTick] = useState(0);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState(() => new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const loadSequence = useRef(0);
  const supabase = useMemo(() => { try { return browserSupabase(); } catch { return null; } }, []);
  const reportTimezone = dashboard?.organization?.timezone ?? 'UTC';

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick(tick => tick + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  function navigate(nextPage: Page) {
    setVisitedPages(current => current.has(nextPage) ? current : new Set(current).add(nextPage));
    setPage(nextPage);
  }

  useEffect(() => {
    if (!supabase) { setError('Supabase is not configured. Add the project URL and publishable key to the web environment.'); setLoadingAuth(false); return; }
    supabase.auth.getUser().then(({ data }) => { setUser(data.user); setLoadingAuth(false); }).catch(() => { setError('Could not validate your sign-in session. Try again.'); setLoadingAuth(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => { loadSequence.current += 1; setFeatures(null); setUser(session?.user ?? null); });
    return () => listener.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    const receiptId = new URLSearchParams(window.location.search).get('purchaseReceipt');
    if (!receiptId) return;
    pendingReceiptOrganizationId.current = new URLSearchParams(window.location.search).get('organizationId') ?? '';
    setPurchaseReceiptId(receiptId);
    setPage('purchases');
    setVisitedPages(current => current.has('purchases') ? current : new Set(current).add('purchases'));
  }, []);

  useEffect(() => {
    if (!user || !supabase) { setOrganizations([]); setOrganizationId(''); return; }
    let active = true;
    void (async () => {
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      if (!currentUser?.id) return;
      const { data: memberships, error: membershipError } = await supabase.from('memberships').select('organization_id,role').eq('user_id', currentUser.id);
      if (!active) return;
      if (membershipError) { setError('Could not load your workspace memberships.'); return; }
      const ids = [...new Set((memberships ?? []).map(row => row.organization_id as string))];
      if (!ids.length) { setOrganizations([]); setOrganizationId(''); return; }
      const { data: orgRows, error: organizationError } = await supabase.from('organizations').select('id,name').in('id', ids);
      if (!active) return;
      if (organizationError) { setError('Could not load your organization details.'); return; }
      const roleByOrganization = new Map((memberships ?? []).map(row => [row.organization_id as string, row.role as string | undefined]));
      const options = ((orgRows ?? []) as Organization[]).map(org => ({ ...org, role: roleByOrganization.get(org.id) }));
      setOrganizations(options);
      const requestedReceiptOrganizationId = pendingReceiptOrganizationId.current;
      pendingReceiptOrganizationId.current = '';
      setOrganizationId(current => requestedReceiptOrganizationId && options.some(org => org.id === requestedReceiptOrganizationId)
        ? requestedReceiptOrganizationId
        : options.some(org => org.id === current) ? current : options[0]?.id ?? '');
    })();
    return () => { active = false; };
  }, [user, supabase]);

  async function load() {
    if (!user || !organizationId) return;
    const sequence = ++loadSequence.current;
    setBusy(true); setError('');
    const query = new URLSearchParams({ organizationId, from: zonedMidnight(from, reportTimezone), to: zonedMidnight(nextDate(to), reportTimezone), ...(accountId ? { accountId } : {}) });
    const orgQuery = new URLSearchParams({ organizationId });
    const tasks: Promise<unknown>[] = [api<Record<string, unknown>>(`/api/dashboard?${query}`), api<{ issues: Issue[] }>(`/api/issues?${orgQuery}&state=open`), api<{ movements: Movement[] }>(`/api/manual-movements?${query}`), api<{ events: AuditEvent[] }>(`/api/audit?${orgQuery}&limit=200`), api<{ settings: { organization?: Organization; accounts?: Dashboard['accounts']; features?: Features } }>(`/api/settings?${orgQuery}`)];
    const results = await Promise.allSettled(tasks);
    if (sequence !== loadSequence.current) return;
    if (results[4].status === 'fulfilled') {
      const settings = (results[4].value as { settings: { features?: Features } }).settings;
      const enabled = { inventoryTracking: settings.features?.inventoryTracking === true, productAnalytics: settings.features?.productAnalytics === true };
      setFeatures(enabled); if (page === 'analytics' && !enabled.productAnalytics) navigate('overview');
    } else setFeatures({ inventoryTracking: false, productAnalytics: false });
    if (results[0].status === 'fulfilled' && results[4].status === 'fulfilled') {
      const raw = results[0].value as Record<string, unknown>; const settings = (results[4].value as { settings: { organization?: Organization; accounts?: Dashboard['accounts']; features?: Features } }).settings;
      const projection = (raw.projection ?? raw.run ?? {}) as Record<string, any>; const result = (projection.result ?? raw.result ?? {}) as Record<string, any>;
      const accountRows = Array.isArray(result.accounts) ? result.accounts as Array<Record<string, unknown>> : [];
      const accountCash = accountRows.find(x => x.accountId === accountId) ?? accountRows[0];
      const rawFreshness = raw.freshness;
      const data: Dashboard = {
        organization: settings.organization,
        accounts: settings.accounts ?? [],
        period: (raw.period as Dashboard['period']) ?? { from: String(projection.period_start ?? from), to: String(projection.period_end ?? to), currency: String(result.income?.currency ?? settings.organization?.base_currency ?? 'USD') },
        projectionVersion: String(raw.projectionVersion ?? projection.calculation_version ?? 'unavailable'),
        freshness: typeof rawFreshness === 'string' ? { status: rawFreshness, lastSyncedAt: typeof raw.lastSyncedAt === 'string' ? raw.lastSyncedAt : null } : rawFreshness as Dashboard['freshness'],
        income: (raw.income ?? result.income) as Dashboard['income'],
        cash: (raw.cash ?? accountCash ?? result.cash) as Dashboard['cash'],
        flags: (raw.flags ?? result.issues ?? []) as Dashboard['flags'],
      };
      if (syncQueuedRef.current) {
        const latestSync = data.freshness?.lastSyncedAt ?? null;
        const syncFailed = data.freshness?.status === 'failed' && syncBaselineStatusRef.current !== 'failed';
        if ((latestSync && latestSync !== syncBaselineRef.current) || syncFailed) {
          syncQueuedRef.current = false; setSyncQueued(false);
          setSyncStatus(syncFailed ? 'Square reported a sync problem. Review source status and open issues.' : 'Square sync finished. Workspace data was updated automatically.');
        }
      }
      setDashboard(data);
      if (!accountId && data.accounts?.length) setAccountId(data.accounts[0].id);
    }
    if (results[1].status === 'fulfilled') setIssues((results[1].value as { issues: Issue[] }).issues ?? []);
    if (results[2].status === 'fulfilled') setMovements((results[2].value as { movements: Movement[] }).movements ?? []);
    if (results[3].status === 'fulfilled') setEvents((results[3].value as { events: AuditEvent[] }).events ?? []);
    if (results[4].status === 'rejected' && page === 'analytics') navigate('overview');
    const rejected = results.find(x => x.status === 'rejected') as PromiseRejectedResult | undefined;
    if (rejected) setError(rejected.reason instanceof Error ? rejected.reason.message : 'Some workspace data could not be loaded.');
    setBusy(false);
  }
  useEffect(() => { void load(); /* Refreshed when filters or identity change. */ }, [user, organizationId, accountId, from, to, reportTimezone]);

  useEffect(() => {
    if (!syncQueued || !organizationId) return;
    let checks = 0;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      checks += 1;
      if (checks >= 24) {
        syncQueuedRef.current = false; setSyncQueued(false);
        setSyncStatus('Square is still processing this sync. The workspace checked automatically and will show new data when it is available.');
        return;
      }
      void load();
    }, 15_000);
    return () => window.clearInterval(timer);
    // Keep checking the selected report window while its durable Square job runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncQueued, organizationId, from, to, accountId, reportTimezone]);

  async function signIn(e: FormEvent) {
    e.preventDefault(); if (!supabase) return;
    setBusy(true); setError('');
    try { const { error: authError } = await supabase.auth.signInWithPassword({ email, password }); if (authError) setError(authError.message); }
    catch { setError('Sign in could not reach the authentication service. Try again.'); }
    finally { setBusy(false); }
  }
  async function signOut() { loadSequence.current += 1; await supabase?.auth.signOut(); setDashboard(null); setIssues([]); setMovements([]); setEvents([]); setFeatures(null); syncQueuedRef.current = false; setSyncQueued(false); setSyncStatus(''); setSyncError(''); }
  async function syncSelectedPeriod(): Promise<boolean> {
    if (!organizationId || !from || !to || from > to) {
      setSyncError('Choose a valid period before syncing.'); setSyncStatus(''); return false;
    }
    setSyncing(true); setSyncError(''); setSyncStatus(''); setSyncQueued(false); syncQueuedRef.current = false;
    syncBaselineRef.current = dashboard?.freshness?.lastSyncedAt ?? null;
    syncBaselineStatusRef.current = dashboard?.freshness?.status ?? null;
    try {
      const result = await api<{ skipped?: boolean; reason?: 'PERIOD_CURRENT' | 'SYNC_IN_PROGRESS'; queuedWindows?: number; syncScope?: 'period' | 'uncovered' }>('/api/sync', {
        method: 'POST',
        headers: { 'Idempotency-Key': `square-sync:${crypto.randomUUID()}` },
        body: JSON.stringify({
          organizationId,
          startAt: zonedMidnight(from, reportTimezone),
          endAt: zonedMidnight(nextDate(to), reportTimezone),
        }),
      });
      if (result.skipped) {
        const alreadyRunning = result.reason === 'SYNC_IN_PROGRESS';
        syncQueuedRef.current = alreadyRunning; setSyncQueued(alreadyRunning);
        setSyncStatus(result.reason === 'SYNC_IN_PROGRESS'
          ? `A Square sync covering ${from} through ${to} is already queued or running.`
          : `Square data for ${from} through ${to} is already covered and current. The report uses the stored facts.`);
      } else if (result.syncScope === 'uncovered') {
        const count = result.queuedWindows ?? 1;
        syncQueuedRef.current = true; setSyncQueued(true);
        setSyncStatus(`Sync queued for ${count} uncovered ${count === 1 ? 'date range' : 'date ranges'} within ${from} through ${to}. The workspace will update automatically when it finishes.`);
      } else {
        syncQueuedRef.current = true; setSyncQueued(true);
        setSyncStatus(`Sync queued for ${from} through ${to}. The workspace will update automatically when it finishes.`);
      }
      return true;
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : '';
      const messages: Record<string, string> = {
        FORBIDDEN: 'Only workspace owners can start a Square sync.',
        SQUARE_NOT_CONNECTED: 'Square is not connected to this workspace. Connect Square, then try again.',
        SQUARE_RECONNECT_REQUIRED: 'Square authorization needs to be renewed. Reconnect Square, then try again.',
        SQUARE_PERMISSION_REQUIRED: 'Square did not grant access to its locations. Reconnect Square with the requested read access.',
        SQUARE_NO_ACTIVE_LOCATIONS: 'Square has no active locations to sync.',
        SQUARE_LOCATION_LIMIT_EXCEEDED: 'This Square account has more locations than one sync can include. Contact support.',
        SYNC_WINDOW_TOO_LARGE: 'A sync can cover up to 366 days. Shorten the selected period and try again.',
        SQUARE_SYNC_UNAVAILABLE: 'Square sync is not configured for this environment.',
        SQUARE_LOCATIONS_UNAVAILABLE: 'Square locations could not be loaded. Try again shortly.',
        SQUARE_SYNC_STATUS_UNAVAILABLE: 'Square sync coverage could not be checked. Try again shortly.',
      };
      setSyncError(messages[code] ?? 'The sync could not be queued. Try again shortly.');
      return false;
    } finally { setSyncing(false); }
  }
  const currency = dashboard?.period?.currency ?? dashboard?.income?.currency ?? 'USD';
  const openIssues = issues.filter(i => !['resolved', 'approved', 'rejected'].includes(i.state));
  const isWorkspaceOwner = organizations.find(org => org.id === organizationId)?.role === 'owner';
  const sourceFreshness = dashboard?.freshness?.status ?? 'unknown';
  const sourceFreshnessTone = ({ fresh: 'good', incomplete: 'warn', stale: 'warn', failed: 'bad', unknown: 'neutral' } as Record<string, string>)[sourceFreshness] ?? 'neutral';
  const sourceFreshnessLabel = ({ fresh: 'Synced with Square', incomplete: 'Sync incomplete', stale: 'Sync overdue', failed: 'Sync failed', unknown: 'Sync status unavailable' } as Record<string, string>)[sourceFreshness] ?? 'Sync status unavailable';
  const sourceSyncAge = relativeTime(dashboard?.freshness?.lastSyncedAt);
  const sourceSyncSummary = sourceFreshness === 'fresh'
    ? sourceSyncAge ? `Synced ${sourceSyncAge}` : sourceFreshnessLabel
    : `${sourceFreshnessLabel}${sourceSyncAge ? ` · ${sourceSyncAge}` : ''}`;

  if (loadingAuth) return <main className="auth-screen"><div className="auth-card">Loading secure workspace…</div></main>;
  if (!user) return <main className="auth-screen"><form className="auth-card" onSubmit={signIn}>
    <div className="brand-lockup"><div className="brand-assets"><img className="brand-icon" src="/vernius-icon.svg" alt="" /><img className="brand-wordmark" src="/vernius-wordmark.svg" alt="Vernius" /></div><small>OPERATIONS ACCOUNTING</small></div>
    <p className="eyebrow">SECURE WORKSPACE</p><h1>Sign in</h1>
    <label>Email address<input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
    <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
    {error && <p className="error" role="alert">{error}</p>}<button className="primary full" disabled={busy || !supabase}>{busy ? 'Signing in…' : 'Sign in'}</button>
    <p className="tiny muted">Access is provided by your workspace administrator.</p>
  </form></main>;

  // Keep Analytics in its final slot while flags load; settings still hide it when disabled.
  const navItems = NAV.filter(x => x.id !== 'analytics' || features === null || features.productAnalytics);
  const title = navItems.find(x => x.id === page)?.label ?? 'Overview';
  return <div className="shell">
    <aside className="sidebar"><div className="brand-lockup"><div className="brand-assets"><img className="brand-icon" src="/vernius-icon.svg" alt="" /><img className="brand-wordmark" src="/vernius-wordmark.svg" alt="Vernius" /></div><small>WORKSPACE</small></div>
      <div className="workspace"><span className="workspace-mark">{dashboard?.organization?.name?.slice(0, 1) ?? 'O'}</span><span><b>{dashboard?.organization?.name ?? 'Your workspace'}</b><small>Organization workspace</small></span></div>
      <nav aria-label="Main navigation">{navItems.map(item => <button key={item.id} className={`nav-link ${page === item.id ? 'selected' : ''}`} onClick={() => navigate(item.id)} aria-current={page === item.id ? 'page' : undefined}><UiIcon name={item.icon} size={17} />{item.label}{item.id === 'review' && openIssues.length > 0 && <i>{openIssues.length}</i>}</button>)}</nav>
      <div className="sidebar-foot"><div className="profile"><span className="avatar">{user.email?.slice(0, 1).toUpperCase() ?? 'U'}</span><span className="profile-info"><b>{user.email}</b><small>Signed in</small></span><button className="icon-button" onClick={signOut} title="Sign out" aria-label="Sign out"><UiIcon name="signOut" /></button></div></div>
    </aside>
    <section className="main-area"><header className="topbar"><div className="top-controls" role="group" aria-label={`Workspace and reporting controls. Period dates use ${reportTimezone}`}>{organizations.length > 1 && <label className="compact organization-picker">Organization<select value={organizationId} onChange={e => { loadSequence.current += 1; setOrganizationId(e.target.value); setAccountId(''); setDashboard(null); setFeatures(null); syncQueuedRef.current = false; setSyncQueued(false); setSyncStatus(''); setSyncError(''); if (page === 'analytics') setPage('overview'); }}><option value="">Choose workspace</option>{organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}</select></label>}<details className="period-picker"><summary aria-label={`Reporting period ${periodLabel(from, to)}`}>{periodLabel(from, to)}<span aria-hidden="true">⌄</span></summary><div className="period-popover"><label>Start date<input aria-label="Period start date" type="date" value={from} onChange={e => { setFrom(e.target.value); setSyncStatus(''); setSyncError(''); }} /></label><label>End date<input aria-label="Period end date" type="date" value={to} onChange={e => { setTo(e.target.value); setSyncStatus(''); setSyncError(''); }} /></label><small>{reportTimezone}</small></div></details></div><div className="sync-controls"><span className={`sync-source tone-${sourceFreshnessTone}`} role="status" aria-live="polite" title={dashboard?.freshness?.lastSyncedAt ? `Last successful Square sync ${date(dashboard.freshness.lastSyncedAt)}` : sourceFreshnessLabel}><i className="sync-source-dot" aria-hidden="true" />{syncQueued ? 'Sync queued · checking automatically' : `Square · ${sourceSyncSummary}`}</span>{isWorkspaceOwner && <button className="primary with-icon sync-data-button" onClick={() => void syncSelectedPeriod()} disabled={syncing || busy || syncQueued} title="Fetch latest data from Square and connected sources" aria-label="Sync data"><UiIcon name="sync" />{syncing ? 'Starting…' : 'Sync data'}</button>}</div></header>
      <main className="page"><div className="page-head"><div><p className="eyebrow">{dashboard?.organization?.name ?? 'FINANCIAL OPERATIONS'}</p><h1>{title}</h1></div></div>
        {error && <div className="notice error-box" role="alert"><b>Data request needs attention</b><span>{error}</span></div>}
        {syncError && <div className="notice error-box" role="alert"><b>Sync could not start</b><span>{syncError}</span></div>}
        {syncStatus && <div className="notice" role="status"><b>Sync status</b><span>{syncStatus}</span></div>}
        {!organizationId ? <section className="empty-state"><div className="empty-icon">⌁</div><h2>{organizations.length ? 'Choose a workspace' : 'No workspace membership found'}</h2><p>Ask a workspace owner to add your account.</p></section> : !dashboard ? <section className="empty-state"><div className="empty-icon">⌁</div><h2>{busy ? 'Loading workspace data' : 'No projection available yet'}</h2><p>A completed projection will appear here.</p><button className="secondary with-icon" onClick={() => void load()}><UiIcon name="refresh" />Retry</button></section> : <>
          {visitedPages.has('overview') && <div hidden={page !== 'overview'}><Overview dashboard={dashboard} currency={currency} issues={openIssues} events={events} accountId={accountId} userId={user.id} onNavigate={navigate} /></div>}
          {visitedPages.has('income') && <div hidden={page !== 'income'}><Income dashboard={dashboard} currency={currency} /><GiftCardSummary income={dashboard.income} currency={currency} /></div>}
          {visitedPages.has('cash') && <div hidden={page !== 'cash'}><Cash key={organizationId} dashboard={dashboard} currency={currency} movements={movements} accounts={dashboard.accounts ?? []} accountId={accountId} organizationId={organizationId} inventoryEnabled={features?.inventoryTracking === true} canManageSquareCatalog={organizations.find(org => org.id === organizationId)?.role === 'owner'} canAuthorizeSquareCatalog={organizations.find(org => org.id === organizationId)?.role === 'owner'} onAccount={setAccountId} onSaved={() => void load()} /></div>}
          {visitedPages.has('purchases') && <div hidden={page !== 'purchases'}><PurchaseReceipts key={organizationId} organizationId={organizationId} role={organizations.find(org => org.id === organizationId)?.role ?? 'read_only'} accounts={dashboard.accounts ?? []} currency={currency} initialReceiptId={purchaseReceiptId} active={page === 'purchases'} onSaved={() => void load()} /></div>}
          {visitedPages.has('analytics') && features?.productAnalytics === true && <div hidden={page !== 'analytics'}><Analytics key={organizationId} organizationId={organizationId} from={zonedMidnight(from, reportTimezone)} to={zonedMidnight(nextDate(to), reportTimezone)} currency={currency} timezone={reportTimezone} refreshKey={dashboard.freshness?.lastSyncedAt ?? ''} role={organizations.find(org => org.id === organizationId)?.role ?? 'read_only'} /></div>}
          {visitedPages.has('review') && <div hidden={page !== 'review'}><Review key={organizationId} issues={openIssues} organizationId={organizationId} currency={currency} canSync={organizations.find(org => org.id === organizationId)?.role === 'owner'} syncPeriodLabel={periodLabel(from, to)} onSaved={() => void load()} /></div>}
          {visitedPages.has('ledger') && <div hidden={page !== 'ledger'}><Ledger organizationId={organizationId} events={events} /></div>}
          {visitedPages.has('financial') && <div hidden={page !== 'financial'}><FinancialLedger organizationId={organizationId} from={zonedMidnight(from, reportTimezone)} to={zonedMidnight(nextDate(to), reportTimezone)} /></div>}
          {visitedPages.has('settings') && <div hidden={page !== 'settings'}><Settings organizationId={organizationId} userId={user.id} role={organizations.find(org => org.id === organizationId)?.role ?? 'read_only'} dashboard={dashboard} accountId={accountId} onAccount={setAccountId} /></div>}
          <footer className="projection-foot"><span>{dashboard.period?.from ?? from} – {dashboard.period?.to ?? to} · {currency}</span><details className="system-details"><summary>System details</summary><span>Calculation {dashboard.projectionVersion ?? 'version pending'} · {dashboard.income?.status === 'incomplete' ? 'Margin incomplete' : 'Operational reporting'}</span></details></footer>
        </>}
      </main>
    </section>
  </div>;
}

function Card({ label, value, hint, tone = '' }: { label: string; value: string; hint: string; tone?: string }) { return <article className="metric"><span>{label}</span><strong className={tone}>{value}</strong><small>{hint}</small></article>; }
function FoldablePanel({ title, description, actions, className = '', children }: {
  title: string; description?: string; actions?: ReactNode; className?: string; children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  return <section className={`panel foldable-panel ${expanded ? 'is-expanded' : 'is-collapsed'} ${className}`}>
    <div className="panel-heading foldable-heading">
      <div className="foldable-heading-copy"><h2><button type="button" className="foldable-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}><span className="foldable-chevron" aria-hidden="true">⌄</span>{title}</button></h2>{description && <p>{description}</p>}</div>
      {actions && <div className="foldable-actions">{actions}</div>}
    </div>
    <div id={contentId} className="foldable-content" hidden={!expanded}>{children}</div>
  </section>;
}
function GiftCardSummary({ income, currency }: { income: Dashboard['income']; currency: string }) {
  if (!income || income.giftCardLiabilityChangeMinor === undefined) return null;
  return <section className="panel"><div className="panel-heading"><div><h2>Gift cards</h2><p>Loads are liabilities; redemptions count as item sales.</p></div></div>
    <div className="status-row"><span>Activations and loads</span><b>{money((income.giftCardActivationsMinor ?? 0) + (income.giftCardLoadsMinor ?? 0), currency)}</b></div>
    <div className="status-row"><span>Redemptions</span><b>{money(income.giftCardRedemptionsMinor, currency)}</b></div>
    <div className="status-row"><span>Liability change this period</span><b>{money(income.giftCardLiabilityChangeMinor, currency)}</b></div>
  </section>;
}
function Overview({ dashboard: d, currency: c, issues, events, accountId, userId, onNavigate }: { dashboard: Dashboard; currency: string; issues: Issue[]; events: AuditEvent[]; accountId: string; userId: string; onNavigate: (p: Page) => void }) {
  const income = d.income;
  const cash = d.cash;
  const account = d.accounts?.find(item => item.id === accountId);
  const operationalMarginMinor = income?.status === 'complete' ? income.operationalMarginMinor : null;
  const marginShare = operationalMarginMinor != null && income?.netSalesMinor != null && income.netSalesMinor > 0
    ? `${(operationalMarginMinor / income.netSalesMinor * 100).toFixed(1)}% of net sales`
    : null;
  const marginHint = income?.status === 'incomplete' ? 'Incomplete · source or cost data needs review' : income?.status === 'failed' ? 'Unavailable · calculation failed' : marginShare ?? 'Share unavailable for this period';
  const freshness = d.freshness?.status ?? 'unknown';
  const freshnessLabel = ({ fresh: 'Synced with Square', incomplete: 'Sync incomplete', stale: 'Sync overdue', failed: 'Sync failed', unknown: 'Sync status unavailable' } as Record<string, string>)[freshness] ?? 'Sync status unavailable';
  const freshnessTone = ({ fresh: 'good', incomplete: 'warn', stale: 'warn', failed: 'bad', unknown: 'neutral' } as Record<string, string>)[freshness] ?? 'neutral';
  const flags = d.flags ?? [];
  const activityLabel = (event: AuditEvent) => {
    const action = (event.action ?? event.event_type ?? '').toLowerCase().replaceAll('_', ' ').replaceAll('.', ' ');
    const entity = (event.entity_type ?? '').toLowerCase();
    if (entity.includes('receipt') && action.includes('reprocess')) return 'Receipt reprocessed';
    if (entity.includes('receipt') && /upload|create|submit/.test(action)) return 'Receipt uploaded';
    if ((event.actor_kind ?? '').toLowerCase() === 'system' && /insert|import|upsert/.test(action)) return 'Square transaction imported';
    if (/payout/.test(entity)) return 'Square payout updated';
    if (/receipt/.test(entity)) return 'Receipt updated';
    if (/issue|review/.test(entity)) return 'Review updated';
    if (/insert|import|upsert/.test(action)) return 'New accounting record added';
    if (/reprocess/.test(action)) return 'Record reprocessed';
    if (/upload/.test(action)) return 'Document uploaded';
    const label = action || (event.entity_type ?? 'Workspace update').replaceAll('_', ' ').replaceAll('.', ' ');
    return label.charAt(0).toUpperCase() + label.slice(1);
  };
  const activityActor = (event: AuditEvent) => {
    const actor = (event.actor_kind ?? '').toLowerCase();
    if (actor === 'system' || actor === 'agent') return 'Automated';
    if (actor === 'human') return event.actor_user_id === userId ? 'By you' : 'By a team member';
    return 'Recorded';
  };
  const activityReference = (event: AuditEvent) => {
    const reference = event.source_refs?.[0] ?? event.entity_id;
    return reference && reference.length > 16 ? `${reference.slice(0, 8)}…${reference.slice(-4)}` : reference ?? '';
  };
  const recentEvents = events.slice(0, 4);
  const discountsMinor = income?.discountsMinor;
  const refundsMinor = income?.refundsMinor;
  const discountsAndRefundsMinor = discountsMinor == null || refundsMinor == null ? null : discountsMinor + refundsMinor;
  const balanceValue = cash?.expectedBalanceMinor == null ? account ? 'Unavailable' : '—' : money(cash.expectedBalanceMinor, cash.currency ?? c);
  const balanceHint = !account ? 'No tracked account is configured' : cash?.expectedBalanceMinor == null ? 'Balance evidence is unavailable for this period' : (cash.status ?? 'Expected account balance').replaceAll('_', ' ');
  return <>
    <section className="overview-summary" aria-label="Period summary">
      <article className="summary-metric"><span>Net sales</span><strong>{money(income?.netSalesMinor, c)}</strong><small>{income?.grossItemSalesMinor == null ? 'After discounts and refunds' : `${money(income.grossItemSalesMinor, c)} gross sales`}</small></article>
      <article className="summary-metric"><span>Operational margin</span><strong className={income?.status !== 'complete' ? 'warn-text' : ''}>{money(operationalMarginMinor, c)}</strong><small>{marginHint}</small></article>
      <article className={`summary-metric ${!account ? 'summary-metric-empty' : ''}`}><span>Expected balance</span><strong className={cash?.expectedBalanceMinor == null ? 'value-muted' : ''}>{balanceValue}</strong><small>{balanceHint}</small></article>
      <article className="summary-metric"><span>Reviews</span><strong>{issues.length}</strong><small>{issues.length ? 'Needs attention' : 'All clear'}</small></article>
    </section>

    <section className={`overview-status-strip tone-${freshnessTone}`} aria-label="Square source status">
      <span className="status-indicator" aria-hidden="true" />
      <strong>{freshnessLabel}</strong>
      {d.freshness?.lastSyncedAt ? <span title={date(d.freshness.lastSyncedAt)}>{relativeTime(d.freshness.lastSyncedAt)}</span> : <span>No successful sync</span>}
    </section>

    <div className="overview-content">
      <section className="overview-section income-snapshot">
        <div className="overview-section-heading"><div><h2>Income</h2><p>Cash basis</p></div><button className="text-button with-icon" aria-label="View sales" title="View sales" onClick={() => onNavigate('income')}><UiIcon name="arrowRight" /></button></div>
        <div className="table-wrap"><table className="finance-table"><tbody>
          <tr><td>Gross item sales</td><td className="numeric">{money(income?.grossItemSalesMinor, c)}</td></tr>
          <tr><td>Discounts and refunds</td><td className="numeric">{money(discountsAndRefundsMinor, c)}</td></tr>
          <tr className="subtotal"><td>Net sales</td><td className="numeric">{money(income?.netSalesMinor, c)}</td></tr>
          <tr><td>Cost of goods sold</td><td className="numeric">{money(income?.cogsMinor, c)}</td></tr>
          <tr><td>Square processing fees</td><td className="numeric">{money(income?.squareFeesMinor, c)}</td></tr>
          <tr className="total"><td>Operational margin</td><td className="numeric">{money(operationalMarginMinor, c)}</td></tr>
        </tbody></table></div>
      </section>

      <section className="overview-section reconciliation-summary">
        <div className="overview-section-heading"><div><h2>Cash &amp; reconciliation</h2><p>{account ? `${account.name} · ${account.currency}` : 'Account status'}</p></div><button className="text-button with-icon" aria-label="View cash and inventory" title="View cash and inventory" onClick={() => onNavigate('cash')}><UiIcon name="arrowRight" /></button></div>
        {!account ? <div className="reconciliation-empty"><strong>No account connected</strong><p>A workspace administrator can configure a tracked account to enable reconciliation.</p></div> : <dl className="reconciliation-values">
          <div><dt>Expected balance</dt><dd>{money(cash?.expectedBalanceMinor, cash?.currency ?? account.currency)}</dd></div>
          <div><dt>Observed balance</dt><dd>{money(cash?.observedBalanceMinor, cash?.currency ?? account.currency)}</dd></div>
          <div className={cash?.discrepancyMinor ? 'mismatch' : ''}><dt>Difference</dt><dd>{money(cash?.discrepancyMinor, cash?.currency ?? account.currency)}</dd></div>
        </dl>}
      </section>
    </div>

    <section className={`overview-attention ${flags.length || issues.length ? 'has-issues' : 'clear'}`}>
      <span className="attention-mark" aria-hidden="true">{flags.length || issues.length ? '!' : '✓'}</span>
      <div className="attention-copy"><strong>{flags.length ? 'Projection needs review' : issues.length ? `${issues.length} open ${issues.length === 1 ? 'review' : 'reviews'}` : 'No open review items'}</strong>
        {flags.length ? <span>{flags.slice(0, 2).map(flag => flag.message).join(' · ')}</span> : issues.length ? <span>Review source and reconciliation questions before relying on this period.</span> : <span>No projection exceptions or open review items were returned.</span>}
      </div>
      {(flags.length || issues.length) > 0 && <button className="text-button with-icon" aria-label="Open reviews" title="Open reviews" onClick={() => onNavigate('review')}><UiIcon name="arrowRight" /></button>}
    </section>

    <section className="overview-section recent-activity">
      <div className="overview-section-heading"><div><h2>Recent activity</h2></div><button className="text-button with-icon" aria-label="View activity" title="View activity" onClick={() => onNavigate('ledger')}><UiIcon name="arrowRight" /></button></div>
      {recentEvents.length ? <ul className="activity-list">{recentEvents.map(event => { const reference = activityReference(event); return <li key={event.id}><time dateTime={event.created_at}>{new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(event.created_at))}</time><span>{activityLabel(event)}</span><small>{[reference, activityActor(event)].filter(Boolean).join(' · ')}</small></li>; })}</ul> : <p className="activity-empty">No audit events have been recorded for this workspace yet.</p>}
    </section>
  </>;
}
function Income({ dashboard: d, currency: c }: { dashboard: Dashboard; currency: string }) {
  return <><div className="metric-grid three"><Card label="Gross item sales" value={money(d.income?.grossItemSalesMinor, c)} hint="Before discounts" /><Card label="Net sales" value={money(d.income?.netSalesMinor, c)} hint="After discounts and refunds" /><Card label="Square fees" value={money(d.income?.squareFeesMinor, c)} hint="Completed processing fees" /></div><section className="panel table-panel"><div className="panel-heading"><div><h2>Sales and inventory</h2></div><span className={`pill ${d.income?.status === 'complete' ? 'good' : 'warn'}`}>{d.income?.status ?? 'Not calculated'}</span></div>{d.income?.lines?.length ? <div className="table-wrap"><table><thead><tr><th>Item</th><th className="numeric">Units</th><th className="numeric">Sales</th><th className="numeric">Unit cost</th><th className="numeric">COGS</th><th className="numeric">Margin</th></tr></thead><tbody>{d.income.lines.map((line, i) => <tr key={String(line.id ?? i)}><td>{String(line.itemName ?? line.name ?? 'Unidentified item')}<small className="cell-sub">{String(line.catalogId ?? line.sourceId ?? '')}</small></td><td className="numeric">{String(line.quantity ?? '—')}</td><td className="numeric">{money(Number(line.netSalesMinor), c)}</td><td className="numeric">{line.unitCostMinor == null ? <span className="pill warn">Needs cost</span> : money(Number(line.unitCostMinor), c)}</td><td className="numeric">{money(line.cogsMinor == null ? null : Number(line.cogsMinor), c)}</td><td className="numeric">{money(line.marginMinor == null ? null : Number(line.marginMinor), c)}</td></tr>)}</tbody></table></div> : <div className="inline-empty">No line items for this period.</div>}</section><div className="notice"><b>Policy</b><span>Tax, tips, discounts and refunds follow the projection policy. Missing approved costs leave margin incomplete.</span></div></>;
}
function Cash({ dashboard: d, currency: c, movements, accounts, accountId, organizationId, inventoryEnabled, canManageSquareCatalog, canAuthorizeSquareCatalog, onAccount, onSaved }: { dashboard: Dashboard; currency: string; movements: Movement[]; accounts: NonNullable<Dashboard['accounts']>; accountId: string; organizationId: string; inventoryEnabled: boolean; canManageSquareCatalog: boolean; canAuthorizeSquareCatalog: boolean; onAccount: (v: string) => void; onSaved: () => void }) {
  const [mode, setMode] = useState<'movement' | 'observation' | null>(null); const [kind, setKind] = useState('purchase'); const [amount, setAmount] = useState(''); const [description, setDescription] = useState(''); const [evidenceFile, setEvidenceFile] = useState<File | null>(null); const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16)); const [saving, setSaving] = useState(false); const [formError, setFormError] = useState('');
  async function save(e: FormEvent) { e.preventDefault(); const acct = accounts.find(x => x.id === accountId); if (!acct || !amount || !evidenceFile) return; const minor = Math.round(Number(amount) * 100); if (!Number.isSafeInteger(minor) || minor <= 0) { setFormError('Enter a positive amount with at most two decimal places.'); return; } setSaving(true); setFormError('');
    const key = crypto.randomUUID(); const isObservation = mode === 'observation';
    try { const upload = new FormData(); upload.set('organizationId', organizationId); upload.set('file', evidenceFile); const stored = await api<{ evidence: { id: string } }>('/api/evidence', { method: 'POST', body: upload }); const evidenceRef = stored.evidence.id; await api(isObservation ? '/api/observations' : '/api/manual-movements', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(isObservation ? { organizationId, accountId, amountMinor: minor, currency: acct.currency, observedAt: new Date(occurredAt).toISOString(), evidenceRef } : { organizationId, accountId, kind, amountMinor: ['purchase','pay','misc_spend'].includes(kind) ? -minor : minor, currency: acct.currency, occurredAt: new Date(occurredAt).toISOString(), description: description.trim(), evidenceRef }) }); setMode(null); setAmount(''); setEvidenceFile(null); setDescription(''); onSaved(); }
    catch (err) { setFormError(err instanceof Error ? err.message : 'Could not save this record.'); } finally { setSaving(false); }
  }
  return <><section className="panel filter-panel">{accounts.length ? <><label>Reconciliation account<select value={accountId} onChange={e => onAccount(e.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</select></label><span className={`pill ${d.cash?.status === 'matched' ? 'good' : d.cash?.status === 'mismatch' ? 'warn' : 'neutral'}`}>{d.cash?.status ?? 'Not reconciled'}</span></> : <div className="cash-account-empty"><strong>No tracked cash account</strong><span>An administrator must configure an account first.</span></div>}<div className="form-actions"><button className="secondary with-icon" disabled={!accounts.length} onClick={() => { setMode('observation'); setFormError(''); }}><UiIcon name="cash" />Record balance</button><button className="primary with-icon" disabled={!accounts.length} onClick={() => { setMode('movement'); setFormError(''); }}><UiIcon name="plus" />Add movement</button></div></section>
    {mode && <form className="panel entry-form" onSubmit={save}><div className="panel-heading"><div><h2>{mode === 'observation' ? 'Record observed balance' : 'Record cash movement'}</h2></div><button type="button" className="icon-button" onClick={() => setMode(null)} aria-label="Close form"><UiIcon name="close" /></button></div>
      {mode === 'movement' && <label>Movement type<select value={kind} onChange={e => setKind(e.target.value)}><option value="cash_deposit">Cash deposit</option><option value="other_inflow">Other cash inflow</option><option value="purchase">Purchase</option><option value="pay">Pay</option><option value="misc_spend">Miscellaneous spend</option></select></label>}
      <div className="form-grid"><label>Amount ({accounts.find(x => x.id === accountId)?.currency ?? c})<input inputMode="decimal" type="number" min="0.01" step="0.01" required value={amount} onChange={e => setAmount(e.target.value)} /></label><label>{mode === 'observation' ? 'Observed at' : 'Occurred at'}<input type="datetime-local" required value={occurredAt} onChange={e => setOccurredAt(e.target.value)} /></label>{mode === 'movement' && <label className="wide">Description<input maxLength={500} required value={description} onChange={e => setDescription(e.target.value)} /></label>}<label className="wide">Supporting evidence<input type="file" accept="application/pdf,image/jpeg,image/png" required onChange={e => setEvidenceFile(e.target.files?.[0] ?? null)} /><small className="field-hint">Private PDF, JPEG, or PNG; maximum 10 MB.</small></label></div>
      {formError && <p className="error" role="alert">{formError}</p>}<div className="form-actions"><button type="button" className="secondary" onClick={() => setMode(null)}>Cancel</button><button className="primary with-icon" disabled={saving}><UiIcon name="check" />{saving ? 'Saving…' : 'Save'}</button></div>
    </form>}
    <section className="metric-grid three"><Card label="Expected balance" value={money(d.cash?.expectedBalanceMinor, d.cash?.currency ?? c)} hint="Opening balance + movements" /><Card label="Observed balance" value={money(d.cash?.observedBalanceMinor, d.cash?.currency ?? c)} hint="Latest observation" /><Card label="Difference" value={money(d.cash?.discrepancyMinor, d.cash?.currency ?? c)} hint="Observed − expected" tone={d.cash?.discrepancyMinor ? 'warn-text' : ''} /></section><section className="panel table-panel"><div className="panel-heading"><div><h2>Account movements</h2></div></div>{movements.length ? <div className="table-wrap"><table><thead><tr><th>Date</th><th>Activity</th><th>Category</th><th>Evidence</th><th className="numeric">Amount</th></tr></thead><tbody>{movements.filter(m => !accountId || m.account_id === accountId).map(m => <tr key={m.id}><td>{date(m.occurred_at)}</td><td>{m.description}</td><td>{m.kind.replaceAll('_', ' ')}</td><td><EvidenceLink organizationId={organizationId} evidenceId={m.evidence_ref ?? ''} /></td><td className={`numeric ${m.amount_minor < 0 ? 'negative' : 'positive'}`}>{money(m.amount_minor, m.currency)}</td></tr>)}</tbody></table></div> : <div className="inline-empty">No account movements for this period.</div>}</section>{inventoryEnabled && <InventoryPanel organizationId={organizationId} accountId={accountId} currency={c} timezone={d.organization?.timezone ?? 'UTC'} accounts={accounts} from={d.period?.from ?? ''} to={d.period?.to ?? ''} canManageSquareCatalog={canManageSquareCatalog} canAuthorizeSquareCatalog={canAuthorizeSquareCatalog} onSaved={onSaved} />}<p className="tiny muted">COGS affects margin, not cash twice. Transfers need linked account legs.</p></>;
}
function EvidenceLink({ organizationId, evidenceId }: { organizationId: string; evidenceId: string }) {
  const [error, setError] = useState('');
  if (!evidenceId) return <>—</>;
  async function openEvidence() {
    setError('');
    try {
      const query = new URLSearchParams({ organizationId, evidenceId });
      const result = await api<{ url: string }>(`/api/evidence?${query}`);
      window.location.assign(result.url);
    } catch { setError('Could not open evidence.'); }
  }
  return <><button type="button" className="icon-button" onClick={() => void openEvidence()} aria-label="Open evidence file" title="Open evidence"><UiIcon name="file" /></button>{error && <small className="error" role="alert">{error}</small>}</>;
}
function InventoryPanel({ organizationId, accountId, currency, timezone, accounts, from, to, canManageSquareCatalog, canAuthorizeSquareCatalog, onSaved }: { organizationId: string; accountId: string; currency: string; timezone: string; accounts: NonNullable<Dashboard['accounts']>; from: string; to: string; canManageSquareCatalog: boolean; canAuthorizeSquareCatalog: boolean; onSaved: () => void }) {
  const [rows, setRows] = useState<InventoryMovement[]>([]), [snapshot, setSnapshot] = useState<InventorySnapshot | null>(null), [loading, setLoading] = useState(false), [mode, setMode] = useState<'purchase' | 'correction' | 'opening' | 'item' | 'square-item' | null>(null);
  const [squareCounts, setSquareCounts] = useState<SquareInventoryCount[]>([]), [squareLoading, setSquareLoading] = useState(false), [squareError, setSquareError] = useState('');
  const [squareCountTarget, setSquareCountTarget] = useState<SquareInventoryCount | null>(null), [squareCountQuantity, setSquareCountQuantity] = useState(''), [squareCountReason, setSquareCountReason] = useState(''), [squareCountError, setSquareCountError] = useState(''), [squareCountNotice, setSquareCountNotice] = useState(''), [savingSquareCount, setSavingSquareCount] = useState(false);
  const [itemId, setItemId] = useState(''), [name, setName] = useState(''), [sku, setSku] = useState(''), [quantity, setQuantity] = useState('1'), [purchaseLines, setPurchaseLines] = useState<PurchaseLineInput[]>([{ itemId: '', quantity: '1', unitCost: '' }]), [amountPaid, setAmountPaid] = useState(''), [reason, setReason] = useState(''), [direction, setDirection] = useState<'add' | 'remove'>('add'), [occurredAt, setOccurredAt] = useState(localDateTimeNow);
  const [evidence, setEvidence] = useState<File | null>(null), [evidenceRefInput, setEvidenceRefInput] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false), [authorizingSquare, setAuthorizingSquare] = useState(false);
  const [variationName, setVariationName] = useState('Regular'), [description, setDescription] = useState(''), [salePrice, setSalePrice] = useState(''), [unitCost, setUnitCost] = useState(''), [itemCurrency, setItemCurrency] = useState(accounts.find(x => x.id === accountId)?.currency ?? currency), [costEffectiveDate, setCostEffectiveDate] = useState(() => todayInTimezone(timezone));
  const pending = useRef<null | { fingerprint: string; key: string; evidenceId?: string; occurredAt: string }>(null);
  async function refresh() {
    if (!from || !to) return;
    setLoading(true); setSnapshot(null); setRows([]);
    try { const query = new URLSearchParams({ organizationId, from, to, currency: accounts.find(x => x.id === accountId)?.currency ?? currency }); const result = await api<{ movements: InventoryMovement[]; snapshot: InventorySnapshot }>(`/api/inventory?${query}`); setRows(result.movements ?? []); setSnapshot(result.snapshot ?? null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Inventory could not be loaded.'); }
    finally { setLoading(false); }
    setSquareLoading(true); setSquareError('');
    try { const result = await api<{ counts: SquareInventoryCount[] }>(`/api/inventory/square-counts?organizationId=${encodeURIComponent(organizationId)}`); setSquareCounts(result.counts ?? []); }
    catch (err) { setSquareError(err instanceof Error ? err.message : 'Square inventory counts could not be loaded.'); }
    finally { setSquareLoading(false); }
  }
  useEffect(() => { void refresh(); }, [organizationId, from, to, accountId]);
  const items: NonNullable<InventorySnapshot['items']> = snapshot?.items ?? [...new Map(rows.map(row => [row.item_id, { id: row.item_id, name: row.item_name, currency, item_kind: 'manual' }])).values()];
  async function authorizeSquareCatalog() {
    if (!canAuthorizeSquareCatalog) return;
    setAuthorizingSquare(true); setError('');
    try {
      const result = await api<{ authorizationUrl: string }>('/api/square/oauth/start', {
        method: 'POST', body: JSON.stringify({ organizationId, catalogWrite: true }),
      });
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Square authorization could not start.');
      setAuthorizingSquare(false);
    }
  }
  async function authorizeSquareInventory() {
    if (!canAuthorizeSquareCatalog) return;
    setAuthorizingSquare(true); setSquareError('');
    try {
      const result = await api<{ authorizationUrl: string }>('/api/square/oauth/start', {
        method: 'POST', body: JSON.stringify({ organizationId, catalogWrite: true, inventoryWrite: true }),
      });
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      setSquareError(err instanceof Error ? err.message : 'Square inventory authorization could not start.');
      setAuthorizingSquare(false);
    }
  }
  async function submitSquareCount(event: FormEvent) {
    event.preventDefault(); setSquareCountError(''); setSquareCountNotice('');
    const target = squareCountTarget, quantityValue = Number(squareCountQuantity), reasonValue = squareCountReason.trim();
    if (!target || !Number.isFinite(quantityValue) || quantityValue < 0 || quantityValue > 1_000_000_000_000
        || Math.abs(quantityValue * 100_000 - Math.round(quantityValue * 100_000)) > 1e-7 || reasonValue.length < 10) {
      setSquareCountError('Enter a count with at most five decimal places and a reason of at least 10 characters.'); return;
    }
    setSavingSquareCount(true);
    try {
      await api('/api/actions', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({
        organizationId, actionType: 'square.inventory.count.set', locationId: target.locationId,
        expectedSourceVersion: target.sourceVersion ?? null, amountMinor: null, currency: null, evidenceRefs: [],
        payload: { sourceMappingId: target.sourceMappingId, locationMappingId: target.locationMappingId,
          businessLocationId: target.locationId, squareVariationId: target.squareVariationId,
          squareLocationId: target.squareLocationId, state: 'IN_STOCK', quantity: quantityValue,
          expectedSquareVersion: target.sourceVersion ?? null, proposalReason: reasonValue },
      }) });
      setSquareCountTarget(null); setSquareCountReason(''); setSquareCountQuantity('');
      setSquareCountNotice('Square physical count submitted for approval. Square changes after an approver accepts it.');
    } catch (err) { setSquareCountError(err instanceof Error ? err.message : 'The Square inventory count could not be proposed.'); }
    finally { setSavingSquareCount(false); }
  }
  async function save(e: FormEvent) {
    e.preventDefault(); setError('');
    if (!evidence && !UUID_INPUT.test(evidenceRefInput.trim())) { setError('Attach a receipt or enter an existing evidence ID.'); return; }
    const receiptLines = purchaseLines.map(line => ({ itemId: line.itemId, itemName: items.find(item => item.id === line.itemId)?.name ?? '', quantity: Number(line.quantity), unitCostMinor: parseMinor(line.unitCost, accounts.find(x => x.id === accountId)?.currency ?? currency) }));
    if (mode === 'purchase' && (!receiptLines.length || receiptLines.some(line => !UUID_INPUT.test(line.itemId) || !line.itemName || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 1_000_000 || line.unitCostMinor === null || line.unitCostMinor < 0))) { setError('Each receipt line needs an item, whole quantity, and valid unit acquisition cost.'); return; }
    if (mode !== 'purchase' && mode !== 'item' && mode !== 'square-item' && (!itemId || reason.trim().length < 10)) { setError('Choose an item and explain the inventory record in at least 10 characters.'); return; }
    if (mode === 'item' && (sku.trim().length < 1 || name.trim().length < 1 || reason.trim().length < 10)) { setError('Enter an item name, SKU, and reason of at least 10 characters.'); return; }
    const squarePriceMinor = parseMinor(salePrice, itemCurrency), squareUnitCostMinor = parseMinor(unitCost, itemCurrency);
    if (mode === 'square-item' && (!name.trim() || !variationName.trim() || name.trim().length > 200 || variationName.trim().length > 200
        || sku.trim().length > 100 || description.length > 4096 || squarePriceMinor === null || squarePriceMinor <= 0
        || squareUnitCostMinor === null || squareUnitCostMinor < 0 || reason.trim().length < 10)) {
      setError('Enter the item name, variation, sale price, supplier-backed unit cost, and a reason of at least 10 characters.'); return;
    }
    const effectiveDateValue = /^\d{4}-\d{2}-\d{2}$/.test(costEffectiveDate) ? new Date(`${costEffectiveDate}T00:00:00Z`) : null;
    const effectiveFrom = effectiveDateValue && Number.isFinite(effectiveDateValue.getTime()) && effectiveDateValue.toISOString().slice(0, 10) === costEffectiveDate
      ? zonedMidnight(costEffectiveDate, timezone) : null;
    if (mode === 'square-item' && (!effectiveFrom || !Number.isFinite(Date.parse(effectiveFrom)))) { setError('Enter a valid COGS effective date.'); return; }
    const qty = Number(quantity), transactionCurrency = accounts.find(x => x.id === accountId)?.currency ?? currency;
    const paidMinor = parseMinor(amountPaid, transactionCurrency);
    if (mode !== 'item' && mode !== 'purchase' && mode !== 'square-item' && (!Number.isSafeInteger(qty) || qty < (mode === 'opening' ? 0 : 1) || qty > 1_000_000) || (mode === 'purchase' && (paidMinor === null || paidMinor <= 0))) { setError('Enter a valid quantity and total amount paid.'); return; }
    const acquisitionSubtotal = receiptLines.reduce((sum, line) => sum + (line.unitCostMinor ?? 0) * line.quantity, 0);
    if (mode === 'purchase' && paidMinor !== null && (!Number.isSafeInteger(acquisitionSubtotal) || paidMinor < acquisitionSubtotal)) { setError('Total paid cannot be below the recorded inventory acquisition subtotal.'); return; }
    const account = accounts.find(x => x.id === accountId); if (mode === 'purchase' && !account) { setError('Choose a cash account before recording this purchase.'); return; }
    setSaving(true);
    try {
      const fingerprint = JSON.stringify([organizationId, mode, accountId, itemId, name.trim(), sku.trim(), mode === 'purchase' ? receiptLines : null, qty, paidMinor, direction, reason.trim(), occurredAt, evidence?.name, evidence?.size, evidence?.lastModified, evidenceRefInput, variationName.trim(), description.trim(), salePrice, unitCost, itemCurrency, costEffectiveDate]);
      if (!pending.current || (mode !== 'square-item' && pending.current.fingerprint !== fingerprint)) pending.current = { fingerprint, key: crypto.randomUUID(), occurredAt: new Date(occurredAt).toISOString() };
      if (!pending.current.evidenceId) {
        if (evidence) { const upload = new FormData(); upload.set('organizationId', organizationId); upload.set('file', evidence); const stored = await api<{ evidence: { id: string } }>('/api/evidence', { method: 'POST', body: upload }); pending.current.evidenceId = stored.evidence.id; }
        else pending.current.evidenceId = evidenceRefInput.trim();
      }
      const evidenceRef = pending.current.evidenceId, eventTime = pending.current.occurredAt, key = pending.current.key;
      if (mode === 'square-item') {
        const result = await api<{ projectionQueued: boolean }>('/api/inventory/catalog-items', {
          method: 'POST', headers: { 'Idempotency-Key': key },
          body: JSON.stringify({ organizationId, name: name.trim(), variationName: variationName.trim(),
            description: description.trim(), sku: sku.trim(), priceMinor: squarePriceMinor!,
            unitCostMinor: squareUnitCostMinor!, currency: itemCurrency, effectiveFrom,
            evidenceRef, reason: reason.trim(), projectionStartAt: from, projectionEndAt: to }),
        });
        pending.current = null; setMode(null); setEvidence(null); setEvidenceRefInput(''); setName(''); setSku(''); setVariationName('Regular'); setDescription(''); setSalePrice(''); setUnitCost(''); setReason('');
        setNotice(result.projectionQueued ? 'Item created in Square. Its approved unit cost and catalog link are saved in Vernius; a projection replay is queued.' : 'Item created in Square and its approved unit cost is saved in Vernius.');
        await refresh(); onSaved(); return;
      }
      if (mode === 'item') { const result = await api<{ itemId: string }>('/api/inventory/items', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ organizationId, sku: sku.trim(), name: name.trim(), currency: transactionCurrency, evidenceRef, reason: reason.trim() }) }); pending.current = null; setMode(null); setEvidence(null); setEvidenceRefInput(''); setReason(''); setName(''); setSku(''); await refresh(); setItemId(result.itemId); return; }
      if (mode === 'purchase') await api('/api/inventory/purchases', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ organizationId, accountId, amountMinor: -paidMinor!, occurredAt: eventTime, currency: account!.currency, description: 'Supply purchase', evidenceRef, lines: receiptLines.map(line => ({ ...line, unitCostMinor: line.unitCostMinor! })) }) });
      else if (mode === 'opening') await api('/api/inventory/openings', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ organizationId, itemId, quantity: qty, occurredAt: eventTime, reason: reason.trim(), evidenceRef }) });
      else await api('/api/inventory/corrections', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ organizationId, itemId, quantityDelta: direction === 'add' ? qty : -qty, occurredAt: eventTime, reason: reason.trim(), evidenceRef }) });
      pending.current = null; setMode(null); setEvidence(null); setEvidenceRefInput(''); setName(''); setSku(''); setQuantity('1'); setPurchaseLines([{ itemId: '', quantity: '1', unitCost: '' }]); setAmountPaid(''); setReason(''); await refresh(); onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Inventory record could not be saved.'); }
    finally { setSaving(false); }
  }
  function openSquareItemForm() {
    setMode('square-item'); setError(''); setNotice(''); setName(''); setSku(''); setVariationName('Regular'); setDescription(''); setSalePrice(''); setUnitCost('');
    setItemCurrency(accounts.find(x => x.id === accountId)?.currency ?? currency); setCostEffectiveDate(todayInTimezone(timezone));
    setEvidence(null); setEvidenceRefInput(''); setReason(''); pending.current = null;
  }
  return <section className="panel table-panel inventory-panel"><div className="panel-heading"><div><h2>Inventory &amp; supply</h2></div><div className="form-actions inventory-actions"><button type="button" className="primary with-icon" onClick={() => { setMode('purchase'); setError(''); setPurchaseLines([{ itemId: items[0]?.id ?? '', quantity: '1', unitCost: '' }]); }}><UiIcon name="plus" />Purchase supplies</button><button type="button" className="secondary with-icon" onClick={() => { setMode('item'); setError(''); setName(''); setSku(''); setItemId(''); }}><UiIcon name="plus" />Add supply</button><details className="action-menu"><summary aria-label="More inventory actions" title="More actions"><UiIcon name="more" /></summary><div className="action-menu-popover">{canManageSquareCatalog && <button type="button" onClick={openSquareItemForm}>Add item to Square</button>}<button type="button" onClick={() => { setMode('opening'); setError(''); setItemId(items[0]?.id ?? ''); }}>Opening count</button><button type="button" onClick={() => { setMode('correction'); setError(''); setItemId(items[0]?.id ?? ''); }}>Adjust stock</button></div></details></div></div>
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel stock-panel"><div className="panel-heading"><div><h3>Square inventory</h3><p>Square calculated counts by item variation, location, and stock state.</p></div><div className="form-actions"><button type="button" className="secondary" onClick={() => void refresh()} disabled={squareLoading}>Refresh</button>{canAuthorizeSquareCatalog && <button type="button" className="secondary" onClick={() => void authorizeSquareInventory()} disabled={authorizingSquare}>{authorizingSquare ? 'Opening Square…' : 'Authorize Square inventory'}</button>}</div></div>
      {squareCountNotice && <div className="notice compact-notice" role="status">{squareCountNotice}</div>}{squareError && <p className="error" role="alert">{squareError}</p>}
      {squareLoading ? <div className="inline-empty">Loading Square counts…</div> : squareCounts.length ? <div className="table-wrap"><table><thead><tr><th>Item</th><th>Variation</th><th>Location</th><th>State</th><th className="numeric">Quantity</th><th>Calculated</th><th></th></tr></thead><tbody>{squareCounts.map((count, index) => <tr key={`${count.variationId}:${count.locationId}:${count.state}:${index}`}><td>{count.itemName}</td><td>{count.variationName}{count.sku ? <small className="cell-sub">{count.sku}</small> : null}</td><td>{count.locationName}</td><td>{count.state.replaceAll('_', ' ').toLowerCase()}</td><td className="numeric">{count.quantity ?? 'Unknown'}</td><td>{count.calculatedAt ? date(count.calculatedAt) : 'No Square count yet'}</td><td>{count.state === 'IN_STOCK' && <button type="button" className="secondary" onClick={() => { setSquareCountTarget(count); setSquareCountQuantity(count.quantity === null ? '' : String(count.quantity)); setSquareCountReason(''); setSquareCountError(''); }}>Propose count</button>}</td></tr>)}</tbody></table></div> : !squareError && <div className="inline-empty">No Square inventory counts are available. Run a Square sync after granting inventory read access.</div>}
      {squareCountTarget && <form className="entry-form" onSubmit={submitSquareCount}><div className="form-grid"><div className="notice compact-notice wide"><b>Propose a physical count for {squareCountTarget.itemName} · {squareCountTarget.variationName} at {squareCountTarget.locationName}.</b> Square changes only after an authorized approver accepts this exact count.</div><label>Counted quantity<input type="number" min="0" step="0.00001" required value={squareCountQuantity} onChange={event => setSquareCountQuantity(event.target.value)} /></label><label className="wide">Reason<textarea minLength={10} maxLength={1000} required value={squareCountReason} onChange={event => setSquareCountReason(event.target.value)} placeholder="Explain when and how this stock was physically counted." /></label></div>{squareCountError && <p className="error" role="alert">{squareCountError}</p>}<div className="form-actions"><button type="button" className="secondary" onClick={() => setSquareCountTarget(null)} disabled={savingSquareCount}>Cancel</button><button className="primary" disabled={savingSquareCount}>{savingSquareCount ? 'Submitting…' : 'Submit for approval'}</button></div></form>}
    </section>
    {mode && <form className="entry-form" onSubmit={save}><div className="form-grid">
      {(mode === 'opening' || mode === 'correction') && <label>Inventory item<select required value={itemId} onChange={e => setItemId(e.target.value)}><option value="">Choose item</option>{items.map(item => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></label>}
      {mode === 'item' && <><label>Item name<input required maxLength={200} value={name} onChange={e => setName(e.target.value)} /></label><label>SKU or stock code<input required maxLength={100} value={sku} onChange={e => setSku(e.target.value)} /></label><label>Currency<select value={accounts.find(x => x.id === accountId)?.currency ?? currency} onChange={() => {}} disabled><option>{accounts.find(x => x.id === accountId)?.currency ?? currency}</option></select></label><label className="wide">Reason<textarea minLength={10} maxLength={1000} required value={reason} onChange={e => setReason(e.target.value)} placeholder="Explain the source for this new supply item" /></label></>}
      {mode === 'square-item' && <>
        <div className="notice compact-notice wide"><b>Creates an item in Square.</b> Finance Loop records its supplier-backed unit cost. Add current stock separately with Opening count.</div>
        <label>Item name<input required maxLength={200} value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Variation name<input required maxLength={200} value={variationName} onChange={e => setVariationName(e.target.value)} /></label>
        <label>SKU (optional)<input maxLength={100} value={sku} onChange={e => setSku(e.target.value)} /></label>
        <label>Currency<select value={itemCurrency} onChange={e => setItemCurrency(e.target.value)}>{Array.from(new Set([currency, ...accounts.map(account => account.currency), itemCurrency])).sort().map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Sale price ({itemCurrency})<input type="number" min="0.01" step="any" required value={salePrice} onChange={e => setSalePrice(e.target.value)} /></label>
        <label>Unit acquisition cost ({itemCurrency})<input type="number" min="0" step="any" required value={unitCost} onChange={e => setUnitCost(e.target.value)} /><small className="field-hint">Supplier purchase cost excluding purchase tax and miscellaneous charges.</small></label>
        <label>COGS effective date ({timezone})<input type="date" required value={costEffectiveDate} onChange={e => setCostEffectiveDate(e.target.value)} /></label>
        <label className="wide">Description (optional)<textarea rows={3} maxLength={4096} value={description} onChange={e => setDescription(e.target.value)} /></label>
        <label className="wide">Supplier evidence reason<textarea required minLength={10} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} placeholder="Cite the supplier invoice or receipt and how it supports the unit acquisition cost." /></label>
      </>}
      {mode === 'purchase' && <div className="wide"><h3>Receipt items</h3>{purchaseLines.map((line, index) => <div className="form-grid" key={`receipt-line-${index}`}><label>Item<select required value={line.itemId} onChange={e => setPurchaseLines(current => current.map((row, i) => i === index ? { ...row, itemId: e.target.value } : row))}><option value="">Choose item</option>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Quantity<input type="number" min="1" step="1" required value={line.quantity} onChange={e => setPurchaseLines(current => current.map((row, i) => i === index ? { ...row, quantity: e.target.value } : row))} /></label><label>Unit acquisition cost ({accounts.find(x => x.id === accountId)?.currency ?? currency})<input type="number" min="0" step="any" required value={line.unitCost} onChange={e => setPurchaseLines(current => current.map((row, i) => i === index ? { ...row, unitCost: e.target.value } : row))} /></label><button type="button" className="icon-button reject-button" disabled={purchaseLines.length === 1} onClick={() => setPurchaseLines(current => current.filter((_, i) => i !== index))} aria-label={`Remove receipt line ${index + 1}`} title="Remove line"><UiIcon name="trash" /></button></div>)}<button type="button" className="secondary with-icon" onClick={() => setPurchaseLines(current => [...current, { itemId: '', quantity: '1', unitCost: '' }])}><UiIcon name="plus" />Add item</button><p className="field-hint">Enter the total paid once, including tax and shipping.</p><label>Total paid ({accounts.find(x => x.id === accountId)?.currency ?? currency})<input type="number" min="0.01" step="any" required value={amountPaid} onChange={e => setAmountPaid(e.target.value)} /></label></div>}
      {mode !== 'item' && mode !== 'square-item' && <label>Occurred at (your local time)<input type="datetime-local" required value={occurredAt} onChange={e => setOccurredAt(e.target.value)} /></label>}
      {mode === 'correction' && <><label>Correction<select value={direction} onChange={e => setDirection(e.target.value as 'add' | 'remove')}><option value="add">Add units</option><option value="remove">Remove units</option></select></label><label>Units<input type="number" min="1" step="1" required value={quantity} onChange={e => setQuantity(e.target.value)} /></label><label className="wide">Reason<textarea minLength={10} maxLength={1000} required value={reason} onChange={e => setReason(e.target.value)} /></label></>}
      {mode === 'opening' && <><label>Physical on-hand count<input type="number" min="0" step="1" required value={quantity} onChange={e => setQuantity(e.target.value)} /></label><label className="wide">Reason<textarea minLength={10} maxLength={1000} required value={reason} onChange={e => setReason(e.target.value)} placeholder="Describe the count and its source" /></label></>}
      <label className="wide">{mode === 'square-item' ? 'Supplier receipt / unit cost evidence' : 'Receipt / evidence file'}<input type="file" accept="application/pdf,image/jpeg,image/png" onChange={e => setEvidence(e.target.files?.[0] ?? null)} /></label><label className="wide">Or existing evidence ID<input value={evidenceRefInput} onChange={e => setEvidenceRefInput(e.target.value)} maxLength={36} placeholder="UUID for a file already uploaded by a workspace member" /></label>
    </div>{error && <><p className="error" role="alert">{error === 'SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED' ? 'Square item write access is needed. An owner can reconnect Square.' : error === 'SQUARE_NOT_CONNECTED' ? 'Connect Square before adding an item.' : error === 'SQUARE_RECONNECT_REQUIRED' ? 'Square authorization expired. Reconnect and try again.' : error === 'SQUARE_CATALOG_WRITE_FAILED' ? 'Square could not create this item. Check Square before retrying.' : error}</p>{canAuthorizeSquareCatalog && ['SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED','SQUARE_NOT_CONNECTED','SQUARE_RECONNECT_REQUIRED'].includes(error) && <button type="button" className="secondary with-icon" onClick={() => void authorizeSquareCatalog()} disabled={authorizingSquare}><UiIcon name="external" />{authorizingSquare ? 'Opening Square…' : 'Connect Square'}</button>}</>}<div className="form-actions"><button type="button" className="secondary" onClick={() => { setMode(null); setError(''); setEvidence(null); setEvidenceRefInput(''); pending.current = null; }}>Cancel</button><button className="primary with-icon" disabled={saving}><UiIcon name="check" />{saving ? 'Saving…' : mode === 'square-item' ? 'Create in Square' : 'Save'}</button></div></form>}
    {snapshot?.balances?.length ? <section className="panel stock-panel"><div className="panel-heading"><div><h3>Stock on hand</h3><p>Based on purchases, adjustments, and sales.</p></div><span className={`pill ${snapshot.status === 'complete' ? 'good' : 'warn'}`}>{snapshot.status === 'complete' ? 'Complete' : 'Incomplete'}</span></div>{snapshot.issues?.length ? <div className="inventory-issues" role="status">Inventory data is incomplete <span>{Array.from(new Set(snapshot.issues.map(issue => issue.code))).map(code => ({ OPENING_BALANCE_MISSING: 'Opening count needed', SOURCE_GAP: 'Source data incomplete', SOURCE_HEALTH_INCOMPLETE: 'Square sync incomplete', UNKNOWN_ITEM: 'Unidentified sale item' } as Record<string, string>)[code] ?? code.replaceAll('_', ' ').toLowerCase()).join(' · ')}</span></div> : null}<div className="table-wrap"><table><thead><tr><th>Item</th><th>Currency</th><th className="numeric">Units</th></tr></thead><tbody>{snapshot.balances.map(balance => <tr key={balance.itemDefinitionId}><td>{balance.itemName}</td><td>{balance.currency}</td><td className="numeric">{balance.quantity ?? 'Unknown'}</td></tr>)}</tbody></table></div></section> : null}{error && !mode && <p className="error" role="alert">{error}</p>}{loading ? <div className="inline-empty">Loading inventory…</div> : rows.length ? <div className="table-wrap"><table><thead><tr><th>Date</th><th>Item</th><th className="numeric">Change</th><th>Type</th><th>Reason</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{date(row.occurred_at)}</td><td>{row.item_name}</td><td className="numeric">{row.quantity_delta > 0 ? '+' : ''}{row.quantity_delta}</td><td>{(row.movement_type ?? 'movement').replaceAll('_', ' ')}</td><td>{row.reason ?? '—'}</td></tr>)}</tbody></table></div> : !loading && <div className="inline-empty">No inventory movements in this period. Existing item definitions appear here after their first recorded movement.</div>}
  </section>;
}
function Analytics({ organizationId, from, to, currency, timezone, refreshKey, role }: { organizationId: string; from: string; to: string; currency: string; timezone: string; refreshKey: string; role: string }) {
  const [domainDraftItems, setDomainDraftItems] = useState<DomainDraftCatalogItem[]>([]);
  const [report, setReport] = useState<AnalyticsReport | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [search, setSearch] = useState(''), [catalogSearch, setCatalogSearch] = useState(''), [sortBy, setSortBy] = useState<'revenue' | 'cost' | 'net' | 'units'>('revenue'), [seriesView, setSeriesView] = useState<'monthly' | 'daily'>('monthly'), [selectedProductId, setSelectedProductId] = useState('');
  const [catalogView, setCatalogView] = useState<'active' | 'archived' | 'all'>('active');
  const [catalogMode, setCatalogMode] = useState<CatalogDialogMode | null>(null);
  const [catalogTarget, setCatalogTarget] = useState<AnalyticsCatalogItem | null>(null);
  const [catalogName, setCatalogName] = useState(''), [catalogDescription, setCatalogDescription] = useState('');
  const [catalogVariations, setCatalogVariations] = useState<CatalogVariationDraft[]>([]);
  const [catalogVariationName, setCatalogVariationName] = useState(''), [catalogSku, setCatalogSku] = useState('');
  const [catalogPricingType, setCatalogPricingType] = useState<'FIXED_PRICING' | 'VARIABLE_PRICING'>('FIXED_PRICING');
  const [catalogPrice, setCatalogPrice] = useState(''), [catalogCurrency, setCatalogCurrency] = useState(currency);
  const [catalogCost, setCatalogCost] = useState(''), [catalogCostDate, setCatalogCostDate] = useState(new Date().toISOString().slice(0, 10));
  const [catalogEvidence, setCatalogEvidence] = useState<File | null>(null), [catalogEvidenceRef, setCatalogEvidenceRef] = useState('');
  const [catalogReason, setCatalogReason] = useState(''), [catalogSaving, setCatalogSaving] = useState(false);
  const [catalogError, setCatalogError] = useState(''), [catalogNotice, setCatalogNotice] = useState('');
  const [catalogReconnectNeeded, setCatalogReconnectNeeded] = useState(false);
  const catalogPending = useRef<{ fingerprint: string; key: string; evidenceId?: string } | null>(null);
  const canManageCatalog = ['owner', 'administrator', 'manager'].includes(role);
  const canManageCosts = role === 'owner' || role === 'reviewer';
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setReport(null); setSelectedProductId('');
    const query = new URLSearchParams({ organizationId, from, to, currency });
    api<{ analytics: AnalyticsReport }>(`/api/analytics?${query}`).then(result => { if (active) setReport(result.analytics); })
      .catch(err => { if (active) setError(err instanceof Error ? err.message : 'Analytics could not be loaded.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [organizationId, from, to, currency, refreshKey]);
  useEffect(() => {
    let active = true;
    api<{ items: DomainDraftCatalogItem[] }>(`/api/domain/catalog?organizationId=${encodeURIComponent(organizationId)}`)
      .then(result => { if (active) setDomainDraftItems(result.items.filter(item => item.status === 'draft')); })
      .catch(() => { if (active) setDomainDraftItems([]); });
    return () => { active = false; };
  }, [organizationId, refreshKey]);
  async function reloadCatalog() {
    const query = new URLSearchParams({ organizationId, from, to, currency });
    const result = await api<{ analytics: AnalyticsReport }>(`/api/analytics?${query}`);
    setReport(result.analytics);
  }
  async function reloadDomainCatalog() {
    const result = await api<{ items: DomainDraftCatalogItem[] }>(`/api/domain/catalog?organizationId=${encodeURIComponent(organizationId)}`);
    setDomainDraftItems(result.items.filter(item => item.status === 'draft'));
  }
  function openCatalogDialog(mode: CatalogDialogMode, item?: AnalyticsCatalogItem) {
    setCatalogMode(mode); setCatalogTarget(item ?? null); setCatalogError(''); setCatalogNotice(''); setCatalogReason(''); setCatalogReconnectNeeded(false);
    setCatalogEvidence(null); setCatalogEvidenceRef(''); catalogPending.current = null;
    setCatalogName(item?.itemName ?? ''); setCatalogDescription(item?.description ?? '');
    setCatalogVariationName(item?.variationName ?? 'Regular'); setCatalogSku(item?.sku ?? '');
    setCatalogPricingType(item?.pricingType === 'VARIABLE_PRICING' ? 'VARIABLE_PRICING' : 'FIXED_PRICING');
    setCatalogPrice(item?.sellingPriceMinor == null ? '' : minorInput(item.sellingPriceMinor, item.currency ?? currency));
    setCatalogCurrency(item?.currency ?? currency);
    setCatalogCost(item?.unitCostMinor == null ? '' : minorInput(item.unitCostMinor, item.currency ?? currency));
    setCatalogCostDate(new Date().toISOString().slice(0, 10));
    setCatalogVariations([{ name: '', sku: '', pricingType: 'FIXED_PRICING', price: '', currency }]);
  }
  function closeCatalogDialog() {
    if (catalogSaving) return;
    setCatalogMode(null); setCatalogTarget(null); setCatalogError(''); setCatalogEvidence(null); catalogPending.current = null;
  }
  const visibleProducts = (report?.products ?? []).filter(product => `${product.productName ?? ''} ${product.productId}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => {
    const value = (p: AnalyticsProduct) => sortBy === 'cost' ? p.costMinor : sortBy === 'net' ? p.netMinor : sortBy === 'units' ? p.unitsSold : p.revenueMinor;
    const av = value(a), bv = value(b); return av == null ? 1 : bv == null ? -1 : bv - av || a.productId.localeCompare(b.productId);
  });
  const allCatalogItems = report?.catalogItems ?? [];
  const showCatalogCurrency = new Set(allCatalogItems.map(item => item.currency).filter((value): value is string => Boolean(value))).size > 1;
  const activeCatalogCount = allCatalogItems.filter(item => item.archived !== true).length;
  const archivedCatalogCount = allCatalogItems.filter(item => item.archived === true).length;
  const visibleCatalogItems = allCatalogItems.filter(item => catalogView === 'all' || (catalogView === 'archived' ? item.archived === true : item.archived !== true))
    .filter(item => `${item.itemName} ${item.variationName ?? ''} ${item.sku ?? ''} ${item.id}`.toLowerCase().includes(catalogSearch.toLowerCase()));
  const selectedProduct = report?.products.find(product => product.productId === selectedProductId);
  const feeHealthIncomplete = report?.issues.some(issue => issue.code === 'PROCESSING_FEE_INCOMPLETE') ?? false;
  async function authorizeSquareCatalog() {
    if (!canManageCatalog) return;
    setCatalogSaving(true); setCatalogError(''); setCatalogReconnectNeeded(false);
    try {
      const result = await api<{ authorizationUrl: string }>('/api/square/oauth/start', {
        method: 'POST', body: JSON.stringify({ organizationId, catalogWrite: true }),
      });
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : 'Square authorization could not start.');
      setCatalogSaving(false);
    }
  }
  async function saveCatalogAction(event: FormEvent) {
    event.preventDefault(); setCatalogError('');
    if (!catalogMode) return;
    const reason = catalogReason.trim();
    if (reason.length < 10) { setCatalogError('Explain the item change in at least 10 characters.'); return; }
    const target = catalogTarget;
    let requestPath = '/api/actions', method: 'POST' | 'PATCH' = 'POST', payload: Record<string, unknown>;
    let actionType: string | null = null, expectedSourceVersion: string | null = null;
    let proposalAmountMinor: number | null = null, proposalCurrency: string | null = null;
    if (catalogMode === 'create' || catalogMode === 'draft_create') {
      if (!catalogName.trim() || catalogName.trim().length > 200 || catalogVariations.length < 1) { setCatalogError('Enter an item name and at least one variation.'); return; }
      const variations = [] as Array<Record<string, unknown>>;
      for (const variation of catalogVariations) {
        const fixedPrice = variation.pricingType === 'FIXED_PRICING' ? parseMinor(variation.price, variation.currency) : null;
        if (!variation.name.trim() || variation.name.trim().length > 200 || variation.sku.trim().length > 100
            || (variation.pricingType === 'FIXED_PRICING' && (fixedPrice === null || fixedPrice < 0))) {
          setCatalogError('Each variation needs a name and a valid fixed price, or variable pricing.'); return;
        }
        variations.push({ name: variation.name.trim(), sku: variation.sku.trim(), pricingType: variation.pricingType,
          ...(variation.pricingType === 'FIXED_PRICING' ? { priceMinor: fixedPrice, currency: variation.currency } : {}) });
      }
      if (catalogMode === 'draft_create') {
        requestPath = '/api/domain/catalog';
        payload = { name: catalogName.trim(), description: catalogDescription.trim(), categoryId: null,
          variations: variations.map(variation => ({ name: variation.name, sku: variation.sku,
            priceMinor: variation.pricingType === 'FIXED_PRICING' ? variation.priceMinor : null,
            currency: variation.pricingType === 'FIXED_PRICING' ? variation.currency : null })) };
      } else {
        actionType = 'square.catalog.item.create';
        payload = { name: catalogName.trim(), description: catalogDescription.trim(), variations, proposalReason: reason };
      }
    } else if (!target?.squareItemId) {
      setCatalogError('This item is missing its Square link. Reopen the catalogue and try again.'); return;
    } else if (catalogMode === 'edit_item') {
      if (!catalogName.trim() || catalogName.trim().length > 200 || catalogDescription.length > 4096) { setCatalogError('Enter a valid item name and description.'); return; }
      if (!target.itemSourceMappingId || !target.itemExpectedSquareVersion) { setCatalogError('Square source version is unavailable. Sync the catalog and retry.'); return; }
      actionType = 'square.catalog.item.update'; expectedSourceVersion = target.itemExpectedSquareVersion;
      payload = { sourceMappingId: target.itemSourceMappingId, squareItemId: target.squareItemId,
        name: catalogName.trim(), description: catalogDescription.trim(), expectedSquareVersion: expectedSourceVersion, proposalReason: reason };
    } else if (catalogMode === 'edit_variation' || catalogMode === 'add_variation') {
      const fixedPrice = catalogPricingType === 'FIXED_PRICING' ? parseMinor(catalogPrice, catalogCurrency) : null;
      if (!catalogVariationName.trim() || catalogVariationName.trim().length > 200 || catalogSku.trim().length > 100
          || (catalogPricingType === 'FIXED_PRICING' && (fixedPrice === null || fixedPrice < 0))) {
        setCatalogError('Enter a variation name and a valid fixed price, or select variable pricing.'); return;
      }
      const sourceMappingId = catalogMode === 'add_variation' ? target.itemSourceMappingId : target.sourceMappingId;
      const sourceVersion = catalogMode === 'add_variation' ? target.itemExpectedSquareVersion : target.expectedSquareVersion;
      if (!sourceMappingId || !sourceVersion) { setCatalogError('Square source version is unavailable. Sync the catalog and retry.'); return; }
      actionType = catalogMode === 'add_variation' ? 'square.catalog.variation.add' : 'square.catalog.variation.update';
      expectedSourceVersion = sourceVersion;
      payload = { sourceMappingId, squareItemId: target.squareItemId,
        ...(catalogMode === 'edit_variation' ? { squareVariationId: target.id } : {}),
        variationName: catalogVariationName.trim(), sku: catalogSku.trim(), pricingType: catalogPricingType,
        ...(catalogPricingType === 'FIXED_PRICING' ? { priceMinor: fixedPrice, currency: catalogCurrency } : {}),
        expectedSquareVersion: sourceVersion, proposalReason: reason };
      if (catalogMode === 'edit_variation' && catalogPricingType === 'FIXED_PRICING') {
        proposalAmountMinor = fixedPrice; proposalCurrency = catalogCurrency;
      }
    } else if (catalogMode === 'cost') {
      const unitCostMinor = parseMinor(catalogCost, target.currency ?? currency);
      const effectiveFrom = /^\d{4}-\d\d-\d\d$/.test(catalogCostDate) ? zonedMidnight(catalogCostDate, timezone) : '';
      if (unitCostMinor === null || unitCostMinor < 0 || !effectiveFrom || !Number.isFinite(Date.parse(effectiveFrom))) {
        setCatalogError('Enter a valid acquisition cost and effective date.'); return;
      }
      if (!catalogEvidence && !UUID_INPUT.test(catalogEvidenceRef.trim())) { setCatalogError('Attach supplier evidence or enter an existing evidence ID.'); return; }
      requestPath = '/api/inventory/receipt-costs'; method = 'POST';
      payload = { organizationId, evidenceRef: catalogEvidenceRef.trim(), reason,
        updates: [{ catalogObjectId: target.id, name: target.itemName, unitCostMinor,
          currency: target.currency ?? currency, effectiveFrom }] };
    } else {
      if (!target.itemSourceMappingId || !target.itemExpectedSquareVersion) { setCatalogError('Square source version is unavailable. Sync the catalog and retry.'); return; }
      actionType = 'square.catalog.item.archive'; expectedSourceVersion = target.itemExpectedSquareVersion;
      payload = { sourceMappingId: target.itemSourceMappingId, squareItemId: target.squareItemId,
        archived: catalogMode === 'archive', expectedSquareVersion: expectedSourceVersion, proposalReason: reason };
    }
    const evidenceKey = catalogEvidence ? `${catalogEvidence.name}:${catalogEvidence.size}:${catalogEvidence.lastModified}` : catalogEvidenceRef.trim();
    const fingerprint = JSON.stringify([catalogMode, payload, evidenceKey]);
    if (!catalogPending.current || catalogPending.current.fingerprint !== fingerprint) {
      catalogPending.current = { fingerprint, key: crypto.randomUUID() };
    }
    setCatalogSaving(true); setCatalogReconnectNeeded(false);
    try {
      if (catalogMode === 'cost') {
        if (!catalogPending.current.evidenceId) {
          if (catalogEvidence) {
            const upload = new FormData(); upload.set('organizationId', organizationId); upload.set('file', catalogEvidence);
            const saved = await api<{ evidence: { id: string } }>('/api/evidence', { method: 'POST', body: upload });
            catalogPending.current.evidenceId = saved.evidence.id;
          } else catalogPending.current.evidenceId = catalogEvidenceRef.trim();
        }
        (payload as { evidenceRef: string }).evidenceRef = catalogPending.current.evidenceId!;
      }
      const requestBody = catalogMode === 'draft_create' ? { organizationId, item: payload, reason }
        : actionType ? { organizationId, actionType, payload, expectedSourceVersion,
          amountMinor: proposalAmountMinor, currency: proposalCurrency, evidenceRefs: [] } : payload;
      const result = await api<{ projectionQueued?: boolean }>(requestPath, {
        method, headers: { 'Idempotency-Key': catalogPending.current.key }, body: JSON.stringify(requestBody),
      });
      catalogPending.current = null; setCatalogMode(null); setCatalogTarget(null); setCatalogEvidence(null);
      const notices: Record<CatalogDialogMode, string> = {
        create: 'Catalog action submitted for approval. Square is unchanged until an approver accepts it.',
        draft_create: 'Vernius draft saved with an internal ID. Square is unchanged.',
        edit_item: 'Catalog action submitted for approval. Square is unchanged until an approver accepts it.',
        edit_variation: 'Catalog action submitted for approval. Square is unchanged until an approver accepts it.',
        add_variation: 'Catalog action submitted for approval. Square is unchanged until an approver accepts it.',
        cost: result.projectionQueued ? 'Approved cost saved. A historical projection replay is queued.' : 'Approved cost saved.',
        archive: 'Catalog action submitted for approval. Square is unchanged until an approver accepts it.',
        restore: 'Catalog action submitted for approval. Square is unchanged until an approver accepts it.',
      };
      setCatalogNotice(notices[catalogMode]);
      if (catalogMode === 'draft_create') void reloadDomainCatalog().catch(() => {});
      if (catalogMode === 'cost') {
        try { await reloadCatalog(); }
        catch { setCatalogError('The change was saved, but item details could not update. Reopen the catalogue to verify it.'); }
      }
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      setCatalogReconnectNeeded(['SQUARE_NOT_CONNECTED','SQUARE_RECONNECT_REQUIRED','SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED'].includes(code));
      const messages: Record<string, string> = {
        FORBIDDEN: 'Your role does not allow this catalog change.',
        INVALID_DRAFT_CATALOG_ITEM: 'Check the item name and its variation details.',
        INVALID_DRAFT_CATALOG_VARIATION: 'Each variation needs a name and either a valid price with currency or variable pricing.',
        IDEMPOTENCY_CONFLICT: 'This request key was already used for a different catalog change. Close the form and submit it again.',
        SQUARE_NOT_CONNECTED: 'Connect Square before changing the catalogue.',
        SQUARE_RECONNECT_REQUIRED: 'Square authorization needs renewal. Reconnect it to continue.',
        SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED: 'Square item write access is needed. Reauthorize Square to grant it.',
        SQUARE_CATALOG_CONFLICT: 'This item changed in Square after it was loaded. Reopen the catalogue and try again.',
        SQUARE_CATALOG_BUSY: 'Square is processing another catalogue update. Wait a moment, then retry.',
        SQUARE_CATALOG_OBJECT_UNAVAILABLE: 'Square could not find this item. Reopen the catalogue and choose it again.',
        SQUARE_CATALOG_VARIATION_LIMIT: 'Square items support a maximum of 250 variations.',
        SQUARE_CATALOG_SAVED_REFRESH_PENDING: 'Square saved the change, but Finance Loop could not refresh the historical item facts. Retry this same change or ask an owner to check the connection.',
        SQUARE_CATALOG_SAVED_AUDIT_PENDING: 'Square saved the change, but Finance Loop could not record its audit event. Retry this same change so the audit can finish.',
        RECEIPT_COST_APPROVAL_FAILED: 'Cost approval failed. Check the evidence, effective date, and your reviewer role.',
        RECEIPT_COST_SAVED_REPLAY_PENDING: 'The cost was saved, but the historical replay could not be queued. Retry the same approval.',
        RECEIPT_COST_DATE_OUTSIDE_REPLAY_WINDOW: 'That cost effective date is outside the supported historical replay window.',
      };
      setCatalogError(messages[code] ?? (code === 'INTERNAL_ERROR' ? 'The change failed unexpectedly. Your form is still here; retry once.' : code || 'Catalogue change could not be saved.'));
    } finally { setCatalogSaving(false); }
  }
  function exportCsv() {
    if (!report) return;
    const rows: unknown[][] = [['Period from', from], ['Period to', to], ['Requested currency', currency], ['Reported currency', report.currency ?? 'Mixed or unavailable'], ['Calculation version', report.calculationVersion], ['Calculation status', report.status], ['Source revision', report.sourceRevision ?? 'unavailable'], ['Aggregate Square processing fees', report.totals.feesMinor ?? 'incomplete'], ['Aggregate net after fees', report.totals.netMinor ?? 'incomplete'], ['Product result basis', 'Net and margin before processing fees'], [], ['Product','Product ID','Units sold','Revenue minor','Cost minor','Net before fees minor','Revenue rank','Net rank','Margin before fees bps','Source refs','Status'], ...report.products.map(p => [p.productName ?? 'Unidentified product', p.productId, p.unitsSold, p.revenueMinor, p.costMinor ?? '', p.netMinor ?? '', p.revenueRank ?? '', p.netRank ?? '', p.marginBps ?? '', p.sourceRefs?.join('|') ?? '', p.netMinor == null ? 'incomplete' : 'complete']), ['Unallocated revenue','','',report.unallocated.revenueMinor,'','','','','','','review'], ['Unallocated refunds','','',report.unallocated.refundsMinor,'','','','','','','review'], ['Unallocated COGS reversals','','','',report.unallocated.cogsReversalMinor ?? '','','','','','','review']];
    const csv = rows.map(row => row.map(value => { const raw = String(value ?? ''); const safe = /^[\s=+\-@]/.test(raw) ? `'${raw}` : raw; return `"${safe.replaceAll('"', '""')}"`; }).join(',')).join('\r\n');
    const href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = href; link.download = `product-analytics-${from.slice(0,10)}-${to.slice(0,10)}.csv`; link.click(); URL.revokeObjectURL(href);
  }
  return <><FoldablePanel title="Performance snapshot" className="analytics-snapshot"><section className="metric-grid"><Card label="Product revenue" value={money(report?.totals?.revenueMinor, currency)} hint="After known discounts and refunds" /><Card label="Product cost" value={money(report?.totals?.costMinor, currency)} hint={report?.totals?.costMinor == null ? 'Cost evidence incomplete' : 'Approved acquisition costs'} tone={report?.totals?.costMinor == null ? 'warn-text' : ''} /><Card label="Square processing fees" value={money(report?.totals?.feesMinor, currency)} hint={report?.totals?.feesMinor == null ? 'Fee data incomplete' : feeHealthIncomplete ? 'Known fees; source health incomplete' : 'After product margins'} tone={report?.totals?.feesMinor == null ? 'warn-text' : feeHealthIncomplete ? 'warn-text' : ''} /><Card label="Net after fees" value={money(report?.totals?.netMinor, currency)} hint={feeHealthIncomplete && report?.totals?.netMinor != null ? 'Available fees only; source health incomplete' : 'Revenue − COGS − fees'} tone={feeHealthIncomplete ? 'warn-text' : report?.totals?.netMinor == null ? 'warn-text' : ''} /></section></FoldablePanel>
    <FoldablePanel title="Item catalog and pricing" description="Square item changes go through approval. Evidence-backed costs remain a separate finance decision." className="table-panel" actions={<span className="pill neutral">{report?.catalogStatus === 'unavailable' ? 'Unavailable' : activeCatalogCount + ' active · ' + archivedCatalogCount + ' archived'}</span>}>
      <div className="catalog-toolbar"><div className="catalog-tabs" role="group" aria-label="Catalogue status filter"><button type="button" className={catalogView === 'active' ? 'catalog-tab selected' : 'catalog-tab'} aria-pressed={catalogView === 'active'} onClick={() => setCatalogView('active')}>Active <span>{activeCatalogCount}</span></button><button type="button" className={catalogView === 'archived' ? 'catalog-tab selected' : 'catalog-tab'} aria-pressed={catalogView === 'archived'} onClick={() => setCatalogView('archived')}>Archived <span>{archivedCatalogCount}</span></button><button type="button" className={catalogView === 'all' ? 'catalog-tab selected' : 'catalog-tab'} aria-pressed={catalogView === 'all'} onClick={() => setCatalogView('all')}>All <span>{allCatalogItems.length}</span></button></div><label>Find item<input type="search" value={catalogSearch} onChange={e => setCatalogSearch(e.target.value)} placeholder="Name, variation, SKU, or ID" /></label>{canManageCatalog && <><button type="button" className="secondary with-icon" onClick={() => openCatalogDialog('draft_create')}><UiIcon name="plus" />Save Vernius draft</button><button type="button" className="primary with-icon" onClick={() => openCatalogDialog('create')}><UiIcon name="plus" />Add item to Square</button></>}</div>
      {catalogNotice && <div className="notice" role="status">{catalogNotice}</div>}{catalogError && !catalogMode && <div className="notice error-box" role="alert">{catalogError}</div>}
      {catalogReconnectNeeded && canManageCatalog && <button type="button" className="secondary" onClick={() => void authorizeSquareCatalog()} disabled={catalogSaving}>Connect or reauthorize Square</button>}
      {loading ? <div className="inline-empty">Loading item catalog…</div> : report?.catalogStatus === 'unavailable' ? <div className="inline-empty">Item catalog pricing could not be loaded. Product performance data is still available.</div> : visibleCatalogItems.length ? <div className="table-wrap"><table className="catalog-table"><thead><tr><th>Item</th><th>SKU</th>{showCatalogCurrency && <th>Currency</th>}<th className="numeric">Selling price</th><th className="numeric">Approved unit cost</th><th aria-label="Actions"></th></tr></thead><tbody>{visibleCatalogItems.map((item, index) => {
        const firstForItem = item.itemKind === 'square' && Boolean(item.squareItemId)
          && !visibleCatalogItems.slice(0, index).some(previous => previous.squareItemId === item.squareItemId);
        return <tr key={`${item.itemKind}:${item.id}:${item.currency ?? ''}`}><td>{item.itemName}{item.archived && <span className="pill neutral catalog-state">Archived</span>}<small className="cell-sub">{item.variationName ? item.variationName : item.itemKind === 'supply' ? 'Supply item' : 'Square item'}</small></td><td>{item.sku ?? '—'}</td>{showCatalogCurrency && <td>{item.currency ?? '—'}</td>}<td className="numeric">{item.itemKind === 'supply' ? '—' : item.sellingPriceMinor == null ? item.pricingType === 'VARIABLE_PRICING' ? 'Variable' : '—' : money(item.sellingPriceMinor, item.currency ?? currency)}</td><td className="numeric">{item.itemKind === 'supply' ? '—' : item.unitCostMinor == null ? <span className="cost-unavailable">Cost unavailable</span> : <>{money(item.unitCostMinor, item.currency ?? currency)}{item.costEffectiveFrom && <small className="cell-sub">Effective {item.costEffectiveFrom.slice(0, 10)}</small>}</>}</td><td><details className="action-menu catalog-row-menu"><summary aria-label={`Actions for ${item.itemName}`} title="More actions"><UiIcon name="more" /></summary><div className="action-menu-popover">{item.itemKind === 'square' && canManageCatalog && <>{firstForItem && <><button type="button" onClick={() => openCatalogDialog('edit_item', item)}>Edit item</button><button type="button" onClick={() => openCatalogDialog('add_variation', item)}>Add variation</button><button type="button" onClick={() => openCatalogDialog(item.archived ? 'restore' : 'archive', item)}>{item.archived ? 'Restore item' : 'Archive item'}</button></>}<button type="button" onClick={() => openCatalogDialog('edit_variation', item)}>Edit variation</button></>}{item.itemKind === 'square' && canManageCosts && <button type="button" onClick={() => openCatalogDialog('cost', item)}>{item.unitCostMinor == null ? 'Add cost' : 'Update cost'}</button>}{item.itemKind === 'supply' && <span className="menu-note">Managed in inventory</span>}</div></details></td></tr>;
      })}</tbody></table></div> : !error ? <div className="inline-empty">{allCatalogItems.length ? 'No items match this filter.' : 'No synced Square items or registered supplies are available.'}</div> : null}
      {domainDraftItems.length > 0 && <section className="stock-panel"><div className="panel-heading"><div><h3>Vernius drafts</h3><p>Internal catalog records that have not been linked to a Square item.</p></div><span className="pill neutral">{domainDraftItems.length} draft{domainDraftItems.length === 1 ? '' : 's'}</span></div><div className="table-wrap"><table><thead><tr><th>Draft item</th><th>Variations</th><th>Internal ID</th><th>Status</th></tr></thead><tbody>{domainDraftItems.map(item => <tr key={item.itemId}><td>{item.name}<small className="cell-sub">{item.description || 'No description'}</small></td><td>{item.variations.map(variation => `${variation.name}${variation.sku ? ` · ${variation.sku}` : ''}`).join(', ')}</td><td><code>{item.itemId}</code></td><td><span className="pill neutral">Draft</span></td></tr>)}</tbody></table></div></section>}
    </FoldablePanel>
    {catalogMode && <div className="dialog-backdrop" role="presentation"><section className="dialog catalog-dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-dialog-title"><button type="button" className="icon-button dialog-close" onClick={closeCatalogDialog} disabled={catalogSaving} aria-label="Close catalogue editor"><UiIcon name="close" /></button><h2 id="catalog-dialog-title">{{ create: 'Add item to Square', draft_create: 'Save Vernius draft', edit_item: 'Edit item details', edit_variation: 'Edit variation', add_variation: 'Add variation', cost: 'Approve item cost', archive: 'Archive item', restore: 'Restore item' }[catalogMode]}</h2>
      <form className="entry-form" onSubmit={saveCatalogAction}>
        {(catalogMode === 'create' || catalogMode === 'draft_create') && <>{catalogMode === 'draft_create' && <p className="muted">This creates a Vernius-owned product record without changing Square.</p>}<label>Item name<input required maxLength={200} value={catalogName} onChange={event => setCatalogName(event.target.value)} /></label><label>Description (optional)<textarea rows={3} maxLength={4096} value={catalogDescription} onChange={event => setCatalogDescription(event.target.value)} /></label><div className="catalog-variation-list"><div className="catalog-section-head"><b>Sale variations</b><button type="button" className="secondary with-icon" disabled={catalogVariations.length >= 250} onClick={() => setCatalogVariations(current => [...current, { name: '', sku: '', pricingType: 'FIXED_PRICING', price: '', currency }])}><UiIcon name="plus" />Add</button></div>{catalogVariations.map((variation, index) => <div className="catalog-variation-draft" key={index}><label>Variation name<input required maxLength={200} value={variation.name} onChange={event => setCatalogVariations(current => current.map((row, rowIndex) => rowIndex === index ? { ...row, name: event.target.value } : row))} /></label><label>SKU<input maxLength={100} value={variation.sku} onChange={event => setCatalogVariations(current => current.map((row, rowIndex) => rowIndex === index ? { ...row, sku: event.target.value } : row))} /></label><label>Pricing<select value={variation.pricingType} onChange={event => setCatalogVariations(current => current.map((row, rowIndex) => rowIndex === index ? { ...row, pricingType: event.target.value as CatalogVariationDraft['pricingType'] } : row))}><option value="FIXED_PRICING">Fixed price</option><option value="VARIABLE_PRICING">Variable amount</option></select></label>{variation.pricingType === 'FIXED_PRICING' ? <><label>Sale price<input type="number" min="0" step="any" required value={variation.price} onChange={event => setCatalogVariations(current => current.map((row, rowIndex) => rowIndex === index ? { ...row, price: event.target.value } : row))} /></label><label>Currency<select value={variation.currency} onChange={event => setCatalogVariations(current => current.map((row, rowIndex) => rowIndex === index ? { ...row, currency: event.target.value } : row))}>{Array.from(new Set([currency, variation.currency])).map(value => <option key={value} value={value}>{value}</option>)}</select></label></> : <p className="field-hint">Customer enters the amount at sale.</p>}{catalogVariations.length > 1 && <button type="button" className="icon-button reject-button" onClick={() => setCatalogVariations(current => current.filter((_, rowIndex) => rowIndex !== index))} aria-label={`Remove variation ${index + 1}`} title="Remove variation"><UiIcon name="trash" /></button>}</div>)}</div></>}
        {catalogMode === 'edit_item' && <><label>Item name<input required maxLength={200} value={catalogName} onChange={event => setCatalogName(event.target.value)} /></label><label>Description (optional)<textarea rows={4} maxLength={4096} value={catalogDescription} onChange={event => setCatalogDescription(event.target.value)} /></label></>}
        {(catalogMode === 'edit_variation' || catalogMode === 'add_variation') && <><label>Variation name<input required maxLength={200} value={catalogVariationName} onChange={event => setCatalogVariationName(event.target.value)} /></label><label>SKU<input maxLength={100} value={catalogSku} onChange={event => setCatalogSku(event.target.value)} /></label><label>Pricing<select value={catalogPricingType} onChange={event => setCatalogPricingType(event.target.value as typeof catalogPricingType)}><option value="FIXED_PRICING">Fixed price</option><option value="VARIABLE_PRICING">Variable amount</option></select></label>{catalogPricingType === 'FIXED_PRICING' ? <><label>Sale price ({catalogCurrency})<input type="number" min="0" step="any" required value={catalogPrice} onChange={event => setCatalogPrice(event.target.value)} /></label><label>Currency<select value={catalogCurrency} onChange={event => setCatalogCurrency(event.target.value)}>{Array.from(new Set([currency, catalogCurrency])).map(value => <option key={value} value={value}>{value}</option>)}</select></label></> : <p className="field-hint">The customer enters the amount when this variation is sold.</p>}</>}
        {catalogMode === 'cost' && <><p className="muted">Use supplier evidence and unit acquisition cost. Historical COGS updates from the effective date.</p><label>Approved unit acquisition cost ({catalogTarget?.currency ?? currency})<input type="number" min="0" step="any" required value={catalogCost} onChange={event => setCatalogCost(event.target.value)} /></label><label>Effective date ({timezone})<input type="date" required value={catalogCostDate} onChange={event => setCatalogCostDate(event.target.value)} /></label><label>Supplier evidence file<input type="file" accept="application/pdf,image/jpeg,image/png" onChange={event => setCatalogEvidence(event.target.files?.[0] ?? null)} /></label><label>Or existing evidence ID<input value={catalogEvidenceRef} onChange={event => setCatalogEvidenceRef(event.target.value)} maxLength={36} placeholder="Evidence UUID" /></label></>}
        {(catalogMode === 'archive' || catalogMode === 'restore') && <p className="muted">{catalogMode === 'archive' ? 'Archives all variations; historical sales keep their item IDs.' : 'Restores this item and its variations.'}</p>}
        <label>Reason<textarea required minLength={10} maxLength={1000} value={catalogReason} onChange={event => setCatalogReason(event.target.value)} placeholder="Why are you changing this item?" /></label>
        {catalogError && <p className="error" role="alert">{catalogError}</p>}{catalogReconnectNeeded && canManageCatalog && <button type="button" className="secondary" onClick={() => void authorizeSquareCatalog()} disabled={catalogSaving}>Connect or reauthorize Square</button>}
        <div className="form-actions"><button type="button" className="secondary" onClick={closeCatalogDialog} disabled={catalogSaving}>Cancel</button><button type="submit" className="primary with-icon" disabled={catalogSaving}><UiIcon name={catalogMode === 'archive' ? 'archive' : catalogMode === 'restore' ? 'refresh' : 'check'} />{catalogSaving ? 'Submitting…' : catalogMode === 'cost' ? 'Approve cost' : catalogMode === 'draft_create' ? 'Save draft' : 'Submit for approval'}</button></div>
      </form></section></div>}
    <FoldablePanel title="Product performance before fees" description="Select a product to see its sales trend." className="table-panel" actions={<div className="form-actions"><span className={report?.status === 'complete' ? 'pill good' : report?.status === 'failed' ? 'pill warn' : 'pill neutral'}>{report?.status ?? (loading ? 'Loading' : 'Unavailable')}</span><button className="secondary with-icon" onClick={exportCsv} disabled={!report}><UiIcon name="download" />Export</button></div>}>
      {loading && <div className="inline-empty">Calculating product results…</div>}{error && <div className="notice error-box" role="alert">{error}</div>}{report?.currency == null && report?.status === 'failed' && <div className="notice error-box" role="alert">Mixed or invalid source currencies prevented a single-currency report.</div>}
      <div className="filter-panel"><label>Find product<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Name or product ID" /></label><label>Rank by<select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}><option value="revenue">Revenue</option><option value="cost">Cost</option><option value="net">Net before fees</option><option value="units">Units sold</option></select></label></div>
      {visibleProducts.length ? <div className="table-wrap"><table><thead><tr><th>Rank</th><th>Product</th><th className="numeric">Units</th><th className="numeric">Revenue</th><th className="numeric">Cost</th><th className="numeric">Net before fees</th><th className="numeric">Margin before fees</th><th className="numeric">Revenue share</th></tr></thead><tbody>{visibleProducts.map(product => <tr key={product.productId}><td>R{product.revenueRank ?? '—'} / N{product.netRank ?? '—'}</td><td><button type="button" className={'analytics-product-choice' + (selectedProductId === product.productId ? ' selected' : '')} aria-pressed={selectedProductId === product.productId} aria-label={(selectedProductId === product.productId ? 'Hide' : 'Show') + ' sales chart for ' + (product.productName ?? 'Unidentified product')} onClick={() => setSelectedProductId(selectedProductId === product.productId ? '' : product.productId)}>{product.productName ?? 'Unidentified product'}<small className="cell-sub">{product.productId}</small></button></td><td className="numeric">{product.unitsSold}</td><td className="numeric">{money(product.revenueMinor, currency)}</td><td className="numeric">{money(product.costMinor, currency)}</td><td className="numeric">{product.netMinor == null ? <span className="pill warn">Incomplete</span> : money(product.netMinor, currency)}</td><td className="numeric">{product.marginBps == null ? '—' : `${(product.marginBps / 100).toFixed(1)}%`}</td><td className="numeric">{product.revenueShareBps == null ? '—' : `${(product.revenueShareBps / 100).toFixed(1)}%`}</td></tr>)}</tbody></table></div> : !loading && !error && <div className="inline-empty">No product sales match this period and filter.</div>}{selectedProduct && <ProductSalesChart product={selectedProduct} from={from} to={to} currency={currency} issues={report?.issues ?? []} />}
    </FoldablePanel>{(seriesView === 'monthly' ? report?.monthly : report?.daily)?.length ? <FoldablePanel title={seriesView === 'monthly' ? 'Monthly trend' : 'Daily trend'} description="UTC · processing fees are deducted after item costs." className="table-panel" actions={<label className="analytics-view-control">View<select value={seriesView} onChange={e => setSeriesView(e.target.value as 'monthly' | 'daily')}><option value="monthly">Monthly</option><option value="daily">Daily</option></select></label>}><div className="table-wrap"><table><thead><tr><th>Period (UTC)</th><th className="numeric">Revenue</th><th className="numeric">Cost</th><th className="numeric">Processing fees</th><th className="numeric">Net after fees</th><th className="numeric">Units</th></tr></thead><tbody>{(seriesView === 'monthly' ? report?.monthly : report?.daily)?.map(series => <tr key={series.period}><td>{series.period}</td><td className="numeric">{money(series.revenueMinor, currency)}</td><td className="numeric">{money(series.costMinor, currency)}</td><td className="numeric">{money(series.feesMinor, currency)}</td><td className="numeric">{money(series.netMinor, currency)}</td><td className="numeric">{series.unitsSold}</td></tr>)}</tbody></table></div></FoldablePanel> : null}<FoldablePanel title="Unallocated activity"><div className="status-row"><span>Unallocated revenue</span><b>{money(report?.unallocated?.revenueMinor, currency)}</b></div><div className="status-row"><span>Unallocated refunds</span><b>{money(report?.unallocated?.refundsMinor, currency)}</b></div><div className="status-row"><span>Unallocated COGS reversals</span><b>{money(report?.unallocated?.cogsReversalMinor, currency)}</b></div>{report?.issues?.length ? <div className="notice compact-notice">Incomplete data: {Array.from(new Set(report.issues.map(issue => issue.code))).join(', ')}</div> : null}</FoldablePanel></>;
}
function salesPeriodKeys(from: string, to: string, view: 'daily' | 'monthly') {
  const fromTime = Date.parse(from), toTime = Date.parse(to);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime <= fromTime) return [];
  const start = new Date(fromTime), last = new Date(toTime - 1);
  let cursor = view === 'monthly'
    ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
    : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const lastPeriod = view === 'monthly'
    ? Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1)
    : Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate());
  const periods: string[] = [];
  while (cursor.getTime() <= lastPeriod && periods.length < 400) {
    periods.push(cursor.toISOString().slice(0, view === 'monthly' ? 7 : 10));
    if (view === 'monthly') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return periods;
}

function ProductSalesChart({ product, from, to, currency, issues }: { product: AnalyticsProduct; from: string; to: string; currency: string; issues: AnalyticsReport['issues'] }) {
  const [view, setView] = useState<'daily' | 'monthly'>('daily');
  const points = useMemo(() => {
    const daily = salesPeriodKeys(from, to, 'daily');
    const salesByDay = new Map((product.dailySales ?? []).map(day => [day.period, day.revenueMinor] as const));
    const dailyPoints = daily.map(period => ({ period, revenueMinor: salesByDay.has(period) ? salesByDay.get(period)! : 0 }));
    if (view === 'daily') return dailyPoints;
    const monthly = new Map<string, { period: string; revenueMinor: number | null }>();
    for (const point of dailyPoints) {
      const period = point.period.slice(0, 7), bucket = monthly.get(period) ?? { period, revenueMinor: 0 };
      if (point.revenueMinor === null || bucket.revenueMinor === null) bucket.revenueMinor = null;
      else {
        const total = bucket.revenueMinor + point.revenueMinor;
        bucket.revenueMinor = Number.isSafeInteger(total) ? total : null;
      }
      monthly.set(period, bucket);
    }
    return [...monthly.values()];
  }, [from, to, product.dailySales, view]);
  const hasMissingTrendPayload = !Array.isArray(product.dailySales) || product.dailySales.length === 0;
  const incompleteWindow = issues.some(issue => issue.code === 'SOURCE_WINDOW_UNVERIFIED');
  const hasIncompleteTrendBucket = Array.isArray(product.dailySales) && product.dailySales.some(day => day.revenueMinor === null);
  const hasCompleteItemTotals = product.revenueMinor !== null;
  const trendUnavailableReason = hasCompleteItemTotals && (hasMissingTrendPayload || hasIncompleteTrendBucket)
    ? 'Product totals loaded, but their item trend buckets are missing or incomplete. If this persists after the next sync, deploy the latest analytics calculation.'
    : incompleteWindow
      ? 'A completed Square sync does not cover the full selected period. Use Sync data for this period; the report updates when the sync finishes.'
      : hasIncompleteTrendBucket
        ? 'One or more item revenue buckets have incomplete source data. Resolve the related source gap, then sync the selected period.'
        : points.length === 0
          ? 'There are no UTC date buckets in the selected period.'
          : hasMissingTrendPayload
            ? 'No item-level trend buckets were returned for this product.'
            : null;
  const trendAvailable = trendUnavailableReason === null && points.every(point => point.revenueMinor !== null);
  const hasSales = points.some(point => point.revenueMinor !== null && point.revenueMinor !== 0);
  const width = 760, height = 220, left = 76, right = 748, top = 20, bottom = 177;
  const values = points.map(point => point.revenueMinor ?? 0);
  const maxValue = Math.max(0, ...values), minValue = Math.min(0, ...values);
  const domainMax = maxValue === minValue ? 1 : maxValue;
  const domainMin = maxValue === minValue ? 0 : minValue;
  const yFor = (value: number) => top + (domainMax - value) / (domainMax - domainMin) * (bottom - top);
  const zeroY = yFor(0), step = points.length ? (right - left) / points.length : 0;
  const barWidth = Math.max(1, Math.min(28, step * 0.68));
  const tickIndexes = points.length ? [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter(index => index >= 0) : [];
  return <div className="item-sales-chart">
    <div className="item-sales-heading"><div><h3>Sales over time · {product.productName ?? 'Unidentified product'}</h3><p>After known discounts and refunds · UTC</p></div><label className="compact">View<select value={view} onChange={event => setView(event.target.value as typeof view)}><option value="daily">Daily</option><option value="monthly">Monthly</option></select></label></div>
    {!trendAvailable ? <div className="inline-empty">{trendUnavailableReason ?? 'Item revenue is incomplete for this period.'}</div> : <>
      <div className="item-sales-svg-wrap"><svg className="item-sales-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${product.productName ?? product.productId} revenue by ${view === 'daily' ? 'day' : 'month'}`}>
        <line x1={left} x2={right} y1={zeroY} y2={zeroY} className="item-sales-zero" />
        <text x={left - 8} y={top + 4} textAnchor="end" className="item-sales-axis">{money(maxValue, currency)}</text>
        {domainMin < 0 && <text x={left - 8} y={bottom + 3} textAnchor="end" className="item-sales-axis">{money(minValue, currency)}</text>}
        {points.map((point, index) => {
          const value = point.revenueMinor ?? 0, valueY = yFor(value), barHeight = value === 0 ? 0 : Math.max(1, Math.abs(zeroY - valueY));
          const x = left + index * step + (step - barWidth) / 2;
          return <rect key={point.period} x={x} y={Math.min(zeroY, valueY)} width={barWidth} height={barHeight} rx="1" fill={value < 0 ? '#B1B1B1' : '#B9B9B9'}><title>{point.period}: {money(point.revenueMinor, currency)}</title></rect>;
        })}
        {tickIndexes.map(index => <text key={points[index].period} x={left + index * step + step / 2} y={height - 12} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'} className="item-sales-axis">{points[index].period}</text>)}
      </svg></div>
      {!hasSales && <p className="item-sales-empty">No recorded revenue for this item in the selected period.</p>}
    </>}
  </div>;
}

function Review({ issues, organizationId, currency, canSync, syncPeriodLabel, onSaved }: { issues: Issue[]; organizationId: string; currency: string; canSync: boolean; syncPeriodLabel: string; onSaved: () => void }) {
  const [selected, setSelected] = useState<Issue | null>(null);
  const [issueDetails, setIssueDetails] = useState<Issue | null>(null);
  const [issueEvidence, setIssueEvidence] = useState<IssueEvidence[]>([]);
  const [issueEvidenceLoading, setIssueEvidenceLoading] = useState(false);
  const [issueEvidenceError, setIssueEvidenceError] = useState('');
  const issueEvidenceRequestId = useRef(0);
  const [correction, setCorrection] = useState<{ issue: Issue; kind: 'item' | 'refund' } | null>(null);
  const [reason, setReason] = useState(''); const [busyId, setBusyId] = useState(''); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [evidence, setEvidence] = useState<IssueEvidence[]>([]); const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [correctionReady, setCorrectionReady] = useState(false);
  const [selectedSaleLineId, setSelectedSaleLineId] = useState('');
  const [catalogId, setCatalogId] = useState(''); const [itemName, setItemName] = useState(''); const [unitCost, setUnitCost] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(''); const [itemCurrency, setItemCurrency] = useState(currency);
  const [refundId, setRefundId] = useState(''); const [orderId, setOrderId] = useState('');
  const [disposition, setDisposition] = useState<'' | 'returned_to_inventory' | 'not_returned_to_inventory'>('');
  const [reversal, setReversal] = useState('0.00'); const [refundCurrency, setRefundCurrency] = useState(currency);

  async function decide(issue: Issue, proposal: Record<string, unknown>, decision: 'approve' | 'reject') {
    const proposalId = String(proposal.id ?? ''); const revision = Number(proposal.revision ?? issue.revision ?? issue.details?.revision ?? 1);
    if (!proposalId || !Number.isSafeInteger(revision) || !reason.trim()) { setError('This issue has no pending proposal ID or review reason.'); return; }
    setBusyId(issue.id); setError('');
    try { await api(`/api/proposals/${encodeURIComponent(proposalId)}/decision`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ organizationId, issueId: issue.id, proposalId, decision, reason: reason.trim(), expectedRevision: revision }) }); setSelected(null); setReason(''); onSaved(); }
    catch (err) { setError(err instanceof Error ? err.message : 'The decision could not be saved.'); } finally { setBusyId(''); }
  }
  async function draft(issue: Issue) {
    setBusyId(issue.id); setError('');
    try { await api('/api/proposals', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ organizationId, issueId: issue.id }) }); onSaved(); }
    catch (err) { setError(err instanceof Error ? err.message : 'A proposal could not be generated.'); } finally { setBusyId(''); }
  }
  async function loadIssueEvidence(issue: Issue) {
    const requestId = ++issueEvidenceRequestId.current;
    setIssueEvidence([]); setIssueEvidenceError(''); setIssueEvidenceLoading(supportsIssueEvidence(issue));
    if (!supportsIssueEvidence(issue)) return;
    try {
      const query = new URLSearchParams({ organizationId });
      const result = await api<{ evidence: IssueEvidence[] }>(`/api/issues/${encodeURIComponent(issue.id)}/evidence?${query}`);
      if (requestId === issueEvidenceRequestId.current) setIssueEvidence(result.evidence ?? []);
    } catch (err) {
      if (requestId === issueEvidenceRequestId.current) {
        setIssueEvidenceError(err instanceof Error && err.message === 'Your session has expired. Sign in again.'
          ? err.message
          : 'Square linked records could not be loaded. This issue remains open and no decision was saved. Retry; if it continues, share the issue ID with a workspace owner.');
      }
    } finally { if (requestId === issueEvidenceRequestId.current) setIssueEvidenceLoading(false); }
  }
  function openIssue(issue: Issue) {
    setIssueDetails(issue);
    void loadIssueEvidence(issue);
  }
  async function openCorrection(issue: Issue, kind: 'item' | 'refund') {
    setCorrection({ issue, kind }); setError(''); setNotice(''); setReason(''); setEvidence([]); setEvidenceLoading(true);
    setCorrectionReady(false);
    setCatalogId(''); setItemName(''); setUnitCost(''); setEffectiveDate(''); setItemCurrency(currency); setSelectedSaleLineId('');
    const message = String(issue.details?.message ?? '');
    const refund = /^Refund ([A-Za-z0-9_-]+)/.exec(message)?.[1] ?? '';
    setRefundId(refund); setOrderId((issue.source_refs ?? []).find(ref => ref !== refund) ?? '');
    setDisposition(''); setReversal('0.00'); setRefundCurrency(currency);
    try {
      const query = new URLSearchParams({ organizationId });
      const result = await api<{ evidence: IssueEvidence[]; correctionReady?: boolean }>(`/api/issues/${encodeURIComponent(issue.id)}/evidence?${query}`);
      const rows = result.evidence ?? []; setEvidence(rows);
      setCorrectionReady(result.correctionReady ?? true);
      const first = rows[0];
      if (kind === 'item' && first) {
        setSelectedSaleLineId(first.id);
        setCatalogId(first.catalog_object_id ?? ''); setItemName(first.item_name ?? ''); setItemCurrency(first.currency ?? currency);
        setEffectiveDate((first.occurred_at ?? String(issue.details?.period_start ?? '')).slice(0, 10));
      }
      if (kind === 'refund') {
        const refundEvidence = rows.find(row => row.type === 'refund');
        const firstLine = rows.find(row => row.type === 'sale_line');
        setRefundId(refundEvidence?.refund_id ?? refund);
        setOrderId(refundEvidence?.order_id ?? (issue.source_refs ?? []).find(ref => ref !== (refundEvidence?.refund_id ?? refund) && /^[A-Za-z0-9_-]{1,200}$/.test(ref)) ?? '');
        setRefundCurrency(refundEvidence?.currency ?? firstLine?.currency ?? currency);
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load source evidence.'); }
    finally { setEvidenceLoading(false); }
  }
  async function saveCorrection(event: FormEvent) {
    event.preventDefault(); if (!correction) return;
    const { issue, kind } = correction; setBusyId(issue.id); setError(''); setNotice('');
    try {
      if (kind === 'item') {
        const dollars = Number(unitCost); const minor = Math.round(dollars * 100);
        if ((catalogId.trim() && !itemName.trim()) || !Number.isFinite(dollars) || dollars < 0 || Math.abs(dollars * 100 - minor) > 1e-7) throw new Error(catalogId.trim() && !itemName.trim() ? 'Enter the source item name and an approved unit cost in cents.' : 'Enter an approved unit cost in cents.');
        const idempotencyKey = crypto.randomUUID();
        let result: { projectionJobId: string };
        if (catalogId.trim()) {
          if (!effectiveDate) throw new Error('Enter the date the catalog item cost became effective.');
          const effectiveFrom = new Date(`${effectiveDate}T00:00:00`).toISOString();
          result = await api<{ projectionJobId: string }>(`/api/issues/${encodeURIComponent(issue.id)}/item-cost`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ organizationId, squareCatalogObjectId: catalogId.trim(), name: itemName.trim(), unitCostMinor: minor, currency: itemCurrency, effectiveFrom, reason: reason.trim() }) });
          setNotice(`Approved catalog cost saved. Historical projection replay ${result.projectionJobId} is queued.`);
        } else {
          const line = evidence.find(row => row.id === selectedSaleLineId);
          if (!line?.provider_object_id || !line.line_id) throw new Error('The selected Square sale line is missing its order or line identifier.');
          result = await api<{ projectionJobId: string }>(`/api/issues/${encodeURIComponent(issue.id)}/line-cost`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ organizationId, squareOrderId: line.provider_object_id, squareLineUid: line.line_id, unitCostMinor: minor, currency: itemCurrency, reason: reason.trim() }) });
          setNotice(`Sale-line cost saved for this transaction only. Historical projection replay ${result.projectionJobId} is queued.`);
        }
      } else {
        const dollars = Number(reversal); const minor = Math.round(dollars * 100);
        if (!refundId || !orderId || !['returned_to_inventory', 'not_returned_to_inventory'].includes(disposition) || !Number.isFinite(dollars) || dollars < 0 || Math.abs(dollars * 100 - minor) > 1e-7) throw new Error('Choose the return disposition and confirm the linked refund, order, and approved COGS reversal in cents.');
        if (disposition === 'not_returned_to_inventory' && minor !== 0) throw new Error('A refund with no goods returned to inventory must have a zero COGS reversal.');
        const result = await api<{ projectionJobId: string }>(`/api/issues/${encodeURIComponent(issue.id)}/refund-review`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ organizationId, squareRefundId: refundId, squareOrderId: orderId, disposition, approvedCogsReversalMinor: minor, currency: refundCurrency, reason: reason.trim() }) });
        setNotice(`Refund decision saved. Historical projection replay ${result.projectionJobId} is queued.`);
      }
      setCorrection(null); setReason(''); onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save this financial decision.'); }
    finally { setBusyId(''); }
  }
  function getProposal(issue: Issue): Record<string, unknown> | undefined {
    const pending = issue.proposals?.find(p => p.decision === 'pending');
    return (pending as Record<string, unknown> | undefined) ?? (issue.details?.proposal as Record<string, unknown> | undefined);
  }
  const selectedSaleLine = evidence.find(row => row.type === 'sale_line' && row.id === selectedSaleLineId) ?? evidence.find(row => row.type === 'sale_line');
  const refundEvidence = evidence.find(row => row.type === 'refund');
  const refundItems = evidence.filter(row => row.type === 'sale_line');
  const passThroughLine = correction?.kind === 'item' && !!selectedSaleLine && !catalogId && !selectedSaleLine.item_name?.trim();
  const passThroughPriceMinor = passThroughLine && selectedSaleLine ? passThroughUnitPriceMinor(selectedSaleLine) : null;
  const saleCostNotice = passThroughLine
    ? passThroughPriceMinor === null
      ? 'Square did not provide a reliable per-unit price, so no pass-through cost is prefilled.'
      : `Square also did not provide an item name. Per merchant policy, the prefilled pass-through cost equals the supported unit price of ${money(passThroughPriceMinor, itemCurrency)}. This approval applies only to this exact sale line (quantity ${selectedSaleLine?.quantity ?? 'unknown'}); replay uses unit cost × quantity.`
    : `This approval applies only to this exact sale line (quantity ${selectedSaleLine?.quantity ?? 'unknown'}). Enter a supplier-backed acquisition cost; replay uses unit cost × quantity.`;
  const issueDiagnosis = issueDetails ? sourceGapReviewContext(issueDetails) : null;
  const issueEvidenceSupported = issueDetails ? supportsIssueEvidence(issueDetails) : false;
  useEffect(() => {
    if (!passThroughLine || !selectedSaleLine) return;
    const unitPriceMinor = passThroughUnitPriceMinor(selectedSaleLine);
    if (unitPriceMinor === null) return;
    setUnitCost(minorInput(unitPriceMinor, itemCurrency));
    setReason(passThroughReason(unitPriceMinor, itemCurrency));
  }, [correction?.kind, correction?.issue.id, selectedSaleLine, passThroughLine, itemCurrency]);
  return <>
    <section className="panel table-panel">
      <div className="panel-heading"><div><h2>Review queue</h2></div><span className="pill neutral">{issues.length} open</span></div>
      {error && !correction && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
      {issues.length ? <div className="review-list">{issues.map(issue => {
        const proposal = getProposal(issue);
        const diagnosis = sourceGapReviewContext(issue);
        const issueTitle = issue.code === 'UNKNOWN_ITEM' ? 'Item cost needs review'
          : issue.code === 'REFUND_COGS_REVIEW' ? 'Refund return needs review'
            : issue.code === 'SOURCE_GAP' ? 'Square source data needs attention'
              : issue.code === 'SOURCE_STALE' ? 'Square sync is out of date'
            : issue.title ?? issue.code?.replaceAll('_', ' ').toLowerCase() ?? 'Needs review';
        const issueMessage = issue.code === 'UNKNOWN_ITEM' ? 'Add a supplier-backed unit cost.'
          : issue.code === 'REFUND_COGS_REVIEW' ? 'Confirm whether goods returned; reverse COGS only for restocked goods.'
            : diagnosis ? diagnosis.summary
            : String(issue.details?.message ?? issue.details?.description ?? 'Review the linked source evidence and decide how to handle this item.');
        return <article className="review-item" key={issue.id}>
          <div className="review-symbol"><UiIcon name="review" /></div>
          <div className="review-copy"><div className="review-title"><button type="button" className="review-issue-trigger" onClick={() => void openIssue(issue)}>{issueTitle}</button> <span className="pill warn">{issue.state.replaceAll('_', ' ')}</span></div>
            <p>{issueMessage}</p>
            {proposal && <details className="proposal-details"><summary>Proposed classification and evidence</summary><pre>{JSON.stringify(proposal.proposal ?? proposal.payload ?? proposal, null, 2)}</pre></details>}
          </div>
          <div className="form-actions review-actions">
            {issue.code === 'UNKNOWN_ITEM' && <button className="secondary with-icon" disabled={busyId === issue.id} onClick={() => void openCorrection(issue, 'item')}><UiIcon name="edit" />Record cost</button>}
            {issue.code === 'REFUND_COGS_REVIEW' && <button className="secondary with-icon" disabled={busyId === issue.id} onClick={() => void openCorrection(issue, 'refund')}><UiIcon name="edit" />Review return</button>}
            {!['UNKNOWN_ITEM', 'REFUND_COGS_REVIEW'].includes(issue.code ?? '') && (proposal ? <button className="secondary with-icon" disabled={busyId === issue.id} onClick={() => { setSelected(issue); setReason(''); setError(''); }}><UiIcon name="review" />Review</button>
              : issue.proposal_supported && <button className="secondary with-icon" disabled={busyId === issue.id} onClick={() => void draft(issue)}><UiIcon name="file" />{busyId === issue.id ? 'Preparing…' : 'Draft'}</button>)}
          </div>
        </article>;
      })}</div> : <div className="inline-empty">No open reviews.</div>}
      {issueDetails && <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setIssueDetails(null); }}><section className="dialog issue-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="issue-details-title">
        <button className="icon-button dialog-close" onClick={() => setIssueDetails(null)} aria-label="Close issue details"><UiIcon name="close" /></button>
        <p className="eyebrow">ISSUE DETAILS</p>
        <h2 id="issue-details-title">{issueDetails.title ?? (issueDetails.code === 'SOURCE_GAP' ? 'Square source data needs attention' : issueDetails.code === 'SOURCE_STALE' ? 'Square sync is out of date' : issueDetails.code?.replaceAll('_', ' ')) ?? 'Review issue'}</h2>
        <p className="issue-detail-state"><span className="pill warn">{issueDetails.state.replaceAll('_', ' ')}</span>{issueDetails.code && <span>{issueDetails.code}</span>}</p>
        <dl className="issue-detail-meta"><div><dt>Issue ID</dt><dd>{issueDetails.id}</dd></div>{issueDetails.updated_at && <div><dt>Last updated</dt><dd>{date(issueDetails.updated_at)}</dd></div>}</dl>
        {issueDiagnosis && <section className="decision-context decision-context-warning">
          <div className="decision-context-heading"><span>WHAT NEEDS ATTENTION</span><strong>{issueDiagnosis.summary}</strong></div>
          <dl className="decision-context-grid">
            <div><dt>Square area</dt><dd>{issueDiagnosis.resource}</dd></div>
            <div><dt>Gap type</dt><dd>{issueDiagnosis.gapCode.replaceAll('_', ' ').toLowerCase()}</dd></div>
            {issueDiagnosis.eventType && <div><dt>Square activity</dt><dd>{issueDiagnosis.eventType}</dd></div>}
            {issueDiagnosis.objectId && <div><dt>Square object</dt><dd>{issueDiagnosis.objectId}</dd></div>}
            {issueDiagnosis.providerStatus !== undefined && <div><dt>Provider status</dt><dd>{issueDiagnosis.providerStatus}</dd></div>}
            {issueDiagnosis.providerCode && <div><dt>Provider code</dt><dd>{issueDiagnosis.providerCode}</dd></div>}
            {issueDiagnosis.jobId && <div><dt>Worker job</dt><dd>{issueDiagnosis.jobId}</dd></div>}
          </dl>
          {issueDiagnosis.problems.length > 0 && <>
            <div className="decision-context-subheading">Missing information on source records</div>
            <ul className="decision-context-lines">{issueDiagnosis.problems.map((problem, index) => <li key={`${index}-${problem.objectId ?? 'record'}`}><strong>{problem.objectId ?? `Source record ${index + 1}`}</strong><span>{problem.fields?.length ? problem.fields.map(issueFieldLabel).join('; ') : 'Required source information is missing.'}</span></li>)}</ul>
          </>}
          <p><strong>Next step:</strong> {issueDiagnosis.nextStep}</p>
          {issueDiagnosis.queueSync && (canSync
            ? <p>Use Sync data in the workspace bar to retry {syncPeriodLabel}.</p>
            : <p>Only a workspace owner can start a Square sync. Ask an owner to sync the selected period.</p>)}
        </section>}
        <section className="issue-detail-section"><h3>Linked source references</h3>{issueDetails.source_refs?.length ? <ul className="issue-source-refs">{issueDetails.source_refs.map((ref, index) => <li key={`${index}-${ref}`}><code>{ref}</code></li>)}</ul> : issueDiagnosis?.objectId ? <ul className="issue-source-refs"><li><code>{issueDiagnosis.objectId}</code><small>Square object from the worker diagnostic</small></li></ul> : <p className="muted">{issueDiagnosis ? `No individual record reference was attached; the gap was reported during the Square ${issueDiagnosis.resource} check.` : 'No source references were attached to this issue.'}</p>}</section>
        <section className="issue-detail-section"><h3>Linked source evidence</h3>{issueEvidenceLoading ? <p className="muted">Loading evidence…</p> : issueEvidenceError ? <><p className="error" role="alert">{issueEvidenceError}</p><button type="button" className="secondary with-icon" onClick={() => void loadIssueEvidence(issueDetails)} disabled={issueEvidenceLoading}><UiIcon name="refresh" />Retry</button></> : issueEvidence.length ? <details className="proposal-details" open><summary>{issueEvidence.length} source record{issueEvidence.length === 1 ? '' : 's'}</summary><pre>{JSON.stringify(issueEvidence, null, 2)}</pre></details> : !issueEvidenceSupported ? <p className="muted">Review the source diagnostics and next step above.</p> : <p className="muted">No linked Square evidence.</p>}</section>
        <details className="proposal-details issue-record-details"><summary>Technical details</summary><pre>{JSON.stringify(issueDetails.details ?? {}, null, 2)}</pre></details>
      </section></div>}
      {selected && <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSelected(null); }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="review-dialog-title"><button className="icon-button dialog-close" onClick={() => setSelected(null)} aria-label="Close review"><UiIcon name="close" /></button><p className="eyebrow">REVIEW DECISION</p><h2 id="review-dialog-title">{selected.title ?? selected.code ?? 'Review proposal'}</h2><p className="muted">Proposal decisions do not update costs or refund treatment. Use a source-backed correction for those.</p><label>Decision reason<textarea required rows={4} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></label><div className="form-actions"><button className="secondary" onClick={() => setSelected(null)}>Cancel</button>{(() => { const p = getProposal(selected); return <><button className="secondary reject-button with-icon" disabled={!p || !reason.trim() || busyId === selected.id} onClick={() => p && void decide(selected, p, 'reject')}><UiIcon name="reject" />Reject</button><button className="primary with-icon" disabled={!p || !reason.trim() || busyId === selected.id} onClick={() => p && void decide(selected, p, 'approve')}><UiIcon name="check" />Approve</button></>; })()}</div></section></div>}
    </section>
    {correction && <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setCorrection(null); }}>
      <form className="dialog" onSubmit={saveCorrection} role="dialog" aria-modal="true" aria-labelledby="correction-title">
        <button type="button" className="icon-button dialog-close" onClick={() => setCorrection(null)} aria-label="Close correction"><UiIcon name="close" /></button>
        <p className="eyebrow">SOURCE-BACKED FINANCE DECISION</p>
        <h2 id="correction-title">{correction.kind === 'item' ? (selectedSaleLine?.item_name?.trim() ? `Approve cost for ${selectedSaleLine.item_name.trim()}` : 'Approve item cost') : (refundEvidence?.amount_minor != null ? `Review refund of ${money(Number(refundEvidence.amount_minor), refundEvidence.currency ?? refundCurrency)}` : 'Review refund and returned items')}</h2>
        <p className="muted">Audited decision; the historical period is recalculated. {passThroughLine ? 'Cost is limited to Square’s supported unit price.' : correction.kind === 'item' ? 'Use supplier evidence for unit cost.' : 'Use return records; reverse COGS only for goods returned to inventory.'}</p>
        {evidenceLoading ? <p className="muted">Loading Square evidence…</p> : correction.kind === 'item' ? <>
          {evidence.filter(row => row.type === 'sale_line').length > 1 && <label>Sale item<select value={selectedSaleLineId} onChange={event => { const row = evidence.find(item => item.type === 'sale_line' && item.id === event.target.value); if (row) { setSelectedSaleLineId(row.id); setCatalogId(row.catalog_object_id ?? ''); setItemName(row.item_name ?? ''); setItemCurrency(row.currency ?? currency); setEffectiveDate((row.occurred_at ?? '').slice(0, 10)); setUnitCost(''); setReason(''); } }}>{evidence.filter(row => row.type === 'sale_line').map(row => <option key={row.id} value={row.id}>{row.item_name?.trim() || 'Unidentified item'} · {row.occurred_at ? new Date(row.occurred_at).toLocaleDateString() : 'Date unavailable'} · {row.quantity ?? '—'} units · {row.amount_minor == null ? 'Amount unavailable' : money(Number(row.amount_minor), row.currency ?? currency)}</option>)}</select></label>}
          {selectedSaleLine ? <section className="decision-context" aria-label="Sale item being reviewed">
            <div className="decision-context-heading"><span>ITEM ON THIS SALE</span><strong>{selectedSaleLine.item_name?.trim() || 'Item name unavailable in Square'}</strong></div>
            <dl className="decision-context-grid"><div><dt>Sold</dt><dd>{selectedSaleLine.occurred_at ? new Date(selectedSaleLine.occurred_at).toLocaleDateString() : 'Date unavailable'}</dd></div><div><dt>Quantity</dt><dd>{selectedSaleLine.quantity ?? 'Unavailable'}</dd></div><div><dt>Gross sale</dt><dd>{selectedSaleLine.amount_minor == null ? 'Not provided' : money(Number(selectedSaleLine.amount_minor), selectedSaleLine.currency ?? itemCurrency)}</dd></div></dl>
          </section> : <section className="decision-context decision-context-warning" role="status">
            <div className="decision-context-heading"><span>SOURCE DETAILS UNAVAILABLE</span><strong>Sale item not identified</strong></div>
            <p>No matching Square sale line was found. Approval is unavailable until it can be identified.</p>
          </section>}
          {!catalogId && selectedSaleLine && <p className="notice compact-notice">Square did not link this line to a catalog variation. {saleCostNotice}</p>}
          <div className="form-grid"><label>Approved {passThroughLine ? 'pass-through unit cost' : catalogId ? 'unit cost per item' : 'acquisition cost per unit'} ({itemCurrency})<input required type="number" min="0" step="0.01" value={unitCost} onChange={event => { setUnitCost(event.target.value); if (passThroughLine && passThroughPriceMinor !== null && parseMinor(event.target.value, itemCurrency) !== passThroughPriceMinor) setReason(''); }} /></label>{catalogId && <label>Cost effective from<input required type="date" value={effectiveDate} onChange={event => setEffectiveDate(event.target.value)} /></label>}<label>Cost currency (must match sale currency)<input readOnly value={itemCurrency} /></label></div>
        </> : <>
          {refundEvidence ? <section className="decision-context" aria-label="Refund and original order details">
            <div className="decision-context-heading"><span>REFUND AMOUNT</span><strong>{refundEvidence.amount_minor == null ? 'Amount unavailable' : money(Number(refundEvidence.amount_minor), refundEvidence.currency ?? refundCurrency)} refunded</strong></div>
            <dl className="decision-context-grid"><div><dt>Refund date</dt><dd>{refundEvidence.occurred_at ? new Date(refundEvidence.occurred_at).toLocaleDateString() : 'Date unavailable'}</dd></div><div><dt>Status</dt><dd>{refundEvidence.status?.replaceAll('_', ' ').toLowerCase() ?? 'Recorded by Square'}</dd></div></dl>
            <div className="decision-context-subheading">Items on the original order</div>
            <p>Square does not identify returned lines. Check the merchant’s return record.</p>
            {refundItems.length ? <ul className="decision-context-lines">{refundItems.map(line => <li key={line.id}><strong>{line.item_name?.trim() || 'Item name unavailable'}</strong><span>{line.occurred_at ? new Date(line.occurred_at).toLocaleDateString() : 'Date unavailable'} · quantity {line.quantity ?? 'unavailable'} · original gross sale {line.amount_minor == null ? 'not provided' : money(Number(line.amount_minor), line.currency ?? refundCurrency)}</span></li>)}</ul> : <p>No item lines were returned for the original order.</p>}
          </section> : <section className="decision-context decision-context-warning" role="status">
            <div className="decision-context-heading"><span>REFUND SOURCE UNAVAILABLE</span><strong>Refund details not found</strong></div>
            <p>Square refund details could not be matched. Approval is unavailable until the amount and date are confirmed.</p>
          </section>}
          <div className="form-grid"><label>Returned disposition<select required value={disposition} onChange={event => { const value = event.target.value as typeof disposition; setDisposition(value); if (value === 'not_returned_to_inventory') setReversal('0.00'); }}><option value="">Select the merchant’s return outcome</option><option value="not_returned_to_inventory">Goods were not returned to inventory</option><option value="returned_to_inventory">Goods were returned and restocked</option></select></label><label>Approved COGS reversal ({refundCurrency})<input required type="number" min="0" step="0.01" disabled={disposition !== 'returned_to_inventory'} value={reversal} onChange={event => setReversal(event.target.value)} /></label><label>Cost currency<input required maxLength={3} value={refundCurrency} onChange={event => setRefundCurrency(event.target.value.toUpperCase())} /></label></div>
        </>}
        {!evidenceLoading && !correctionReady && <section className="decision-context decision-context-warning" role="status"><div className="decision-context-heading"><span>SAVING UNAVAILABLE</span><strong>Finance review update required</strong></div></section>}
        <label>Decision reason<textarea required minLength={10} rows={3} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} placeholder={passThroughLine ? 'Explain the pass-through assumption and unit price basis…' : correction.kind === 'item' ? 'Cite the supplier invoice/receipt and how it establishes the per-unit cost…' : 'Cite the merchant return record and the basis for this decision…'} /></label>
        {error && correction && <p className="error" role="alert">{error}</p>}
        <div className="form-actions"><button type="button" className="secondary" onClick={() => setCorrection(null)}>Cancel</button><button className="primary with-icon" disabled={busyId === correction.issue.id || evidenceLoading || !correctionReady || (correction.kind === 'item' && (!selectedSaleLine || (catalogId ? !itemName.trim() : (!selectedSaleLine.provider_object_id || !selectedSaleLine.line_id)))) || (correction.kind === 'refund' && (!refundEvidence || !refundId || !orderId || !disposition))}><UiIcon name="check" />{busyId === correction.issue.id ? 'Saving…' : 'Save & recalculate'}</button></div>
      </form>
    </div>}
  </>;
}
function Ledger({ organizationId, events }: { organizationId: string; events: AuditEvent[] }) {
  const [visibleEvents, setVisibleEvents] = useState(events), [actorUserId, setActorUserId] = useState(''), [action, setAction] = useState('');
  const [entityId, setEntityId] = useState(''), [fromDate, setFromDate] = useState(''), [toDate, setToDate] = useState('');
  const [searchError, setSearchError] = useState(''), [searching, setSearching] = useState(false);
  useEffect(() => { setVisibleEvents(events); }, [events]);
  async function searchAudit(event: FormEvent) {
    event.preventDefault(); setSearching(true); setSearchError('');
    const query = new URLSearchParams({ organizationId, limit: '500' });
    if (actorUserId.trim()) query.set('actorUserId', actorUserId.trim());
    if (action.trim()) query.set('action', action.trim());
    if (entityId.trim()) query.set('entityId', entityId.trim());
    if (fromDate) query.set('from', new Date(`${fromDate}T00:00:00.000Z`).toISOString());
    if (toDate) query.set('to', new Date(Date.parse(`${toDate}T00:00:00.000Z`) + 86400000).toISOString());
    try { const result = await api<{ events: AuditEvent[] }>(`/api/audit?${query}`); setVisibleEvents(result.events ?? []); }
    catch (error) { setSearchError(error instanceof Error ? error.message : 'Audit history could not be searched.'); }
    finally { setSearching(false); }
  }
  function resetSearch() { setActorUserId(''); setAction(''); setEntityId(''); setFromDate(''); setToDate(''); setVisibleEvents(events); setSearchError(''); }
  function exportCsv() {
    const columns = ['id', 'created_at', 'action', 'actor_kind', 'actor_user_id', 'entity_type', 'entity_id', 'source_refs', 'revision', 'details'];
    const quote = (value: unknown) => { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
    const rows = [columns.join(','), ...visibleEvents.map(event => columns.map(key => quote(['details', 'source_refs'].includes(key) ? JSON.stringify((event as unknown as Record<string, unknown>)[key] ?? (key === 'details' ? {} : [])) : (event as unknown as Record<string, unknown>)[key])).join(','))];
    const blob = new Blob([`\uFEFF${rows.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'vernius-audit.csv'; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="panel table-panel"><div className="panel-heading"><div><h2>Audit history</h2><p>Search by employee, operation, record, and date.</p></div><button className="secondary with-icon" disabled={!visibleEvents.length} onClick={exportCsv}><UiIcon name="download" />Export</button></div><form className="form-grid" onSubmit={searchAudit}><label>Employee user ID<input value={actorUserId} onChange={event => setActorUserId(event.target.value)} /></label><label>Operation<input value={action} onChange={event => setAction(event.target.value)} placeholder="e.g. set_permission" /></label><label>Product or record ID<input value={entityId} onChange={event => setEntityId(event.target.value)} /></label><label>From<input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} /></label><label>Through<input type="date" value={toDate} onChange={event => setToDate(event.target.value)} /></label><div className="button-row"><button className="secondary" disabled={searching}>{searching ? 'Searching…' : 'Search history'}</button><button type="button" className="text-button" onClick={resetSearch}>Reset</button></div></form>{searchError && <p className="error" role="alert">{searchError}</p>}{visibleEvents.length ? <div className="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Details</th><th>Reference</th></tr></thead><tbody>{visibleEvents.map(e => <tr key={e.id}><td>{date(e.created_at)}</td><td>{e.action ?? e.event_type ?? 'Workspace event'}<small className="cell-sub">{e.entity_type ?? ''}</small></td><td>{e.actor_user_id ?? e.actor_id ?? e.actor_kind ?? 'System'}</td><td>{e.reason ?? JSON.stringify(e.details ?? e.payload ?? {})}</td><td>{e.entity_id ?? e.id}</td></tr>)}</tbody></table></div> : <div className="inline-empty">No matching audit events. Adjust your filters and search again.</div>}</section>;
}
function FinancialLedger({ organizationId, from, to }: { organizationId: string; from: string; to: string }) {
  const [events, setEvents] = useState<FinancialEvent[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    const query = new URLSearchParams({ organizationId, from, to });
    api<{ events: FinancialEvent[] }>(`/api/financial-events?${query}`)
      .then(result => { if (active) setEvents(result.events ?? []); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Financial events could not be loaded.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [organizationId, from, to]);
  return <section className="panel table-panel"><div className="panel-heading"><div><h2>Financial events</h2><p>Source-linked sales, refunds, discounts, taxes, fees, and settlement entries.</p></div><span className="muted">{events.length} events</span></div>
    {loading ? <div className="inline-empty">Loading financial events…</div> : error ? <div className="notice error-box" role="alert">{error}</div> : events.length ? <div className="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Description</th><th>Amount</th><th>Source</th></tr></thead><tbody>{events.map(event => <tr key={event.id}>
      <td>{date(event.occurredAt)}</td><td>{event.eventType.replaceAll('_', ' ')}<small className="cell-sub">{event.status}</small></td>
      <td>{event.description}{event.lines?.length ? <small className="cell-sub">{event.lines.map(line => `${line.description || 'Line'} × ${line.quantity ?? '—'}`).join(', ')}</small> : null}</td>
      <td className={event.status === 'incomplete' ? 'muted' : ''}>{event.amountMinor == null ? 'Amount missing' : money(event.amountMinor, event.currency)}</td>
      <td><small>{event.sourceProvider ?? 'Vernius'} · {event.sourceType ?? 'manual'}</small><details className="proposal-details"><summary>Evidence</summary><pre>{JSON.stringify({ sourceId: event.sourceId, sourceVersion: event.sourceVersion, supersedesEventId: event.supersedesEventId, details: event.details }, null, 2)}</pre></details></td>
    </tr>)}</tbody></table></div> : <div className="inline-empty">No financial events in this period. Sync Square or record an operational transaction to populate the ledger.</div>}
  </section>;
}

type ActionProposalRow = { id: string; action_type: string; status: string; payload: Record<string, unknown>; payload_sha256: string; expected_source_version?: string | null; location_id?: string | null; amount_minor?: number | null; currency?: string | null; proposed_by: string; created_at: string; expires_at: string; evidence_refs?: string[]; decisions?: Array<{ decision: string; reason: string; decided_by: string | null; decided_by_kind?: string; created_at: string }>; executions?: Array<{ attempt: number; status: string; outcome_code?: string | null }> };
type PowerAutomateApprovalIntegration = { id: string; name: string; mappingId: string; userId: string; email: string | null; tenantId: string; teamsUserId: string; createdAt: string; revokedAt: string | null };
type RoleSettingsData = { memberships: Array<{ user_id: string; role: string; custom_role_id?: string | null; location_scope_mode: string }>; organization_custom_roles: Array<{ id: string; name: string; description?: string }>; organization_role_permission_overrides: Array<{ role_key: string; permission_key: string; allowed: boolean }>; membership_location_scopes: Array<{ user_id: string; location_id: string }>; business_locations: Array<{ id: string; name: string; status: string }>; external_identity_mappings: Array<{ id: string; user_id: string; provider: string; tenant_id: string; external_user_id: string; external_email?: string | null; status: string }>; action_approval_policies: Array<{ id: string; action_type: string; location_id: string | null; amount_currency: string | null; min_amount_minor: number | null; max_amount_minor: number | null; required_role: string; required_approval_count: number; required_permission: string; max_single_approver_minor: number | null; enabled: boolean }> };
function Settings({ organizationId, userId, role, dashboard: d, accountId, onAccount }: { organizationId: string; userId: string; role: string; dashboard: Dashboard; accountId: string; onAccount: (v: string) => void }) {
  const [proposals, setProposals] = useState<ActionProposalRow[]>([]), [proposalError, setProposalError] = useState(''), [proposalLoading, setProposalLoading] = useState(true);
  const [roles, setRoles] = useState<RoleSettingsData | null>(null), [roleError, setRoleError] = useState(''), [roleLoading, setRoleLoading] = useState(false);
  const [reasonByProposal, setReasonByProposal] = useState<Record<string, string>>({}), [busyProposal, setBusyProposal] = useState('');
  const [revisionProposalId, setRevisionProposalId] = useState(''), [revisionPayload, setRevisionPayload] = useState(''), [revisionReason, setRevisionReason] = useState('');
  const [roleByUser, setRoleByUser] = useState<Record<string, string>>({}), [customRoleByUser, setCustomRoleByUser] = useState<Record<string, string>>({}), [busyUser, setBusyUser] = useState('');
  const [scopeByUser, setScopeByUser] = useState<Record<string, { mode: string; locationIds: string[] }>>({});
  const [customRoleName, setCustomRoleName] = useState(''), [customRolePermissions, setCustomRolePermissions] = useState('catalog.read, issues.read'), [customRoleBusy, setCustomRoleBusy] = useState(false), [roleSuccess, setRoleSuccess] = useState('');
  const [permissionRole, setPermissionRole] = useState('employee'), [permissionKey, setPermissionKey] = useState('catalog.read'), [permissionAllowed, setPermissionAllowed] = useState(true), [permissionBusy, setPermissionBusy] = useState(false);
  const [policyActionType, setPolicyActionType] = useState('square.inventory.count.set'), [policyLocationId, setPolicyLocationId] = useState('');
  const [policyMinAmount, setPolicyMinAmount] = useState(''), [policyMaxAmount, setPolicyMaxAmount] = useState(''), [policyMaxSingle, setPolicyMaxSingle] = useState('');
  const [policyCurrency, setPolicyCurrency] = useState(d.period?.currency ?? 'USD');
  const [policyRole, setPolicyRole] = useState('manager'), [policyPermission, setPolicyPermission] = useState('approvals.decide'), [policyApprovalCount, setPolicyApprovalCount] = useState('1'), [policyBusy, setPolicyBusy] = useState(false);
  const [teamsUserId, setTeamsUserId] = useState(''), [teamsTenantId, setTeamsTenantId] = useState(''), [teamsExternalUserId, setTeamsExternalUserId] = useState(''), [teamsEmail, setTeamsEmail] = useState('');
  const [teamsReason, setTeamsReason] = useState(''), [teamsOperation, setTeamsOperation] = useState('link'), [teamsBusy, setTeamsBusy] = useState(false);
  const [approvalIntegrations, setApprovalIntegrations] = useState<PowerAutomateApprovalIntegration[]>([]);
  const [approvalIntegrationName, setApprovalIntegrationName] = useState('Teams approvals');
  const [approvalMappingId, setApprovalMappingId] = useState(''), [approvalIntegrationBusy, setApprovalIntegrationBusy] = useState(false);
  const [createdApprovalToken, setCreatedApprovalToken] = useState('');
  const canManagePeople = role === 'owner' || role === 'administrator';
  const eligibleApprovalMappings = roles?.external_identity_mappings.filter(identity => identity.status === 'active'
    && identity.external_email && !approvalIntegrations.some(integration => integration.mappingId === identity.id && !integration.revokedAt)) ?? [];
  async function reloadProposals() {
    setProposalLoading(true); setProposalError('');
    try { const result = await api<{ proposals: ActionProposalRow[] }>(`/api/actions?${new URLSearchParams({ organizationId })}`); setProposals(result.proposals ?? []); }
    catch (error) { setProposalError(error instanceof Error ? error.message : 'Approval requests could not be loaded.'); }
    finally { setProposalLoading(false); }
  }
  async function reloadRoles() {
    if (!canManagePeople) return;
    setRoleLoading(true); setRoleError('');
    try {
      const result = await api<{ roles: RoleSettingsData }>(`/api/roles?${new URLSearchParams({ organizationId })}`);
      setRoles(result.roles);
      if (role === 'owner') {
        try {
          const integrations = await api<{ integrations: PowerAutomateApprovalIntegration[] }>(`/api/approval-integrations?${new URLSearchParams({ organizationId })}`);
          setApprovalIntegrations(integrations.integrations ?? []);
        } catch (error) { setRoleError(error instanceof Error ? error.message : 'Power Automate integrations could not be loaded.'); }
      }
    }
    catch (error) { setRoleError(error instanceof Error ? error.message : 'Role settings could not be loaded.'); }
    finally { setRoleLoading(false); }
  }
  useEffect(() => { void reloadProposals(); void reloadRoles(); }, [organizationId, canManagePeople]);
  async function decide(proposal: ActionProposalRow, decision: 'approved' | 'rejected') {
    const reason = (reasonByProposal[proposal.id] ?? '').trim();
    if (reason.length < 10) { setProposalError('Enter an approval or rejection reason of at least 10 characters.'); return; }
    setBusyProposal(proposal.id); setProposalError('');
    try {
      await api(`/api/actions/${encodeURIComponent(proposal.id)}/decision`, { method: 'POST', headers: { 'Idempotency-Key': window.crypto.randomUUID() }, body: JSON.stringify({ organizationId, decision, reason, expectedPayloadSha256: proposal.payload_sha256 }) });
      await reloadProposals();
    } catch (error) { setProposalError(error instanceof Error ? error.message : 'The approval decision could not be saved.'); }
    finally { setBusyProposal(''); }
  }
  async function cancelProposal(proposal: ActionProposalRow) {
    const reason = (reasonByProposal[proposal.id] ?? '').trim();
    if (reason.length < 10) { setProposalError('Enter a cancellation reason of at least 10 characters.'); return; }
    setBusyProposal(proposal.id); setProposalError('');
    try {
      await api(`/api/actions/${encodeURIComponent(proposal.id)}/cancel`, { method: 'POST', headers: { 'Idempotency-Key': window.crypto.randomUUID() }, body: JSON.stringify({ organizationId, reason }) });
      await reloadProposals();
    } catch (error) { setProposalError(error instanceof Error ? error.message : 'The action proposal could not be cancelled.'); }
    finally { setBusyProposal(''); }
  }
  function startRevision(proposal: ActionProposalRow) {
    setRevisionProposalId(proposal.id); setRevisionPayload(JSON.stringify(proposal.payload, null, 2)); setRevisionReason(''); setProposalError('');
  }
  async function submitRevision(event: FormEvent, proposal: ActionProposalRow) {
    event.preventDefault(); setProposalError('');
    const reason = revisionReason.trim();
    if (reason.length < 10) { setProposalError('Enter a reason of at least 10 characters for the revised proposal.'); return; }
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(revisionPayload);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The proposal payload must be a JSON object.');
      payload = { ...(parsed as Record<string, unknown>), proposalReason: reason };
    } catch (error) { setProposalError(error instanceof Error ? error.message : 'Enter a valid JSON object.'); return; }
    setBusyProposal(proposal.id);
    try {
      const changedPrice = payload.priceMinor;
      const amountMinor = Number.isSafeInteger(changedPrice) ? changedPrice as number : proposal.amount_minor ?? null;
      const currency = typeof payload.currency === 'string' ? payload.currency : proposal.currency ?? null;
      await api('/api/actions', { method: 'POST', headers: { 'Idempotency-Key': window.crypto.randomUUID() }, body: JSON.stringify({
        organizationId, actionType: proposal.action_type, payload, expectedSourceVersion: proposal.expected_source_version ?? null,
        locationId: proposal.location_id ?? null, amountMinor, currency, evidenceRefs: proposal.evidence_refs ?? [], supersedesProposalId: proposal.id,
      }) });
      setRevisionProposalId(''); setRevisionPayload(''); setRevisionReason(''); await reloadProposals();
    } catch (error) { setProposalError(error instanceof Error ? error.message : 'The revised proposal could not be submitted.'); }
    finally { setBusyProposal(''); }
  }
  async function updateRole(member: RoleSettingsData['memberships'][number]) {
    const nextRole = roleByUser[member.user_id] ?? member.role;
    const scope = scopeByUser[member.user_id] ?? { mode: member.location_scope_mode, locationIds: roles?.membership_location_scopes.filter(row => row.user_id === member.user_id).map(row => row.location_id) ?? [] };
    const customRoleId = customRoleByUser[member.user_id] ?? member.custom_role_id ?? null;
    if (nextRole === 'custom' && (!customRoleId || !roles?.organization_custom_roles.some(custom => custom.id === customRoleId))) { setRoleError('Choose an existing custom role before assigning it.'); return; }
    if (scope.mode === 'selected' && !scope.locationIds.length) { setRoleError('Select at least one location for a location-scoped role.'); return; }
    const currentLocations = roles?.membership_location_scopes.filter(row => row.user_id === member.user_id).map(row => row.location_id) ?? [];
    if (nextRole === member.role && nextRole !== 'custom' && scope.mode === member.location_scope_mode && scope.locationIds.slice().sort().join(',') === currentLocations.slice().sort().join(',')) return;
    setBusyUser(member.user_id); setRoleError(''); setRoleSuccess('');
    try {
      await api('/api/roles/membership', { method: 'PATCH', body: JSON.stringify({ organizationId, userId: member.user_id, role: nextRole, customRoleId: nextRole === 'custom' ? customRoleId : null, locationScopeMode: scope.mode, locationIds: scope.mode === 'selected' ? scope.locationIds : [] }) });
      setRoleSuccess('Workspace role updated and recorded in audit history.'); await reloadRoles();
    } catch (error) { setRoleError(error instanceof Error ? error.message : 'The role could not be updated.'); }
    finally { setBusyUser(''); }
  }
  async function createCustomRole(event: FormEvent) {
    event.preventDefault(); setCustomRoleBusy(true); setRoleError(''); setRoleSuccess('');
    try {
      const permissions = [...new Set(customRolePermissions.split(',').map(item => item.trim()).filter(Boolean))];
      await api('/api/roles/custom', { method: 'POST', body: JSON.stringify({ organizationId, name: customRoleName, permissions }) });
      setCustomRoleName(''); setRoleSuccess('Custom role created.'); await reloadRoles();
    } catch (error) { setRoleError(error instanceof Error ? error.message : 'The custom role could not be created.'); }
    finally { setCustomRoleBusy(false); }
  }
  async function savePermission(event: FormEvent) {
    event.preventDefault(); setPermissionBusy(true); setRoleError(''); setRoleSuccess('');
    try {
      await api('/api/roles/permission', { method: 'PATCH', body: JSON.stringify({ organizationId, role: permissionRole, permission: permissionKey, allowed: permissionAllowed }) });
      setRoleSuccess('Role permission override saved and recorded in audit history.'); await reloadRoles();
    } catch (error) { setRoleError(error instanceof Error ? error.message : 'The permission override could not be saved.'); }
    finally { setPermissionBusy(false); }
  }
  async function saveApprovalPolicy(event: FormEvent) {
    event.preventDefault(); setPolicyBusy(true); setRoleError(''); setRoleSuccess('');
    const toMinor = (value: string) => value.trim() === '' ? null : Number(value);
    const minAmountMinor = toMinor(policyMinAmount), maxAmountMinor = toMinor(policyMaxAmount), maxSingleApproverMinor = toMinor(policyMaxSingle);
    const hasAmountThreshold = [minAmountMinor, maxAmountMinor, maxSingleApproverMinor].some(value => value !== null);
    if ([minAmountMinor, maxAmountMinor, maxSingleApproverMinor].some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))) {
      setRoleError('Approval thresholds must be non-negative integer minor units.'); setPolicyBusy(false); return;
    }
    if (hasAmountThreshold && !/^[A-Z]{3}$/.test(policyCurrency.trim().toUpperCase())) {
      setRoleError('Enter a three-letter currency when setting an amount threshold.'); setPolicyBusy(false); return;
    }
    try {
      await api('/api/roles/approval-policy', { method: 'POST', body: JSON.stringify({ organizationId, actionType: policyActionType,
        locationId: policyLocationId || null, amountCurrency: hasAmountThreshold ? policyCurrency.trim().toUpperCase() : null,
        minAmountMinor, maxAmountMinor, maxSingleApproverMinor,
        requiredPermission: policyPermission, requiredRole: policyRole, requiredApprovalCount: Number(policyApprovalCount) }) });
      setRoleSuccess('Approval policy saved and recorded in audit history.'); await reloadRoles();
    } catch (error) { setRoleError(error instanceof Error ? error.message : 'The approval policy could not be saved.'); }
    finally { setPolicyBusy(false); }
  }
  async function saveTeamsIdentity(event: FormEvent) {
    event.preventDefault(); setTeamsBusy(true); setRoleError(''); setRoleSuccess('');
    try {
      const result = await api<{ status: string }>('/api/roles/teams-identity', { method: 'POST', body: JSON.stringify({ organizationId,
        userId: teamsUserId, tenantId: teamsTenantId.trim(), teamsUserId: teamsExternalUserId.trim(), email: teamsEmail.trim() || null,
        active: teamsOperation === 'link', reason: teamsReason.trim() }) });
      setRoleSuccess(`Teams identity ${result.status === 'active' ? 'linked' : 'unlinked'} and recorded in audit history.`);
      await reloadRoles();
    } catch (error) { setRoleError(error instanceof Error ? error.message : 'The Teams identity mapping could not be saved.'); }
    finally { setTeamsBusy(false); }
  }
  async function createPowerAutomateApprovalIntegration(event: FormEvent) {
    event.preventDefault(); setApprovalIntegrationBusy(true); setRoleError(''); setRoleSuccess(''); setCreatedApprovalToken('');
    try {
      const result = await api<{ id: string; token: string }>('/api/approval-integrations', { method: 'POST', body: JSON.stringify({
        organizationId, mappingId: approvalMappingId, name: approvalIntegrationName.trim(),
      }) });
      setCreatedApprovalToken(result.token);
      setApprovalIntegrationName('Teams approvals');
      setRoleSuccess('Power Automate approval integration created. Copy its token now; it is shown only once.');
      await reloadRoles();
    } catch (error) { setRoleError(error instanceof Error ? error.message : 'The Power Automate integration could not be created.'); }
    finally { setApprovalIntegrationBusy(false); }
  }
  async function revokePowerAutomateApprovalIntegration(integration: PowerAutomateApprovalIntegration) {
    setApprovalIntegrationBusy(true); setRoleError(''); setRoleSuccess('');
    try {
      await api(`/api/approval-integrations/${integration.id}`, { method: 'DELETE', body: JSON.stringify({ organizationId }) });
      setRoleSuccess(`Power Automate access for ${integration.email ?? integration.name} was revoked.`);
      await reloadRoles();
    } catch (error) { setRoleError(error instanceof Error ? error.message : 'The Power Automate integration could not be revoked.'); }
    finally { setApprovalIntegrationBusy(false); }
  }
  return <div className="settings-grid">
    <section className="panel settings-card"><div className="panel-heading"><div><h2>Workspace</h2></div></div><div className="setting-row"><span>Organization</span><b>{d.organization?.name ?? 'Not provided'}</b></div><div className="setting-row"><span>Reporting timezone</span><b>{d.organization?.timezone ?? 'Not configured'}</b></div><div className="setting-row"><span>Projection version</span><b>{d.projectionVersion ?? 'Not reported'}</b></div><div className="setting-row"><span>Reporting currency</span><b>{d.period?.currency ?? d.income?.currency ?? 'Not specified'}</b></div></section>
    <section className="panel settings-card"><div className="panel-heading"><div><h2>Accounts</h2></div></div>{d.accounts?.length ? <label>Selected account<select value={accountId} onChange={e => onAccount(e.target.value)}>{d.accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.kind ?? 'account'} · {a.currency}</option>)}</select></label> : <div className="inline-empty">No accounts available.</div>}<div className="notice compact-notice">Role assignments, approvals, and financial changes are recorded in audit history.</div></section>
    <section className="panel table-panel"><div className="panel-heading"><div><h2>Action approvals</h2><p>Review the exact approved payload and leave a reason with each decision.</p></div><button className="secondary" onClick={() => void reloadProposals()} disabled={proposalLoading}>Refresh</button></div>
      {proposalError && <p className="error" role="alert">{proposalError}</p>}{proposalLoading ? <div className="inline-empty">Loading approvals…</div> : proposals.length ? <div className="stack-list">{proposals.map(proposal => <article className="panel settings-card" key={proposal.id}><div className="setting-row"><span>{proposal.action_type}</span><b>{proposal.status.replaceAll('_', ' ')}</b></div><small className="muted">Proposed {date(proposal.created_at)} · by {proposal.proposed_by}</small><details className="proposal-details"><summary>Approved payload · {proposal.payload_sha256.slice(0, 12)}</summary><pre>{JSON.stringify({ payload: proposal.payload, evidenceRefs: proposal.evidence_refs ?? [], expiresAt: proposal.expires_at, decisions: proposal.decisions ?? [], executions: proposal.executions ?? [] }, null, 2)}</pre></details>
        {proposal.status === 'pending_approval' && <><label>Decision or cancellation reason<textarea minLength={10} maxLength={1000} value={reasonByProposal[proposal.id] ?? ''} onChange={event => setReasonByProposal(previous => ({ ...previous, [proposal.id]: event.target.value }))} /></label><div className="button-row"><button className="primary" disabled={busyProposal === proposal.id} onClick={() => void decide(proposal, 'approved')}>{busyProposal === proposal.id ? 'Saving…' : 'Approve'}</button><button className="secondary" disabled={busyProposal === proposal.id} onClick={() => void decide(proposal, 'rejected')}>Reject</button>{proposal.proposed_by === userId && <><button className="text-button" disabled={busyProposal === proposal.id} onClick={() => void cancelProposal(proposal)}>Cancel proposal</button><button type="button" className="text-button" onClick={() => startRevision(proposal)}>Revise proposal</button></>}</div>
        {revisionProposalId === proposal.id && proposal.proposed_by === userId && <form className="entry-form" onSubmit={event => void submitRevision(event, proposal)}><label>Revised action payload (JSON)<textarea rows={10} value={revisionPayload} onChange={event => setRevisionPayload(event.target.value)} required /></label><label>Revision reason<textarea minLength={10} maxLength={1000} value={revisionReason} onChange={event => setRevisionReason(event.target.value)} required /></label><p className="muted">Submitting creates a new proposal with a new hash, cancels the old pending proposal, and requires approval again.</p><div className="button-row"><button className="primary" disabled={busyProposal === proposal.id}>{busyProposal === proposal.id ? 'Submitting…' : 'Submit revised proposal'}</button><button type="button" className="secondary" onClick={() => setRevisionProposalId('')}>Close</button></div></form>}</>}
      </article>)}</div> : <div className="inline-empty">No action proposals are available to this role.</div>}
    </section>
    {canManagePeople && <section className="panel table-panel"><div className="panel-heading"><div><h2>People and permissions</h2><p>Assign workspace roles and see the active approval requirements.</p></div><button className="secondary" onClick={() => void reloadRoles()} disabled={roleLoading}>Refresh</button></div>
      {roleError && <p className="error" role="alert">{roleError}</p>}{roleSuccess && <p className="notice" role="status">{roleSuccess}</p>}{roleLoading ? <div className="inline-empty">Loading role settings…</div> : roles ? <>
        {roles.memberships.map(member => { const scope = scopeByUser[member.user_id] ?? { mode: member.location_scope_mode, locationIds: roles.membership_location_scopes.filter(row => row.user_id === member.user_id).map(row => row.location_id) }; return <div className="settings-card" key={member.user_id}><div className="setting-row"><span>{member.user_id}<small className="cell-sub">{scope.mode === 'selected' ? 'Selected locations' : 'All locations'}</small></span><div className="button-row"><select aria-label={`Role for ${member.user_id}`} value={roleByUser[member.user_id] ?? member.role} onChange={event => setRoleByUser(previous => ({ ...previous, [member.user_id]: event.target.value }))}>{['administrator','manager','employee','operator','reviewer','read_only','custom',...(role === 'owner' ? ['owner'] : [])].map(value => <option key={value} value={value} disabled={value === 'custom' && roles.organization_custom_roles.length === 0}>{value.replaceAll('_', ' ')}</option>)}</select>{(roleByUser[member.user_id] ?? member.role) === 'custom' && <select aria-label={`Custom role for ${member.user_id}`} value={customRoleByUser[member.user_id] ?? member.custom_role_id ?? ''} onChange={event => setCustomRoleByUser(previous => ({ ...previous, [member.user_id]: event.target.value }))}><option value="">Choose custom role</option>{roles.organization_custom_roles.map(custom => <option key={custom.id} value={custom.id}>{custom.name}</option>)}</select>}<button className="secondary" disabled={busyUser === member.user_id} onClick={() => void updateRole(member)}>{busyUser === member.user_id ? 'Saving…' : 'Save'}</button></div></div><div className="button-row"><label>Location access<select value={scope.mode} onChange={event => setScopeByUser(previous => ({ ...previous, [member.user_id]: { ...scope, mode: event.target.value } }))}><option value="all">All locations</option><option value="selected">Selected locations</option></select></label>{scope.mode === 'selected' && roles.business_locations.filter(location => location.status === 'active').map(location => <label className="compact" key={location.id}><input type="checkbox" checked={scope.locationIds.includes(location.id)} onChange={event => setScopeByUser(previous => ({ ...previous, [member.user_id]: { ...scope, locationIds: event.target.checked ? [...scope.locationIds, location.id] : scope.locationIds.filter(id => id !== location.id) } }))} />{location.name}</label>)}</div></div>; })}
        <h3>Custom roles</h3>{roles.organization_custom_roles.length ? <ul>{roles.organization_custom_roles.map(custom => <li key={custom.id}>{custom.name}{custom.description ? ` · ${custom.description}` : ''}</li>)}</ul> : <p className="muted">No custom roles yet.</p>}
        <form onSubmit={createCustomRole}><label>Custom role name<input value={customRoleName} onChange={event => setCustomRoleName(event.target.value)} maxLength={80} required /></label><label>Permissions, comma-separated<input value={customRolePermissions} onChange={event => setCustomRolePermissions(event.target.value)} placeholder="catalog.read, issues.read" required /></label><button className="secondary" disabled={customRoleBusy}>{customRoleBusy ? 'Saving…' : 'Create custom role'}</button></form>
        <h3>Teams identity links</h3><p className="muted">These administrator-attested directory mappings identify the reviewer for Power Automate approval cards. No Azure Bot registration is used.</p>{roles.external_identity_mappings.filter(identity => identity.status === 'active').map(identity => <div className="setting-row" key={identity.id}><span>{identity.user_id}<small className="cell-sub">{identity.tenant_id} · {identity.external_user_id}{identity.external_email ? ` · ${identity.external_email}` : ''}</small></span><b>Linked</b></div>)}
        <form onSubmit={saveTeamsIdentity}><label>Action<select value={teamsOperation} onChange={event => setTeamsOperation(event.target.value)}><option value="link">Link or update</option><option value="unlink">Unlink</option></select></label><label>Vernius member<select required value={teamsUserId} onChange={event => setTeamsUserId(event.target.value)}><option value="">Choose member</option>{roles.memberships.map(member => <option key={member.user_id} value={member.user_id}>{member.user_id}</option>)}</select></label><label>Microsoft tenant ID<input required value={teamsTenantId} onChange={event => setTeamsTenantId(event.target.value)} /></label><label>Teams user object ID<input required value={teamsExternalUserId} onChange={event => setTeamsExternalUserId(event.target.value)} /></label>{teamsOperation === 'link' && <label>Directory email (required for Power Automate cards)<input type="email" maxLength={320} required value={teamsEmail} onChange={event => setTeamsEmail(event.target.value)} /></label>}<label>Reason<textarea minLength={10} maxLength={1000} required value={teamsReason} onChange={event => setTeamsReason(event.target.value)} /></label><button className="secondary" disabled={teamsBusy}>{teamsBusy ? 'Saving…' : teamsOperation === 'link' ? 'Save Teams identity' : 'Unlink Teams identity'}</button></form>
        {role === 'owner' && <><h3>Power Automate approvals</h3><p className="muted">Create one integration for each reviewer. The token is displayed once; put it in the flow's Authorization header, enable Secure Inputs/Outputs, and restrict flow editors. The flow sends cards in a personal Teams chat and returns the decision to the app.</p>
          {approvalIntegrations.map(integration => <div className="setting-row" key={integration.id}><span>{integration.name}<small className="cell-sub">{integration.email ?? 'No directory email'} · created {date(integration.createdAt)}</small></span>{integration.revokedAt ? <b>Revoked</b> : <button className="text-button" disabled={approvalIntegrationBusy} onClick={() => void revokePowerAutomateApprovalIntegration(integration)}>Revoke</button>}</div>)}
          <form onSubmit={event => void createPowerAutomateApprovalIntegration(event)}><label>Reviewer identity<select required value={approvalMappingId} onChange={event => setApprovalMappingId(event.target.value)}><option value="">Choose a linked Teams reviewer</option>{eligibleApprovalMappings.map(identity => <option key={identity.id} value={identity.id}>{identity.external_email} · {identity.user_id}</option>)}</select></label><label>Integration name<input maxLength={100} required value={approvalIntegrationName} onChange={event => setApprovalIntegrationName(event.target.value)} /></label><button className="secondary" disabled={approvalIntegrationBusy || !eligibleApprovalMappings.some(identity => identity.id === approvalMappingId)}>{approvalIntegrationBusy ? 'Saving…' : 'Create Power Automate integration'}</button></form>
          {createdApprovalToken && <div className="notice"><p>Copy this token into Power Automate now. Vernius stores only its hash, so it cannot be shown again.</p><pre>{createdApprovalToken}</pre><button className="text-button" onClick={() => setCreatedApprovalToken('')}>Hide token</button></div>}
          <p className="muted">Setup instructions: <code>docs/POWER_AUTOMATE_APPROVALS_SETUP.md</code>. Microsoft 365 and Power Automate are still required; Azure Bot resources and bot credentials are not.</p>
        </>}
        <h3>Role permission override</h3><form onSubmit={savePermission}><label>Role<select value={permissionRole} onChange={event => setPermissionRole(event.target.value)}>{['administrator','manager','employee','operator','reviewer','read_only'].map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label><label>Permission<select value={permissionKey} onChange={event => setPermissionKey(event.target.value)}>{['catalog.read','catalog.write','catalog.price.write','inventory.read','inventory.write','finance.metrics.read','finance.cash.write','finance.cost.approve','finance.refund.review','issues.read','issues.propose','approvals.read','approvals.decide','actions.propose','audit.read','sync.read','employees.read','locations.read','suppliers.read','purchases.read','purchases.write'].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label><input type="checkbox" checked={permissionAllowed} onChange={event => setPermissionAllowed(event.target.checked)} />Allow permission</label><button className="secondary" disabled={permissionBusy}>{permissionBusy ? 'Saving…' : 'Save override'}</button></form>
        {roles.organization_role_permission_overrides.length > 0 && <details><summary>Existing overrides</summary><ul>{roles.organization_role_permission_overrides.map(item => <li key={`${item.role_key}:${item.permission_key}`}>{item.role_key} · {item.permission_key}: {item.allowed ? 'allowed' : 'denied'}</li>)}</ul></details>}
        <h3>Approval policies</h3>{roles.action_approval_policies.length ? <ul>{roles.action_approval_policies.map(policy => <li key={policy.id}>{policy.action_type}{policy.location_id ? ` · ${roles.business_locations.find(location => location.id === policy.location_id)?.name ?? 'Location'}` : ' · all locations'}{policy.min_amount_minor !== null || policy.max_amount_minor !== null ? ` · ${policy.min_amount_minor ?? 'any'}–${policy.max_amount_minor ?? 'any'} ${policy.amount_currency ?? ''} minor units` : ''}: {policy.required_approval_count} approval(s), {policy.required_role} role, {policy.required_permission} permission{policy.max_single_approver_minor !== null ? ` · second approval above ${policy.max_single_approver_minor} ${policy.amount_currency ?? ''}` : ''}{policy.enabled ? '' : ' · disabled'}</li>)}</ul> : <p className="muted">Default owner approval applies until a policy is configured.</p>}
        <form onSubmit={saveApprovalPolicy}><label>Action type<select value={policyActionType} onChange={event => setPolicyActionType(event.target.value)}>{['square.catalog.item.create','square.catalog.item.update','square.catalog.item.archive','square.catalog.variation.update','square.catalog.variation.add','square.inventory.count.set'].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Location<select value={policyLocationId} onChange={event => setPolicyLocationId(event.target.value)}><option value="">All locations</option>{roles.business_locations.filter(location => location.status === 'active').map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label><label>Amount currency<input required={false} maxLength={3} value={policyCurrency} onChange={event => setPolicyCurrency(event.target.value.toUpperCase())} /></label><label>Minimum amount (minor units)<input type="number" min="0" step="1" value={policyMinAmount} onChange={event => setPolicyMinAmount(event.target.value)} /></label><label>Maximum amount (minor units)<input type="number" min="0" step="1" value={policyMaxAmount} onChange={event => setPolicyMaxAmount(event.target.value)} /></label><label>Required approver role<select value={policyRole} onChange={event => setPolicyRole(event.target.value)}>{['owner','administrator','manager','reviewer'].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Required permission<select value={policyPermission} onChange={event => setPolicyPermission(event.target.value)}>{['approvals.decide','finance.cost.approve','catalog.price.write'].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Approvals required<input type="number" min="1" max="5" step="1" value={policyApprovalCount} onChange={event => setPolicyApprovalCount(event.target.value)} required /></label><label>Second approver above (minor units)<input type="number" min="0" step="1" value={policyMaxSingle} onChange={event => setPolicyMaxSingle(event.target.value)} /></label><button className="secondary" disabled={policyBusy}>{policyBusy ? 'Saving…' : 'Save approval policy'}</button></form>
      </> : null}
    </section>}
  </div>;
}
