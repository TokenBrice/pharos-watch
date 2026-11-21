# Runbook: Partner API Key Issuance

Procedure for issuing and retiring operator-issued partner API keys (internal tier `standard`): free-partner keys (`plan = "free_partner"`), commercial keys (`plan = "commercial"`, at `COMMERCIAL_API_KEY_USD_PER_MONTH` per month), and institutional keys (`plan = "institutional"`). Route contracts live in the [admin reference](../api-reference-admin.md); published limits in [Rate Limits](../api-reference.md#rate-limits); access terms at `/api/terms/`. Supporter (donor) keys are claimed by wallets on `/api/`, not issued here.

## Issue

1. Confirm the request through the private channel (Telegram primary, X secondary; handles in `shared/lib/public-api-contract.ts`). The test for a free key is the service, not the entity: it must be free to its users. Agree the term and price in writing before issuing.
2. Create the key through the API Management workspace (or `POST /api/api-keys`) with the ops-form presets: **Free partner** (`plan = "free_partner"`, 60/min, plan-default monthly quota of 500,000), **Commercial** (`plan = "commercial"`, 120/min, plan-default monthly quota of 1,000,000), or **Institutional** (`plan = "institutional"`, 600/min, plan-default monthly quota of 5,000,000); higher limits on explicit request. Leave `monthlyRequestQuota` empty to keep the plan default unless a custom override was agreed. Set `expiresAt` to the paid term end (plus any agreed grace) — not the form's 90-day default, which ends paid terms early; creation rejects an `expiresAt` at or before now. Set `ownerEmail` so the holder is contactable.
3. Deliver the plaintext token exactly once, through a single-view expiring secret link (Bitwarden Send or 1Password). Never paste a raw key into chat or email: deleting the message does not un-leak it, and the create response shows the token only once (`tokenUnavailableOnReplay`).
4. Record the payment reference (transaction hash, term, price) privately, never in the public ledger, issues or commit messages. At the funding reconciliation, approve the payment as kind `revenue`: revenue rows never count as donations, never appear on the donor wall or community totals, and never grant supporter-key eligibility.

## Plan Backfill And Entitlement Fail-Closed Rule

- `api_keys.plan` (`free_partner`, `commercial`, `institutional`) is the sole authority for paid-endpoint entitlements. A `standard` key with `plan = NULL` fails closed on paid endpoints (`403` with `reason: "plan_upgrade_required"`) regardless of its `rateLimitPerMinute`, while keeping legacy rate-based monthly quota defaults (`>= 120/min` → 1,000,000/month, else 500,000/month).
- Non-standard keys (`tier = "donor"` and retired `tier = "self-serve"`) always carry `plan = NULL` and are rejected if an update attempts to assign a non-null plan; changing a key's `tier` away from `"standard"` clears `plan = NULL` automatically. First-party `trafficClass = "site"` keys bypass plan gating.
- **Required operator backfill after migration `0320` deploys (before paid endpoints ship):** open `/admin-api`, switch **Status** to **All statuses** and **Plan filter** to **Plan unset**, and assign an explicit `plan` on every active `standard` key (`commercial` or `institutional` for paying keys; `free_partner` for grandfathered free partners). Repeat until the **Plan unset** filter shows no active standard keys remaining.

## Renewal

Put the term's T-14 date in the owner's calendar when the key is issued; there is no automated reminder. Renewal is a new term at the published price, paid in stablecoins only to the addresses published on `/funding/`, never to an address sent by direct message. Extend `expiresAt` before it lapses; after expiry the key stops authenticating, and a lapsed key is re-issued fresh rather than argued back to life.

## Re-issue on leak

- No-downtime path: create a *second* key, deliver it by secret link, and deactivate the old one (`POST /api/api-keys/:id/deactivate`) once the holder confirms cutover. Both keys work during the handover window; the audit trail shows two `created` rows and one `deactivated`.
- `POST /api/api-keys/:id/rotate` rotates the existing key in place and cuts over instantly with no overlap — the old token stops working the moment rotation commits — so use it only for planned rotations where the holder can swap immediately. Plaintext is returned once.
- A leaked key reported through the private channel is re-issued the same day; feedback issues and public channels never carry tokens.

## Revoke

Deactivation is immediate on the D1-backed path; protected cacheable edge-cache hits follow within about five seconds (the isolate auth-cache TTL). Deactivation does not erase the row, name or usage metadata — for full erasure requests follow the donor-style deletion procedure in the [admin reference](../api-reference-admin.md#post-apiapi-keysiddeactivate).

## Onboarding message

Send after issuance, with the secret link separate from this text:

- the secret link (single view; copy the key server-side and store it in the holder's secret manager)
- expiry date and the renewal path
- their rate and monthly volume, and how limits behave: fixed 60-second windows aligned to the clock, `429` with `Retry-After`, monthly volume counted per UTC calendar month (enforced from 2027-01-01, reset on the 1st)
- a five-call smoke test, all with `X-API-Key`:
  1. `GET /api/health`
  2. `GET /api/stablecoins`
  3. `GET /api/stablecoin/usdc-circle`
  4. `GET /api/depeg-events?active=true&limit=5`
  5. `GET /api/snapshots/index`
- server-side use only: CORS allows just the Pharos origins, so the key never goes into browser code or public repositories
- a human reply within `PARTNER_KEY_REPLY_BUSINESS_DAYS` (2) business days; `/status/` for service health; `/api/terms/` for the terms of use
