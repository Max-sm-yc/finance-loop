'use client';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { browserSupabase } from '@/lib/browser-supabase';
import { api, type AuditEvent, type Dashboard, type Issue, type Movement } from '@/lib/api';
import { rankReceiptCatalogCandidates } from '../../src/agent/receipt-matching.mjs';
import { calculatePackageUnitCostMinor } from '../../src/agent/receipt-units.mjs';

type Page = 'overview' | 'income' | 'cash' | 'review' | 'ledger' | 'settings' | 'analytics';
type Features = { inventoryTracking: boolean; productAnalytics: boolean };
type InventoryMovement = { id: string; item_id: string; item_name: string; quantity_delta: number; occurred_at: string; movement_type?: string; reason?: string };
type InventorySnapshot = { asOf: string; status?: string; issues?: Array<{ code: string }>; sourceCoverage?: unknown; sourceHealth?: unknown[]; items?: Array<{ id: string; name: string; currency: string; sku?: string | null; square_catalog_object_id?: string | null; item_kind?: string }>; balances?: Array<{ itemDefinitionId: string; itemName: string; currency: string; quantity: number | null }> };
type PurchaseLineInput = { itemId: string; quantity: string; unitCost: string };
type ReceiptDraftLine = { lineNumber: number; description: string; quantity: string | null; wholeQuantity: number | null; packageUnitCount: number | null; unitPriceText: string | null; sourceUnitPriceText: string | null; lineAmountText: string | null; sourceLineAmountText: string | null; expectedLineAmountText: string | null; suggestedLineAmountText: string | null; unitCostMinor: number | null; packageCostMinor: number | null; costBasis: string; reviewReason: string | null };
type ReceiptDraft = { supplier: string | null; invoiceDate: string | null; currency: string; model: string; promptVersion: string; lines: ReceiptDraftLine[] };
type ReceiptDraftLineInput = ReceiptDraftLine & { itemId: string; unitCostText: string; unitsPerSquareItemText: string; catalogSearchText: string };
type ReceiptCatalogCandidate = { catalogObjectId: string; name: string; sku: string | null; currency: string };
type AnalyticsProduct = { productId: string; productName?: string | null; unitsSold: number; revenueMinor: number | null; costMinor: number | null; netMinor: number | null; grossMinor?: number | null; discountMinor?: number | null; refundsMinor?: number | null; revenueRank?: number | null; netRank?: number | null; revenueShareBps?: number | null; marginBps?: number | null; dailySales?: Array<{ period: string; revenueMinor: number | null }>; sourceRefs?: string[] };
type AnalyticsSeries = { period: string; revenueMinor: number | null; costMinor: number | null; feesMinor: number | null; netMinor: number | null; unitsSold: number };
type AnalyticsReport = { calculationVersion: string; status: string; currency: string | null; sourceRevision?: number | null; products: AnalyticsProduct[]; totals: { revenueMinor: number | null; costMinor: number | null; netMinor: number | null; feesMinor: number | null; refundsMinor: number | null }; unallocated: { revenueMinor: number | null; refundsMinor: number | null; feesMinor: number | null; cogsReversalMinor?: number | null }; issues: Array<{ code: string; sourceRefs?: string[] }>; daily?: AnalyticsSeries[]; monthly?: AnalyticsSeries[] };
const UUID_INPUT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Organization = { id: string; name: string; base_currency?: string; timezone?: string; role?: string };
type IssueEvidence = { id: string; type?: 'sale_line' | 'refund'; occurred_at?: string; currency?: string; quantity?: string | number; amount_minor?: string | number; gross_minor?: string | number; unit_price_minor?: string | number; discount_minor?: string | number; catalog_object_id?: string | null; item_name?: string | null; provider_object_id?: string; line_id?: string; refund_id?: string; order_id?: string; status?: string };
const NAV: Array<{ id: Page; label: string }> = [
  { id: 'overview', label: 'Overview' }, { id: 'income', label: 'Income & inventory' },
  { id: 'cash', label: 'Cash flow' }, { id: 'analytics', label: 'Business analytics' }, { id: 'review', label: 'Review queue' },
  { id: 'ledger', label: 'Activity ledger' }, { id: 'settings', label: 'Settings' },
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
function receiptLineConversion(line: ReceiptDraftLineInput, currency: string) {
  const packageCostMinor = line.packageCostMinor ?? line.unitCostMinor;
  const unitsPerSquareItem = Number(line.unitsPerSquareItemText);
  if (packageCostMinor === null || !Number.isSafeInteger(unitsPerSquareItem) || unitsPerSquareItem < 1 || unitsPerSquareItem > 1_000_000) return null;
  const squareUnitCostMinor = line.unitCostText.trim() ? parseMinor(line.unitCostText, currency) : null;
  if (line.unitCostText.trim() && squareUnitCostMinor === null) return null;
  return calculatePackageUnitCostMinor(packageCostMinor, line.wholeQuantity, unitsPerSquareItem, squareUnitCostMinor);
}
const date = (value?: string | null) => value ? new Date(value).toLocaleString() : '—';
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
  const [user, setUser] = useState<{ email?: string | null } | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [page, setPage] = useState<Page>('overview');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [features, setFeatures] = useState<Features>({ inventoryTracking: false, productAnalytics: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');
  const [syncError, setSyncError] = useState('');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState(() => new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const loadSequence = useRef(0);
  const supabase = useMemo(() => { try { return browserSupabase(); } catch { return null; } }, []);
  const reportTimezone = dashboard?.organization?.timezone ?? 'UTC';

  useEffect(() => {
    if (!supabase) { setError('Supabase is not configured. Add the project URL and publishable key to the web environment.'); setLoadingAuth(false); return; }
    supabase.auth.getUser().then(({ data }) => { setUser(data.user); setLoadingAuth(false); }).catch(() => { setError('Could not validate your sign-in session. Try again.'); setLoadingAuth(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => { loadSequence.current += 1; setFeatures({ inventoryTracking: false, productAnalytics: false }); setUser(session?.user ?? null); });
    return () => listener.subscription.unsubscribe();
  }, [supabase]);

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
      setOrganizationId(current => options.some(org => org.id === current) ? current : options[0]?.id ?? '');
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
      setFeatures(enabled); if (page === 'analytics' && !enabled.productAnalytics) setPage('overview');
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
      setDashboard(data);
      if (!accountId && data.accounts?.length) setAccountId(data.accounts[0].id);
    }
    if (results[1].status === 'fulfilled') setIssues((results[1].value as { issues: Issue[] }).issues ?? []);
    if (results[2].status === 'fulfilled') setMovements((results[2].value as { movements: Movement[] }).movements ?? []);
    if (results[3].status === 'fulfilled') setEvents((results[3].value as { events: AuditEvent[] }).events ?? []);
    if (results[4].status === 'rejected' && page === 'analytics') setPage('overview');
    const rejected = results.find(x => x.status === 'rejected') as PromiseRejectedResult | undefined;
    if (rejected) setError(rejected.reason instanceof Error ? rejected.reason.message : 'Some workspace data could not be loaded.');
    setBusy(false);
  }
  useEffect(() => { void load(); /* Refreshed when filters or identity change. */ }, [user, organizationId, accountId, from, to, reportTimezone]);

  async function signIn(e: FormEvent) {
    e.preventDefault(); if (!supabase) return;
    setBusy(true); setError('');
    try { const { error: authError } = await supabase.auth.signInWithPassword({ email, password }); if (authError) setError(authError.message); }
    catch { setError('Sign in could not reach the authentication service. Try again.'); }
    finally { setBusy(false); }
  }
  async function signOut() { loadSequence.current += 1; await supabase?.auth.signOut(); setDashboard(null); setIssues([]); setMovements([]); setEvents([]); setFeatures({ inventoryTracking: false, productAnalytics: false }); setSyncStatus(''); setSyncError(''); }
  async function syncSelectedPeriod() {
    if (!organizationId || !from || !to || from > to) {
      setSyncError('Choose a valid period before syncing.'); setSyncStatus(''); return;
    }
    setSyncing(true); setSyncError(''); setSyncStatus('');
    try {
      await api('/api/sync', {
        method: 'POST',
        headers: { 'Idempotency-Key': `square-sync:${crypto.randomUUID()}` },
        body: JSON.stringify({
          organizationId,
          startAt: zonedMidnight(from, reportTimezone),
          endAt: zonedMidnight(nextDate(to), reportTimezone),
        }),
      });
      setSyncStatus(`Sync queued for ${from} through ${to} across active Square locations. When the worker finishes, click ↻ to refresh; incomplete Square data may still leave figures unavailable.`);
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
      };
      setSyncError(messages[code] ?? 'The sync could not be queued. Refresh the page and try again.');
    } finally { setSyncing(false); }
  }
  const currency = dashboard?.period?.currency ?? dashboard?.income?.currency ?? 'USD';
  const openIssues = issues.filter(i => !['resolved', 'approved', 'rejected'].includes(i.state));

  if (loadingAuth) return <main className="auth-screen"><div className="auth-card">Loading secure workspace…</div></main>;
  if (!user) return <main className="auth-screen"><form className="auth-card" onSubmit={signIn}>
    <div className="brand-lockup"><span className="brand-icon" aria-hidden="true">Z</span><span><b>ZYTHE</b><small>OPERATIONS ACCOUNTING</small></span></div>
    <p className="eyebrow">SECURE WORKSPACE</p><h1>Sign in</h1><p className="muted">Use your organization account to access financial records.</p>
    <label>Email address<input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
    <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
    {error && <p className="error" role="alert">{error}</p>}<button className="primary full" disabled={busy || !supabase}>{busy ? 'Signing in…' : 'Sign in securely'}</button>
    <p className="tiny muted">Access is provided by your workspace administrator.</p>
  </form></main>;

  const navItems = NAV.filter(x => x.id !== 'analytics' || features.productAnalytics);
  const title = navItems.find(x => x.id === page)?.label ?? 'Overview';
  return <div className="shell">
    <aside className="sidebar"><div className="brand-lockup"><span className="brand-icon" aria-hidden="true">Z</span><span><b>ZYTHE</b><small>WORKSPACE</small></span></div>
      <div className="workspace"><span className="workspace-mark">{dashboard?.organization?.name?.slice(0, 1) ?? 'O'}</span><span><b>{dashboard?.organization?.name ?? 'Your workspace'}</b><small>Organization workspace</small></span></div>
      <div className="nav-caption">WORKSPACE</div><nav aria-label="Main navigation">{navItems.map(item => <button key={item.id} className={`nav-link ${page === item.id ? 'selected' : ''}`} onClick={() => setPage(item.id)} aria-current={page === item.id ? 'page' : undefined}>{item.label}{item.id === 'review' && openIssues.length > 0 && <i>{openIssues.length}</i>}</button>)}</nav>
      <div className="sidebar-foot"><div className="profile"><span className="avatar">{user.email?.slice(0, 1).toUpperCase() ?? 'U'}</span><span className="profile-info"><b>{user.email}</b><small>Signed in</small></span><button className="icon-button" onClick={signOut} title="Sign out" aria-label="Sign out">↪</button></div></div>
    </aside>
    <section className="main-area"><header className="topbar"><div className="top-controls" role="group" aria-label={`Workspace and reporting controls. Period dates use ${reportTimezone}`}>{organizations.length > 1 && <label className="compact">Organization<select value={organizationId} onChange={e => { loadSequence.current += 1; setOrganizationId(e.target.value); setAccountId(''); setDashboard(null); setFeatures({ inventoryTracking: false, productAnalytics: false }); setSyncStatus(''); setSyncError(''); if (page === 'analytics') setPage('overview'); }}><option value="">Choose workspace</option>{organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}</select></label>}<details className="period-picker"><summary aria-label={`Reporting period ${periodLabel(from, to)}`}>{periodLabel(from, to)}<span aria-hidden="true">⌄</span></summary><div className="period-popover"><label>Start date<input aria-label="Period start date" type="date" value={from} onChange={e => { setFrom(e.target.value); setSyncStatus(''); setSyncError(''); }} /></label><label>End date<input aria-label="Period end date" type="date" value={to} onChange={e => { setTo(e.target.value); setSyncStatus(''); setSyncError(''); }} /></label><small>Reporting timezone · {reportTimezone}</small></div></details><button className="icon-button refresh" onClick={() => void load()} disabled={busy || syncing} aria-label="Refresh workspace data">{busy ? '…' : '↻'}</button></div></header>
      <main className="page"><div className="page-head"><div><p className="eyebrow">{dashboard?.organization?.name ?? 'FINANCIAL OPERATIONS'}</p><h1>{title}</h1><p className="muted">{page === 'overview' ? 'Business performance and accounting status' : subhead(page)}</p></div>{organizations.find(org => org.id === organizationId)?.role === 'owner' && <div className="page-actions"><button className="secondary" onClick={() => void syncSelectedPeriod()} disabled={syncing || busy}>{syncing ? 'Queueing…' : 'Sync period'}</button></div>}</div>
        {error && <div className="notice error-box" role="alert"><b>Data request needs attention</b><span>{error}</span></div>}
        {syncError && <div className="notice error-box" role="alert"><b>Sync could not start</b><span>{syncError}</span></div>}
        {syncStatus && <div className="notice" role="status"><b>Sync queued</b><span>{syncStatus}</span></div>}
        {!organizationId ? <section className="empty-state"><div className="empty-icon">⌁</div><h2>{organizations.length ? 'Choose a workspace' : 'No workspace membership found'}</h2><p>Ask a workspace owner to add your account, then sign in again.</p></section> : !dashboard ? <section className="empty-state"><div className="empty-icon">⌁</div><h2>{busy ? 'Loading workspace data' : 'No projection available yet'}</h2><p>Once your workspace has accounts and a completed projection, verified figures will appear here.</p><button className="secondary" onClick={() => void load()}>Retry</button></section> : <>
          {page === 'overview' && <Overview dashboard={dashboard} currency={currency} issues={openIssues} events={events} accountId={accountId} onNavigate={setPage} />}
          {page === 'income' && <Income dashboard={dashboard} currency={currency} />}
          {page === 'income' && <GiftCardSummary income={dashboard.income} currency={currency} />}
          {page === 'cash' && <Cash key={organizationId} dashboard={dashboard} currency={currency} movements={movements} accounts={dashboard.accounts ?? []} accountId={accountId} organizationId={organizationId} inventoryEnabled={features.inventoryTracking} canManageSquareCatalog={organizations.find(org => org.id === organizationId)?.role === 'owner'} canAuthorizeSquareCatalog={organizations.find(org => org.id === organizationId)?.role === 'owner'} onAccount={setAccountId} onSaved={() => void load()} />}
          {page === 'analytics' && features.productAnalytics && <Analytics key={organizationId} organizationId={organizationId} from={zonedMidnight(from, reportTimezone)} to={zonedMidnight(nextDate(to), reportTimezone)} currency={currency} />}
          {page === 'review' && <Review issues={openIssues} organizationId={organizationId} currency={currency} onSaved={() => void load()} />}
          {page === 'ledger' && <Ledger events={events} />}
          {page === 'settings' && <Settings dashboard={dashboard} accountId={accountId} onAccount={setAccountId} />}
          <footer className="projection-foot">Calculation {dashboard.projectionVersion ?? 'version pending'} · {dashboard.period?.from ?? from} to {dashboard.period?.to ?? to} · {currency} · {dashboard.income?.status === 'incomplete' ? 'Margin incomplete' : 'Operational reporting'}</footer>
        </>}
      </main>
    </section>
  </div>;
}

function subhead(page: Page) { return ({ income: 'Completed sales, approved unit costs, fees and margin status.', cash: 'Account movements and balance reconciliation for the selected period.', analytics: 'Deterministic product revenue, cost and net results for the selected period.', review: 'Human decisions for unresolved source and reconciliation exceptions.', ledger: 'Read-only history of recorded decisions and financial activity.', settings: 'Accounts, reporting scope and workspace configuration.' } as Record<string, string>)[page] ?? ''; }
function Card({ label, value, hint, tone = '' }: { label: string; value: string; hint: string; tone?: string }) { return <article className="metric"><span>{label}</span><strong className={tone}>{value}</strong><small>{hint}</small></article>; }
function GiftCardSummary({ income, currency }: { income: Dashboard['income']; currency: string }) {
  if (!income || income.giftCardLiabilityChangeMinor === undefined) return null;
  return <section className="panel"><div className="panel-heading"><div><h2>Gift cards</h2><p>Issuance changes the gift-card liability; redemption recognizes the purchased item sale and its item cost.</p></div></div>
    <div className="status-row"><span>Activations and loads</span><b>{money((income.giftCardActivationsMinor ?? 0) + (income.giftCardLoadsMinor ?? 0), currency)}</b></div>
    <div className="status-row"><span>Redemptions</span><b>{money(income.giftCardRedemptionsMinor, currency)}</b></div>
    <div className="status-row"><span>Liability change this period</span><b>{money(income.giftCardLiabilityChangeMinor, currency)}</b></div>
  </section>;
}
function Overview({ dashboard: d, currency: c, issues, events, accountId, onNavigate }: { dashboard: Dashboard; currency: string; issues: Issue[]; events: AuditEvent[]; accountId: string; onNavigate: (p: Page) => void }) {
  const income = d.income;
  const cash = d.cash;
  const account = d.accounts?.find(item => item.id === accountId);
  const operationalMarginMinor = income?.status === 'complete' ? income.operationalMarginMinor : null;
  const marginShare = operationalMarginMinor != null && income?.netSalesMinor != null && income.netSalesMinor > 0
    ? `${(operationalMarginMinor / income.netSalesMinor * 100).toFixed(1)}% of net sales`
    : null;
  const marginHint = income?.status === 'incomplete' ? 'Incomplete · source or cost data needs review' : income?.status === 'failed' ? 'Unavailable · calculation failed' : marginShare ?? 'Share unavailable for this period';
  const freshness = d.freshness?.status ?? 'unknown';
  const freshnessLabel = ({ fresh: 'Fresh', incomplete: 'Incomplete source data', stale: 'Sync is stale', failed: 'Latest sync failed', unknown: 'Sync status unavailable' } as Record<string, string>)[freshness] ?? 'Sync status unavailable';
  const freshnessTone = ({ fresh: 'good', incomplete: 'warn', stale: 'warn', failed: 'bad', unknown: 'neutral' } as Record<string, string>)[freshness] ?? 'neutral';
  const flags = d.flags ?? [];
  const activityLabel = (event: AuditEvent) => (event.action ?? event.event_type ?? event.entity_type ?? 'Workspace event').replaceAll('_', ' ').replaceAll('.', ' ');
  const recentEvents = events.slice(0, 4);
  const discountsMinor = income?.discountsMinor;
  const refundsMinor = income?.refundsMinor;
  const discountsAndRefundsMinor = discountsMinor == null || refundsMinor == null ? null : discountsMinor + refundsMinor;
  const balanceValue = cash?.expectedBalanceMinor == null ? account ? 'Unavailable' : 'Not configured' : money(cash.expectedBalanceMinor, cash.currency ?? c);
  const balanceHint = !account ? 'No tracked account is available' : cash?.expectedBalanceMinor == null ? 'Balance evidence is unavailable for this period' : (cash.status ?? 'Expected account balance').replaceAll('_', ' ');
  return <>
    <section className="overview-summary" aria-label="Period summary">
      <article className="summary-metric"><span>Net sales</span><strong>{money(income?.netSalesMinor, c)}</strong><small>{income?.grossItemSalesMinor == null ? 'After discounts and refunds' : `${money(income.grossItemSalesMinor, c)} gross sales`}</small></article>
      <article className="summary-metric"><span>Operational margin</span><strong className={income?.status !== 'complete' ? 'warn-text' : ''}>{money(operationalMarginMinor, c)}</strong><small>{marginHint}</small></article>
      <article className="summary-metric"><span>Expected account balance</span><strong className={cash?.expectedBalanceMinor == null ? 'value-muted' : ''}>{balanceValue}</strong><small>{balanceHint}</small></article>
      <article className="summary-metric"><span>Open reviews</span><strong>{issues.length}</strong><small>{issues.length ? 'Human decision required' : 'No unresolved reviews'}</small></article>
    </section>

    <section className={`overview-status-strip tone-${freshnessTone}`} aria-label="Square source status">
      <span className="status-indicator" aria-hidden="true" />
      <strong>{freshnessLabel}</strong>
      <span className="status-separator" aria-hidden="true">·</span>
      <span>{d.freshness?.lastSyncedAt ? `Last successful Square sync ${date(d.freshness.lastSyncedAt)}` : 'No successful Square sync recorded'}</span>
      <span className="status-version">Calculation {d.projectionVersion ?? 'unavailable'}</span>
    </section>

    <div className="overview-content">
      <section className="overview-section income-snapshot">
        <div className="overview-section-heading"><div><h2>Income</h2><p>Operational cash basis · selected period</p></div><button className="text-button" onClick={() => onNavigate('income')}>View income →</button></div>
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
        <div className="overview-section-heading"><div><h2>Cash &amp; reconciliation</h2><p>{account ? `${account.name} · ${account.currency}` : 'Account status'}</p></div><button className="text-button" onClick={() => onNavigate('cash')}>View cash flow →</button></div>
        {!account ? <div className="reconciliation-empty"><strong>No tracked account</strong><p>A workspace administrator can configure an account before reconciliation.</p></div> : <dl className="reconciliation-values">
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
      {(flags.length || issues.length) > 0 && <button className="text-button" onClick={() => onNavigate('review')}>Open review queue →</button>}
    </section>

    <section className="overview-section recent-activity">
      <div className="overview-section-heading"><div><h2>Recent activity</h2><p>Recorded workspace decisions and changes</p></div><button className="text-button" onClick={() => onNavigate('ledger')}>Open activity ledger →</button></div>
      {recentEvents.length ? <ul className="activity-list">{recentEvents.map(event => <li key={event.id}><time dateTime={event.created_at}>{date(event.created_at)}</time><span>{activityLabel(event)}</span><small>{event.actor_kind ?? 'Recorded event'}</small></li>)}</ul> : <p className="activity-empty">No audit events have been recorded for this workspace yet.</p>}
    </section>
  </>;
}
function Income({ dashboard: d, currency: c }: { dashboard: Dashboard; currency: string }) {
  return <><div className="metric-grid three"><Card label="Gross item sales" value={money(d.income?.grossItemSalesMinor, c)} hint="Before discounts" /><Card label="Net sales" value={money(d.income?.netSalesMinor, c)} hint="After discounts and refunds" /><Card label="Square fees" value={money(d.income?.squareFeesMinor, c)} hint="Completed processing fees" /></div><section className="panel table-panel"><div className="panel-heading"><div><h2>Sales and inventory</h2><p>Line item details from the selected calculation run</p></div><span className={`pill ${d.income?.status === 'complete' ? 'good' : 'warn'}`}>{d.income?.status ?? 'Not calculated'}</span></div>{d.income?.lines?.length ? <div className="table-wrap"><table><thead><tr><th>Item</th><th className="numeric">Units</th><th className="numeric">Sales</th><th className="numeric">Unit cost</th><th className="numeric">COGS</th><th className="numeric">Margin</th></tr></thead><tbody>{d.income.lines.map((line, i) => <tr key={String(line.id ?? i)}><td>{String(line.itemName ?? line.name ?? 'Unidentified item')}<small className="cell-sub">{String(line.catalogId ?? line.sourceId ?? '')}</small></td><td className="numeric">{String(line.quantity ?? '—')}</td><td className="numeric">{money(Number(line.netSalesMinor), c)}</td><td className="numeric">{line.unitCostMinor == null ? <span className="pill warn">Needs cost</span> : money(Number(line.unitCostMinor), c)}</td><td className="numeric">{money(line.cogsMinor == null ? null : Number(line.cogsMinor), c)}</td><td className="numeric">{money(line.marginMinor == null ? null : Number(line.marginMinor), c)}</td></tr>)}</tbody></table></div> : <div className="inline-empty">No line details were included in this projection response.</div>}</section><div className="notice"><b>Policy treatment</b><span>Tax, tips, discounts and refunds follow the calculation policy attached to the projection. Missing approved item cost keeps margin incomplete.</span></div></>;
}
function Cash({ dashboard: d, currency: c, movements, accounts, accountId, organizationId, inventoryEnabled, canManageSquareCatalog, canAuthorizeSquareCatalog, onAccount, onSaved }: { dashboard: Dashboard; currency: string; movements: Movement[]; accounts: NonNullable<Dashboard['accounts']>; accountId: string; organizationId: string; inventoryEnabled: boolean; canManageSquareCatalog: boolean; canAuthorizeSquareCatalog: boolean; onAccount: (v: string) => void; onSaved: () => void }) {
  const [mode, setMode] = useState<'movement' | 'observation' | null>(null); const [kind, setKind] = useState('purchase'); const [amount, setAmount] = useState(''); const [description, setDescription] = useState(''); const [evidenceFile, setEvidenceFile] = useState<File | null>(null); const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16)); const [saving, setSaving] = useState(false); const [formError, setFormError] = useState('');
  async function save(e: FormEvent) { e.preventDefault(); const acct = accounts.find(x => x.id === accountId); if (!acct || !amount || !evidenceFile) return; const minor = Math.round(Number(amount) * 100); if (!Number.isSafeInteger(minor) || minor <= 0) { setFormError('Enter a positive amount with at most two decimal places.'); return; } setSaving(true); setFormError('');
    const key = crypto.randomUUID(); const isObservation = mode === 'observation';
    try { const upload = new FormData(); upload.set('organizationId', organizationId); upload.set('file', evidenceFile); const stored = await api<{ evidence: { id: string } }>('/api/evidence', { method: 'POST', body: upload }); const evidenceRef = stored.evidence.id; await api(isObservation ? '/api/observations' : '/api/manual-movements', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(isObservation ? { organizationId, accountId, amountMinor: minor, currency: acct.currency, observedAt: new Date(occurredAt).toISOString(), evidenceRef } : { organizationId, accountId, kind, amountMinor: ['purchase','pay','misc_spend'].includes(kind) ? -minor : minor, currency: acct.currency, occurredAt: new Date(occurredAt).toISOString(), description: description.trim(), evidenceRef }) }); setMode(null); setAmount(''); setEvidenceFile(null); setDescription(''); onSaved(); }
    catch (err) { setFormError(err instanceof Error ? err.message : 'Could not save this record.'); } finally { setSaving(false); }
  }
  return <><section className="panel filter-panel">{accounts.length ? <><label>Reconciliation account<select value={accountId} onChange={e => onAccount(e.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</select></label><span className={`pill ${d.cash?.status === 'matched' ? 'good' : d.cash?.status === 'mismatch' ? 'warn' : 'neutral'}`}>{d.cash?.status ?? 'Not reconciled'}</span></> : <div className="cash-account-empty"><strong>No tracked cash account</strong><span>A workspace administrator must configure an account before you can record cash activity or reconcile a balance.</span></div>}<div className="form-actions"><button className="secondary" disabled={!accounts.length} onClick={() => { setMode('observation'); setFormError(''); }}>Record balance</button><button className="primary" disabled={!accounts.length} onClick={() => { setMode('movement'); setFormError(''); }}>＋ Record movement</button></div></section>
    {mode && <form className="panel entry-form" onSubmit={save}><div className="panel-heading"><div><h2>{mode === 'observation' ? 'Record observed balance' : 'Record cash movement'}</h2><p>Saved through the authenticated workspace API with an idempotency key.</p></div><button type="button" className="icon-button" onClick={() => setMode(null)} aria-label="Close form">×</button></div>
      {mode === 'movement' && <label>Movement type<select value={kind} onChange={e => setKind(e.target.value)}><option value="cash_deposit">Cash deposit</option><option value="other_inflow">Other cash inflow</option><option value="purchase">Purchase</option><option value="pay">Pay</option><option value="misc_spend">Miscellaneous spend</option></select></label>}
      <div className="form-grid"><label>Amount ({accounts.find(x => x.id === accountId)?.currency ?? c})<input inputMode="decimal" type="number" min="0.01" step="0.01" required value={amount} onChange={e => setAmount(e.target.value)} /></label><label>{mode === 'observation' ? 'Observed at' : 'Occurred at'}<input type="datetime-local" required value={occurredAt} onChange={e => setOccurredAt(e.target.value)} /></label>{mode === 'movement' && <label className="wide">Description<input maxLength={500} required value={description} onChange={e => setDescription(e.target.value)} /></label>}<label className="wide">Supporting evidence<input type="file" accept="application/pdf,image/jpeg,image/png" required onChange={e => setEvidenceFile(e.target.files?.[0] ?? null)} /><small className="field-hint">Private PDF, JPEG, or PNG; maximum 10 MB.</small></label></div>
      {formError && <p className="error" role="alert">{formError}</p>}<div className="form-actions"><button type="button" className="secondary" onClick={() => setMode(null)}>Cancel</button><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save record'}</button></div>
    </form>}
    <section className="metric-grid three"><Card label="Expected balance" value={money(d.cash?.expectedBalanceMinor, d.cash?.currency ?? c)} hint="Opening balance + posted movements" /><Card label="Observed balance" value={money(d.cash?.observedBalanceMinor, d.cash?.currency ?? c)} hint="Most recent human observation" /><Card label="Difference" value={money(d.cash?.discrepancyMinor, d.cash?.currency ?? c)} hint="Observed minus expected" tone={d.cash?.discrepancyMinor ? 'warn-text' : ''} /></section><section className="panel table-panel"><div className="panel-heading"><div><h2>Account movements</h2><p>Cash activity for the selected account and period</p></div></div>{movements.length ? <div className="table-wrap"><table><thead><tr><th>Date</th><th>Activity</th><th>Category</th><th>Evidence</th><th className="numeric">Amount</th></tr></thead><tbody>{movements.filter(m => !accountId || m.account_id === accountId).map(m => <tr key={m.id}><td>{date(m.occurred_at)}</td><td>{m.description}</td><td>{m.kind.replaceAll('_', ' ')}</td><td><EvidenceLink organizationId={organizationId} evidenceId={m.evidence_ref ?? ''} /></td><td className={`numeric ${m.amount_minor < 0 ? 'negative' : 'positive'}`}>{money(m.amount_minor, m.currency)}</td></tr>)}</tbody></table></div> : <div className="inline-empty">No confirmed account movements were returned for this period.</div>}</section>{inventoryEnabled && <InventoryPanel organizationId={organizationId} accountId={accountId} currency={c} timezone={d.organization?.timezone ?? 'UTC'} accounts={accounts} from={d.period?.from ?? ''} to={d.period?.to ?? ''} canManageSquareCatalog={canManageSquareCatalog} canAuthorizeSquareCatalog={canAuthorizeSquareCatalog} onSaved={onSaved} />}<p className="tiny muted">COGS is an analytical margin measure and is not deducted again from the account balance. Transfers require linked account legs.</p></>;
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
  return <><button type="button" className="text-button" onClick={() => void openEvidence()}>View file</button>{error && <small className="error" role="alert">{error}</small>}</>;
}
function InventoryPanel({ organizationId, accountId, currency, timezone, accounts, from, to, canManageSquareCatalog, canAuthorizeSquareCatalog, onSaved }: { organizationId: string; accountId: string; currency: string; timezone: string; accounts: NonNullable<Dashboard['accounts']>; from: string; to: string; canManageSquareCatalog: boolean; canAuthorizeSquareCatalog: boolean; onSaved: () => void }) {
  const [rows, setRows] = useState<InventoryMovement[]>([]), [snapshot, setSnapshot] = useState<InventorySnapshot | null>(null), [loading, setLoading] = useState(false), [mode, setMode] = useState<'purchase' | 'correction' | 'opening' | 'item' | 'square-item' | null>(null);
  const [itemId, setItemId] = useState(''), [name, setName] = useState(''), [sku, setSku] = useState(''), [quantity, setQuantity] = useState('1'), [purchaseLines, setPurchaseLines] = useState<PurchaseLineInput[]>([{ itemId: '', quantity: '1', unitCost: '' }]), [amountPaid, setAmountPaid] = useState(''), [reason, setReason] = useState(''), [direction, setDirection] = useState<'add' | 'remove'>('add'), [occurredAt, setOccurredAt] = useState(localDateTimeNow);
  const [evidence, setEvidence] = useState<File | null>(null), [evidenceRefInput, setEvidenceRefInput] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false), [authorizingSquare, setAuthorizingSquare] = useState(false);
  const [variationName, setVariationName] = useState('Regular'), [description, setDescription] = useState(''), [salePrice, setSalePrice] = useState(''), [unitCost, setUnitCost] = useState(''), [itemCurrency, setItemCurrency] = useState(accounts.find(x => x.id === accountId)?.currency ?? currency), [costEffectiveDate, setCostEffectiveDate] = useState(() => todayInTimezone(timezone));
  const [receiptText, setReceiptText] = useState(''), [receiptDraft, setReceiptDraft] = useState<ReceiptDraft | null>(null), [receiptLines, setReceiptLines] = useState<ReceiptDraftLineInput[]>([]), [receiptCandidates, setReceiptCandidates] = useState<ReceiptCatalogCandidate[]>([]);
  const [receiptDate, setReceiptDate] = useState(() => todayInTimezone(timezone)), [receiptCurrency, setReceiptCurrency] = useState(currency);
  const [receiptEvidence, setReceiptEvidence] = useState<File | null>(null), [receiptEvidenceRef, setReceiptEvidenceRef] = useState(''), [receiptReason, setReceiptReason] = useState(''), [receiptError, setReceiptError] = useState(''), [receiptNotice, setReceiptNotice] = useState('');
  const [parsingReceipt, setParsingReceipt] = useState(false), [applyingReceiptCosts, setApplyingReceiptCosts] = useState(false);
  const receiptApprovalKey = useRef<null | { fingerprint: string; key: string; evidenceId?: string }>(null);
  const pending = useRef<null | { fingerprint: string; key: string; evidenceId?: string; occurredAt: string }>(null);
  async function refresh() {
    if (!from || !to) return;
    setLoading(true); setSnapshot(null); setRows([]);
    try { const query = new URLSearchParams({ organizationId, from, to, currency: accounts.find(x => x.id === accountId)?.currency ?? currency }); const result = await api<{ movements: InventoryMovement[]; snapshot: InventorySnapshot }>(`/api/inventory?${query}`); setRows(result.movements ?? []); setSnapshot(result.snapshot ?? null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Inventory could not be loaded.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [organizationId, from, to, accountId]);
  const items: NonNullable<InventorySnapshot['items']> = snapshot?.items ?? [...new Map(rows.map(row => [row.item_id, { id: row.item_id, name: row.item_name, currency, item_kind: 'manual' }])).values()];
  async function parseReceiptText() {
    setReceiptError(''); setReceiptNotice(''); setParsingReceipt(true); setReceiptDraft(null); setReceiptLines([]); setReceiptCandidates([]); setReceiptEvidence(null); setReceiptEvidenceRef(''); setReceiptReason(''); receiptApprovalKey.current = null;
    try {
      const result = await api<{ draft: ReceiptDraft; candidates: ReceiptCatalogCandidate[] }>('/api/inventory/receipt-drafts', { method: 'POST', body: JSON.stringify({ organizationId, currency: receiptCurrency, text: receiptText }) });
      const draft = result.draft; setReceiptDraft(draft); setReceiptCandidates(result.candidates ?? []); setReceiptDate(draft.invoiceDate ?? todayInTimezone(timezone));
      setReceiptLines(draft.lines.map(line => {
        const unitsPerSquareItem = line.packageUnitCount ?? 1;
        const packageCostMinor = line.packageCostMinor ?? line.unitCostMinor;
        const conversion = packageCostMinor === null ? null : calculatePackageUnitCostMinor(packageCostMinor, line.wholeQuantity, unitsPerSquareItem);
        return {
          ...line,
          packageCostMinor,
          itemId: '',
          catalogSearchText: line.description,
          unitsPerSquareItemText: String(unitsPerSquareItem),
          unitCostText: conversion ? minorInput(conversion.unitCostMinor, draft.currency) : '',
        };
      }));
    } catch (err) { setReceiptError(err instanceof Error ? err.message : 'Receipt details could not be extracted.'); }
    finally { setParsingReceipt(false); }
  }
  async function approveReceiptCosts() {
    setReceiptError(''); setReceiptNotice('');
    const selectedLines = receiptLines.filter(line => line.itemId);
    if (!receiptDraft || !selectedLines.length) { setReceiptError('Choose at least one exact Square catalog item to update.'); return; }
    if (selectedLines.some(line => !receiptCandidates.some(candidate => candidate.catalogObjectId === line.itemId && candidate.currency === receiptDraft.currency))) { setReceiptError('Choose an item from the current Square sale evidence for this receipt currency.'); return; }
    const parsedReceiptDate = /^\d{4}-\d{2}-\d{2}$/.test(receiptDate) ? new Date(`${receiptDate}T00:00:00Z`) : null;
    if (!parsedReceiptDate || !Number.isFinite(parsedReceiptDate.getTime()) || parsedReceiptDate.toISOString().slice(0, 10) !== receiptDate) { setReceiptError('Enter a valid effective date for the approved COGS change.'); return; }
    const effectiveFrom = zonedMidnight(receiptDate, timezone);
    const effectiveDateCheck = new Date(effectiveFrom);
    if (!effectiveFrom || !Number.isFinite(effectiveDateCheck.getTime()) || effectiveDateCheck.toISOString() !== effectiveFrom) { setReceiptError('Enter a valid effective date for the approved COGS change.'); return; }
    if (Date.now() + 1_000 - effectiveDateCheck.getTime() > 370 * 24 * 60 * 60 * 1000) { setReceiptError('This flow can replay at most 370 days. Choose a later effective date; older cost corrections need a separately planned historical replay.'); return; }
    if (selectedLines.some(line => {
      const unitsPerSquareItem = Number(line.unitsPerSquareItemText);
      return !Number.isSafeInteger(unitsPerSquareItem) || unitsPerSquareItem < 1 || unitsPerSquareItem > 1_000_000;
    })) { setReceiptError('Enter a whole number of 1 to 1,000,000 units per Square item.'); return; }
    const prepared = selectedLines.map(line => { const candidate = receiptCandidates.find(item => item.catalogObjectId === line.itemId)!; return { catalogObjectId: candidate.catalogObjectId, name: candidate.name, unitCostMinor: parseMinor(line.unitCostText, receiptDraft.currency), currency: receiptDraft.currency, effectiveFrom }; });
    if (prepared.some(update => update.unitCostMinor === null)) { setReceiptError('Each mapped line needs a valid nonnegative unit acquisition cost in the receipt currency.'); return; }
    if (new Set(prepared.map(update => update.catalogObjectId)).size !== prepared.length) { setReceiptError('Map each catalog item once. Combine duplicate receipt lines before applying a cost.'); return; }
    if (receiptReason.trim().length < 10) { setReceiptError('Add a reason of at least 10 characters describing how you reviewed the receipt.'); return; }
    const conversionNotes = selectedLines.flatMap(line => {
      const unitsPerSquareItem = Number(line.unitsPerSquareItemText);
      if (unitsPerSquareItem <= 1 || (line.packageCostMinor ?? line.unitCostMinor) === null) return [];
      const conversion = receiptLineConversion(line, receiptDraft.currency);
      if (!conversion) return [];
      const rounding = conversion.roundingDeltaMinor === null ? '' : `; ${money(conversion.roundingDeltaMinor, receiptDraft.currency)} rounding difference over ${conversion.squareUnitCount} items`;
      return [`Line ${line.lineNumber}: ${money(line.packageCostMinor ?? line.unitCostMinor, receiptDraft.currency)}/package ÷ ${unitsPerSquareItem} = ${money(conversion.unitCostMinor, receiptDraft.currency)} rounded/item; approved ${money(conversion.appliedUnitCostMinor, receiptDraft.currency)}${rounding}.`];
    });
    const approvalReason = [receiptReason.trim(), conversionNotes.length ? `Package conversions: ${conversionNotes.join(' ')}` : ''].filter(Boolean).join(' ');
    if (approvalReason.length > 1000) { setReceiptError('Shorten the approval reason so it and the package conversion details fit within 1,000 characters.'); return; }
    if (!receiptEvidence && !UUID_INPUT.test(receiptEvidenceRef.trim())) { setReceiptError('Attach the receipt file or enter an existing evidence ID.'); return; }
    setApplyingReceiptCosts(true);
    try {
      const fingerprint = JSON.stringify([organizationId, prepared, approvalReason, receiptEvidence?.name, receiptEvidence?.size, receiptEvidence?.lastModified, receiptEvidenceRef]);
      if (!receiptApprovalKey.current || receiptApprovalKey.current.fingerprint !== fingerprint) receiptApprovalKey.current = { fingerprint, key: crypto.randomUUID() };
      if (!receiptApprovalKey.current.evidenceId) {
        if (receiptEvidence) { const upload = new FormData(); upload.set('organizationId', organizationId); upload.set('file', receiptEvidence); const stored = await api<{ evidence: { id: string } }>('/api/evidence', { method: 'POST', body: upload }); receiptApprovalKey.current.evidenceId = stored.evidence.id; }
        else receiptApprovalKey.current.evidenceId = receiptEvidenceRef.trim();
      }
      const result = await api<{ projectionQueued: boolean }>('/api/inventory/receipt-costs', { method: 'POST', headers: { 'Idempotency-Key': receiptApprovalKey.current.key }, body: JSON.stringify({ organizationId, evidenceRef: receiptApprovalKey.current.evidenceId, reason: approvalReason, updates: prepared }) });
      receiptApprovalKey.current = null;
      setReceiptNotice(result.projectionQueued ? 'Approved cost updates were recorded. Projection replay is queued; refresh after it completes.' : 'Approved cost updates were recorded. They take effect on the selected date.');
      setReceiptDraft(null); setReceiptLines([]); setReceiptCandidates([]); setReceiptText(''); setReceiptEvidence(null); setReceiptEvidenceRef(''); setReceiptReason('');
      await refresh(); onSaved();
    } catch (err) { setReceiptError(err instanceof Error ? err.message : 'Receipt cost update could not be saved.'); }
    finally { setApplyingReceiptCosts(false); }
  }
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
        setNotice(result.projectionQueued ? 'Item created in Square. Its approved unit cost and catalog link are saved in Zythe; a projection replay is queued.' : 'Item created in Square and its approved unit cost is saved in Zythe.');
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
  return <section className="panel table-panel"><div className="panel-heading"><div><h2>Inventory and supply purchases</h2><p>Purchases post cash and stock together. Opening counts and corrections keep their evidence and reason.</p></div><div className="form-actions">{canManageSquareCatalog && <button type="button" className="primary" onClick={openSquareItemForm}>＋ Add item to Square</button>}<button type="button" className="secondary" onClick={() => { setMode('item'); setError(''); setName(''); setSku(''); setItemId(''); }}>Add supply item</button><button type="button" className="secondary" onClick={() => { setMode('opening'); setError(''); setItemId(items[0]?.id ?? ''); }}>Set opening count</button><button type="button" className="secondary" onClick={() => { setMode('correction'); setError(''); setItemId(items[0]?.id ?? ''); }}>Correct stock</button><button type="button" className="primary" onClick={() => { setMode('purchase'); setError(''); setPurchaseLines([{ itemId: items[0]?.id ?? '', quantity: '1', unitCost: '' }]); }}>＋ Purchase supplies</button></div></div>
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="receipt-assist panel">
      <div className="panel-heading"><div><h3>Receipt-to-cost assistant</h3><p>Paste receipt text to draft unit costs. A person maps each line to a Square catalog item and approves any COGS change.</p></div><span className="pill neutral">Draft only</span></div>
      <div className="form-grid">
        <label className="wide">Unstructured receipt details<textarea rows={5} maxLength={8000} disabled={parsingReceipt} value={receiptText} onChange={e => { setReceiptText(e.target.value); setReceiptDraft(null); setReceiptLines([]); setReceiptCandidates([]); setReceiptEvidence(null); setReceiptEvidenceRef(''); setReceiptReason(''); receiptApprovalKey.current = null; }} placeholder={'Paste the item lines and prices from a supplier receipt.\nExample: 4 × Canvas Tote — $8.25 each'} /></label>
        <label>Receipt currency<select disabled={parsingReceipt} value={receiptCurrency} onChange={e => { setReceiptCurrency(e.target.value); setReceiptDraft(null); setReceiptLines([]); setReceiptCandidates([]); setReceiptEvidence(null); setReceiptEvidenceRef(''); setReceiptReason(''); receiptApprovalKey.current = null; }}>{Array.from(new Set([receiptCurrency, currency, ...accounts.map(account => account.currency), ...items.filter(item => item.item_kind === 'catalog').map(item => item.currency)])).sort().map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <div className="form-actions"><button type="button" className="secondary" disabled={parsingReceipt || receiptText.trim().length < 1} onClick={() => void parseReceiptText()}>{parsingReceipt ? 'Extracting…' : 'Extract receipt lines'}</button></div>
      </div>
      <p className="field-hint">Only pasted text is sent to the model; do not include payment card data or personal details. The model cannot match catalog items or write costs. Extraction is budget limited.</p>
      {receiptError && <p className="error" role="alert">{receiptError}</p>}{receiptNotice && <div className="notice" role="status">{receiptNotice}</div>}
      {receiptDraft && <>
        <div className="notice compact-notice"><b>Review every extracted value.</b> Package prices are converted to cost per Square item using the units assigned to each Square item. Use the package contents when Square sells an individual piece; use 1 when the Square item is the full package. The calculation rounds to the nearest cent and shows the total difference. Exclude purchase tax and miscellaneous charges. The receipt remains supporting evidence. This approval changes effective-dated COGS; it does not record the purchase cash outflow or stock receipt. Use “Purchase supplies” for that separate entry. Cost approval requires an owner or reviewer.</div>
        <div className="status-row"><span>Supplier detected</span><b>{receiptDraft.supplier ?? 'Not identified'}</b></div>
        <div className="form-grid">
          <label>Effective date for COGS ({timezone})<input type="date" required value={receiptDate} onChange={e => setReceiptDate(e.target.value)} /></label>
          <div className="wide table-wrap"><table><thead><tr><th>Receipt line</th><th>Purchased packages</th><th>Extracted basis</th><th>Units per Square item</th><th>Cost per Square item ({receiptDraft.currency})</th><th>Square catalog item</th></tr></thead><tbody>{receiptLines.map((line, index) => {
            const suggestions = rankReceiptCatalogCandidates(line.catalogSearchText, receiptCandidates, receiptDraft.currency);
            const topSuggestion = suggestions[0];
            const conversion = receiptLineConversion(line, receiptDraft.currency);
            const packageCostMinor = line.packageCostMinor ?? line.unitCostMinor;
            const unitsPerSquareItem = Number(line.unitsPerSquareItemText);
            const unitsPerSquareItemValid = Number.isSafeInteger(unitsPerSquareItem) && unitsPerSquareItem >= 1 && unitsPerSquareItem <= 1_000_000;
            return <tr key={line.lineNumber}>
              <td>{line.description}{line.reviewReason && <small className="cell-sub">Review: {line.reviewReason.replaceAll('_', ' ')}</small>}</td>
              <td>{line.quantity ? `${line.quantity} package${Number(line.quantity) === 1 ? '' : 's'}` : 'Unclear'}</td>
              <td><span>{line.costBasis.replaceAll('_', ' ')}</span>{line.sourceUnitPriceText ? <small className="cell-sub">Printed package price {line.sourceUnitPriceText}</small> : line.unitPriceText && <small className="cell-sub">Model extracted package price {line.unitPriceText}; check the pasted price.</small>}{line.sourceLineAmountText && <small className="cell-sub">Printed line amount {line.sourceLineAmountText}</small>}{!line.sourceLineAmountText && line.lineAmountText && <small className="cell-sub">Model extracted amount {line.lineAmountText}; check the pasted total.</small>}{line.expectedLineAmountText && <small className="cell-sub">At package price × quantity: {line.expectedLineAmountText}</small>}{line.suggestedLineAmountText && <small className="cell-sub">The printed total may be missing its decimal; verify it.</small>}</td>
              <td><input aria-label={`Units per Square item for receipt line ${line.lineNumber}`} type="number" min="1" max="1000000" step="1" value={line.unitsPerSquareItemText} onChange={e => setReceiptLines(current => current.map((row, i) => i === index ? { ...row, unitsPerSquareItemText: e.target.value } : row))} /><small className="cell-sub">Contents inside each package assigned to this Square item. Use 1 if Square sells the full package.</small></td>
              <td><input aria-label={`Cost per Square item for receipt line ${line.lineNumber}`} type="number" min="0" step="any" value={line.unitCostText} onChange={e => setReceiptLines(current => current.map((row, i) => i === index ? { ...row, unitCostText: e.target.value } : row))} />{conversion && <small className="cell-sub">Nearest-cent calculation: {money(packageCostMinor, receiptDraft.currency)} per package ÷ {unitsPerSquareItem} = {money(conversion.unitCostMinor, receiptDraft.currency)} per item.</small>}{conversion?.roundingDeltaMinor !== null && conversion?.roundingDeltaMinor !== undefined && <small className="cell-sub">At entered cost: {money(conversion.roundingDeltaMinor, receiptDraft.currency)} rounding difference over {conversion.squareUnitCount} items.</small>}{conversion && conversion.roundingDeltaMinor === null && <small className="cell-sub">Purchase-total rounding difference unavailable because quantity is unclear.</small>}{!unitsPerSquareItemValid && <small className="cell-sub">Enter a whole number from 1 to 1,000,000.</small>}</td>
              <td><input aria-label={`Search catalog for receipt line ${line.lineNumber}`} type="search" value={line.catalogSearchText} onChange={e => setReceiptLines(current => current.map((row, i) => i === index ? { ...row, itemId: '', catalogSearchText: e.target.value } : row))} placeholder="Search name, SKU, or ID" /><select aria-label={`Select catalog item for receipt line ${line.lineNumber}`} value={line.itemId} onChange={e => setReceiptLines(current => current.map((row, i) => i === index ? { ...row, itemId: e.target.value, catalogSearchText: receiptCandidates.find(candidate => candidate.catalogObjectId === e.target.value)?.name ?? row.catalogSearchText } : row))}><option value="">{suggestions.length ? `Choose from ${suggestions.length} suggestions` : 'Skip this line'}</option>{suggestions.map(({ candidate, exactNameMatch, nameWordsMatch }) => <option key={candidate.catalogObjectId} value={candidate.catalogObjectId}>{exactNameMatch ? 'Exact name match · ' : nameWordsMatch ? 'Name words match · ' : ''}{candidate.name}{candidate.sku ? ` · ${candidate.sku}` : ''} · {candidate.catalogObjectId}</option>)}</select>{topSuggestion && <small className="cell-sub">Suggested by name: {topSuggestion.candidate.name}. Select to confirm.</small>}{!suggestions.length && <small className="cell-sub">No name matches. Try a shorter product name, SKU, or ID.</small>}</td>
            </tr>;
          })}</tbody></table></div>
          <label className="wide">Approval reason<textarea minLength={10} maxLength={1000} value={receiptReason} onChange={e => setReceiptReason(e.target.value)} placeholder="Describe how you matched the receipt lines to the catalog and verified the unit costs." /></label>
          <label className="wide">Receipt evidence file<input type="file" accept="application/pdf,image/jpeg,image/png" onChange={e => { setReceiptEvidence(e.target.files?.[0] ?? null); receiptApprovalKey.current = null; }} /></label>
          <label className="wide">Or existing evidence ID<input value={receiptEvidenceRef} onChange={e => { setReceiptEvidenceRef(e.target.value); receiptApprovalKey.current = null; }} maxLength={36} placeholder="UUID for receipt evidence already uploaded by a workspace member" /></label>
        </div>
        <div className="form-actions"><button type="button" className="primary" disabled={applyingReceiptCosts || !receiptLines.some(line => line.itemId)} onClick={() => void approveReceiptCosts()}>{applyingReceiptCosts ? 'Applying approved costs…' : `Approve and update COGS (${receiptLines.filter(line => line.itemId).length})`}</button><button type="button" className="secondary" onClick={() => { setReceiptDraft(null); setReceiptLines([]); setReceiptCandidates([]); setReceiptError(''); }}>Discard draft</button></div>
      </>}
    </section>
    {mode && <form className="entry-form" onSubmit={save}><div className="form-grid">
      {(mode === 'opening' || mode === 'correction') && <label>Inventory item<select required value={itemId} onChange={e => setItemId(e.target.value)}><option value="">Choose item</option>{items.map(item => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></label>}
      {mode === 'item' && <><label>Item name<input required maxLength={200} value={name} onChange={e => setName(e.target.value)} /></label><label>SKU or stock code<input required maxLength={100} value={sku} onChange={e => setSku(e.target.value)} /></label><label>Currency<select value={accounts.find(x => x.id === accountId)?.currency ?? currency} onChange={() => {}} disabled><option>{accounts.find(x => x.id === accountId)?.currency ?? currency}</option></select></label><label className="wide">Reason<textarea minLength={10} maxLength={1000} required value={reason} onChange={e => setReason(e.target.value)} placeholder="Explain the source for this new supply item" /></label></>}
      {mode === 'square-item' && <>
        <div className="notice compact-notice wide"><b>Creates a real Square catalog item.</b> The sale price, item name, variation, and optional SKU are written to Square. Zythe records the supplier-backed unit cost and evidence for COGS. Use “Set opening count” separately if you need to enter current stock.</div>
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
      {mode === 'purchase' && <div className="wide"><h3>Receipt items</h3>{purchaseLines.map((line, index) => <div className="form-grid" key={`receipt-line-${index}`}><label>Item<select required value={line.itemId} onChange={e => setPurchaseLines(current => current.map((row, i) => i === index ? { ...row, itemId: e.target.value } : row))}><option value="">Choose item</option>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Quantity<input type="number" min="1" step="1" required value={line.quantity} onChange={e => setPurchaseLines(current => current.map((row, i) => i === index ? { ...row, quantity: e.target.value } : row))} /></label><label>Unit acquisition cost ({accounts.find(x => x.id === accountId)?.currency ?? currency})<input type="number" min="0" step="any" required value={line.unitCost} onChange={e => setPurchaseLines(current => current.map((row, i) => i === index ? { ...row, unitCost: e.target.value } : row))} /></label><button type="button" className="secondary" disabled={purchaseLines.length === 1} onClick={() => setPurchaseLines(current => current.filter((_, i) => i !== index))}>Remove line</button></div>)}<button type="button" className="secondary" onClick={() => setPurchaseLines(current => [...current, { itemId: '', quantity: '1', unitCost: '' }])}>＋ Add receipt item</button><p className="field-hint">Enter the amount paid once for the whole receipt; include taxes and shipping.</p><label>Total paid ({accounts.find(x => x.id === accountId)?.currency ?? currency})<input type="number" min="0.01" step="any" required value={amountPaid} onChange={e => setAmountPaid(e.target.value)} /></label></div>}
      {mode !== 'item' && mode !== 'square-item' && <label>Occurred at (your local time)<input type="datetime-local" required value={occurredAt} onChange={e => setOccurredAt(e.target.value)} /></label>}
      {mode === 'correction' && <><label>Correction<select value={direction} onChange={e => setDirection(e.target.value as 'add' | 'remove')}><option value="add">Add units</option><option value="remove">Remove units</option></select></label><label>Units<input type="number" min="1" step="1" required value={quantity} onChange={e => setQuantity(e.target.value)} /></label><label className="wide">Reason<textarea minLength={10} maxLength={1000} required value={reason} onChange={e => setReason(e.target.value)} /></label></>}
      {mode === 'opening' && <><label>Physical on-hand count<input type="number" min="0" step="1" required value={quantity} onChange={e => setQuantity(e.target.value)} /></label><label className="wide">Reason<textarea minLength={10} maxLength={1000} required value={reason} onChange={e => setReason(e.target.value)} placeholder="Describe the count and its source" /></label></>}
      <label className="wide">{mode === 'square-item' ? 'Supplier receipt / unit cost evidence' : 'Receipt / evidence file'}<input type="file" accept="application/pdf,image/jpeg,image/png" onChange={e => setEvidence(e.target.files?.[0] ?? null)} /></label><label className="wide">Or existing evidence ID<input value={evidenceRefInput} onChange={e => setEvidenceRefInput(e.target.value)} maxLength={36} placeholder="UUID for a file already uploaded by a workspace member" /></label>
    </div>{error && <><p className="error" role="alert">{error === 'SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED' ? 'Square item write access is needed. An owner can reconnect Square to grant it.' : error === 'SQUARE_NOT_CONNECTED' ? 'Square is not connected to this workspace. Connect it before adding a sellable item.' : error === 'SQUARE_RECONNECT_REQUIRED' ? 'Square authorization needs renewal. Reconnect Square and try again.' : error === 'SQUARE_CATALOG_WRITE_FAILED' ? 'Square could not create this item. Check the catalog in Square before retrying.' : error}</p>{canAuthorizeSquareCatalog && ['SQUARE_CATALOG_WRITE_PERMISSION_REQUIRED','SQUARE_NOT_CONNECTED','SQUARE_RECONNECT_REQUIRED'].includes(error) && <button type="button" className="secondary" onClick={() => void authorizeSquareCatalog()} disabled={authorizingSquare}>{authorizingSquare ? 'Opening Square…' : 'Connect or reauthorize Square'}</button>}</>}<div className="form-actions"><button type="button" className="secondary" onClick={() => { setMode(null); setError(''); setEvidence(null); setEvidenceRefInput(''); pending.current = null; }}>Cancel</button><button className="primary" disabled={saving}>{saving ? mode === 'square-item' ? 'Creating Square item…' : 'Saving…' : mode === 'square-item' ? 'Create Square item and save cost' : 'Save inventory record'}</button></div></form>}
    {snapshot?.balances?.length ? <section className="panel"><div className="panel-heading"><div><h3>Stock on hand</h3><p>Calculated from recorded openings, purchases, corrections, and completed sales.</p></div><span className={`pill ${snapshot.status === 'complete' ? 'good' : 'warn'}`}>{snapshot.status ?? 'incomplete'}</span></div>{snapshot.issues?.length ? <div className="notice compact-notice">Inventory needs review: {Array.from(new Set(snapshot.issues.map(issue => issue.code))).join(', ')}</div> : null}<div className="table-wrap"><table><thead><tr><th>Item</th><th>Currency</th><th className="numeric">Units</th></tr></thead><tbody>{snapshot.balances.map(balance => <tr key={balance.itemDefinitionId}><td>{balance.itemName}</td><td>{balance.currency}</td><td className="numeric">{balance.quantity ?? 'Unknown'}</td></tr>)}</tbody></table></div></section> : null}{error && !mode && <p className="error" role="alert">{error}</p>}{loading ? <div className="inline-empty">Loading inventory…</div> : rows.length ? <div className="table-wrap"><table><thead><tr><th>Date</th><th>Item</th><th className="numeric">Change</th><th>Type</th><th>Reason</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{date(row.occurred_at)}</td><td>{row.item_name}</td><td className="numeric">{row.quantity_delta > 0 ? '+' : ''}{row.quantity_delta}</td><td>{(row.movement_type ?? 'movement').replaceAll('_', ' ')}</td><td>{row.reason ?? '—'}</td></tr>)}</tbody></table></div> : !loading && <div className="inline-empty">No inventory movements in this period. Existing item definitions appear here after their first recorded movement.</div>}
  </section>;
}
function Analytics({ organizationId, from, to, currency }: { organizationId: string; from: string; to: string; currency: string }) {
  const [report, setReport] = useState<AnalyticsReport | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [search, setSearch] = useState(''), [sortBy, setSortBy] = useState<'revenue' | 'cost' | 'net' | 'units'>('revenue'), [seriesView, setSeriesView] = useState<'monthly' | 'daily'>('monthly'), [selectedProductId, setSelectedProductId] = useState('');
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setReport(null); setSelectedProductId('');
    const query = new URLSearchParams({ organizationId, from, to, currency });
    api<{ analytics: AnalyticsReport }>(`/api/analytics?${query}`).then(result => { if (active) setReport(result.analytics); })
      .catch(err => { if (active) setError(err instanceof Error ? err.message : 'Analytics could not be loaded.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [organizationId, from, to, currency]);
  const visibleProducts = (report?.products ?? []).filter(product => `${product.productName ?? ''} ${product.productId}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => {
    const value = (p: AnalyticsProduct) => sortBy === 'cost' ? p.costMinor : sortBy === 'net' ? p.netMinor : sortBy === 'units' ? p.unitsSold : p.revenueMinor;
    const av = value(a), bv = value(b); return av == null ? 1 : bv == null ? -1 : bv - av || a.productId.localeCompare(b.productId);
  });
  const selectedProduct = report?.products.find(product => product.productId === selectedProductId);
  function exportCsv() {
    if (!report) return;
    const rows: unknown[][] = [['Period from', from], ['Period to', to], ['Requested currency', currency], ['Reported currency', report.currency ?? 'Mixed or unavailable'], ['Calculation version', report.calculationVersion], ['Calculation status', report.status], ['Source revision', report.sourceRevision ?? 'unavailable'], ['Aggregate Square processing fees', report.totals.feesMinor ?? 'incomplete'], ['Aggregate net after fees', report.totals.netMinor ?? 'incomplete'], ['Product result basis', 'Net and margin before processing fees'], [], ['Product','Product ID','Units sold','Revenue minor','Cost minor','Net before fees minor','Revenue rank','Net rank','Margin before fees bps','Source refs','Status'], ...report.products.map(p => [p.productName ?? 'Unidentified product', p.productId, p.unitsSold, p.revenueMinor, p.costMinor ?? '', p.netMinor ?? '', p.revenueRank ?? '', p.netRank ?? '', p.marginBps ?? '', p.sourceRefs?.join('|') ?? '', p.netMinor == null ? 'incomplete' : 'complete']), ['Unallocated revenue','','',report.unallocated.revenueMinor,'','','','','','','review'], ['Unallocated refunds','','',report.unallocated.refundsMinor,'','','','','','','review'], ['Unallocated COGS reversals','','','',report.unallocated.cogsReversalMinor ?? '','','','','','','review']];
    const csv = rows.map(row => row.map(value => { const raw = String(value ?? ''); const safe = /^[\s=+\-@]/.test(raw) ? `'${raw}` : raw; return `"${safe.replaceAll('"', '""')}"`; }).join(',')).join('\r\n');
    const href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = href; link.download = `product-analytics-${from.slice(0,10)}-${to.slice(0,10)}.csv`; link.click(); URL.revokeObjectURL(href);
  }
  return <><section className="metric-grid"><Card label="Product revenue" value={money(report?.totals?.revenueMinor, currency)} hint="After known discounts and refunds" /><Card label="Product cost" value={money(report?.totals?.costMinor, currency)} hint={report?.totals?.costMinor == null ? 'Incomplete where cost evidence is missing' : 'Effective approved acquisition costs'} tone={report?.totals?.costMinor == null ? 'warn-text' : ''} /><Card label="Square processing fees" value={money(report?.totals?.feesMinor, currency)} hint={report?.totals?.feesMinor == null ? 'Incomplete source fee data' : 'Deducted after product margins'} tone={report?.totals?.feesMinor == null ? 'warn-text' : ''} /><Card label="Net after fees" value={money(report?.totals?.netMinor, currency)} hint="Product revenue − COGS − processing fees" tone={report?.totals?.netMinor == null ? 'warn-text' : ''} /></section>
    <section className="panel table-panel"><div className="panel-heading"><div><h2>Product performance before fees</h2><p>Select an item name to chart its sales. Revenue, COGS and margin are before aggregate Square fees · {report?.calculationVersion ?? 'loading'} · source revision {report?.sourceRevision ?? 'unavailable'}</p></div><div className="form-actions"><span className={`pill ${report?.status === 'complete' ? 'good' : report?.status === 'failed' ? 'warn' : 'neutral'}`}>{report?.status ?? (loading ? 'Loading' : 'Unavailable')}</span><button className="secondary" onClick={exportCsv} disabled={!report}>Export CSV</button></div></div>
      {loading && <div className="inline-empty">Calculating product results…</div>}{error && <div className="notice error-box" role="alert">{error}</div>}{report?.currency == null && report?.status === 'failed' && <div className="notice error-box" role="alert">Mixed or invalid source currencies prevented a single-currency report.</div>}
      <div className="filter-panel"><label>Find product<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Name or product ID" /></label><label>Rank by<select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}><option value="revenue">Revenue</option><option value="cost">Cost</option><option value="net">Net before fees</option><option value="units">Units sold</option></select></label></div>
      {visibleProducts.length ? <div className="table-wrap"><table><thead><tr><th>Rank</th><th>Product</th><th className="numeric">Units</th><th className="numeric">Revenue</th><th className="numeric">Cost</th><th className="numeric">Net before fees</th><th className="numeric">Margin before fees</th><th className="numeric">Revenue share</th></tr></thead><tbody>{visibleProducts.map(product => <tr key={product.productId}><td>R{product.revenueRank ?? '—'} / N{product.netRank ?? '—'}</td><td><button type="button" className={'analytics-product-choice' + (selectedProductId === product.productId ? ' selected' : '')} aria-pressed={selectedProductId === product.productId} aria-label={(selectedProductId === product.productId ? 'Hide' : 'Show') + ' sales chart for ' + (product.productName ?? 'Unidentified product')} onClick={() => setSelectedProductId(selectedProductId === product.productId ? '' : product.productId)}>{product.productName ?? 'Unidentified product'}<small className="cell-sub">{product.productId}</small></button></td><td className="numeric">{product.unitsSold}</td><td className="numeric">{money(product.revenueMinor, currency)}</td><td className="numeric">{money(product.costMinor, currency)}</td><td className="numeric">{product.netMinor == null ? <span className="pill warn">Incomplete</span> : money(product.netMinor, currency)}</td><td className="numeric">{product.marginBps == null ? '—' : `${(product.marginBps / 100).toFixed(1)}%`}</td><td className="numeric">{product.revenueShareBps == null ? '—' : `${(product.revenueShareBps / 100).toFixed(1)}%`}</td></tr>)}</tbody></table></div> : !loading && !error && <div className="inline-empty">No product sales match this period and filter.</div>}{selectedProduct && <ProductSalesChart product={selectedProduct} from={from} to={to} currency={currency} issues={report?.issues ?? []} />}
    </section>{(seriesView === 'monthly' ? report?.monthly : report?.daily)?.length ? <section className="panel table-panel"><div className="panel-heading"><div><h2>{seriesView === 'monthly' ? 'Monthly' : 'Daily'} trend</h2><p>UTC reporting buckets show processing fees as an aggregate cost after product COGS.</p></div><label>View<select value={seriesView} onChange={e => setSeriesView(e.target.value as 'monthly' | 'daily')}><option value="monthly">Monthly</option><option value="daily">Daily</option></select></label></div><div className="table-wrap"><table><thead><tr><th>Period (UTC)</th><th className="numeric">Revenue</th><th className="numeric">Cost</th><th className="numeric">Processing fees</th><th className="numeric">Net after fees</th><th className="numeric">Units</th></tr></thead><tbody>{(seriesView === 'monthly' ? report?.monthly : report?.daily)?.map(series => <tr key={series.period}><td>{series.period}</td><td className="numeric">{money(series.revenueMinor, currency)}</td><td className="numeric">{money(series.costMinor, currency)}</td><td className="numeric">{money(series.feesMinor, currency)}</td><td className="numeric">{money(series.netMinor, currency)}</td><td className="numeric">{series.unitsSold}</td></tr>)}</tbody></table></div></section> : null}<section className="panel"><div className="panel-heading"><div><h2>Unallocated activity</h2><p>Revenue, refunds and COGS reversals without defensible item attribution remain separate; fees are summarized above.</p></div></div><div className="status-row"><span>Unallocated revenue</span><b>{money(report?.unallocated?.revenueMinor, currency)}</b></div><div className="status-row"><span>Unallocated refunds</span><b>{money(report?.unallocated?.refundsMinor, currency)}</b></div><div className="status-row"><span>Unallocated COGS reversals</span><b>{money(report?.unallocated?.cogsReversalMinor, currency)}</b></div>{report?.issues?.length ? <div className="notice compact-notice">Incomplete data: {Array.from(new Set(report.issues.map(issue => issue.code))).join(', ')}</div> : null}</section></>;
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
    ? 'Product totals loaded, but their item trend buckets are missing or marked incomplete. Refresh the report; if this persists, deploy the latest analytics calculation.'
    : incompleteWindow
      ? 'A completed Square sync does not cover the full selected period. Sync this period, then refresh the report.'
      : hasIncompleteTrendBucket
        ? 'One or more item revenue buckets have incomplete source data. Resolve the related source gap, then refresh the report.'
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
    <div className="item-sales-heading"><div><h3>Sales over time · {product.productName ?? 'Unidentified product'}</h3><p>Daily bars show item revenue after known discounts and item-level refunds. Dates use UTC; processing fees remain aggregate.</p></div><label className="compact">Buckets<select value={view} onChange={event => setView(event.target.value as typeof view)}><option value="daily">Daily</option><option value="monthly">Monthly</option></select></label></div>
    {!trendAvailable ? <div className="inline-empty">{trendUnavailableReason ?? 'Item revenue is incomplete for this period.'}</div> : <>
      <div className="item-sales-svg-wrap"><svg className="item-sales-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${product.productName ?? product.productId} revenue by ${view === 'daily' ? 'day' : 'month'}`}>
        <line x1={left} x2={right} y1={zeroY} y2={zeroY} className="item-sales-zero" />
        <text x={left - 8} y={top + 4} textAnchor="end" className="item-sales-axis">{money(maxValue, currency)}</text>
        {domainMin < 0 && <text x={left - 8} y={bottom + 3} textAnchor="end" className="item-sales-axis">{money(minValue, currency)}</text>}
        {points.map((point, index) => {
          const value = point.revenueMinor ?? 0, valueY = yFor(value), barHeight = value === 0 ? 0 : Math.max(1, Math.abs(zeroY - valueY));
          const x = left + index * step + (step - barWidth) / 2;
          return <rect key={point.period} x={x} y={Math.min(zeroY, valueY)} width={barWidth} height={barHeight} rx="1" fill={value < 0 ? '#e6a36b' : '#76ca94'}><title>{point.period}: {money(point.revenueMinor, currency)}</title></rect>;
        })}
        {tickIndexes.map(index => <text key={points[index].period} x={left + index * step + step / 2} y={height - 12} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'} className="item-sales-axis">{points[index].period}</text>)}
      </svg></div>
      {!hasSales && <p className="item-sales-empty">No recorded revenue for this item in the selected period.</p>}
    </>}
  </div>;
}

function Review({ issues, organizationId, currency, onSaved }: { issues: Issue[]; organizationId: string; currency: string; onSaved: () => void }) {
  const [selected, setSelected] = useState<Issue | null>(null);
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
  useEffect(() => {
    if (!passThroughLine || !selectedSaleLine) return;
    const unitPriceMinor = passThroughUnitPriceMinor(selectedSaleLine);
    if (unitPriceMinor === null) return;
    setUnitCost(minorInput(unitPriceMinor, itemCurrency));
    setReason(passThroughReason(unitPriceMinor, itemCurrency));
  }, [correction?.kind, correction?.issue.id, selectedSaleLine, passThroughLine, itemCurrency]);
  return <>
    <section className="panel table-panel">
      <div className="panel-heading"><div><h2>Human review queue</h2><p>Record the source-backed correction or prepare a draft for review.</p></div><span className="pill neutral">{issues.length} open</span></div>
      {error && !correction && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
      {issues.length ? <div className="review-list">{issues.map(issue => {
        const proposal = getProposal(issue);
        const issueTitle = issue.code === 'UNKNOWN_ITEM' ? 'Item cost needs review'
          : issue.code === 'REFUND_COGS_REVIEW' ? 'Refund return needs review'
            : issue.title ?? issue.code?.replaceAll('_', ' ').toLowerCase() ?? 'Needs review';
        const issueMessage = issue.code === 'UNKNOWN_ITEM' ? 'A sale item needs a documented unit cost. Open the review to see the item and sale details.'
          : issue.code === 'REFUND_COGS_REVIEW' ? 'Confirm whether goods returned to inventory and whether a COGS reversal is supported.'
            : String(issue.details?.message ?? issue.details?.description ?? 'Review the linked source evidence and decide how to handle this item.');
        return <article className="review-item" key={issue.id}>
          <div className="review-symbol">◇</div>
          <div className="review-copy"><div className="review-title">{issueTitle} <span className="pill warn">{issue.state.replaceAll('_', ' ')}</span></div>
            <p>{issueMessage}</p>
            {proposal && <details className="proposal-details"><summary>Proposed classification and evidence</summary><pre>{JSON.stringify(proposal.proposal ?? proposal.payload ?? proposal, null, 2)}</pre></details>}
          </div>
          <div className="form-actions review-actions">
            {issue.code === 'UNKNOWN_ITEM' && <button className="secondary" disabled={busyId === issue.id} onClick={() => void openCorrection(issue, 'item')}>Record item cost</button>}
            {issue.code === 'REFUND_COGS_REVIEW' && <button className="secondary" disabled={busyId === issue.id} onClick={() => void openCorrection(issue, 'refund')}>Record refund decision</button>}
            {!['UNKNOWN_ITEM', 'REFUND_COGS_REVIEW'].includes(issue.code ?? '') && (proposal ? <button className="secondary" disabled={busyId === issue.id} onClick={() => { setSelected(issue); setReason(''); setError(''); }}>{busyId === issue.id ? 'Saving…' : 'Review proposal'}</button>
              : issue.proposal_supported && <button className="secondary" disabled={busyId === issue.id} onClick={() => void draft(issue)}>{busyId === issue.id ? 'Preparing…' : 'Prepare proposal'}</button>)}
          </div>
        </article>;
      })}</div> : <div className="inline-empty">The API reported no open issues.</div>}
      {selected && <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSelected(null); }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="review-dialog-title"><button className="icon-button dialog-close" onClick={() => setSelected(null)} aria-label="Close review">×</button><p className="eyebrow">REVIEW DECISION</p><h2 id="review-dialog-title">{selected.title ?? selected.code ?? 'Review proposal'}</h2><p className="muted">This records a proposal decision. Use the source-backed correction form to update costs or refund treatment and recalculate.</p><label>Decision reason<textarea required rows={4} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></label><div className="form-actions"><button className="secondary" onClick={() => setSelected(null)}>Cancel</button>{(() => { const p = getProposal(selected); return <><button className="secondary reject-button" disabled={!p || !reason.trim() || busyId === selected.id} onClick={() => p && void decide(selected, p, 'reject')}>Reject</button><button className="primary" disabled={!p || !reason.trim() || busyId === selected.id} onClick={() => p && void decide(selected, p, 'approve')}>Record approval</button></>; })()}</div></section></div>}
    </section>
    {correction && <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setCorrection(null); }}>
      <form className="dialog" onSubmit={saveCorrection} role="dialog" aria-modal="true" aria-labelledby="correction-title">
        <button type="button" className="icon-button dialog-close" onClick={() => setCorrection(null)} aria-label="Close correction">×</button>
        <p className="eyebrow">SOURCE-BACKED FINANCE DECISION</p>
        <h2 id="correction-title">{correction.kind === 'item' ? (selectedSaleLine?.item_name?.trim() ? `Approve cost for ${selectedSaleLine.item_name.trim()}` : 'Approve item cost') : (refundEvidence?.amount_minor != null ? `Review refund of ${money(Number(refundEvidence.amount_minor), refundEvidence.currency ?? refundCurrency)}` : 'Review refund and returned items')}</h2>
        <p className="muted">This decision is audited and triggers a replay of the issue’s historical period. {passThroughLine ? 'For an unidentified sale line with no catalog variation, merchant policy uses Square’s supported unit price as pass-through COGS.' : correction.kind === 'item' ? 'Use supplier acquisition records to establish the unit cost.' : 'Use merchant return records to establish the refund disposition and any supported COGS reversal.'}</p>
        {evidenceLoading ? <p className="muted">Loading Square evidence…</p> : correction.kind === 'item' ? <>
          {evidence.filter(row => row.type === 'sale_line').length > 1 && <label>Sale item<select value={selectedSaleLineId} onChange={event => { const row = evidence.find(item => item.type === 'sale_line' && item.id === event.target.value); if (row) { setSelectedSaleLineId(row.id); setCatalogId(row.catalog_object_id ?? ''); setItemName(row.item_name ?? ''); setItemCurrency(row.currency ?? currency); setEffectiveDate((row.occurred_at ?? '').slice(0, 10)); setUnitCost(''); setReason(''); } }}>{evidence.filter(row => row.type === 'sale_line').map(row => <option key={row.id} value={row.id}>{row.item_name?.trim() || 'Unidentified item'} · {row.occurred_at ? new Date(row.occurred_at).toLocaleDateString() : 'Date unavailable'} · {row.quantity ?? '—'} units · {row.amount_minor == null ? 'Amount unavailable' : money(Number(row.amount_minor), row.currency ?? currency)}</option>)}</select></label>}
          {selectedSaleLine ? <section className="decision-context" aria-label="Sale item being reviewed">
            <div className="decision-context-heading"><span>ITEM ON THIS SALE</span><strong>{selectedSaleLine.item_name?.trim() || 'Item name unavailable in Square'}</strong></div>
            <dl className="decision-context-grid"><div><dt>Sold</dt><dd>{selectedSaleLine.occurred_at ? new Date(selectedSaleLine.occurred_at).toLocaleDateString() : 'Date unavailable'}</dd></div><div><dt>Quantity</dt><dd>{selectedSaleLine.quantity ?? 'Unavailable'}</dd></div><div><dt>Gross sale</dt><dd>{selectedSaleLine.amount_minor == null ? 'Not provided' : money(Number(selectedSaleLine.amount_minor), selectedSaleLine.currency ?? itemCurrency)}</dd></div></dl>
          </section> : <section className="decision-context decision-context-warning" role="status">
            <div className="decision-context-heading"><span>SOURCE DETAILS UNAVAILABLE</span><strong>Sale item not identified</strong></div>
            <p>No matching Square sale line was found for this cost issue. The approval stays disabled until the item and transaction can be identified.</p>
          </section>}
          {!catalogId && selectedSaleLine && <p className="notice compact-notice">Square did not link this line to a catalog variation. {saleCostNotice}</p>}
          <div className="form-grid"><label>Approved {passThroughLine ? 'pass-through unit cost' : catalogId ? 'unit cost per item' : 'acquisition cost per unit'} ({itemCurrency})<input required type="number" min="0" step="0.01" value={unitCost} onChange={event => { setUnitCost(event.target.value); if (passThroughLine && passThroughPriceMinor !== null && parseMinor(event.target.value, itemCurrency) !== passThroughPriceMinor) setReason(''); }} /></label>{catalogId && <label>Cost effective from<input required type="date" value={effectiveDate} onChange={event => setEffectiveDate(event.target.value)} /></label>}<label>Cost currency (must match sale currency)<input readOnly value={itemCurrency} /></label></div>
        </> : <>
          {refundEvidence ? <section className="decision-context" aria-label="Refund and original order details">
            <div className="decision-context-heading"><span>REFUND AMOUNT</span><strong>{refundEvidence.amount_minor == null ? 'Amount unavailable' : money(Number(refundEvidence.amount_minor), refundEvidence.currency ?? refundCurrency)} refunded</strong></div>
            <dl className="decision-context-grid"><div><dt>Refund date</dt><dd>{refundEvidence.occurred_at ? new Date(refundEvidence.occurred_at).toLocaleDateString() : 'Date unavailable'}</dd></div><div><dt>Status</dt><dd>{refundEvidence.status?.replaceAll('_', ' ').toLowerCase() ?? 'Recorded by Square'}</dd></div></dl>
            <div className="decision-context-subheading">Items on the original order</div>
            <p>Square links these items to the order; the refund itself does not identify returned lines. Use the merchant’s return record to confirm which goods came back into inventory.</p>
            {refundItems.length ? <ul className="decision-context-lines">{refundItems.map(line => <li key={line.id}><strong>{line.item_name?.trim() || 'Item name unavailable'}</strong><span>{line.occurred_at ? new Date(line.occurred_at).toLocaleDateString() : 'Date unavailable'} · quantity {line.quantity ?? 'unavailable'} · original gross sale {line.amount_minor == null ? 'not provided' : money(Number(line.amount_minor), line.currency ?? refundCurrency)}</span></li>)}</ul> : <p>No item lines were returned for the original order.</p>}
          </section> : <section className="decision-context decision-context-warning" role="status">
            <div className="decision-context-heading"><span>REFUND SOURCE UNAVAILABLE</span><strong>Refund details not found</strong></div>
            <p>The saved Square refund record could not be matched. The approval stays disabled until its amount and date can be confirmed.</p>
          </section>}
          <div className="form-grid"><label>Returned disposition<select required value={disposition} onChange={event => { const value = event.target.value as typeof disposition; setDisposition(value); if (value === 'not_returned_to_inventory') setReversal('0.00'); }}><option value="">Select the merchant’s return outcome</option><option value="not_returned_to_inventory">Goods were not returned to inventory</option><option value="returned_to_inventory">Goods were returned and restocked</option></select></label><label>Approved COGS reversal ({refundCurrency})<input required type="number" min="0" step="0.01" disabled={disposition !== 'returned_to_inventory'} value={reversal} onChange={event => setReversal(event.target.value)} /></label><label>Cost currency<input required maxLength={3} value={refundCurrency} onChange={event => setRefundCurrency(event.target.value.toUpperCase())} /></label></div>
        </>}
        {!evidenceLoading && !correctionReady && <section className="decision-context decision-context-warning" role="status"><div className="decision-context-heading"><span>DECISION SAVING UNAVAILABLE</span><strong>A required system update is pending</strong></div><p>The Square evidence is shown for review, but this decision cannot be recorded until the finance review update is available.</p></section>}
        <label>Decision reason<textarea required minLength={10} rows={3} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} placeholder={passThroughLine ? 'Explain the pass-through assumption and unit price basis…' : correction.kind === 'item' ? 'Cite the supplier invoice/receipt and how it establishes the per-unit cost…' : 'Cite the merchant return record and the basis for this decision…'} /></label>
        {error && correction && <p className="error" role="alert">{error}</p>}
        <div className="form-actions"><button type="button" className="secondary" onClick={() => setCorrection(null)}>Cancel</button><button className="primary" disabled={busyId === correction.issue.id || evidenceLoading || !correctionReady || (correction.kind === 'item' && (!selectedSaleLine || (catalogId ? !itemName.trim() : (!selectedSaleLine.provider_object_id || !selectedSaleLine.line_id)))) || (correction.kind === 'refund' && (!refundEvidence || !refundId || !orderId || !disposition))}>{busyId === correction.issue.id ? 'Saving…' : 'Save and recalculate'}</button></div>
      </form>
    </div>}
  </>;
}
function Ledger({ events }: { events: AuditEvent[] }) {
  function exportCsv() {
    const columns = ['id', 'created_at', 'action', 'actor_kind', 'actor_user_id', 'entity_type', 'entity_id', 'source_refs', 'revision', 'details'];
    const quote = (value: unknown) => { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
    const rows = [columns.join(','), ...events.map(event => columns.map(key => quote(['details', 'source_refs'].includes(key) ? JSON.stringify((event as unknown as Record<string, unknown>)[key] ?? (key === 'details' ? {} : [])) : (event as unknown as Record<string, unknown>)[key])).join(','))];
    const blob = new Blob([`\uFEFF${rows.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'zythe-audit.csv'; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="panel table-panel"><div className="panel-heading"><div><h2>Audit history</h2><p>Read-only events returned for this workspace and period</p></div><button className="secondary" disabled={!events.length} onClick={exportCsv}>Export CSV</button></div>{events.length ? <div className="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Details</th><th>Reference</th></tr></thead><tbody>{events.map(e => <tr key={e.id}><td>{date(e.created_at)}</td><td>{e.action ?? e.event_type ?? 'Workspace event'}<small className="cell-sub">{e.entity_type ?? ''}</small></td><td>{e.actor_user_id ?? e.actor_id ?? e.actor_kind ?? 'System'}</td><td>{e.reason ?? JSON.stringify(e.details ?? e.payload ?? {})}</td><td>{e.entity_id ?? e.id}</td></tr>)}</tbody></table></div> : <div className="inline-empty">No audit events were returned for this period.</div>}</section>;
}
function Settings({ dashboard: d, accountId, onAccount }: { dashboard: Dashboard; accountId: string; onAccount: (v: string) => void }) { return <div className="settings-grid"><section className="panel settings-card"><div className="panel-heading"><div><h2>Workspace</h2><p>Organization scope for authenticated data</p></div></div><div className="setting-row"><span>Organization</span><b>{d.organization?.name ?? 'Not provided'}</b></div><div className="setting-row"><span>Reporting timezone</span><b>{d.organization?.timezone ?? 'Not configured'}</b></div><div className="setting-row"><span>Projection version</span><b>{d.projectionVersion ?? 'Not reported'}</b></div><div className="setting-row"><span>Reporting currency</span><b>{d.period?.currency ?? d.income?.currency ?? 'Not specified'}</b></div></section><section className="panel settings-card"><div className="panel-heading"><div><h2>Accounts</h2><p>Choose the cash account shown in reconciliation</p></div></div>{d.accounts?.length ? <label>Selected account<select value={accountId} onChange={e => onAccount(e.target.value)}>{d.accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.kind ?? 'account'} · {a.currency}</option>)}</select></label> : <div className="inline-empty">No accounts were included in the dashboard response.</div>}<div className="notice compact-notice">Opening balances, tolerance, mapping policy and approval roles are maintained by authorized workspace administrators.</div></section></div>; }
