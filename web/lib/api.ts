'use client';
import { browserSupabase } from './browser-supabase';

export type ApiError = { error: string; code?: string };
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data: { session } } = await browserSupabase().auth.getSession();
  if (!session?.access_token) throw new Error('Your session has expired. Sign in again.');
  const headers = new Headers(init.headers);
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData;
  if (init.body && !isFormData && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  headers.set('Authorization', `Bearer ${session.access_token}`);
  const response = await fetch(path, {
    ...init,
    headers,
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({})) as { data?: T; error?: string | { code?: string }; code?: string; detail?: string };
  if (!response.ok) {
    if (typeof body.detail === 'string') throw new Error(body.detail);
    const detail = typeof body.error === 'string' ? body.error : body.error?.code;
    throw new Error(detail || `Request failed (${response.status}).`);
  }
  return (body.data ?? body) as T;
}

export type Dashboard = {
  organization?: { id: string; name: string; timezone?: string };
  period?: { from: string; to: string; currency?: string };
  projectionVersion?: string;
  freshness?: { lastSyncedAt?: string | null; status?: string };
  income?: { netSalesMinor?: number; grossItemSalesMinor?: number; discountsMinor?: number; refundsMinor?: number; cogsMinor?: number | null; squareFeesMinor?: number; operationalMarginMinor?: number | null; giftCardLiabilityChangeMinor?: number | null; giftCardActivationsMinor?: number; giftCardLoadsMinor?: number; giftCardRedemptionsMinor?: number; status?: string; currency?: string; lines?: Array<Record<string, unknown>> };
  cash?: { expectedBalanceMinor?: number; observedBalanceMinor?: number | null; discrepancyMinor?: number | null; status?: string; currency?: string };
  accounts?: Array<{ id: string; name: string; currency: string; kind?: string }>;
  flags?: Array<{ code: string; message: string; severity?: string }>;
};
export type Issue = { id: string; code?: string; state: string; title?: string; details?: Record<string, unknown>; source_refs?: string[]; updated_at?: string; revision?: number; proposal_supported?: boolean; proposals?: Array<{ id: string; decision: string; revision?: number; proposal?: unknown; payload?: unknown }> };
export type Movement = { id: string; kind: string; amount_minor: number; currency: string; occurred_at: string; description: string; evidence_ref?: string | null; account_id: string };
export type AuditEvent = { id: string; event_type?: string; action?: string; actor_id?: string; actor_user_id?: string | null; actor_kind?: string; entity_type?: string; entity_id?: string | null; created_at: string; reason?: string; payload?: Record<string, unknown>; details?: Record<string, unknown>; source_refs?: string[]; revision?: number };
export type FinancialEvent = { id: string; eventType: string; status: 'draft' | 'posted' | 'incomplete' | 'superseded'; occurredAt: string; amountMinor: number | null; currency: string; description: string; locationId?: string | null; sourceProvider?: string | null; sourceType?: string | null; sourceId?: string | null; sourceVersion?: string | null; supersedesEventId?: string | null; details?: Record<string, unknown>; lines?: Array<{ lineNumber: number; variationId?: string | null; description: string; quantity?: number | null; unitAmountMinor?: number | null; amountMinor?: number | null; currency: string }> };
