'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { calculatePackageUnitCostMinor } from '../../src/agent/receipt-units.mjs';
import UiIcon from './UiIcon';

type Account = { id: string; name: string; currency: string; kind?: string };
type InventoryItem = { id: string; name: string; currency: string; sku?: string | null; squareCatalogObjectId?: string | null; unitCostMinor?: number | null; itemKind?: string };
type CatalogTarget = { catalogObjectId: string; name: string; sku?: string | null; currency: string; archived?: boolean };
type InventoryChoice = { id: string; name: string; sku?: string | null; squareCatalogObjectId?: string | null; unitCostMinor?: number | null; archived: boolean };
type PurchaseLine = { lineId: string; lineNumber: number; description: string; quantityText?: string | null; packageQuantity?: number | null; unitsPerPackage?: number | null; lineAmountMinor?: number | null; unitPriceMinor?: number | null; suggestedUnitCostMinor?: number | null; sourceAmounts?: { lineAmount?: string | null; unitPrice?: string | null }; reviewFlags?: string[] };
type JevMatch = { itemId: string | null; itemName: string | null; confidence: number | null; reason?: 'empty_description' | 'no_inventory_options' | null };
type InventoryMatching = { status: 'completed' | 'budget_exceeded' | 'unavailable' | 'awaiting_currency_confirmation'; model?: string; errorCode?: string; matches: Array<JevMatch & { lineId: string }> };
type PurchaseDraft = { supplier?: string | null; invoiceDate?: string | null; purchaseReference?: string | null; currency: string | null; totals?: { subtotalMinor?: number | null; discountMinor?: number | null; taxMinor?: number | null; shippingMinor?: number | null; otherChargesMinor?: number | null; totalMinor?: number | null; totalAmount?: string | null; rawAmounts?: Record<string, string | null> }; payment?: { status?: string; paidAt?: string | null; fundingHint?: string | null }; lines: PurchaseLine[]; reconciliation?: { lineTotalMinor?: number | null; documentTotalMinor?: number | null; unexplainedMinor?: number | null; status?: string }; extraction?: { model?: string; promptVersion?: string }; inventoryMatching?: InventoryMatching };
type Receipt = { id: string; status: string; activeDraftVersion?: number; filename?: string; originalFilename?: string; supplier?: string | null; createdAt?: string; submittedAt?: string; evidenceFileId?: string; duplicateOfReceiptId?: string | null; lastErrorCode?: string | null };
type IntegrationCredential = { id: string; name: string; createdAt?: string; revokedAt?: string | null };
type ReceiptEffect = { id: string; source_line_id: string; effect_type: 'cost_update' | 'stock_receipt' | 'payment'; effect_payload: Record<string, unknown>; inventory_movement_id?: string | null; cash_movement_id?: string | null; created_at: string };
type ReceiptDetail = { receipt: Receipt; draft: PurchaseDraft | null; version?: number; candidates?: Array<{ catalogObjectId: string; name: string; sku?: string | null; currency: string; archived?: boolean }>; inventoryItems?: InventoryItem[]; effects?: ReceiptEffect[]; evidenceUrl?: string };
type LineChoice = { itemId: string; costCatalogObjectId: string; effectiveFrom: string; packageQuantity: string; unitsPerPackage: string; unitCost: string; costEdited: boolean; receive: boolean; receivedQuantity: string; receivedAt: string; updateCost: boolean };
const digitsFor = (currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
const formatMoney = (minor: number | null | undefined, currency: string) => minor == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / (10 ** digitsFor(currency)));
const minorText = (minor: number, currency: string) => (minor / (10 ** digitsFor(currency))).toFixed(digitsFor(currency));
const parseMinor = (value: string, currency: string) => {
  const digits = digitsFor(currency);
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > digits) return null;
  const result = Number(whole) * (10 ** digits) + Number((fraction + '0'.repeat(digits)).slice(0, digits) || 0);
  return Number.isSafeInteger(result) ? result : null;
};
const parseSourceMinor = (value: string | null | undefined, currency: string) => {
  if (typeof value !== 'string') return null;
  const amounts = value.replaceAll(',', '').match(/\d+(?:\.\d+)?/g);
  return amounts?.length === 1 ? parseMinor(amounts[0], currency) : null;
};
const amountMinor = (minor: number | null | undefined, source: string | null | undefined, currency: string) => minor ?? parseSourceMinor(source, currency);
const localDateTime = () => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const newKey = () => crypto.randomUUID();
const isReceiptProcessing = (status: string) => ['awaiting_upload', 'queued', 'processing', 'projection_pending'].includes(status);
function receiptStatusLabel(status: string) {
  const labels: Record<string, string> = { awaiting_upload: 'Processing', queued: 'Processing', processing: 'Processing', needs_review: 'Needs review', projection_pending: 'Posting', approved: 'Approved', posted: 'Posted', duplicate: 'Duplicate', failed: 'Failed', rejected: 'Rejected' };
  return labels[status] ?? status.replaceAll('_', ' ');
}
function receiptStatusTone(status: string) {
  if (['posted', 'approved'].includes(status)) return 'good';
  if (['failed', 'rejected'].includes(status)) return 'bad';
  if (status === 'duplicate') return 'neutral';
  return 'warn';
}
function shortReceiptFilename(value: string) {
  const match = /^(\w{8}-\w{4}-\w{4}-\w{4}-\w{12})(\.[^.]+)?$/i.exec(value);
  return match ? `${match[1].slice(0, 8)}…${match[1].slice(-4)}${match[2] ?? ''}` : value;
}
function receiptPrimaryName(receipt: Pick<Receipt, 'supplier' | 'status' | 'originalFilename' | 'filename'>) {
  const filename = receipt.originalFilename || receipt.filename || '';
  const uuidFilename = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[^.]+)?$/i.test(filename);
  return receipt.supplier?.trim() || (uuidFilename ? isReceiptProcessing(receipt.status) ? 'Processing receipt' : 'Supplier receipt' : filename || 'Supplier receipt');
}

