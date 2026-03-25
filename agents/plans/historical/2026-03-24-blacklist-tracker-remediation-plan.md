# Blacklist Tracker Remediation Plan

Date: 2026-03-24
Input: [blacklist tracker review](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-03-24-blacklist-tracker-review.md)
Goal: execute on all audit findings with the best accuracy/maintainability payoff first, while treating `EURC` as a gated expansion that ships only if the mirrored-zero-noise problem is solved cleanly

## Objectives

1. Make blacklist data attribution more accurate and auditable.
2. Make the implementation easier to maintain and cheaper to extend.
3. Create a coverage-expansion path that does not compound current schema and modeling weaknesses.
4. Re-enable `EURC` only if we can preserve signal quality.

## Delivery Strategy

Use four sequential workstreams:

1. Correctness and schema hardening
2. Amount semantics and downstream consumer cleanup
3. Ingestion/domain simplification for maintainability and lower LOC
4. Coverage expansion, with `EURC` behind a hard decision gate

Do not start broad coverage expansion before Workstreams 1 and 2 are complete.

## Workstream 1: Correctness And Provenance Hardening

Findings covered: 1, 2, 8, 9

### Scope

- `worker/src/cron/sync-blacklist.ts`
- `worker/src/cron/blacklist/shared.ts`
- `worker/src/cron/blacklist/evm-source.ts`
- `worker/src/cron/blacklist/balance-providers.ts`
- `worker/src/lib/blacklist-contracts.ts`
- `worker/src/lib/blacklist-gaps.ts`
- `worker/src/api/blacklist.ts`
- `shared/types/market.ts`
- `worker/migrations/*`
- blacklist cron/API tests

### Phase 1A: Persist Contract-Level Provenance

- Add new `blacklist_events` columns:
  - `contract_address`
  - `config_key`
  - `event_signature`
  - `event_topic0`
  - `amount_source`
  - `amount_status`
- Keep `amount` temporarily for backward compatibility during migration, but treat it as a legacy field to be renamed or replaced in Workstream 2.
- Write these fields at ingestion time for all new rows.
- Backfill provenance where it can be deterministically reconstructed for historical rows.

### Phase 1B: Fix Backfill Identity Resolution

- Replace `(chain_id, stablecoin)` lookup with persisted `config_key` or `(chain_id, contract_address)`.
- Add a `getContractConfigByKey()` or equivalent lookup in the blacklist domain.
- Ensure destroy-log recovery and `balanceOf(block-1)` reads always use the emitting contract.

### Phase 1C: Formalize Amount Recovery State

- Define `amount_source` enum values such as:
  - `event`
  - `historical_balance`
  - `derived`
  - `unavailable`
- Define `amount_status` enum values such as:
  - `resolved`
  - `recoverable_pending`
  - `permanently_unavailable`
  - `provider_failed`
  - `ambiguous`
- Update gap monitoring and status logic to use `amount_status`, not `amount IS NULL` alone.
- Exclude intentionally unavailable Tron blacklist/unblacklist rows from retry pressure and operator noise without relying on ad hoc chain/event exceptions.

### Phase 1D: Upgrade Tests Before Further Expansion

- Add regression tests for:
  - Optimism `USDT` legacy vs `USDT0`
  - receipt-log recovery on the correct contract
  - backfill prioritization for recoverable vs permanently unavailable rows
  - historical row migration behavior for provenance columns

### Docs

- Update `docs/blacklist-tracker.md`
- Update `docs/api-reference.md`
- Update `docs/status-dashboard.md`
- Update `docs/blacklist-tracker-timeline.md`
- Update `/methodology` blacklist tracker section if field semantics or gap logic become user-visible

### Acceptance Criteria

- Every newly inserted blacklist row stores the emitting contract identity.
- Backfill no longer resolves configs by symbol alone.
- Missing-amount monitoring distinguishes recoverable backlog from intentionally unavailable cases.
- Regression tests cover multi-config same-symbol chains.

### Risks And Mitigation

- Risk: migration complexity on historical rows.
- Mitigation: keep reconstruction best-effort, mark uncertain rows with explicit `amount_status` or provenance gaps instead of inventing precision.

- Risk: temporary API compatibility pressure.
- Mitigation: introduce new fields alongside legacy ones first, then cut consumers over in Workstream 2.

## Workstream 2: Normalize Amount Semantics End-To-End

Findings covered: 3, 8

### Scope

- `worker/src/api/blacklist.ts`
- `worker/src/cron/daily-digest/collectors.ts`
- `worker/src/api/digest-snapshot.ts`
- `src/components/blacklist-table.tsx`
- `src/components/blacklist-chart.tsx`
- `src/components/blacklist-stats.tsx`
- `src/lib/blacklist-helpers.ts`
- `shared/types/market.ts`
- related tests

