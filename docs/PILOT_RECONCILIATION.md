# Pilot reconciliation checklist

This is a controlled parallel-run procedure for one merchant and a bounded set of accounts/periods. No live pilot has been performed. Obtain merchant and accounting-adviser approval of the policies below before using real data. The tool is an operational subledger/reconciliation aid, not a replacement for the merchant's books or tax advice.

## Pilot entry gate

- [ ] Name the merchant, location(s), Square account, bank/cash account(s), timezone, currency, and pilot owner.
- [ ] Select a period with complete Square and bank evidence; define local start/end cutoff and treatment of activity around midnight/timezone changes.
- [ ] Record opening balance and its evidence for each account. Define reconciliation tolerance in minor units and who approves it.
- [ ] Sign off reporting basis, inventory cost method, cost effective dates, tax/tip/discount/gift card/refund treatment, fees, chargebacks/holds, transfers, and failed payouts. Record unresolved policy items as excluded from pilot calculations.
- [ ] Assign operator, independent reviewer, read-only participant, escalation contact, and approval thresholds. Confirm no user can approve their own high-risk proposal.
- [ ] Verify auth/RLS, source freshness, evidence storage, backup, alerts, incident process, and deterministic replay in the target environment before loading merchant data.
- [ ] Export baseline Square reports and bank statement/evidence. Record source file IDs/checksums and export timestamps in the pilot record.

## Per-period procedure

1. Freeze and record the reporting cutoff, timezone, account, currency, opening observation, policy version, and application/calculation release.
2. Sync Orders, Payments, Refunds, Catalog, Payouts, and payout entries through the cutoff plus agreed overlap. Confirm pagination complete, last sync fresh, and no permission or webhook gaps. If source is stale/incomplete, stop and mark period not ready.
3. Compare source object counts and amounts to Square exports by object family and currency. Investigate missing/duplicate IDs and version ordering before evaluating margin.
4. Check order-to-payment/refund joins and catalog variation IDs. Review unknown costs and ambiguous classifications. Do not treat absent item cost as zero; mark margin incomplete. For a line with neither an item name nor catalog variation, review the merchant-approved pass-through cost derived from Square's supported unit price and retain the assumption in the approval trail.
5. Reconcile cash by named account: opening balance + actual account inflows − actual outflows ± explicitly approved adjustments = expected ending balance. Match Square payout entries to their payout and destination. Do not count a payout as sales or subtract COGS again when the inventory purchase is already a cash movement.
6. Compare expected ending balance with bank statement or observed balance in the same currency and cutoff. List each unmatched payout, fee, deposit, purchase, payroll/miscellaneous spend, transfer, timing item, and evidence link. Internal transfers must be paired or flagged as incomplete.
7. For every discrepancy, create an issue with source IDs and evidence. An agent may draft a proposal only; a human reviewer inspects evidence, reason, amount, date, account, and currency. Never post a balancing plug solely to reach zero.
8. Recompute from source facts after approved classification/correction. Compare rerun hash/totals and check no duplicate facts or COGS double deduction.
9. An independent reviewer signs the period only when sync is fresh, sources are complete, exceptions have documented disposition, and all remaining variance is within the agreed tolerance with a reason.
10. Export the report, calculation version, source manifest, exception list, approval/audit trail, and reviewer sign-off. Preserve a copy according to the approved retention policy.

## Comparison worksheet

| Measure | Finance Loop result | Independent source | Difference | Explanation/evidence | Reviewer |
|---|---:|---:|---:|---|---|
| Completed orders / gross item sales |  | Square order export |  |  |  |
| Discounts / taxes / tips / gift cards (separate lines) |  | Square reports/policy |  |  |  |
| Refunds / chargebacks |  | Square refund/payment export |  |  |  |
| Processing fees |  | Square payout entries |  |  |  |
| Payouts by destination account |  | Square payout report + bank |  |  |  |
| Opening balance |  | Bank statement/observation |  |  |  |
| Manual inflows/outflows and transfers |  | Receipts, invoices, payroll/bank docs |  |  |  |
| Expected and observed ending balance |  | Bank statement |  |  |  |
| COGS and operational margin |  | Approved cost source / independent calculation |  |  |  |

## Pilot exit gate

- [ ] Run at least two consecutive statement periods (or a merchant/accountant-approved sample sufficient to cover known edge cases).
- [ ] Explain every difference; record policy limitations and excluded activities.
- [ ] Confirm duplicate and reordered delivery does not alter final totals; confirm replay produces the same result for same source/policy version.
- [ ] Confirm no unresolved currency mismatch, source gap, stale sync, unapproved high-risk entry, or unexplained out-of-tolerance balance remains.
- [ ] Merchant and independent accounting adviser sign the comparison and approve any remaining operational limitation.
- [ ] Record go/no-go decision, named approver, date, period coverage, and follow-up owners. A pilot result is not a general accounting assurance.
