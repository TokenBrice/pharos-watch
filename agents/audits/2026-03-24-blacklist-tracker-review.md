# Blacklist Tracker Review

Date: 2026-03-24
Scope: docs, worker ingestion, backfill, API, status/health, digest consumers, frontend page and helpers, existing tests

## Executive Summary

The Blacklist Tracker is already stronger than a typical "event feed" implementation: it has explicit methodology versioning, cursor safety margins, partial-coverage handling, and a visible health model for missing amounts. The weakest parts are not the basic event scans. They are:

1. backfill/config identity, which can mis-handle multi-contract assets and directly hurts amount attribution
2. schema and domain modeling gaps, which make the tracker harder to extend cleanly
3. downstream amount semantics, where token-native values are sometimes treated as USD
4. a coverage model/UI contract mismatch around `EURC`
5. tests that mostly exercise the happy path and do not pin the tricky cases the system is now exposed to

The highest effort/return remediation path is:

1. fix config identity and persist contract-level provenance
2. normalize amount semantics into explicit token-native and USD fields
3. consolidate event-family/config modeling so adding assets is data work, not bespoke code work
4. then expand coverage, with `EURC` as the obvious first candidate once ABI/event parity is verified

## What Is Working

- Methodology versioning is first-class and correctly surfaced through docs, API, and page shell.
- EVM cursor advancement is deliberately conservative and avoids silent event loss on partial coverage.
- Backfill is prioritized ahead of incremental scans, which is the right tradeoff for user-visible data quality.
- The worker already distinguishes "no events" from provider failure on EVM.
- Health/status surfaces expose missing-amount risk instead of silently hiding it.

## Confirmed Weaknesses

### 1. Backfill can resolve the wrong contract config for multi-contract assets

Severity: high
Goal impact: accuracy, maintainability

The backfill path resolves a row back to a contract config using only `(chain_id, stablecoin)`:

