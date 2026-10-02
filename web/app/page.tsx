'use client';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { browserSupabase } from '@/lib/browser-supabase';
import { api, type AuditEvent, type Dashboard, type Issue, type Movement } from '@/lib/api';

type Page = 'overview' | 'income' | 'cash' | 'review' | 'ledger' | 'settings';
type Organization = { id: string; name: string; base_currency?: string; timezone?: string };
const NAV: Array<{ id: Page; label: string; icon: string }> = [
  { id: 'overview', label: 'Overview', icon: '▦' }, { id: 'income', label: 'Income & inventory', icon: '▥' },
  { id: 'cash', label: 'Cash flow', icon: '⇄' }, { id: 'review', label: 'Review queue', icon: '◇' },
  { id: 'ledger', label: 'Activity ledger', icon: '☷' }, { id: 'settings', label: 'Settings', icon: '⚙' },
];
const money = (minor?: number | null, currency = 'USD') => {
  if (minor == null) return '—';
  const fractionDigits = new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / (10 ** (fractionDigits ?? 2)));
};
const date = (value?: string | null) => value ? new Date(value).toLocaleString() : '—';
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
const nextDate = (dateText: string) => new Date(Date.parse(`${dateText}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState(() => new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const supabase = useMemo(() => { try { return browserSupabase(); } catch { return null; } }, []);
  const reportTimezone = dashboard?.organization?.timezone ?? 'UTC';

  useEffect(() => {
    if (!supabase) { setError('Supabase is not configured. Add the project URL and publishable key to the web environment.'); setLoadingAuth(false); return; }
    supabase.auth.getUser().then(({ data }) => { setUser(data.user); setLoadingAuth(false); }).catch(() => { setError('Could not validate your sign-in session. Try again.'); setLoadingAuth(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
    return () => listener.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    if (!user || !supabase) { setOrganizations([]); setOrganizationId(''); return; }
    let active = true;
    void (async () => {
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      if (!currentUser?.id) return;
      const { data: memberships, error: membershipError } = await supabase.from('memberships').select('organization_id').eq('user_id', currentUser.id);
      if (!active) return;
      if (membershipError) { setError('Could not load your workspace memberships.'); return; }
      const ids = [...new Set((memberships ?? []).map(row => row.organization_id as string))];
      if (!ids.length) { setOrganizations([]); setOrganizationId(''); return; }
      const { data: orgRows, error: organizationError } = await supabase.from('organizations').select('id,name').in('id', ids);
      if (!active) return;
      if (organizationError) { setError('Could not load your organization details.'); return; }
      const options = (orgRows ?? []) as Organization[];
      setOrganizations(options);
      setOrganizationId(current => options.some(org => org.id === current) ? current : options[0]?.id ?? '');
    })();
    return () => { active = false; };
  }, [user, supabase]);

  async function load() {
    if (!user || !organizationId) return;
    setBusy(true); setError('');
    const query = new URLSearchParams({ organizationId, from: zonedMidnight(from, reportTimezone), to: zonedMidnight(nextDate(to), reportTimezone), ...(accountId ? { accountId } : {}) });
    const orgQuery = new URLSearchParams({ organizationId });
    const tasks: Promise<unknown>[] = [api<Record<string, unknown>>(`/api/dashboard?${query}`), api<{ issues: Issue[] }>(`/api/issues?${orgQuery}&state=open`), api<{ movements: Movement[] }>(`/api/manual-movements?${query}`), api<{ events: AuditEvent[] }>(`/api/audit?${orgQuery}&limit=200`), api<{ settings: { organization?: Organization; accounts?: Dashboard['accounts'] } }>(`/api/settings?${orgQuery}`)];
    const results = await Promise.allSettled(tasks);
    if (results[0].status === 'fulfilled' && results[4].status === 'fulfilled') {
      const raw = results[0].value as Record<string, unknown>; const settings = (results[4].value as { settings: { organization?: Organization; accounts?: Dashboard['accounts'] } }).settings;
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
  async function signOut() { await supabase?.auth.signOut(); setDashboard(null); setIssues([]); setMovements([]); setEvents([]); }
  const currency = dashboard?.period?.currency ?? dashboard?.income?.currency ?? 'USD';
  const openIssues = issues.filter(i => !['resolved', 'approved', 'rejected'].includes(i.state));

  if (loadingAuth) return <main className="auth-screen"><div className="auth-card">Loading secure workspace…</div></main>;
  if (!user) return <main className="auth-screen"><form className="auth-card" onSubmit={signIn}>
    <div className="brand-lockup"><span className="brand-icon">↗</span><span><b>finance loop</b><small>OPERATIONS ACCOUNTING</small></span></div>
    <p className="eyebrow">SECURE WORKSPACE</p><h1>Sign in</h1><p className="muted">Use your organization account to access financial records.</p>
    <label>Email address<input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
    <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
    {error && <p className="error" role="alert">{error}</p>}<button className="primary full" disabled={busy || !supabase}>{busy ? 'Signing in…' : 'Sign in securely'}</button>
    <p className="tiny muted">Access is provided by your workspace administrator.</p>
  </form></main>;

  const title = NAV.find(x => x.id === page)?.label ?? 'Overview';
  return <div className="shell">
    <aside className="sidebar"><div className="brand-lockup"><span className="brand-icon">↗</span><span><b>finance loop</b><small>WORKSPACE</small></span></div>
      <div className="workspace"><span className="workspace-mark">{dashboard?.organization?.name?.slice(0, 1) ?? 'O'}</span><span><b>{dashboard?.organization?.name ?? 'Your workspace'}</b><small>Authenticated account</small></span></div>
      <div className="nav-caption">WORKSPACE</div><nav aria-label="Main navigation">{NAV.map(item => <button key={item.id} className={`nav-link ${page === item.id ? 'selected' : ''}`} onClick={() => setPage(item.id)} aria-current={page === item.id ? 'page' : undefined}><span aria-hidden="true">{item.icon}</span>{item.label}{item.id === 'review' && openIssues.length > 0 && <i>{openIssues.length}</i>}</button>)}</nav>
      <div className="sidebar-foot"><div className="secure-note"><span className="status-dot" /> <b>Authenticated session</b><small>Workspace data is access controlled.</small></div><div className="profile"><span className="avatar">{user.email?.slice(0, 1).toUpperCase() ?? 'U'}</span><span className="profile-info"><b>{user.email}</b><small>Signed in</small></span><button className="icon-button" onClick={signOut} title="Sign out" aria-label="Sign out">↪</button></div></div>
    </aside>
    <section className="main-area"><header className="topbar"><div className="crumb">{dashboard?.organization?.name ?? 'Workspace'} <span>/</span> <strong>{title}</strong></div><div className="top-controls">{organizations.length > 1 && <label className="compact">Organization<select value={organizationId} onChange={e => { setOrganizationId(e.target.value); setDashboard(null); }}><option value="">Choose workspace</option>{organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}</select></label>}<label className="compact">Period from<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label className="compact">through<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label><span className="timezone-note">{reportTimezone}</span><button className="icon-button refresh" onClick={() => void load()} disabled={busy} aria-label="Refresh workspace data">{busy ? '…' : '↻'}</button></div></header>
      <main className="page"><div className="page-head"><div><p className="eyebrow">FINANCIAL OPERATIONS</p><h1>{title}</h1><p className="muted">{page === 'overview' ? 'A clear view of sales, margin, cash and items that need review.' : subhead(page)}</p></div></div>
        {error && <div className="notice error-box" role="alert"><b>Data request needs attention</b><span>{error}</span></div>}
        {!organizationId ? <section className="empty-state"><div className="empty-icon">⌁</div><h2>{organizations.length ? 'Choose a workspace' : 'No workspace membership found'}</h2><p>Ask a workspace owner to add your account, then sign in again.</p></section> : !dashboard ? <section className="empty-state"><div className="empty-icon">⌁</div><h2>{busy ? 'Loading workspace data' : 'No projection available yet'}</h2><p>Once your workspace has accounts and a completed projection, verified figures will appear here.</p><button className="secondary" onClick={() => void load()}>Retry</button></section> : <>
          {page === 'overview' && <Overview dashboard={dashboard} currency={currency} issues={openIssues} onNavigate={setPage} />}
          {page === 'income' && <Income dashboard={dashboard} currency={currency} />}
          {page === 'income' && <GiftCardSummary income={dashboard.income} currency={currency} />}
          {page === 'cash' && <Cash dashboard={dashboard} currency={currency} movements={movements} accounts={dashboard.accounts ?? []} accountId={accountId} organizationId={organizationId} onAccount={setAccountId} onSaved={() => void load()} />}
          {page === 'review' && <Review issues={openIssues} organizationId={organizationId} onSaved={() => void load()} />}
          {page === 'ledger' && <Ledger events={events} />}
          {page === 'settings' && <Settings dashboard={dashboard} accountId={accountId} onAccount={setAccountId} />}
          <footer className="projection-foot">Calculation {dashboard.projectionVersion ?? 'version pending'} · {dashboard.period?.from ?? from} to {dashboard.period?.to ?? to} · {currency} · {dashboard.income?.status === 'incomplete' ? 'Margin incomplete' : 'Operational reporting'}</footer>
        </>}
      </main>
    </section>
  </div>;
}

function subhead(page: Page) { return ({ income: 'Completed sales, approved unit costs, fees and margin status.', cash: 'Account movements and balance reconciliation for the selected period.', review: 'Human decisions for unresolved source and reconciliation exceptions.', ledger: 'Read-only history of recorded decisions and financial activity.', settings: 'Accounts, reporting scope and workspace configuration.' } as Record<string, string>)[page] ?? ''; }
function Card({ label, value, hint, tone = '' }: { label: string; value: string; hint: string; tone?: string }) { return <article className="metric"><span>{label}</span><strong className={tone}>{value}</strong><small>{hint}</small></article>; }
function GiftCardSummary({ income, currency }: { income: Dashboard['income']; currency: string }) {
  if (!income || income.giftCardLiabilityChangeMinor === undefined) return null;
  return <section className="panel"><div className="panel-heading"><div><h2>Gift cards</h2><p>Issuance changes the gift-card liability; redemption recognizes the purchased item sale and its item cost.</p></div></div>
    <div className="status-row"><span>Activations and loads</span><b>{money((income.giftCardActivationsMinor ?? 0) + (income.giftCardLoadsMinor ?? 0), currency)}</b></div>
    <div className="status-row"><span>Redemptions</span><b>{money(income.giftCardRedemptionsMinor, currency)}</b></div>
    <div className="status-row"><span>Liability change this period</span><b>{money(income.giftCardLiabilityChangeMinor, currency)}</b></div>
  </section>;
}
function Overview({ dashboard: d, currency: c, issues, onNavigate }: { dashboard: Dashboard; currency: string; issues: Issue[]; onNavigate: (p: Page) => void }) {
  return <><section className="metric-grid"><Card label="Net sales" value={money(d.income?.netSalesMinor, c)} hint="After discounts and refunds" /><Card label="Operational margin" value={money(d.income?.operationalMarginMinor, c)} hint={d.income?.status === 'incomplete' ? 'Incomplete: item cost evidence required' : 'After COGS and processing fees'} tone={d.income?.status === 'incomplete' ? 'warn-text' : ''} /><Card label="Expected account balance" value={money(d.cash?.expectedBalanceMinor, d.cash?.currency ?? c)} hint={d.cash?.status ?? 'Reconciliation unavailable'} /><Card label="Open reviews" value={String(issues.length)} hint={issues.length ? 'Human decision required' : 'No unresolved issues'} /></section>
    <div className="two-col"><section className="panel"><div className="panel-heading"><div><h2>Reporting status</h2><p>Source and calculation state for this period</p></div><span className={`pill ${d.freshness?.status === 'fresh' ? 'good' : 'neutral'}`}>{d.freshness?.status ?? 'Not reported'}</span></div><div className="status-row"><span>Last successful sync</span><b>{date(d.freshness?.lastSyncedAt)}</b></div><div className="status-row"><span>Calculation version</span><b>{d.projectionVersion ?? 'Unavailable'}</b></div><div className="status-row"><span>Observed balance</span><b>{money(d.cash?.observedBalanceMinor, d.cash?.currency ?? c)}</b></div></section><section className="panel"><div className="panel-heading"><div><h2>Needs attention</h2><p>Exceptions from the current projection</p></div><button className="text-button" onClick={() => onNavigate('review')}>Open queue →</button></div>{(d.flags ?? []).length ? <ul className="flag-list">{d.flags!.slice(0, 4).map((f, i) => <li key={`${f.code}-${i}`}><span className="flag-dot" />{f.message}<small>{f.code}</small></li>)}</ul> : <div className="inline-empty">No projection exceptions were reported.</div>}</section></div>
    <section className="panel table-panel"><div className="panel-heading"><div><h2>Income snapshot</h2><p>Operational cash basis · source figures for selected period</p></div><button className="text-button" onClick={() => onNavigate('income')}>View income →</button></div><div className="table-wrap"><table><thead><tr><th>Measure</th><th>Amount</th><th>Calculation note</th></tr></thead><tbody><tr><td>Gross item sales</td><td>{money(d.income?.grossItemSalesMinor, c)}</td><td>Completed line items</td></tr><tr><td>Discounts and refunds</td><td>{money((d.income?.discountsMinor ?? 0) + (d.income?.refundsMinor ?? 0), c)}</td><td>Reduce recognized sales</td></tr><tr><td>Square fees</td><td>{money(d.income?.squareFeesMinor, c)}</td><td>Actual processing fees</td></tr><tr><td>Cost of goods sold</td><td>{money(d.income?.cogsMinor, c)}</td><td>Approved effective item costs</td></tr></tbody></table></div></section></>;
}
function Income({ dashboard: d, currency: c }: { dashboard: Dashboard; currency: string }) {
  return <><div className="metric-grid three"><Card label="Gross item sales" value={money(d.income?.grossItemSalesMinor, c)} hint="Before discounts" /><Card label="Net sales" value={money(d.income?.netSalesMinor, c)} hint="After discounts and refunds" /><Card label="Square fees" value={money(d.income?.squareFeesMinor, c)} hint="Completed processing fees" /></div><section className="panel table-panel"><div className="panel-heading"><div><h2>Sales and inventory</h2><p>Line item details from the selected calculation run</p></div><span className={`pill ${d.income?.status === 'complete' ? 'good' : 'warn'}`}>{d.income?.status ?? 'Not calculated'}</span></div>{d.income?.lines?.length ? <div className="table-wrap"><table><thead><tr><th>Item</th><th>Units</th><th>Sales</th><th>Unit cost</th><th>COGS</th><th>Margin</th></tr></thead><tbody>{d.income.lines.map((line, i) => <tr key={String(line.id ?? i)}><td>{String(line.itemName ?? line.name ?? 'Unidentified item')}<small className="cell-sub">{String(line.catalogId ?? line.sourceId ?? '')}</small></td><td>{String(line.quantity ?? '—')}</td><td>{money(Number(line.netSalesMinor), c)}</td><td>{line.unitCostMinor == null ? <span className="pill warn">Needs cost</span> : money(Number(line.unitCostMinor), c)}</td><td>{money(line.cogsMinor == null ? null : Number(line.cogsMinor), c)}</td><td>{money(line.marginMinor == null ? null : Number(line.marginMinor), c)}</td></tr>)}</tbody></table></div> : <div className="inline-empty">No line details were included in this projection response.</div>}</section><div className="notice"><b>Policy treatment</b><span>Tax, tips, discounts and refunds follow the calculation policy attached to the projection. Missing approved item cost keeps margin incomplete.</span></div></>;
}
function Cash({ dashboard: d, currency: c, movements, accounts, accountId, organizationId, onAccount, onSaved }: { dashboard: Dashboard; currency: string; movements: Movement[]; accounts: NonNullable<Dashboard['accounts']>; accountId: string; organizationId: string; onAccount: (v: string) => void; onSaved: () => void }) {
  const [mode, setMode] = useState<'movement' | 'observation' | null>(null); const [kind, setKind] = useState('purchase'); const [amount, setAmount] = useState(''); const [description, setDescription] = useState(''); const [evidenceFile, setEvidenceFile] = useState<File | null>(null); const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16)); const [saving, setSaving] = useState(false); const [formError, setFormError] = useState('');
  async function save(e: FormEvent) { e.preventDefault(); const acct = accounts.find(x => x.id === accountId); if (!acct || !amount || !evidenceFile) return; const minor = Math.round(Number(amount) * 100); if (!Number.isSafeInteger(minor) || minor <= 0) { setFormError('Enter a positive amount with at most two decimal places.'); return; } setSaving(true); setFormError('');
    const key = crypto.randomUUID(); const isObservation = mode === 'observation';
    try { const upload = new FormData(); upload.set('organizationId', organizationId); upload.set('file', evidenceFile); const stored = await api<{ evidence: { id: string } }>('/api/evidence', { method: 'POST', body: upload }); const evidenceRef = stored.evidence.id; await api(isObservation ? '/api/observations' : '/api/manual-movements', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(isObservation ? { organizationId, accountId, amountMinor: minor, currency: acct.currency, observedAt: new Date(occurredAt).toISOString(), evidenceRef } : { organizationId, accountId, kind, amountMinor: ['purchase','pay','misc_spend'].includes(kind) ? -minor : minor, currency: acct.currency, occurredAt: new Date(occurredAt).toISOString(), description: description.trim(), evidenceRef }) }); setMode(null); setAmount(''); setEvidenceFile(null); setDescription(''); onSaved(); }
    catch (err) { setFormError(err instanceof Error ? err.message : 'Could not save this record.'); } finally { setSaving(false); }
  }
  return <><section className="panel filter-panel"><label>Reconciliation account<select value={accountId} onChange={e => onAccount(e.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</select></label><span className={`pill ${d.cash?.status === 'matched' ? 'good' : d.cash?.status === 'mismatch' ? 'warn' : 'neutral'}`}>{d.cash?.status ?? 'Not reconciled'}</span><div className="form-actions"><button className="secondary" onClick={() => { setMode('observation'); setFormError(''); }}>Record balance</button><button className="primary" onClick={() => { setMode('movement'); setFormError(''); }}>＋ Record movement</button></div></section>
    {mode && <form className="panel entry-form" onSubmit={save}><div className="panel-heading"><div><h2>{mode === 'observation' ? 'Record observed balance' : 'Record cash movement'}</h2><p>Saved through the authenticated workspace API with an idempotency key.</p></div><button type="button" className="icon-button" onClick={() => setMode(null)} aria-label="Close form">×</button></div>
      {mode === 'movement' && <label>Movement type<select value={kind} onChange={e => setKind(e.target.value)}><option value="cash_deposit">Cash deposit</option><option value="other_inflow">Other cash inflow</option><option value="purchase">Purchase</option><option value="pay">Pay</option><option value="misc_spend">Miscellaneous spend</option></select></label>}
      <div className="form-grid"><label>Amount ({accounts.find(x => x.id === accountId)?.currency ?? c})<input inputMode="decimal" type="number" min="0.01" step="0.01" required value={amount} onChange={e => setAmount(e.target.value)} /></label><label>{mode === 'observation' ? 'Observed at' : 'Occurred at'}<input type="datetime-local" required value={occurredAt} onChange={e => setOccurredAt(e.target.value)} /></label>{mode === 'movement' && <label className="wide">Description<input maxLength={500} required value={description} onChange={e => setDescription(e.target.value)} /></label>}<label className="wide">Supporting evidence<input type="file" accept="application/pdf,image/jpeg,image/png" required onChange={e => setEvidenceFile(e.target.files?.[0] ?? null)} /><small className="field-hint">Private PDF, JPEG, or PNG; maximum 10 MB.</small></label></div>
      {formError && <p className="error" role="alert">{formError}</p>}<div className="form-actions"><button type="button" className="secondary" onClick={() => setMode(null)}>Cancel</button><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save record'}</button></div>
    </form>}
    <section className="metric-grid three"><Card label="Expected balance" value={money(d.cash?.expectedBalanceMinor, d.cash?.currency ?? c)} hint="Opening balance + posted movements" /><Card label="Observed balance" value={money(d.cash?.observedBalanceMinor, d.cash?.currency ?? c)} hint="Most recent human observation" /><Card label="Difference" value={money(d.cash?.discrepancyMinor, d.cash?.currency ?? c)} hint="Observed minus expected" tone={d.cash?.discrepancyMinor ? 'warn-text' : ''} /></section><section className="panel table-panel"><div className="panel-heading"><div><h2>Account movements</h2><p>Cash activity for the selected account and period</p></div></div>{movements.length ? <div className="table-wrap"><table><thead><tr><th>Date</th><th>Activity</th><th>Category</th><th>Evidence</th><th>Amount</th></tr></thead><tbody>{movements.filter(m => !accountId || m.account_id === accountId).map(m => <tr key={m.id}><td>{date(m.occurred_at)}</td><td>{m.description}</td><td>{m.kind.replaceAll('_', ' ')}</td><td><EvidenceLink organizationId={organizationId} evidenceId={m.evidence_ref ?? ''} /></td><td className={m.amount_minor < 0 ? 'negative' : 'positive'}>{money(m.amount_minor, m.currency)}</td></tr>)}</tbody></table></div> : <div className="inline-empty">No confirmed account movements were returned for this period.</div>}</section><p className="tiny muted">COGS is an analytical margin measure and is not deducted again from the account balance. Transfers require linked account legs.</p></>;
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
function Review({ issues, organizationId, onSaved }: { issues: Issue[]; organizationId: string; onSaved: () => void }) {
  const [selected, setSelected] = useState<Issue | null>(null); const [reason, setReason] = useState(''); const [busyId, setBusyId] = useState(''); const [error, setError] = useState('');
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
  function getProposal(issue: Issue): Record<string, unknown> | undefined {
    const pending = issue.proposals?.find(p => p.decision === 'pending');
    return (pending as Record<string, unknown> | undefined) ?? (issue.details?.proposal as Record<string, unknown> | undefined);
  }
  return <section className="panel table-panel"><div className="panel-heading"><div><h2>Human review queue</h2><p>Proposals remain pending until an authorized reviewer decides.</p></div><span className="pill neutral">{issues.length} open</span></div>{error && <p className="error" role="alert">{error}</p>}{issues.length ? <div className="review-list">{issues.map(i => { const proposal = getProposal(i); return <article className="review-item" key={i.id}><div className="review-symbol">◇</div><div className="review-copy"><div className="review-title">{i.title ?? i.code ?? 'Needs review'} <span className="pill warn">{i.state.replaceAll('_', ' ')}</span></div><p>{String(i.details?.message ?? i.details?.description ?? 'Review the linked source evidence and decide how this item should be handled.')}</p><small>Reference {i.id} · {i.code ?? 'Unclassified'} · Evidence: {(i.source_refs ?? []).join(', ') || 'none linked'}</small>{proposal && <details className="proposal-details"><summary>Proposed classification and evidence</summary><pre>{JSON.stringify(proposal.proposal ?? proposal.payload ?? proposal, null, 2)}</pre></details>}</div>{proposal ? <button className="secondary" disabled={busyId === i.id} onClick={() => { setSelected(i); setReason(''); setError(''); }}>{busyId === i.id ? 'Saving…' : 'Review'}</button> : i.proposal_supported ? <button className="secondary" disabled={busyId === i.id} onClick={() => void draft(i)}>{busyId === i.id ? 'Preparing…' : 'Prepare proposal'}</button> : <span className="tiny muted">Manual review required</span>}</article>; })}</div> : <div className="inline-empty">The API reported no open issues.</div>}
    {selected && <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSelected(null); }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="review-dialog-title"><button className="icon-button dialog-close" onClick={() => setSelected(null)} aria-label="Close review">×</button><p className="eyebrow">REVIEW DECISION</p><h2 id="review-dialog-title">{selected.title ?? selected.code ?? 'Review proposal'}</h2><p className="muted">Record whether you accept or reject this proposal and why. An approval records the review decision; it does not post a correction or recalculate financial results yet.</p><label>Decision reason<textarea required rows={4} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></label><div className="form-actions"><button className="secondary" onClick={() => setSelected(null)}>Cancel</button>{(() => { const p = getProposal(selected); return <><button className="secondary reject-button" disabled={!p || !reason.trim() || busyId === selected.id} onClick={() => p && void decide(selected, p, 'reject')}>Reject</button><button className="primary" disabled={!p || !reason.trim() || busyId === selected.id} onClick={() => p && void decide(selected, p, 'approve')}>Record approval</button></>; })()}</div></section></div>}
  </section>;
}
function Ledger({ events }: { events: AuditEvent[] }) {
  function exportCsv() {
    const columns = ['id', 'created_at', 'action', 'actor_kind', 'actor_user_id', 'entity_type', 'entity_id', 'source_refs', 'revision', 'details'];
    const quote = (value: unknown) => { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
    const rows = [columns.join(','), ...events.map(event => columns.map(key => quote(['details', 'source_refs'].includes(key) ? JSON.stringify((event as unknown as Record<string, unknown>)[key] ?? (key === 'details' ? {} : [])) : (event as unknown as Record<string, unknown>)[key])).join(','))];
    const blob = new Blob([`\uFEFF${rows.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'finance-loop-audit.csv'; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="panel table-panel"><div className="panel-heading"><div><h2>Audit history</h2><p>Read-only events returned for this workspace and period</p></div><button className="secondary" disabled={!events.length} onClick={exportCsv}>Export CSV</button></div>{events.length ? <div className="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Details</th><th>Reference</th></tr></thead><tbody>{events.map(e => <tr key={e.id}><td>{date(e.created_at)}</td><td>{e.action ?? e.event_type ?? 'Workspace event'}<small className="cell-sub">{e.entity_type ?? ''}</small></td><td>{e.actor_user_id ?? e.actor_id ?? e.actor_kind ?? 'System'}</td><td>{e.reason ?? JSON.stringify(e.details ?? e.payload ?? {})}</td><td>{e.entity_id ?? e.id}</td></tr>)}</tbody></table></div> : <div className="inline-empty">No audit events were returned for this period.</div>}</section>;
}
function Settings({ dashboard: d, accountId, onAccount }: { dashboard: Dashboard; accountId: string; onAccount: (v: string) => void }) { return <div className="settings-grid"><section className="panel settings-card"><div className="panel-heading"><div><h2>Workspace</h2><p>Organization scope for authenticated data</p></div></div><div className="setting-row"><span>Organization</span><b>{d.organization?.name ?? 'Not provided'}</b></div><div className="setting-row"><span>Reporting timezone</span><b>{d.organization?.timezone ?? 'Not configured'}</b></div><div className="setting-row"><span>Projection version</span><b>{d.projectionVersion ?? 'Not reported'}</b></div><div className="setting-row"><span>Reporting currency</span><b>{d.period?.currency ?? d.income?.currency ?? 'Not specified'}</b></div></section><section className="panel settings-card"><div className="panel-heading"><div><h2>Accounts</h2><p>Choose the cash account shown in reconciliation</p></div></div>{d.accounts?.length ? <label>Selected account<select value={accountId} onChange={e => onAccount(e.target.value)}>{d.accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.kind ?? 'account'} · {a.currency}</option>)}</select></label> : <div className="inline-empty">No accounts were included in the dashboard response.</div>}<div className="notice compact-notice">Opening balances, tolerance, mapping policy and approval roles are maintained by authorized workspace administrators.</div></section></div>; }
