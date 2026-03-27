# Blacklist 3.23B Remediation Plan

Date: 2026-03-27

## Target

Close the blacklist tracker gap against the active-address frozen total reported by `stables.rip`:

- reference total: `~$3.235B`
- reference records: `~9,466`
- reference scope: active `USDC` + `USDT` blacklist records on `ETH` + `TRON`

## Audit Findings

### 1. The current Pharos summary is event-centric, not active-address-centric

The existing blacklist summary aggregates:

- current unique blacklisted address counts
- destroyed totals
- recent event counts

It does **not** persist or expose an active blacklist ledger with one current frozen amount per address. That means the public summary cannot express the external `~$3.23B` figure cleanly even when the underlying event history is good enough.

### 2. Ethereum is already close under a latest-active-address model

Remote D1 spot checks against `blacklist_events` show:

- `USDT / Ethereum`: latest active amount total is already near the external reference
- `USDC / Ethereum`: small delta only

This makes Ethereum a lower-priority fix path than Tron.

### 3. Tron production still contains legacy `amount_source='derived'` blacklist balances

Remote D1 currently has thousands of Tron USDT blacklist rows with:

- `amount_source = 'derived'`
- `amount_status = 'resolved'`

Those values come from the old overloaded `amount` field and survived the `0076_blacklist_provenance_and_amount_semantics.sql` migration. The live sync no longer produces new Tron blacklist amounts this way, but the historical rows remain in production and materially skew totals.

### 4. New Tron blacklist events are now inserted with `amount_source='unavailable'`

That is safer for event-time semantics than using current account balance, but it means the tracker has no production path today to converge toward a current active frozen total for new Tron blacklist records.

### 5. The external reference is a blacklist-record ledger, not a raw event sum

`stables.rip` exposes one current `frozen_balance` per blacklist record. That balance appears to be:

- updated to the destroy amount when a later destroy event exists
- otherwise retained as the address-level frozen amount for the active blacklist record

This is distinct from Pharos' current `blacklist_events` event feed.

## Remediation Order

1. Add a persisted active blacklist address-state surface for summary math.
2. Feed that state from the existing event sync.
3. Add Tron current-balance enrichment for active blacklist addresses, separate from event-time event amounts.
4. Add a bounded remediation path for historical Tron legacy-derived rows / address states.
5. Update API/docs/UI/methodology to distinguish:
   - event-time amounts
   - current frozen totals for active blacklist records

## First Iteration Scope

- new D1 table for active blacklist address state
- worker helpers to upsert active state from blacklist/unblacklist/destroy events
- Tron current-balance fetch helper for active address state
- blacklist summary extension with active-address metrics:
  - `activeAddressCount`
  - `activeFrozenTotal`
- docs + methodology update for the new active-ledger semantics

## Verification Plan

1. unit tests for active-state transitions:
   - blacklist creates active row
   - destroy updates amount, keeps row active
   - unblacklist deactivates row
2. worker summary test for new stats fields
3. remote D1 remediation dry run
4. remote D1 metric comparison against `stables.rip`
5. full repo validation:
   - `npm run lint`
   - `npm test`
   - `npm run build`
   - `cd worker && npx tsc --noEmit`
   - `npm run test:merge-gate`