### Phase 2A: Replace Overloaded `amount`

- Introduce explicit API/domain fields:
  - `amountNative`
  - `amountUsdAtEvent`
  - optional `amountUsdCurrent` only if a current-price UI needs it
- Preserve `amount` only as a transition alias if needed, then remove it once all consumers are cut over.
- Make it explicit which values are token-native and which are USD-normalized.

### Phase 2B: Fix Downstream Consumers

- Table:
  - display token-native amounts with token symbol
  - display USD only from `amountUsdAtEvent` or a clearly labeled current-price field
- Chart:
  - stop treating current gold price as historical event value
  - use `amountUsdAtEvent` if available
  - otherwise either omit from USD chart or label as current-value approximation only in a separate view
- Stats:
  - compute destroyed/frozen totals from explicit USD fields only
- Digest:
  - stop summing token-native values into `totalAmountUsd`
  - degrade gracefully when USD valuation is unavailable

### Phase 2C: Decide Historical USD Valuation Policy

- For USD-pegged assets:
  - `amountUsdAtEvent` can equal `amountNative` unless exceptional pricing treatment is needed
- For gold assets:
  - use event-time price only if the repo has reliable historical pricing inputs at the required granularity
  - otherwise leave `amountUsdAtEvent = null`
- Do not use current gold price as a silent substitute for historical valuation in API or digest outputs

### Docs

- Update `docs/api-reference.md`
- Update `docs/blacklist-tracker.md`
- Update `docs/blacklist-tracker-timeline.md`
- Update methodology copy where the page currently describes USD-valued freeze totals

### Acceptance Criteria

- No production consumer treats token-native `amount` as USD implicitly.
- Digest blacklist activity is numerically coherent for gold assets.
- UI labels match the actual field semantics.

### Risks And Mitigation

- Risk: user-visible totals change after semantics are corrected.
- Mitigation: document the methodology change and annotate it in the timeline/changelog.

## Workstream 3: Simplify Ingestion And Shared Blacklist Domain Logic

Findings covered: 5, 6, 7, 9

### Scope

- `worker/src/cron/blacklist/evm-source.ts`
- `worker/src/lib/blacklist-contracts.ts`
- new shared/domain helpers under `shared/lib/` or worker runtime-neutral modules where appropriate
- `src/lib/blacklist-api.ts`
- `src/app/blacklist/page.tsx`
- `src/lib/blacklist-helpers.ts`
- `src/components/blacklist-*`

### Phase 3A: Move To Event-Family Descriptors

- Replace per-topic looping with a descriptor model that defines:
  - event family name
  - supported topics
  - address decode rule
  - amount decode rule
  - fallback enrichment rule
- Fetch all event-family topic0 variants in one pass when possible.
- Parse rows by topic hash after fetch.

### Phase 3B: Centralize Blacklist Domain Derivations

- Move blacklist-specific summary helpers into one shared domain surface.
- Consolidate:
  - explorer/provenance mapping
  - address-state aggregation
  - amount formatting decisions
  - chart/stat derivation logic that should not live only in the page

### Phase 3C: Clarify Address-State Semantics

- Decide and codify whether a "blacklisted address count" is:
  - address only
  - address + chain
  - address + chain + stablecoin
- Reflect that choice in helper names, methodology text, and UI labels.
- Add tests to pin the chosen semantics.

### Phase 3D: Reduce Full-History Frontend Hydration

- Keep `/api/blacklist` paginated for the table.
- Add dedicated aggregate endpoints or response sections for:
  - stats
  - chart
  - filter options if needed
- Stop hydrating the full dataset client-side for every page load once the aggregate path is available.

### Docs

- Update `docs/architecture.md`
- Update `docs/blacklist-tracker.md`
- Update `docs/api-reference.md`
- Update `docs/testing.md` if blacklist integration coverage expands materially

### Acceptance Criteria

- Adding a new blacklistable asset/event family is mostly configuration plus tests, not bespoke parsing code in multiple files.
- The page no longer requires walking all paginated rows to render core summary views.
- Address-state methodology is explicit and tested.

### Risks And Mitigation

- Risk: refactor churn obscures correctness regressions.
- Mitigation: land Workstream 1 and 2 first, then keep Workstream 3 heavily characterization-tested.

## Workstream 4: Coverage Expansion With EURC Gate

Findings covered: 4 and the user note on mirrored zero-balance noise

### Hard Rule

`EURC` should not ship back into live blacklist coverage unless the mirrored-noise problem is solved in a way that preserves trust in the feed.

### Known Problem

Circle appears to blacklist the same address across both `USDC` and `EURC`, producing many `EURC` events with `0` balance. If those rows are displayed naively, the tracker becomes noisy and less credible.