export default function PurchaseReceipts({ organizationId, role, accounts, currency, initialReceiptId, active, onSaved }: { organizationId: string; role: string; accounts: Account[]; currency: string; initialReceiptId?: string; active: boolean; onSaved: () => void }) {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [selected, setSelected] = useState<ReceiptDetail | null>(null);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [choices, setChoices] = useState<Record<string, LineChoice>>({});
  const [jevMatches, setJevMatches] = useState<Record<string, JevMatch>>({});
  const [matching, setMatching] = useState(false);
  const [matchNotice, setMatchNotice] = useState('');
  const [reason, setReason] = useState('');
  const [confirmedCurrency, setConfirmedCurrency] = useState('');
  const [confirmPurchaseDocument, setConfirmPurchaseDocument] = useState(false);
  const [paid, setPaid] = useState(false);
  const [paidAmount, setPaidAmount] = useState('');
  const [paidAt, setPaidAt] = useState(localDateTime());
  const [accountId, setAccountId] = useState('');
  const [existingMovementId, setExistingMovementId] = useState('');
  const [credentialName, setCredentialName] = useState('Power Automate');
  const [newCredential, setNewCredential] = useState<{ id: string; token: string } | null>(null);
  const [credentials, setCredentials] = useState<IntegrationCredential[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const decisionKey = useRef(newKey());
  const decisionPayload = useRef<string | null>(null);
  const uploadSubmissionId = useRef<string | null>(null);
  const uploadFileIdentity = useRef('');
  const openedDeepLink = useRef('');
  const activeReceiptId = useRef<string | null>(null);
  const activeReceiptStatus = useRef<string | null>(null);
  const receiptEpoch = useRef(0);
  const autoJevAttempts = useRef(new Set<string>());
  const jevMatchCache = useRef(new Map<string, Record<string, JevMatch>>());
  const canReview = ['owner', 'reviewer'].includes(role);
  const canUpload = ['owner', 'reviewer', 'operator'].includes(role);
  const canManageIntegration = role === 'owner';
  // Currency here is only a candidate-search hint. It never fills the human confirmation field.
  const detailQuery = useMemo(() => new URLSearchParams({ organizationId, currency: confirmedCurrency || currency }), [organizationId, currency, confirmedCurrency]);
  const displayCurrency = selected?.draft?.currency || confirmedCurrency || currency;
  const candidateCatalogIds = useMemo(() => new Set((selected?.candidates ?? []).map(candidate => candidate.catalogObjectId)), [selected?.candidates]);
  const costTargets = useMemo<CatalogTarget[]>(() => [
    ...(selected?.candidates ?? []),
    ...items.filter(item => item.squareCatalogObjectId && !candidateCatalogIds.has(item.squareCatalogObjectId)).map(item => ({ catalogObjectId: item.squareCatalogObjectId!, name: item.name, sku: item.sku, currency: item.currency, archived: false })),
  ].filter(target => target.currency === displayCurrency).sort((a, b) => Number(Boolean(a.archived)) - Number(Boolean(b.archived)) || a.name.localeCompare(b.name)), [selected?.candidates, items, candidateCatalogIds, displayCurrency]);
  const inventoryChoices = useMemo<InventoryChoice[]>(() => [
    ...(selected?.candidates ?? []).filter(candidate => candidate.currency === displayCurrency).map(candidate => ({ id: `square:${candidate.catalogObjectId}`, name: candidate.name, sku: candidate.sku, squareCatalogObjectId: candidate.catalogObjectId, unitCostMinor: items.find(item => item.squareCatalogObjectId === candidate.catalogObjectId && item.currency === displayCurrency)?.unitCostMinor ?? null, archived: candidate.archived ?? false })),
    ...items.filter(item => !item.squareCatalogObjectId || !candidateCatalogIds.has(item.squareCatalogObjectId)).filter(item => item.currency === displayCurrency).map(item => ({ ...item, archived: false })),
  ], [selected?.candidates, items, candidateCatalogIds, displayCurrency]);
  const purchaseTotals = selected?.draft?.totals;
  const displayedSubtotal = purchaseTotals ? amountMinor(purchaseTotals.subtotalMinor, purchaseTotals.rawAmounts?.subtotal, displayCurrency) : null;
  const displayedDiscount = purchaseTotals ? amountMinor(purchaseTotals.discountMinor, purchaseTotals.rawAmounts?.discount, displayCurrency) : null;
  const displayedTax = purchaseTotals ? amountMinor(purchaseTotals.taxMinor, purchaseTotals.rawAmounts?.tax, displayCurrency) : null;
  const displayedShipping = purchaseTotals ? amountMinor(purchaseTotals.shippingMinor, purchaseTotals.rawAmounts?.shipping, displayCurrency) : null;
  const displayedOther = purchaseTotals ? amountMinor(purchaseTotals.otherChargesMinor, purchaseTotals.rawAmounts?.other_charges, displayCurrency) : null;
  const displayedDocumentTotal = purchaseTotals ? amountMinor(purchaseTotals.totalMinor, purchaseTotals.totalAmount ?? purchaseTotals.rawAmounts?.total, displayCurrency) : null;
  const displayedLineTotal = selected?.draft?.reconciliation?.lineTotalMinor ?? (selected?.draft?.lines.every(line => amountMinor(line.lineAmountMinor, line.sourceAmounts?.lineAmount, displayCurrency) != null)
    ? selected.draft.lines.reduce((sum, line) => sum + (amountMinor(line.lineAmountMinor, line.sourceAmounts?.lineAmount, displayCurrency) ?? 0), 0) : null);
  const displayedDifference = selected?.draft?.reconciliation?.unexplainedMinor ?? null;
  const canRecordPayment = selected?.draft?.totals?.totalMinor != null || (displayCurrency === 'USD' && displayedDocumentTotal != null);
  const priorPaidMinor = (selected?.effects ?? []).filter(effect => effect.effect_type === 'payment').reduce((sum, effect) => sum + (Number(effect.effect_payload.amountMinor) || 0), 0);
  const priorReceivedByLine = (lineId: string) => (selected?.effects ?? []).filter(effect => effect.effect_type === 'stock_receipt' && effect.source_line_id === lineId).reduce((sum, effect) => sum + (Number(effect.effect_payload.quantity) || 0), 0);
  const hasCostForLine = (lineId: string) => (selected?.effects ?? []).some(effect => effect.effect_type === 'cost_update' && effect.source_line_id === lineId);
  const draftLines = selected?.draft?.lines ?? [];
  const costSelectableLines = draftLines.filter(line => !hasCostForLine(line.lineId));
  const stockSelectableLines = draftLines.filter(line => {
    const orderedUnits = (line.packageQuantity ?? 0) * (line.unitsPerPackage ?? 0);
    return orderedUnits <= 0 || priorReceivedByLine(line.lineId) < orderedUnits;
  });
  const allCostsSelected = costSelectableLines.length > 0 && costSelectableLines.every(line => choices[line.lineId]?.updateCost);
  const someCostsSelected = costSelectableLines.some(line => choices[line.lineId]?.updateCost);
  const allStockSelected = stockSelectableLines.length > 0 && stockSelectableLines.every(line => choices[line.lineId]?.receive);
  const someStockSelected = stockSelectableLines.some(line => choices[line.lineId]?.receive);
  const allEffectsSelected = (costSelectableLines.length === 0 || allCostsSelected) && (stockSelectableLines.length === 0 || allStockSelected) && (costSelectableLines.length > 0 || stockSelectableLines.length > 0);
  const someEffectsSelected = someCostsSelected || someStockSelected;

  function defaultCostCatalogId(itemId: string) {
    const matchedVariation = inventoryChoices.find(item => item.id === itemId)?.squareCatalogObjectId;
    return (matchedVariation && costTargets.some(target => target.catalogObjectId === matchedVariation) ? matchedVariation : null)
      ?? costTargets.find(target => !target.archived)?.catalogObjectId
      ?? costTargets[0]?.catalogObjectId
      ?? '';
  }

  function setAllReceiptEffects(checked: boolean) {
    setChoices(current => {
      const next = { ...current };
      for (const line of costSelectableLines) {
        const choice = current[line.lineId];
        if (!choice) continue;
        next[line.lineId] = { ...choice, updateCost: checked, costCatalogObjectId: checked ? choice.costCatalogObjectId || defaultCostCatalogId(choice.itemId) : choice.costCatalogObjectId };
      }
      for (const line of stockSelectableLines) {
        const choice = next[line.lineId] ?? current[line.lineId];
        if (!choice) continue;
        next[line.lineId] = { ...choice, receive: checked };
      }
      return next;
    });
  }

  async function load(refreshCredentials = true) {
    if (!organizationId) return;
    setLoading(true); setError('');
    try {
      const [list, integrations] = await Promise.all([
        api<{ receipts: Receipt[] }>(`/api/purchase-receipts?${detailQuery}`),
        canManageIntegration && refreshCredentials ? api<{ integrations: IntegrationCredential[] }>(`/api/purchase-receipt-integrations?${detailQuery}`) : Promise.resolve(null),
      ]);
      setReceipts(list.receipts ?? []);
      if (integrations) setCredentials(integrations.integrations ?? []);
      const selectedId = activeReceiptId.current;
      if (selectedId) {
        const current = (list.receipts ?? []).find(row => row.id === selectedId);
        if (!current) { setSelected(null); activeReceiptId.current = null; activeReceiptStatus.current = null; }
        else if (isReceiptProcessing(activeReceiptStatus.current ?? '')) await openReceipt(current.id);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load purchase receipts.'); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    receiptEpoch.current += 1;
    setReceipts([]); setSelected(null); setChoices({}); setJevMatches({}); setMatchNotice(''); setMatching(false); activeReceiptId.current = null; activeReceiptStatus.current = null; setNewCredential(null);
    void (async () => { await load(); if (initialReceiptId && openedDeepLink.current !== initialReceiptId) { openedDeepLink.current = initialReceiptId; await openReceipt(initialReceiptId); } })();
    // org/currency changes intentionally reload the inbox; a receipt deep link is opened once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, currency, initialReceiptId, canManageIntegration]);

  useEffect(() => {
    if (!uploadOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeUpload(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [uploadOpen, busy]);
  const processingCount = receipts.filter(receipt => isReceiptProcessing(receipt.status)).length;
  const hasActivatedPage = useRef(false);
  useEffect(() => {
    if (!active) return;
    if (hasActivatedPage.current) void load();
    hasActivatedPage.current = true;
    // Refresh the inbox when returning to this page without resetting review edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(() => {
    if (!active || !processingCount) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(false); }, 15_000);
    return () => window.clearInterval(timer);
    // Refresh only while this page is visible and extraction work is pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, organizationId, processingCount]);

  async function openReceipt(id: string) {
    const requestEpoch = ++receiptEpoch.current;
    activeReceiptId.current = id; activeReceiptStatus.current = null; setMatching(false);
    setError(''); setNotice('');
    try {
      const result = await api<ReceiptDetail>(`/api/purchase-receipts/${encodeURIComponent(id)}?${detailQuery}`);
      if (receiptEpoch.current !== requestEpoch) return;
      setSelected(result);
      activeReceiptStatus.current = result.receipt.status;
      setItems(result.inventoryItems ?? []);
      const effectCurrencies = [...new Set((result.effects ?? []).map(effect => typeof effect.effect_payload.currency === 'string' ? effect.effect_payload.currency : '').filter(code => /^[A-Z]{3}$/.test(code)))];
      const version = Number(result.version ?? result.receipt.activeDraftVersion);
      const matchCurrency = result.draft?.currency ?? (effectCurrencies.length === 1 ? effectCurrencies[0] : currency);
      const matchKey = `${organizationId}:${id}:${version}:${matchCurrency}`;
      const storedMatching = result.draft?.inventoryMatching;
      const validLineIds = new Set((result.draft?.lines ?? []).map(line => line.lineId));
      const validInventoryIds = new Set([
        ...(result.candidates ?? []).map(candidate => `square:${candidate.catalogObjectId}`),
        ...(result.inventoryItems ?? []).map(item => item.squareCatalogObjectId ? `square:${item.squareCatalogObjectId}` : item.id),
      ]);
      const storedSuggestions = Object.fromEntries((storedMatching?.matches ?? [])
        .filter(match => validLineIds.has(match.lineId) && (match.itemId === null || validInventoryIds.has(match.itemId)))
        .map(match => [match.lineId, { itemId: match.itemId, itemName: match.itemName, confidence: match.confidence, reason: match.reason }])) as Record<string, JevMatch>;
      const suggestions = jevMatchCache.current.get(matchKey) ?? storedSuggestions;
      if (storedMatching) jevMatchCache.current.set(matchKey, suggestions);
      setJevMatches(suggestions); setMatchNotice(storedMatching?.status === 'completed'
        ? 'Jev suggestions were generated during receipt processing. Review and edit each selection before approval.'
        : storedMatching?.status === 'budget_exceeded'
          ? 'Jev matching was skipped because the organization AI budget is exhausted. You can retry matching later.'
          : storedMatching?.status === 'awaiting_currency_confirmation'
            ? 'Confirm the receipt currency to generate same-currency inventory suggestions.'
            : storedMatching?.status === 'unavailable'
              ? 'Jev matching was unavailable during processing. You can retry it here.' : '');
      const url = new URL(window.location.href); url.searchParams.set('purchaseReceipt', id); url.searchParams.set('organizationId', organizationId); window.history.replaceState(null, '', url.toString());
      const next: Record<string, LineChoice> = {};
      for (const line of result.draft?.lines ?? []) {
        const draftCurrency = result.draft?.currency ?? '';
        const lineAmount = draftCurrency ? amountMinor(line.lineAmountMinor, line.sourceAmounts?.lineAmount, draftCurrency) : null;
        const cost = lineAmount != null && line.packageQuantity && line.unitsPerPackage ? calculatePackageUnitCostMinor(lineAmount, 1, line.packageQuantity * line.unitsPerPackage)?.unitCostMinor ?? null : null;
        const alreadyReceived = (result.effects ?? []).filter(effect => effect.effect_type === 'stock_receipt' && effect.source_line_id === line.lineId).reduce((sum, effect) => sum + (Number(effect.effect_payload.quantity) || 0), 0);
        const orderedUnits = (line.packageQuantity ?? 0) * (line.unitsPerPackage ?? 0);
        next[line.lineId] = { itemId: '', costCatalogObjectId: '', effectiveFrom: result.draft?.invoiceDate ?? new Date().toISOString().slice(0, 10), packageQuantity: line.packageQuantity == null ? '' : String(line.packageQuantity), unitsPerPackage: line.unitsPerPackage == null ? '' : String(line.unitsPerPackage), unitCost: cost == null || !draftCurrency ? '' : minorText(cost, draftCurrency), costEdited: false, receive: false, receivedQuantity: orderedUnits ? String(Math.max(0, orderedUnits - alreadyReceived)) : '', receivedAt: localDateTime(), updateCost: false };
      }
      const inventoryById = new Map<string, InventoryItem | CatalogTarget>([
        ...(result.candidates ?? []).map(candidate => [`square:${candidate.catalogObjectId}`, candidate] as const),
        ...(result.inventoryItems ?? []).map(item => [item.squareCatalogObjectId ? `square:${item.squareCatalogObjectId}` : item.id, item] as const),
      ]);
      for (const [lineId, suggestion] of Object.entries(suggestions)) {
        if (!suggestion.itemId || !next[lineId]) continue;
        const item = inventoryById.get(suggestion.itemId);
        if (!item) continue;
        next[lineId].itemId = suggestion.itemId;
        next[lineId].costCatalogObjectId = 'squareCatalogObjectId' in item && item.squareCatalogObjectId
          ? item.squareCatalogObjectId : 'catalogObjectId' in item ? item.catalogObjectId : '';
      }
      setChoices(next);
      const previouslyVerifiedCurrency = result.draft?.currency ?? (effectCurrencies.length === 1 ? effectCurrencies[0] : '');
      setConfirmedCurrency(previouslyVerifiedCurrency); setConfirmPurchaseDocument(false); setPaid(false); setAccountId(''); setExistingMovementId('');
      const totalCurrency = previouslyVerifiedCurrency;
      const total = totalCurrency && result.draft?.totals ? amountMinor(result.draft.totals.totalMinor, result.draft.totals.totalAmount ?? result.draft.totals.rawAmounts?.total, totalCurrency) : null;
      const priorPaid = (result.effects ?? []).filter(effect => effect.effect_type === 'payment').reduce((sum, effect) => sum + (Number(effect.effect_payload.amountMinor) || 0), 0);
      setPaidAmount(total == null || !totalCurrency ? '' : (Math.max(0, total - priorPaid) / (10 ** digitsFor(totalCurrency))).toFixed(digitsFor(totalCurrency)));
      // The extraction date is only a reference; a human must confirm the actual payment timestamp.
      setPaidAt('');
    } catch (reason) { if (receiptEpoch.current === requestEpoch) setError(reason instanceof Error ? reason.message : 'Could not open this receipt.'); }
  }
  function suggestedCostText(lineId: string, packages: string, unitsPerPackage: string, code: string) {
    const line = selected?.draft?.lines.find(item => item.lineId === lineId);
    const amount = line ? amountMinor(line.lineAmountMinor, line.sourceAmounts?.lineAmount, code) : null;
    const unitCount = Number(packages) * Number(unitsPerPackage);
    if (amount == null || !Number.isSafeInteger(unitCount) || unitCount < 1) return '';
    const unitCostMinor = calculatePackageUnitCostMinor(amount, 1, unitCount)?.unitCostMinor;
    return unitCostMinor == null ? '' : minorText(unitCostMinor, code);
  }
  function patchLine(lineId: string, patch: Partial<LineChoice>) {
    setChoices(current => {
      const next = { ...current[lineId], ...patch };
      if (patch.itemId !== undefined) {
        const matchedVariation = inventoryChoices.find(item => item.id === patch.itemId)?.squareCatalogObjectId;
        next.costCatalogObjectId = matchedVariation ?? '';
      }
      if (patch.updateCost === true) next.costCatalogObjectId = next.costCatalogObjectId || defaultCostCatalogId(next.itemId);
      if (patch.packageQuantity !== undefined || patch.unitsPerPackage !== undefined) {
        const orderedUnits = next.packageQuantity && next.unitsPerPackage ? Number(next.packageQuantity) * Number(next.unitsPerPackage) : 0;
        next.receivedQuantity = orderedUnits ? String(Math.max(0, orderedUnits - priorReceivedByLine(lineId))) : '';
        if (!next.costEdited) next.unitCost = suggestedCostText(lineId, next.packageQuantity, next.unitsPerPackage, displayCurrency);
      }
      return { ...current, [lineId]: next };
    });
  }
  async function matchInventoryWithJev(automatic = false) {
    if (!selected?.draft) return;
    const receiptId = selected.receipt.id;
    const requestEpoch = receiptEpoch.current;
    const expectedVersion = Number(selected.version ?? selected.receipt.activeDraftVersion);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) { setMatchNotice('Reload this receipt before matching items with Jev.'); return; }
    const matchCurrency = selected.draft.currency || confirmedCurrency;
    if (!/^[A-Z]{3}$/.test(matchCurrency)) { setMatchNotice('Confirm the receipt currency before matching inventory.'); return; }
    const matchKey = `${organizationId}:${receiptId}:${expectedVersion}:${matchCurrency}`;
    if (automatic && autoJevAttempts.current.has(matchKey)) return;
    if (automatic) autoJevAttempts.current.add(matchKey);
    setMatching(true); setError(''); setMatchNotice(automatic ? 'Jev is matching the receipt lines to the available inventory…' : '');
    try {
      const result = await api<{ receiptId: string; version: number; matches: Array<{ lineId: string; itemId: string | null; itemName: string | null; confidence: number | null; reason?: JevMatch['reason'] }> }>(
        `/api/purchase-receipts/${encodeURIComponent(receiptId)}/match`,
        { method: 'POST', body: JSON.stringify({ organizationId, expectedVersion, currency: matchCurrency }) },
      );
      if (activeReceiptId.current !== receiptId || receiptEpoch.current !== requestEpoch) return;
      if (result.receiptId !== receiptId || result.version !== expectedVersion) throw new Error('The receipt draft changed. Reopen this receipt and try Jev matching again.');
      const validLineIds = new Set(selected.draft.lines.map(line => line.lineId));
      const matches = (result.matches ?? []).filter(match => validLineIds.has(match.lineId)
        && (match.itemId === null || inventoryChoices.some(item => item.id === match.itemId)));
      const inventoryById = new Map(inventoryChoices.map(item => [item.id, item]));
      const suggestions = Object.fromEntries(matches.map(match => [match.lineId, {
        itemId: match.itemId, itemName: match.itemName, confidence: match.confidence, reason: match.reason,
      }])) as Record<string, JevMatch>;
      jevMatchCache.current.set(matchKey, suggestions);
      setJevMatches(suggestions);
      setChoices(current => {
        const next = { ...current };
        for (const match of matches) {
          if (!match.itemId || next[match.lineId]?.itemId) continue;
          const item = inventoryById.get(match.itemId);
          const choice = next[match.lineId];
          if (!item || !choice) continue;
          next[match.lineId] = { ...choice, itemId: item.id, costCatalogObjectId: item.squareCatalogObjectId ?? '' };
        }
        return next;
      });
      const matchedCount = matches.filter(match => match.itemId).length;
      const filledCount = matches.filter(match => match.itemId && !choices[match.lineId]?.itemId).length;
      const noMatchCount = matches.filter(match => !match.itemId).length;
      const skippedCount = matches.filter(match => match.reason === 'empty_description').length;
      const noInventoryCount = matches.filter(match => match.reason === 'no_inventory_options').length;
      setMatchNotice(`Jev matched ${matchedCount} line${matchedCount === 1 ? '' : 's'} and filled ${filledCount} empty choice${filledCount === 1 ? '' : 's'}; no match for ${noMatchCount - skippedCount - noInventoryCount}${skippedCount ? `, skipped ${skippedCount} without a description` : ''}${noInventoryCount ? `, ${noInventoryCount} had no inventory options` : ''}. Review and edit the selections before approval.`);
    } catch (reason) { if (activeReceiptId.current === receiptId && receiptEpoch.current === requestEpoch) setError(reason instanceof Error ? reason.message : 'Jev could not match these receipt lines.'); }
    finally { if (activeReceiptId.current === receiptId && receiptEpoch.current === requestEpoch) setMatching(false); }
  }

  useEffect(() => {
    if (!active || !canReview || !selected?.draft || selected.receipt.status !== 'needs_review'
        || !selected.draft.lines.length || !inventoryChoices.length) return;
    const matchCurrency = selected.draft.currency || confirmedCurrency;
    if (!/^[A-Z]{3}$/.test(matchCurrency)) return;
    const version = Number(selected.version ?? selected.receipt.activeDraftVersion);
    if (!Number.isSafeInteger(version) || version < 1) return;
    const matchKey = `${organizationId}:${selected.receipt.id}:${version}:${matchCurrency}`;
    if (autoJevAttempts.current.has(matchKey) || jevMatchCache.current.has(matchKey)) return;
    void matchInventoryWithJev(true);
    // One automatic Jev request per receipt draft version; the button remains available to retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, canReview, organizationId, selected?.draft, selected?.receipt.id, selected?.receipt.status, selected?.receipt.activeDraftVersion, selected?.version, inventoryChoices, selected?.draft?.currency, confirmedCurrency]);
  function confirmCurrency(code: string) {
    setConfirmedCurrency(code);
    const totals = selected?.draft?.totals;
    const total = totals ? amountMinor(totals.totalMinor, totals.totalAmount ?? totals.rawAmounts?.total, code) : null;
    const remainingPayment = total == null ? null : Math.max(0, total - priorPaidMinor);
    setPaidAmount(remainingPayment == null ? '' : (remainingPayment / (10 ** digitsFor(code))).toFixed(digitsFor(code)));
    setChoices(current => Object.fromEntries(Object.entries(current).map(([lineId, choice]) => [lineId, choice.costEdited ? choice : { ...choice, unitCost: suggestedCostText(lineId, choice.packageQuantity, choice.unitsPerPackage, code) }])));
    if (selected && code) {
      const query = new URLSearchParams({ organizationId, currency: code });
      void api<ReceiptDetail>(`/api/purchase-receipts/${encodeURIComponent(selected.receipt.id)}?${query}`).then(result => {
        setSelected(current => current?.receipt.id === selected.receipt.id ? { ...current, candidates: result.candidates ?? [] } : current);
      }).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not load cost candidates for the confirmed currency.'));
    }
  }

  async function uploadReceipt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!file) return; const formElement = event.currentTarget;
    setBusy(true); setError(''); setNotice('');
    try {
      const fileIdentity = `${file.name}:${file.size}:${file.lastModified}`;
      if (uploadFileIdentity.current !== fileIdentity) { uploadFileIdentity.current = fileIdentity; uploadSubmissionId.current = newKey(); }
      const submissionId = uploadSubmissionId.current ?? newKey(); uploadSubmissionId.current = submissionId;
      const registered = await api<{ receiptId: string; status: string; duplicateOfReceiptId?: string | null; upload?: { url: string; method: 'PUT'; contentType: string; headers?: Record<string, string> } }>('/api/purchase-receipts', { method: 'POST', headers: { 'Idempotency-Key': submissionId }, body: JSON.stringify({ organizationId, externalSubmissionId: submissionId, filename: file.name, contentType: file.type }) });
      if (registered.upload) {
        const uploadResponse = await fetch(registered.upload.url, { method: registered.upload.method, headers: { 'Content-Type': registered.upload.contentType, ...(registered.upload.headers ?? { 'x-upsert': 'false' }) }, body: file });
        if (!uploadResponse.ok && uploadResponse.status !== 409) throw new Error('The private document upload failed. Try uploading the same file again.');
        await api(`/api/purchase-receipts/${encodeURIComponent(registered.receiptId)}/complete`, { method: 'POST', headers: { 'Idempotency-Key': submissionId }, body: JSON.stringify({ organizationId }) });
      }
      uploadSubmissionId.current = null; uploadFileIdentity.current = '';
      setNotice(registered.duplicateOfReceiptId ? 'This document matches an earlier submission. Review the duplicate record before proceeding.' : registered.upload ? `Uploaded ${file.name}. Extraction is processing; status updates automatically.` : 'This submission was already received; showing its existing status.'); setFile(null); formElement.reset(); setUploadOpen(false); await load(); if (registered.receiptId) await openReceipt(registered.receiptId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The document could not be uploaded.'); }
    finally { setBusy(false); }
  }

  async function decide(action: 'approve' | 'reject') {
    if (!selected) return;
    const draft = selected.draft;
    if (!draft) { setError('This receipt has no reviewable draft yet.'); return; }
    const activeCurrency = draft.currency ?? confirmedCurrency;
    if (action === 'approve' && (!activeCurrency || !/^[A-Z]{3}$/.test(activeCurrency))) { setError('Confirm the three-letter document currency from the source before recording any effects.'); return; }
    if (reason.trim().length < 10) { setError('Add a decision reason of at least 10 characters, with the supplier evidence or review basis.'); return; }
    if (action === 'approve' && !confirmPurchaseDocument) { setError('Confirm that the source is a supplier purchase receipt or invoice before approval.'); return; }
    const lines = draft.lines;
    let costUpdates: Array<Record<string, unknown>> = [];
    let stockReceipts: Array<Record<string, unknown>> = [];
    let payments: Array<Record<string, unknown>> = [];
    try {
      if (action === 'approve') {
      costUpdates = lines.flatMap(line => {
        const choice = choices[line.lineId]; if (!choice?.updateCost) return [];
        const unitCostMinor = parseMinor(choice.unitCost, activeCurrency);
        const target = selected.candidates?.find(candidate => candidate.catalogObjectId === choice.costCatalogObjectId) ?? items.find(item => item.squareCatalogObjectId === choice.costCatalogObjectId);
        const name = target?.name ?? '';
        if (!choice.costCatalogObjectId || !name || unitCostMinor == null || !/^\d{4}-\d{2}-\d{2}$/.test(choice.effectiveFrom)) throw new Error(`Choose a catalog variation, a valid unit cost, and its effective date for line ${line.lineNumber}.`);
        return [{ lineId: line.lineId, catalogObjectId: choice.costCatalogObjectId, name, unitCostMinor, currency: activeCurrency, effectiveFrom: new Date(`${choice.effectiveFrom}T00:00:00.000Z`).toISOString() }];
      });
      stockReceipts = lines.flatMap(line => {
        const choice = choices[line.lineId]; if (!choice?.receive) return [];
        const item = items.find(row => row.id === choice.itemId);
        const catalogId = choice.itemId.startsWith('square:') ? choice.itemId.slice('square:'.length) : item?.squareCatalogObjectId ?? null;
        const candidate = catalogId ? selected.candidates?.find(row => row.catalogObjectId === catalogId) : null;
        const catalogDefinition = catalogId ? items.find(row => row.squareCatalogObjectId === catalogId && row.currency === activeCurrency && row.unitCostMinor != null) : null;
        const quantity = Number(choice.receivedQuantity);
        const packageQuantity = Number(choice.packageQuantity), unitsPerPackage = Number(choice.unitsPerPackage);
        const unitCostMinor = parseMinor(choice.unitCost, activeCurrency) ?? item?.unitCostMinor ?? catalogDefinition?.unitCostMinor ?? null;
        if ((!item && !candidate) || !Number.isSafeInteger(quantity) || quantity < 1 || !choice.receivedAt || !Number.isSafeInteger(packageQuantity) || packageQuantity < 1 || !Number.isSafeInteger(unitsPerPackage) || unitsPerPackage < 1 || unitCostMinor == null || quantity > packageQuantity * unitsPerPackage) throw new Error(`Confirm the item, package quantity, units per package, unit cost, received units, and receipt time for line ${line.lineNumber}. Received units cannot exceed ordered units.`);
        if (choice.updateCost && catalogId && choice.costCatalogObjectId !== catalogId) throw new Error(`The cost update and stock receipt must use the same Square variation for line ${line.lineNumber}.`);
        if (catalogId && !catalogDefinition && !(choice.updateCost && choice.costCatalogObjectId === catalogId)) throw new Error(`Add an evidence-backed effective cost for the selected Square variation before receiving stock on line ${line.lineNumber}.`);
        return [{ lineId: line.lineId, ...(catalogId ? { catalogObjectId: catalogId } : { itemId: item!.id }), quantity, packageQuantity, unitsPerPackage, unitCostMinor, currency: activeCurrency, receivedAt: new Date(choice.receivedAt).toISOString() }];
      });
      payments = paid ? (() => {
        const amountMinor = parseMinor(paidAmount, activeCurrency);
        if (amountMinor == null || amountMinor < 1 || !paidAt || (!accountId && !existingMovementId.trim())) throw new Error('Confirm a positive paid amount, actual date, and either a funding account or existing movement.');
        return [{ amountMinor, currency: activeCurrency, paidAt: new Date(paidAt).toISOString(), ...(accountId ? { accountId } : {}), ...(existingMovementId.trim() ? { existingMovementId: existingMovementId.trim() } : {}) }];
      })() : [];
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Check the selected purchase effects.'); return; }
    if (action === 'approve' && costUpdates.length + stockReceipts.length + payments.length === 0) { setError('Select at least one cost, stock, or payment effect to approve. Pending delivery and payment can be handled later.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const requestBody = { organizationId, expectedVersion: selected.version ?? selected.receipt.activeDraftVersion, reason: reason.trim(), ...(action === 'approve' ? { confirmPurchaseDocument: true, currency: draft.currency ?? confirmedCurrency, costUpdates, stockReceipts, payments } : {}) };
      const serializedBody = JSON.stringify(requestBody);
      if (decisionPayload.current !== serializedBody) { decisionPayload.current = serializedBody; decisionKey.current = newKey(); }
      await api(`/api/purchase-receipts/${encodeURIComponent(selected.receipt.id)}/${action}`, { method: 'POST', headers: { 'Idempotency-Key': decisionKey.current }, body: serializedBody });
      setNotice(action === 'approve' ? 'Selected effects were approved. Projection processing may still be pending.' : 'Receipt rejected with an audit reason.');
      setReason(''); decisionPayload.current = null; decisionKey.current = newKey(); onSaved(); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : `Could not ${action} this receipt.`); }
    finally { setBusy(false); }
  }

  async function createCredential() {
    setBusy(true); setError(''); setNotice('');
    try { const result = await api<{ id: string; token: string }>('/api/purchase-receipt-integrations', { method: 'POST', body: JSON.stringify({ organizationId, name: credentialName.trim() }) }); setNewCredential(result); setCredentials(current => [{ id: result.id, name: credentialName.trim(), createdAt: new Date().toISOString(), revokedAt: null }, ...current]); setNotice('Copy this token into your approved secret store now. Finance Loop will not show it again.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create the integration credential.'); }
    finally { setBusy(false); }
  }
  async function deleteReceipt() {
    if (!selected || !canReview) return;
    if (!window.confirm('Remove this receipt from the inbox? Queued processing may continue. The source document, decisions, posted financial effects, and audit history will be retained. This cannot be undone.')) return;
    const receiptId = selected.receipt.id;
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/purchase-receipts/${encodeURIComponent(receiptId)}`, { method: 'DELETE', body: JSON.stringify({ organizationId }) });
      setReceipts(current => current.filter(receipt => receipt.id !== receiptId)); setSelected(null);
      uploadSubmissionId.current = null; uploadFileIdentity.current = '';
      const url = new URL(window.location.href); url.searchParams.delete('purchaseReceipt'); window.history.replaceState(null, '', url.toString());
      setNotice('Receipt removed from the inbox. Source and financial history were retained.'); onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not delete the receipt.'); }
    finally { setBusy(false); }
  }
  async function reprocessFailedReceipt() {
    if (!selected || !canReview || selected.receipt.status !== 'failed' || selected.draft) return;
    if (!window.confirm('Retry extraction from the retained source document? Any 4,096-token reservation held by the failed run will be released and reallocated to this retry.')) return;
    const receiptId = selected.receipt.id;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ receiptId: string; status: string; alreadyQueued?: boolean }>(`/api/purchase-receipts/${encodeURIComponent(receiptId)}/reprocess`, { method: 'POST', body: JSON.stringify({ organizationId }) });
      setReceipts(current => current.map(receipt => receipt.id === receiptId ? { ...receipt, status: result.status, lastErrorCode: null } : receipt));
      activeReceiptStatus.current = result.status;
      setSelected(current => current?.receipt.id === receiptId ? { ...current, receipt: { ...current.receipt, status: result.status, lastErrorCode: null } } : current);
      setNotice(result.alreadyQueued ? 'This receipt already has an active extraction attempt.' : 'Receipt reprocessed from its retained source document. Status updates automatically while extraction runs.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not reprocess the failed receipt.'); }
    finally { setBusy(false); }
  }

  function closeUpload() {
    if (busy) return;
    setUploadOpen(false); setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const renderReceiptRow = (receipt: Receipt) => {
    const processing = isReceiptProcessing(receipt.status);
    const filename = receipt.originalFilename || receipt.filename || '';
    const uuidFilename = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[^.]+)?$/i.test(filename);
    const title = receiptPrimaryName(receipt);
    const timestamp = receipt.submittedAt || receipt.createdAt;
    const details = [timestamp ? `${processing ? 'Uploaded' : 'Updated'} ${new Date(timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '', uuidFilename ? shortReceiptFilename(filename) : !filename ? shortReceiptFilename(receipt.id) : '', receipt.duplicateOfReceiptId ? 'Possible duplicate' : '', processing ? 'Checking automatically' : ''].filter(Boolean).join(' · ');
    return <button type="button" key={receipt.id} className={`purchase-receipt-row ${selected?.receipt.id === receipt.id ? 'selected' : ''}`} onClick={() => void openReceipt(receipt.id)}><span className="purchase-receipt-file"><b>{title}</b><small>{details}</small></span><span className={`pill status-pill ${receiptStatusTone(receipt.status)}`}><i aria-hidden="true" />{receiptStatusLabel(receipt.status)}</span></button>;
  };

  async function revokeCredential(id: string) {
    if (!window.confirm('Revoke this integration credential now? Existing flows using it will stop working.')) return;
    setBusy(true); setError('');
    try { await api(`/api/purchase-receipt-integrations/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ organizationId }) }); if (newCredential?.id === id) setNewCredential(null); setCredentials(current => current.map(credential => credential.id === id ? { ...credential, revokedAt: new Date().toISOString() } : credential)); setNotice('Integration credential revoked.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not revoke the credential.'); }
    finally { setBusy(false); }
  }

  return <div className="purchase-receipts">
    <section className="panel purchase-inbox">
      <div className="panel-heading"><div><h2>Recent receipts</h2><p>Supplier purchases are extracted for review before any financial effects are approved.</p></div>{canUpload && <button type="button" className="primary with-icon" onClick={() => { setError(''); setFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; setUploadOpen(true); }} disabled={busy}><UiIcon name="upload" />Upload receipt</button>}</div>
      {error && <p className="error" role="alert">{error}</p>}{notice && <p className="purchase-success" role="status">{notice}</p>}
      {processingCount > 0 && <div className="receipt-group"><div className="receipt-group-heading"><h3>Processing</h3><span>{processingCount}</span><small>Checking automatically</small></div><div className="purchase-receipt-list">{receipts.filter(receipt => isReceiptProcessing(receipt.status)).map(renderReceiptRow)}</div></div>}
      <div className="receipt-group"><div className="receipt-group-heading"><h3>Recent receipts</h3></div><div className="purchase-receipt-list">{receipts.filter(receipt => !isReceiptProcessing(receipt.status)).map(renderReceiptRow)}{!loading && receipts.length === 0 && <div className="inline-empty">No receipts yet.</div>}</div></div>
    </section>
    {uploadOpen && <div className="purchase-upload-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeUpload() }}><section className="purchase-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="receipt-upload-title"><div className="panel-heading"><div><h2 id="receipt-upload-title">Upload receipt</h2><p>Choose a supplier invoice or receipt. Extraction runs automatically.</p></div><button type="button" className="icon-button" aria-label="Close upload dialog" onClick={closeUpload} disabled={busy}>×</button></div><form className="receipt-upload-form" onSubmit={uploadReceipt}><div className="receipt-dropzone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const dropped = event.dataTransfer.files?.[0]; if (dropped) setFile(dropped); }}><UiIcon name="upload" size={22} /><strong>{file?.name ?? 'Drop a receipt here'}</strong><small>PDF, JPEG, or PNG</small><input ref={fileInputRef} className="receipt-file-input" type="file" accept="application/pdf,image/jpeg,image/png" onChange={event => setFile(event.target.files?.[0] ?? null)} /><button type="button" className="secondary" onClick={() => fileInputRef.current?.click()}>Choose file</button></div>{error && <p className="error" role="alert">{error}</p>}<div className="form-actions"><button type="button" className="secondary" onClick={closeUpload} disabled={busy}>Cancel</button><button className="primary with-icon" disabled={busy || !file}><UiIcon name="upload" />{busy ? 'Uploading…' : 'Upload receipt'}</button></div></form></section></div>}
    {selected && <section className="panel purchase-review">
      <div className="panel-heading"><div><h2>{selected.draft?.supplier || receiptPrimaryName(selected.receipt)}</h2><p>{selected.draft?.purchaseReference ? `Reference ${selected.draft.purchaseReference} · ` : ''}{selected.draft?.invoiceDate || 'Date not extracted'}</p></div><div className="purchase-review-actions">{selected.evidenceUrl && <a className="secondary button-link icon-button" href={selected.evidenceUrl} target="_blank" rel="noreferrer" aria-label="Open source document" title="Open source document"><UiIcon name="file" /></a>}{canReview && <button type="button" className="icon-button reject-button" disabled={busy} onClick={() => void deleteReceipt()} aria-label="Delete receipt" title="Delete receipt"><UiIcon name="trash" /></button>}<span className={`pill status-pill ${receiptStatusTone(selected.receipt.status)}`}><i aria-hidden="true" />{receiptStatusLabel(selected.receipt.status)}</span></div></div>
      {selected.receipt.duplicateOfReceiptId && <div className="notice decision-context-warning">Possible duplicate. <button type="button" className="secondary with-icon" onClick={() => void openReceipt(selected.receipt.duplicateOfReceiptId!)}><UiIcon name="external" />View original</button></div>}
      {!selected.draft ? selected.receipt.status === 'failed' ? <div className="notice decision-context-warning"><b>Processing failed{selected.receipt.lastErrorCode ? ` · ${selected.receipt.lastErrorCode}` : ''}</b><span>Fix the processing issue, then retry. Receipts with a draft, decision, or financial effect cannot be retried.</span>{canReview && <div className="purchase-review-actions"><button type="button" className="secondary with-icon" disabled={busy} onClick={() => void reprocessFailedReceipt()}><UiIcon name="refresh" />Reprocess document</button></div>}</div> : <div className="inline-empty">Extraction is in progress. Status updates automatically.</div> : <>
        {selected.receipt.lastErrorCode && ['failed','projection_pending'].includes(selected.receipt.status) && <div className="notice decision-context-warning"><b>Processing issue · {selected.receipt.lastErrorCode}</b></div>}
        <div className={`notice ${selected.draft.reconciliation?.status === 'matched' ? 'purchase-match' : 'decision-context-warning'}`}><b>Reconciliation · {selected.draft.reconciliation?.status ?? 'incomplete'}</b><span>Lines {formatMoney(displayedLineTotal, displayCurrency)} · Total {formatMoney(displayedDocumentTotal, displayCurrency)} · Difference {formatMoney(displayedDifference, displayCurrency)}</span></div>
        {!selected.draft.currency && <label className="purchase-currency">Confirm currency from the source document<select required value={confirmedCurrency} onChange={event => confirmCurrency(event.target.value)}><option value="">Choose currency</option>{[...new Set([currency, ...accounts.map(account => account.currency)])].map(code => <option key={code} value={code}>{code}</option>)}</select></label>}
        {canReview && selected.receipt.status === 'needs_review' && <div className="purchase-jev-control"><div><b>Inventory matching</b><small>{inventoryChoices.length ? 'Jev runs with receipt extraction when the document provides a currency. Suggestions appear beside each line and remain editable.' : 'No same-currency inventory choices are available.'}</small></div><button type="button" className="secondary" onClick={() => void matchInventoryWithJev()} disabled={busy || matching || !inventoryChoices.length || !selected.draft.lines.length || (!selected.draft.currency && !confirmedCurrency)}>{matching ? 'Matching with Jev…' : selected.draft.inventoryMatching || Object.keys(jevMatches).length ? 'Retry Jev matching' : 'Run Jev matching'}</button></div>}
        {matchNotice && <p className="purchase-jev-status" role="status">{matchNotice}</p>}
        <div className="table-wrap"><table className="purchase-line-table"><thead><tr><th scope="col">Document line</th><th scope="col">Inventory identity</th><th scope="col">Packages</th><th scope="col">Units / package</th><th scope="col" className="numeric">Exact goods amount</th><th scope="col">Unit cost</th><th scope="col"><div className="purchase-effect-heading"><span>Effects</span><div className="purchase-effect-bulk"><label title="Select cost and stock effects for all available lines"><input ref={element => { if (element) element.indeterminate = someEffectsSelected && !allEffectsSelected; }} type="checkbox" aria-label="Select all cost and stock effects" checked={allEffectsSelected} disabled={!canReview || busy || (!costSelectableLines.length && !stockSelectableLines.length)} onChange={event => setAllReceiptEffects(event.currentTarget.checked)} />All</label></div></div></th></tr></thead><tbody>{selected.draft.lines.map(line => {
          const priorReceived = priorReceivedByLine(line.lineId);
          const choice = choices[line.lineId] ?? { itemId: '', costCatalogObjectId: '', effectiveFrom: selected.draft?.invoiceDate ?? new Date().toISOString().slice(0, 10), packageQuantity: '', unitsPerPackage: '', unitCost: '', costEdited: false, receive: false, receivedQuantity: '', receivedAt: localDateTime(), updateCost: false };
          const ext = Number(choice.packageQuantity) * Number(choice.unitsPerPackage);
          const stockAlreadyReceived = ext > 0 && priorReceived >= ext;
          const exactLineAmount = amountMinor(line.lineAmountMinor, line.sourceAmounts?.lineAmount, displayCurrency);
          return <tr key={line.lineId}><td><b>{line.description || `Line ${line.lineNumber}`}</b>{(line.reviewFlags?.length || line.quantityText) && <small className="cell-sub">{line.reviewFlags?.length ? line.reviewFlags.join(' · ') : line.quantityText}</small>}</td>
            <td><select value={choice.itemId} onChange={event => patchLine(line.lineId, { itemId: event.target.value })} disabled={!canReview || matching}><option value="">Choose item</option>{inventoryChoices.map(item => <option key={item.id} value={item.id}>{item.name}{item.sku ? ` · ${item.sku}` : ''}{item.archived ? ' · archived Square item' : ''}</option>)}</select>{jevMatches[line.lineId] && <small className="purchase-jev-note">Jev {jevMatches[line.lineId].reason === 'empty_description' ? 'skipped: no receipt description' : jevMatches[line.lineId].reason === 'no_inventory_options' ? 'could not match: no inventory options' : jevMatches[line.lineId].itemName ? `suggested ${jevMatches[line.lineId].itemName}` : 'suggested no match'}{jevMatches[line.lineId].confidence == null ? '' : ` · ${Math.round(jevMatches[line.lineId].confidence! * 100)}% confidence`}</small>}</td>
            <td><input type="number" min="1" step="1" value={choice.packageQuantity} onChange={event => patchLine(line.lineId, { packageQuantity: event.target.value })} disabled={!canReview} aria-label="Packages" /></td>
            <td><input type="number" min="1" step="1" value={choice.unitsPerPackage} onChange={event => patchLine(line.lineId, { unitsPerPackage: event.target.value })} disabled={!canReview} aria-label="Units per package" /></td>
            <td className="numeric">{formatMoney(exactLineAmount, displayCurrency)}</td>
            <td><input inputMode="decimal" value={choice.unitCost} onChange={event => patchLine(line.lineId, { unitCost: event.target.value, costEdited: true })} placeholder="0.00" disabled={!canReview || !displayCurrency} aria-label="Unit cost" /></td>
            <td>{hasCostForLine(line.lineId) ? <small className="cell-sub">Cost recorded</small> : <><label className="purchase-effect"><input type="checkbox" checked={choice.updateCost} onChange={event => patchLine(line.lineId, { updateCost: event.target.checked })} disabled={!canReview || busy} /> Update cost</label>{choice.updateCost && <div className="purchase-stock-fields"><label>Variation<select value={choice.costCatalogObjectId} onChange={event => patchLine(line.lineId, { costCatalogObjectId: event.target.value })} disabled={!canReview}><option value="">Choose variation</option>{costTargets.map(target => <option key={target.catalogObjectId} value={target.catalogObjectId}>{target.name}{target.sku ? ` · ${target.sku}` : ''}{target.archived ? ' · archived Square item' : ''}</option>)}</select></label><label>Effective from<input type="date" value={choice.effectiveFrom} onChange={event => patchLine(line.lineId, { effectiveFrom: event.target.value })} disabled={!canReview} /></label></div>}</>}<label className="purchase-effect"><input type="checkbox" checked={choice.receive} onChange={event => patchLine(line.lineId, { receive: event.currentTarget.checked })} disabled={!canReview || busy || stockAlreadyReceived} title={!canReview ? 'Approval requires an owner or reviewer.' : stockAlreadyReceived ? `All ordered units were already received (${priorReceived}/${ext}).` : undefined} /> Receive stock</label>{stockAlreadyReceived && <small className="cell-sub">Ordered quantity already received ({priorReceived}/{ext} units).</small>}{choice.receive && <div className="purchase-stock-fields"><label>Units received<input type="number" min="1" max={ext > 0 ? Math.max(0, ext - priorReceived) : undefined} step="1" value={choice.receivedQuantity} onChange={event => patchLine(line.lineId, { receivedQuantity: event.target.value })} disabled={!canReview} /></label><label>Received at<input type="datetime-local" value={choice.receivedAt} onChange={event => patchLine(line.lineId, { receivedAt: event.target.value })} disabled={!canReview} /></label></div>}</td>
          </tr>;
        })}</tbody></table></div>
        <div className="purchase-totals"><span>Subtotal <b>{formatMoney(displayedSubtotal, displayCurrency)}</b></span><span>Discount <b>{formatMoney(displayedDiscount, displayCurrency)}</b></span><span>Tax <b>{formatMoney(displayedTax, displayCurrency)}</b></span><span>Shipping <b>{formatMoney(displayedShipping, displayCurrency)}</b></span><span>Other charges <b>{formatMoney(displayedOther, displayCurrency)}</b></span><span>Document total <b>{formatMoney(displayedDocumentTotal, displayCurrency)}</b></span></div>
        {(selected.effects ?? []).length > 0 && <section className="purchase-payment"><div><h3>Approved effects</h3><div className="purchase-credentials-list">{selected.effects!.map(effect => { const payload = effect.effect_payload; const kind = effect.effect_type === 'cost_update' ? 'Cost update' : effect.effect_type === 'stock_receipt' ? 'Stock received' : 'Cash payment'; const amount = typeof payload.amountMinor === 'number' ? formatMoney(payload.amountMinor, String(payload.currency ?? displayCurrency)) : typeof payload.unitCostMinor === 'number' ? `${formatMoney(payload.unitCostMinor, String(payload.currency ?? displayCurrency))} / unit` : null; const detail = effect.effect_type === 'stock_receipt' ? `${payload.quantity ?? '?'} units received` : effect.effect_type === 'payment' ? `${amount ?? 'Amount unavailable'} paid` : `${amount ?? 'Cost updated'}`; return <div className="purchase-credential-row" key={effect.id}><span><b>{kind} · {detail}</b><small>{effect.source_line_id.startsWith('payment:') ? 'Document payment' : `Source line ${effect.source_line_id}`} · ${new Date(effect.created_at).toLocaleString()} {effect.inventory_movement_id ? `· Inventory movement ${effect.inventory_movement_id}` : ''}{effect.cash_movement_id ? `· Cash movement ${effect.cash_movement_id}` : ''}</small></span></div>; })}</div></div></section>}
        <section className="purchase-payment"><div><h3>Payment</h3><p>Recorded: {formatMoney(priorPaidMinor, displayCurrency)} of {formatMoney(displayedDocumentTotal, displayCurrency)} · Extracted status: {selected.draft.payment?.status ?? 'unknown'}{selected.draft.payment?.fundingHint ? ` · ${selected.draft.payment.fundingHint}` : ''}{selected.draft.payment?.paidAt ? ` · ${selected.draft.payment.paidAt}` : ''}. Confirm actual payment; holds do not count. For card purchases, wait for bank settlement.</p><label className="purchase-effect"><input type="checkbox" checked={paid} onChange={event => setPaid(event.target.checked)} disabled={!canReview || !canRecordPayment || (displayedDocumentTotal != null && priorPaidMinor >= displayedDocumentTotal)} /> Record or link cash payment</label>{!canRecordPayment ? <small className="cell-sub">Payment needs a verified currency and document total. Ambiguous currency currently supports USD only.</small> : null}</div>{paid && <div className="purchase-payment-fields"><label>Amount paid<input inputMode="decimal" value={paidAmount} onChange={event => setPaidAmount(event.target.value)} disabled={!canReview} /></label><label>Paid at<input type="datetime-local" required value={paidAt} onChange={event => setPaidAt(event.target.value)} disabled={!canReview} /></label><label>Funding account<select value={accountId} onChange={event => { setAccountId(event.target.value); setExistingMovementId(''); }} disabled={!canReview}><option value="">Select account</option>{accounts.filter(row => row.currency === displayCurrency).map(account => <option key={account.id} value={account.id}>{account.name} · {account.kind ?? 'account'}</option>)}</select></label><label>Or link movement ID<input value={existingMovementId} onChange={event => { setExistingMovementId(event.target.value); if (event.target.value) setAccountId(''); }} placeholder="Movement UUID" disabled={!canReview} /></label></div>}</section>
        <label className="purchase-reason">Decision reason<textarea rows={3} minLength={10} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} placeholder="Cite the supplier document and the basis for the cost, receipt, or payment decisions." disabled={!canReview} /></label>
        {canReview && ['needs_review','approved','projection_pending','posted'].includes(selected.receipt.status) && <><label className="purchase-effect purchase-document-confirm"><input type="checkbox" checked={confirmPurchaseDocument} onChange={event => setConfirmPurchaseDocument(event.target.checked)} disabled={busy || matching} /> Confirm supplier receipt or invoice</label><div className="form-actions"><button type="button" className="secondary reject-button with-icon" disabled={busy || matching || selected.receipt.status !== 'needs_review'} onClick={() => void decide('reject')}><UiIcon name="reject" />Reject</button><button type="button" className="primary with-icon" disabled={busy || matching} onClick={() => void decide('approve')}><UiIcon name="check" />{busy ? 'Saving…' : selected.receipt.status === 'needs_review' ? 'Approve effects' : 'Approve pending'}</button></div></>}
        {!canReview && <p className="field-hint">Approval requires an owner or reviewer.</p>}
      </>}
    </section>}
    {canManageIntegration && <details className="purchase-integration-details"><summary><span>Power Automate integration</span><small>Manage credentials for unattended uploads</small></summary><section className="panel"><div className="panel-heading"><div><h2>Power Automate</h2><p>Can submit documents and read status; cannot approve financial effects.</p></div></div><div className="purchase-credential"><label>Credential name<input value={credentialName} maxLength={80} onChange={event => setCredentialName(event.target.value)} /></label><button type="button" className="secondary with-icon" onClick={() => void createCredential()} disabled={busy || !credentialName.trim()}><UiIcon name="plus" />Create</button></div>{newCredential && <div className="purchase-token"><p><b>Copy now.</b> This token is shown once. Store it in approved secret storage.</p><code>{newCredential.token}</code><button type="button" className="secondary with-icon" onClick={() => { void navigator.clipboard.writeText(newCredential.token).then(() => setNotice('Credential copied. Move it to the approved secret store, then remove it from the clipboard.')).catch(() => setError('Clipboard access is unavailable; select and copy the token manually.')); }}><UiIcon name="copy" />Copy</button></div>}{credentials.length > 0 && <div className="purchase-credentials-list">{credentials.map(credential => <div className="purchase-credential-row" key={credential.id}><span><b>{credential.name}</b><small>Created {credential.createdAt ? new Date(credential.createdAt).toLocaleString() : '—'}{credential.revokedAt ? ` · Revoked ${new Date(credential.revokedAt).toLocaleString()}` : ''}</small></span><span className={`pill ${credential.revokedAt ? 'bad' : 'good'}`}>{credential.revokedAt ? 'revoked' : 'active'}</span>{!credential.revokedAt && <button type="button" className="icon-button reject-button" onClick={() => void revokeCredential(credential.id)} disabled={busy} aria-label={`Revoke ${credential.name}`} title="Revoke credential"><UiIcon name="reject" /></button>}</div>)}</div>}</section></details>}
  </div>;
}
