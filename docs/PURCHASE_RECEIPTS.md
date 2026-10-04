# Supplier purchase receipt inbox

Finance Loop accepts supplier receipts and invoices through one intake path, whether a person uploads a file in the workspace or Power Automate submits it. Intake creates evidence and a durable processing job. It does not approve costs, receive stock, or record a payment.

## Review boundary

The worker extracts a versioned draft from the uploaded PDF, JPEG, or PNG. Draft values are suggestions tied to the source document; they are not ledger facts. A member reviews the private source file and each line, then an owner or reviewer submits explicit selections for approved cost changes, received quantities, and actual payments. Each effect is independently optional, so an unpaid bill or undelivered order can remain pending and be reviewed later. Repeating requests uses the same submission ID or approval idempotency key and cannot duplicate an effect.

For every line, confirm the Finance Loop inventory item or Square variation, package quantity, units per package, exact goods line amount, suggested rounded unit cost, and any rounding difference. Assortments need an explicit inventory mapping. Do not infer tax, shipping, or other charges as item cost. The document total and its component totals remain visible for reconciliation.

Cost selection includes synchronized Square variations that have never sold. If a variation has no approved cost definition yet, approve its first cost, refresh the receipt, then select the resulting inventory item to receive stock. Manual inventory items can be received directly with a supported unit acquisition cost.

Stock receipt records require the quantity actually received and receipt time. A cost update requires a supplier-supported unit acquisition cost and effective date. A payment record requires the actual paid amount, date, and funding account, or a link to an existing movement. An authorization hold is not a payment. A credit-card purchase does not reduce checking; record the card payment separately, and do not duplicate a later settlement already in cash movements.

If the document does not print an unambiguous currency, the reviewer must confirm it. Payment approval can convert a preserved decimal total to cents after explicit USD confirmation. For other currencies, payment remains pending unless extraction supplied a valid currency and total in minor units; the original document and amounts remain available for review.

Every decision records the actor, draft version, reason, idempotency key, source evidence, and selected effects. Projection work is queued after approval; the UI should show `projection pending` until it finishes. Rejected and clarification-required documents remain auditable. Never discard an extraction mismatch or use a balancing adjustment to make totals agree.

## Intake API

Human uploads use the signed-in member's Supabase session. Integration uploads use a dedicated per-organization bearer token which can submit documents and read processing status only. The organization is bound to the integration token and is never accepted as an authorization claim from the flow.

Power Automate calls:

1. `POST /api/integrations/purchase-receipts` with `{ "externalSubmissionId", "filename", "contentType" }`, `Authorization: Bearer <integration-token>`, and a stable `Idempotency-Key` header derived from the external submission ID.
2. If status is `awaiting_upload`, upload the original binary bytes with `PUT` to the returned `upload.url`, set `Content-Type` to the returned MIME type and `x-upsert: false`. The signed URL already contains its upload authorization; do not add the integration bearer token to the storage request. If a retry returns a receipt that is already queued or processing, use that existing receipt and do not upload another object.
3. `POST /api/integrations/purchase-receipts/{receiptId}/complete` with JSON body `{}` to verify and queue processing.
4. `GET /api/integrations/purchase-receipts/{receiptId}` to poll `status` and obtain the review link when ready.

Repeat a submission with the same stable `externalSubmissionId` after a timeout. The API returns the same receipt and upload state. Do not create a new ID for a retry. Check HTTP response bodies for an upload failure before calling `complete`.

Workspace users register an upload with `POST /api/purchase-receipts` using their Supabase bearer token and `{ organizationId, externalSubmissionId, filename, contentType }`, then upload the file with the returned signed `PUT` URL and call `POST /api/purchase-receipts/{receiptId}/complete` with `{ organizationId }`. The UI follows this same path. The private source link is short-lived and only issued after membership authorization.

## Workflow states

`awaiting_upload → queued → processing → needs_review → approved → projection_pending → posted`

`duplicate`, `rejected`, and `failed` need explicit handling; duplicates link to the prior receipt and must not be posted again. Delivery and payment are separate from intake status and can remain pending after the document has been approved. A completed upload or successful processing job does not mean the resulting accounting projection is ready.

## Deployment prerequisites

- Apply the new ordered receipt migrations only after reviewing their scope and verifying the linked Supabase project. Do not use production `db push` as a local validation step.
- Deploy the compatible web/API and Render worker release together. Configure document parsing/OCR dependencies and the bounded extraction budget in the worker environment before enabling intake.
- Confirm the private evidence storage policy, signed-upload expiry, actual-byte limits, content validation, and monitoring in the target environment.
- Pilot with duplicate deliveries, scanned and text PDFs, arithmetic mismatches, discounts, partial deliveries, unpaid bills, credit cards, retry/timeouts, cross-tenant access, and worker failure/replay. Compare against the supplier document and bank/card records before relying on reports.

Power Automate flow construction is documented in [POWER_AUTOMATE_SETUP.md](POWER_AUTOMATE_SETUP.md).