### Phase 4A: EURC Research Spike

- Verify current Circle `EURC` contracts and event family parity with `USDC`.
- Sample historical `USDC` and `EURC` blacklist events on overlapping chains.
- Measure:
  - share of `EURC` blacklist/unblacklist events with zero balance
  - share of `EURC` events that are same-tx or near-same-time mirrors of `USDC`
  - share of non-zero `EURC` events that would be lost under aggressive deduping

### Phase 4B: Define A Noise-Suppression Policy

Valid implementation options, in order of preference:

1. Persist raw `EURC` rows, but classify rows with `amountNative = 0` and a matching same-address Circle blacklist event on `USDC` as `mirrored_no_balance`.
2. Exclude `mirrored_no_balance` rows from default public views while keeping them available in raw/admin/debug views.
3. Add a page-level toggle such as `Show mirrored no-balance events` only if the default experience stays clean.

Avoid:

- silently dropping all zero-amount `EURC` rows at ingestion
- hiding rows without a persisted classification explaining why
- heuristics that collapse genuinely independent `EURC` freezes into `USDC`

### Phase 4C: EURC Decision Gate

Ship `EURC` only if all three are true:

1. mirrored-noise rows can be identified with a deterministic or near-deterministic rule
2. genuinely impactful `EURC` rows remain visible by default
3. the resulting public feed is materially more informative than today’s placeholder state

If any of those fail:

- remove `EURC` from the live-supported enum/UI surfaces
- keep it as a planned asset internally, not a public filter value

### Phase 4D: If EURC Passes The Gate

- add `EURC` contract configs
- add mirrored-noise classification fields if needed
- update status/gap logic so expected no-balance mirrored rows do not look like attribution failures
- update page copy to explain the classification

### Docs

- Update `docs/blacklist-tracker.md`
- Update `docs/api-reference.md`
- Update `src/app/about/page.tsx` only if public feature coverage text changes materially
- Update `/methodology` blacklist tracker section and `docs/blacklist-tracker-timeline.md`

### Acceptance Criteria

- `EURC` is either:
  - live with a documented noise-suppression model, or
  - explicitly removed from public support claims
- no ambiguous half-supported public state remains

### Risks And Mitigation

- Risk: mirrored-event heuristics suppress real `EURC` signal.
- Mitigation: require historical sampling, false-positive review, and explicit row classification rather than hard deletion.

## Suggested Ticket Breakdown

### Ticket Group A: Schema And Provenance

- A1: add blacklist provenance columns and migration
- A2: write provenance during ingestion
- A3: backfill provenance for historical rows where deterministic
- A4: switch backfill identity to persisted config key

### Ticket Group B: Amount Model

- B1: introduce explicit native/USD blacklist amount fields
- B2: update blacklist API contract and types
- B3: update digest and snapshot consumers
- B4: update table/chart/stats rendering

### Ticket Group C: Domain Cleanup

- C1: event-family descriptor refactor for EVM scans
- C2: shared blacklist domain helpers for summaries and formatting
- C3: address-state methodology decision and implementation
- C4: aggregate API path to reduce full-history page hydration

### Ticket Group D: EURC Gate

- D1: historical `EURC` sampling and mirror analysis
- D2: mirrored-noise classification design
- D3: ship `EURC` only if gate passes, else remove public support claims

### Ticket Group E: Test Expansion

- E1: worker regression suite for multi-config contract identity
- E2: API contract tests for new fields and semantics
- E3: frontend/shared helper tests for address-state and amount display semantics
- E4: one integration-style fixture covering ingest -> API -> UI derivation

## Validation Plan

For each merged phase, run at minimum:

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit
```

Before pushing:

```bash
npm run test:merge-gate
```

Additional recommended checks while touching this area:

- targeted blacklist suites during iteration
- a local query against representative D1 data after schema changes
- manual `/blacklist/` verification for:
  - table semantics
  - chart totals
  - stale/error behavior
  - any new `EURC` classification or filtering behavior

## Recommended Execution Order

1. Land provenance schema and backfill identity fixes.
2. Land explicit amount semantics and update consumers.
3. Refactor event-family/domain logic and reduce full-history frontend hydration.
4. Run the `EURC` research spike.
5. Ship `EURC` only if the mirrored-noise gate passes. Otherwise remove the public mismatch.

## Definition Of Done

The blacklist tracker is done when:

- row provenance is explicit enough that reprocessing no longer depends on symbol-level inference
- amount semantics are unambiguous across worker, API, digest, and UI
- missing-amount monitoring reflects recoverability, not just nulls
- adding a new asset/event family is mostly data/config work
- `EURC` is either supported cleanly with a documented mirrored-noise model or removed from public support surfaces