- [worker/src/cron/sync-blacklist.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-blacklist.ts#L357)

That is not unique anymore. `USDT` on Optimism has both legacy and `USDT0` configs:

- [worker/src/lib/blacklist-contracts.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/blacklist-contracts.ts#L237)
- [worker/src/lib/blacklist-contracts.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/blacklist-contracts.ts#L238)

Consequences:

- destroy-log recovery can inspect the wrong contract receipt logs
- `balanceOf` backfill can hit the wrong token contract
- amount recovery quality degrades exactly on the assets/chains where coverage is getting more complex

This is the most important correctness flaw in the current implementation.

Root cause:

- `blacklist_events` does not persist `contract_address`, `config_key`, or event-family metadata
- the runtime reconstructs provenance from incomplete row data

Recommended fix:

- persist `contract_address` on insert
- preferably also persist `config_key` and `event_signature` or `event_source_family`
- backfill should resolve config by `config_key` or `(chain_id, contract_address)`, never by symbol alone

### 2. The schema is missing provenance needed for reliable reprocessing and future expansion

Severity: high
Goal impact: accuracy, maintainability, coverage expansion

Current row shape:

- [worker/src/cron/blacklist/shared.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/blacklist/shared.ts#L4)
- [docs/blacklist-tracker.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/blacklist-tracker.md)

Missing from persisted rows:

- emitting contract address
- config key
- raw event signature/topic
- whether amount came from event data vs historical balance lookup
- whether amount is token-native or normalized USD

Consequences:

- backfill has to guess config identity
- auditability is weaker than it should be
- downstream consumers cannot distinguish exact amount provenance
- coverage expansion multiplies edge cases because row semantics stay under-specified

Recommended fix:

- add explicit provenance columns
- make `amount_source` an enum such as `event`, `historical_balance`, `derived`, `unavailable`
- keep token-native amount canonical and add a separate USD-normalized field when needed

### 3. Amount semantics are inconsistent across ingestion, API, UI, and digest consumers

Severity: high
Goal impact: accuracy

The API documents `amount` as token-native:

- [docs/api-reference.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md)

That is broadly true at ingestion. But downstream code often treats it as USD:

- table uses `formatCurrency(evt.amount)` for non-gold assets:
  [src/components/blacklist-table.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/blacklist-table.tsx#L138)
- digest sums `amount` into `totalAmountUsd` without gold conversion:
  [worker/src/cron/daily-digest/collectors.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest/collectors.ts#L86)
- chart converts gold using current frontend prices, not event-time prices:
  [src/components/blacklist-chart.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/blacklist-chart.tsx#L50)
- stats convert gold destroyed amounts using current frontend prices:
  [src/lib/blacklist-helpers.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/blacklist-helpers.ts#L68)

Consequences:

- `amount` is overloaded
- gold-asset totals are not historically accurate
- digest ranking/thresholds are distorted for PAXG/XAUT
- UI labels like "USD value" rely on current market prices, not event-time valuation

Recommended fix:

- define canonical fields:
  - `amountNative`
  - `amountUsdAtEvent` when computable
  - `amountUsdCurrent` only for clearly labeled UI-only views if still desired
- stop calling token-native `amount` "USD" downstream
- push normalization into shared worker-side helpers instead of recomputing ad hoc in the frontend

### 4. `EURC` is modeled as supported in shared types and UI, but not ingested

Severity: medium-high
Goal impact: accuracy, maintainability, coverage expansion

Shared enum and page filters include `EURC`:

- [shared/types/market.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/types/market.ts#L369)
- [src/app/blacklist/page.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/blacklist/page.tsx#L27)

Live contract registry does not:

- [worker/src/lib/blacklist-contracts.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/blacklist-contracts.ts#L225)

The docs explicitly acknowledge the mismatch:

- [docs/blacklist-tracker.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/blacklist-tracker.md)
- [docs/api-reference.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md)

Consequences:

- public contract is misleading
- UI and helper code carry dead branches (`EURC` cards, chart buckets, stats)
- it becomes harder to reason about "supported" vs "planned"

Recommended fix:

- split `SUPPORTED_BLACKLIST_STABLECOINS` from `PLANNED_BLACKLIST_STABLECOINS`, or
- fully ingest `EURC` and remove the mismatch

Given the current product copy and shared metadata already present for `EURC`, enabling real coverage is likely the cleaner end state.

### 5. Event fetching is more bespoke than it needs to be

Severity: medium
Goal impact: maintainability, LOC reduction, coverage expansion

`fetchEvmEventsIncremental()` scans each topic separately:

- [worker/src/cron/blacklist/evm-source.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/blacklist/evm-source.ts#L178)

But the repo already has compound-topic fetch support:

- [worker/src/lib/evm-logs.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/evm-logs.ts#L179)

Consequences:

- extra provider calls per contract
- more timestamp-resolution fan-out
- higher LOC and more branching for every new event family
- new asset onboarding remains code-heavy

Recommended fix:

- move to event-family descriptors that can fetch all topic0 variants for a contract in one pass
- parse logs by topic hash after fetch
- centralize address/amount decode rules per event family

This is one of the best maintainability wins because it simultaneously reduces request count and simplifies future coverage work.

### 6. Frontend derives too much from the full history payload client-side

Severity: medium
Goal impact: maintainability, future scalability

The page hydrates the full blacklist history, then filters/paginates client-side:

- [src/lib/blacklist-api.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/blacklist-api.ts#L56)
- [src/app/blacklist/page.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/blacklist/page.tsx#L131)

Consequences:

- expanding coverage directly increases frontend payload and page work
- API pagination exists, but the main page defeats it by walking all pages
- stats/chart/filter derivation cannot easily move server-side because there is no shared blacklist domain layer

Recommended fix:

- keep `/api/blacklist` paginated and filterable for the table
- add dedicated summary endpoints or worker-computed aggregates for stats/chart
- share derived helpers in `shared/lib` or worker-side response builders rather than re-deriving in the page

This is not the first thing to fix for correctness, but it becomes important once coverage expands beyond the current set.

### 7. Address-state stats have ambiguous semantics

Severity: medium
Goal impact: accuracy

`computeBlacklistStats()` aggregates "currently blacklisted" counts by raw address string only:

- [src/lib/blacklist-helpers.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/blacklist-helpers.ts#L42)

Open questions in current behavior:

- same `0x...` on two EVM chains is counted once
- same address across different issuers can offset in `allAddresses`
- chain is ignored in "unique addresses" cards

This may be intentional, but it is not clearly defined methodology. Right now the implementation chooses one interpretation implicitly.

Recommended fix:

- decide whether the unit is `address`, `address+chain`, or `address+chain+asset`
- encode that choice in shared helper naming and methodology text
- add tests that lock the chosen semantics

### 8. Missing-amount monitoring is good, but backfill targeting can be smarter

Severity: medium
Goal impact: accuracy, efficiency

Backfill currently selects recent `amount IS NULL` rows only:

- [worker/src/cron/sync-blacklist.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-blacklist.ts#L324)

It does not persist why the amount is missing, so the scheduler cannot prioritize the recoverable subset:

- recoverable because wrong contract chosen
- recoverable because archive provider was down
- unrecoverable by design on Tron blacklist/unblacklist today

Recommended fix:

- persist `amount_source` and `amount_status`
- backfill only rows with `amount_status = recoverable_pending`
- keep intentionally-unavailable cases out of the retry loop and out of operator noise

### 9. Test coverage is shallow on the hard parts

Severity: medium
Goal impact: accuracy, maintainability

The focused suite passes:

- `npm test -- --run worker/src/cron/__tests__/sync-blacklist.test.ts worker/src/api/__tests__/blacklist.test.ts worker/src/lib/__tests__/blacklist-contracts.test.ts src/lib/__tests__/blacklist-api.test.ts src/components/__tests__/blacklist-table-logic.test.ts`

But the current tests do not pin:

- multi-config same-symbol same-chain backfill resolution
- `USDT` legacy vs `USDT0` receipt parsing
- amount provenance semantics
- gold event-time vs current-price valuation
- frontend stat semantics across chain/address collisions
- incomplete timestamp resolution on RPC log scans beyond generic partial-coverage handling

Recommended fix:

- add table-driven fixtures for real multi-family contracts
- add one end-to-end blacklist fixture path that covers ingest -> persist -> API map -> UI helper
- add regression tests for every bug fixed in this review, especially config identity

## Amount Attribution: How Much Better Can It Get?

## Current state

- EVM destroy events: mostly solvable from emitted event data or `balanceOf(block-1)`
- EVM blacklist/unblacklist: solvable only when archive state is available
- Tron destroy: solvable from emitted event payload
- Tron blacklist/unblacklist: intentionally unresolved today

Relevant implementation:

- [worker/src/cron/sync-blacklist.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-blacklist.ts#L197)
- [worker/src/cron/blacklist/balance-providers.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/blacklist/balance-providers.ts)

## Improvements that are clearly feasible

### 1. Fix wrong-config backfill first

This should recover some currently missed amounts with no new provider dependency.

### 2. Persist amount provenance

This lets you measure exactly where attribution fails:

- archive node unavailable
- wrong contract
- no historical state source
- event has no amount and chain does not support historical reads

Without this, improvement work stays anecdotal.

### 3. Precompute USD-at-event where price source is deterministic

For USD assets this is straightforward.
For gold assets, event-time valuation can be approximated from the pricing history already maintained elsewhere in the system if the data exists for those timestamps. If pricing history is too sparse, store `amount_native` and leave `amount_usd_at_event` null instead of silently using current gold price as if it were historical.

## Improvements that look limited or conditional

### Tron blacklist/unblacklist attribution

The current code is conservative for a good reason:

- [worker/src/cron/sync-blacklist.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-blacklist.ts#L219)

Official TRON docs expose:

- `GetBlockBalance`, which returns block balance change operations but requires historical-balance support on specific nodes
- `eth_call` / `triggerConstantContract`, but the official docs do not present this as a straightforward arbitrary-historical TRC20 state query path comparable to archive `eth_call` on EVM

Sources:

- https://developers.tron.network/reference/getblockbalance
- https://developers.tron.network/reference/eth_call

Inference:

- there may be niche reconstruction approaches with special TRON nodes or ledger-delta replay, but there is no obvious low-complexity, high-confidence equivalent to the EVM `balanceOf(block-1)` path
- this makes Tron blacklist/unblacklist valuation a poor first target compared with fixing EVM provenance and config identity

## Highest Effort/Return Coverage Expansion Path

### Recommendation: make coverage additions data-driven, then add `EURC`

Why `EURC` first:

- it is already in shared types and product copy
- shared stablecoin metadata already contains contract deployments:
  [shared/data/stablecoins/non-usd.json](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/non-usd.json#L81)
- the UI already anticipates it, so finishing support removes an existing product mismatch
- Circle event families are likely close to the current USDC path, so implementation cost should be low once the contract/config model is cleaned up

Why not expand before refactoring:

- current backfill identity is already wrong for multi-config assets
- every new asset adds more bespoke config/event branching
- frontend full-history hydration gets more expensive immediately

Practical sequence:

1. persist `contract_address` + provenance
2. refactor event-family descriptors and shared parsing
3. validate `EURC` ABI/event parity
4. enable `EURC` on the relevant chains
5. only then consider long-tail assets or more exotic freeze models

## Recommended Remediation Plan

### Phase 1: correctness hardening

- Add `contract_address`, `config_key`, `amount_source`, `amount_status`
- Resolve backfill by persisted config identity
- Split token-native vs USD amount semantics
- Add regression tests for multi-config `USDT`

Expected return:

- immediate improvement to amount attribution
- stronger auditability
- lower risk when touching the tracker again

### Phase 2: domain cleanup and LOC reduction

- Replace per-topic scan loops with event-family fetch + parse descriptors
- Move blacklist-specific derivations into a shared domain module
- Remove dead `EURC` branches or convert them to real support

Expected return:

- lower request count
- simpler onboarding for new assets/chains
- less frontend-only logic

### Phase 3: coverage expansion

- Add `EURC` after ABI verification
- Add summary endpoints/server-side aggregates if dataset size starts to pressure the page
- Reassess whether any additional Paxos/Tether/Circle assets warrant inclusion

### Phase 4: optional research track

- investigate specialized TRON historical-state options only after the above is done
- proceed only if a source provides reproducible event-time token balances, not best-effort current-state approximations

## Suggested New Tests

- worker cron regression: `USDT` Optimism legacy vs `USDT0` backfill resolution
- worker cron regression: destroy-amount recovery uses persisted `contract_address`
- worker API contract: `amount_source` and `amount_status` are surfaced correctly
- shared/frontend helper: address count semantics for same address across multiple chains
- shared/frontend helper: gold valuation does not silently use current price when a historical USD field is absent
- integration fixture: ingest mixed blacklist/unblacklist/destroy rows and assert stats/chart/table outputs from the same source data

## Bottom Line

The best near-term move is not "add more assets". It is "make each event row self-describing enough that backfill, attribution, and future expansion stop depending on inference." Once that is done, `EURC` is the clear highest-return expansion candidate, and some currently unattributed EVM amounts should recover automatically as a side effect of fixing config identity.
