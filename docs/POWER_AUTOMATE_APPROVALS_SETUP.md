# Power Automate Teams approvals

This integration uses a Power Automate cloud flow to post adaptive cards in
Teams and relay the response to Finance Loop. No Azure subscription or Azure
Bot Service resource is needed; there is no bot app registration, messaging
endpoint, or bot credential. You still need your existing Microsoft Entra
directory through a Microsoft 365 tenant with Teams and Power Automate, plus a
public HTTPS Finance Loop API.

This is separate from supplier receipt intake in
[`POWER_AUTOMATE_SETUP.md`](POWER_AUTOMATE_SETUP.md).

## Requirements

- Deploy the Finance Loop web/API release that includes this integration.
- Apply and verify the additive migration
  `202610080000_power_automate_action_approvals.sql` in the intended Supabase
  project. It depends on the operational foundation and action approval
  migrations. Check `npx supabase migration list` before applying migrations;
  this guide does not authorize a production schema change.
- Keep the Render worker on a compatible release so approved actions can run.
- In Teams, allow the **Workflows** app for the pilot users. Microsoft lists
  this app as a prerequisite for adaptive card flows.
- Confirm Power Automate licensing for the HTTP action. Microsoft's connector
  catalog currently lists HTTP with Microsoft Entra ID as Premium; licensing
  depends on the exact connector and flow plan used.

Microsoft documents the current Teams action as **Post an adaptive card as the
Flow bot to a Teams user, and wait for a response**. A wait action is required
to collect inputs; the card is posted in a direct chat with its named recipient.
See [Adaptive Cards in Power Automate](https://learn.microsoft.com/en-us/power-automate/overview-adaptive-cards),
[the Teams connector](https://learn.microsoft.com/en-us/connectors/teams/), and
[Power Automate connector licensing](https://learn.microsoft.com/en-us/connectors/webcontentsv2/).

## Link the reviewer in Finance Loop

1. As an owner, open **Settings → People and permissions → Teams identity
   links**.
2. Link the Finance Loop member to their Microsoft Entra tenant ID, Teams user
   object ID, and directory email. The object ID must be the reviewer's Entra
   user object ID, not their Teams display name.
3. Grant that member `approvals.read` and `approvals.decide`, with the needed
   location scope. Existing approval policies and the proposal-creator rule
   still apply.
4. In **Power Automate approvals**, choose that linked identity and create an
   integration. Each integration is bound to one reviewer. Copy the returned
   `flpa_...` token immediately; Finance Loop stores only its hash and shows the
   token once.

Create a separate integration for each reviewer. Treat the `flpa_...` value as
that reviewer's bearer credential: anyone who can read or change the flow and
its HTTP action can submit decisions as that reviewer. Restrict flow editors
accordingly and enable Secure Inputs/Outputs on every HTTP action that uses the
token. Secure Inputs/Outputs hide runtime values in run history; they do not
hide the configured bearer value from flow editors.

## Create the flow

Create an **Automated cloud flow** with a **Recurrence** trigger. Start with a
five-minute interval. Set trigger concurrency to one so multiple runs for the
same reviewer do not race. Each reviewer integration allows one outstanding
approval card at a time.

### 1. Claim the next approval

Add an **HTTP** action named `Get_next_action_approval`:

- Method: `GET`
- URI: `https://<active-vernius-host>/api/integrations/action-approvals/next`
- Header: `Authorization` = `Bearer <flpa token>`
- Header: `Accept` = `application/json`

Turn on **Secure Inputs** and **Secure Outputs** in this action's settings so
the bearer token and returned payload are hidden from run history. If the
response has `proposal` equal to `null`, terminate the flow successfully. When
there is a proposal, continue to the card action.

The response contains `recipientEmail`, `expectedResponder`, `proposal`, and
`card`. The API claims the proposal for up to 29 days. If a wait action fails or
times out, release it using the failure step below so a later run can retry.

### 2. Post the card and wait

Add the Microsoft Teams action **Post an adaptive card as the Flow bot to a
Teams user, and wait for a response**:

- Recipient: `recipientEmail` from `Get_next_action_approval`.
- Adaptive Card: `card` from `Get_next_action_approval`.
- Configure the replacement/update message to say that the decision was
  recorded. The Teams connector accepts only one response per card.

The Finance Loop card shows the exact proposal payload and evidence references,
and requires a reason. Its submit buttons include the decision and proposal ID.
Use the wait action's dynamic content for **decision**, **reason**, and the
responder's **User ID**. Do not fill the responder user ID from the expected
identity returned by Finance Loop. The API compares the ID supplied by the flow
with the linked Entra object ID; the flow must pass the Teams connector's
responder output. The responder tenant ID comes from
`expectedResponder.tenantId` in the claimed proposal response. In your first
pilot run, confirm that the wait action's user ID is the same Entra object ID
you linked in Finance Loop; a different ID is rejected.

### 3. Submit the decision

Add an **HTTP** action after the Teams wait action:

- Method: `POST`
- URI:
  `https://<active-vernius-host>/api/integrations/action-approvals/<proposal-id>/decision`
- Headers:
  - `Authorization`: `Bearer <flpa token>`
  - `Content-Type`: `application/json`
  - `Idempotency-Key`: use a stable value for this flow run, such as the
    expression below:

  ```text
  concat('pa:', body('Get_next_action_approval')?['proposal']?['id'], ':', workflow().run.name)
  ```

- JSON body. Insert the values using dynamic content from the two preceding
  actions:

  ```json
  {
    "decision": "<decision from the Teams wait action>",
    "reason": "<reason from the Teams wait action>",
    "expectedPayloadSha256": "<proposal.payloadSha256 from Get_next_action_approval>",
    "responderTenantId": "<expectedResponder.tenantId from Get_next_action_approval>",
    "responderTeamsUserId": "<responder User ID from the Teams wait action>"
  }
  ```

Enable **Secure Inputs** on the HTTP action. A successful response means the
decision was accepted by the approval state machine. Approved Square actions
are still executed asynchronously by the worker.

### 4. Release if the Teams wait fails

Add a second HTTP action configured to run after the Teams wait action fails or
times out:

- Method: `POST`
- URI:
  `https://<active-vernius-host>/api/integrations/action-approvals/<proposal-id>/release`
- Header: `Authorization` = `Bearer <flpa token>`

This releases the claim for another flow run. Do not release after the Teams
wait succeeded but the decision POST failed; allow Power Automate's retry to
reuse the same idempotency key. If the flow is canceled, the lease expires after
29 days and the pending proposal can be claimed again.

## Test in a pilot

1. Create a proposal from a different Finance Loop member than the linked
   reviewer.
2. Run the flow and confirm the reviewer receives the card in a direct Teams
   chat with the Flow bot.
3. Submit an approval with a reason of at least ten characters. Check the
   proposal and audit history in Finance Loop.
4. Repeat with a rejection. Confirm a second submission on the same card is
   ignored by Teams and the proposal cannot be decided a second time.
5. Confirm approved actions complete through the Render worker and verify the
   result in the Finance Loop UI.

If the responder ID supplied by the flow does not match the linked object ID,
the API returns `FORBIDDEN`. If an approval is no longer pending, expired, or stale, the
API returns a conflict and the reviewer should refresh the Finance Loop app.
The standard Finance Loop web approval remains available if a flow is
unavailable.
