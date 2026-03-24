# Mint/Burn Flow Tracker — Comprehensive Coverage Audit

**Date:** 2026-03-24  
**Scope:** Full audit of the mint/burn flow tracker implementation with explicit review of all current mint/burn adapters/configs, shared ingestion pipeline, cron orchestration, admin backfill/remediation paths, APIs, schemas, and relevant tests.  
**Objective:** Establish the remediation baseline for two goals:
- maximize data accuracy
- improve maintainability, mutualization, and code quality

---

## Executive Summary

The module is materially stronger than the March 15 audit baseline. The important parser gaps identified then have been closed: custom USDT `Issue/Redeem`, custom reUSD vault events, bridge-burn classification, and automated cross-run roundtrip sweeping are now implemented and covered by tests.

The main risks have moved. The current weak points are:
- adapter/config quality, especially historical coverage assumptions for the large March 24 expansion
- nondeterministic remediation paths (`NULL` price healing, roundtrip sweep)
- one admin repair endpoint that can overwrite historical valuations with current prices
- duplicated ingestion/re-aggregation logic that will make future fixes slower and easier to apply inconsistently

The tracker is operationally usable, but the new long-tail coverage wave should not be treated as equally trusted across adapters. The expanded registry is heavily dependent on blanket defaults rather than per-adapter evidence.

---

## Adapter Review

I reviewed the current adapter surface in [worker/src/lib/mint-burn-contracts.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-contracts.ts).

Current composition:
- `124` contract configs across `123` stablecoin IDs
- `7` critical configs, `117` extended configs
- `121` transfer-based adapters using zero-address `Transfer` filters
- `1` mixed USDT adapter with transfer filters plus custom `Issue/Redeem` events
- `2` custom reUSD vault-event adapters
- `5` bridge-aware CCIP overlays on top of transfer adapters

Adapter assessment by class:
- Transfer-only adapters: low parser complexity, but most exposed to config-quality risk. The core issue is not decoding, it is whether each adapter has the right `startBlock`, dust threshold, and confidence in the assumption that zero-address `Transfer` fully represents issuance/redemption semantics.
- USDT adapter: structurally sound and now tested. Remaining risk is historical completeness because it shares the same broad `startBlock: 21_900_000` assumption as several recent configs even though its custom treasury events are exactly the kind of data that should be backfilled carefully.
- reUSD adapters: structurally correct and tested, but they remain an exception path with explicit overrides and deserve continued regression protection because they bypass shared token metadata for contract addresses.
- CCIP bridge-aware adapters: classification logic is in much better shape than before and now has direct tests. The main remaining issue is maintainability: the bridge-aware surface is still configured inline and inconsistently separated from the rest of adapter metadata.

Bottom line:
- parser reliability is acceptable
- adapter metadata reliability is uneven
- the long-tail expansion is over-optimized for speed of coverage expansion, not for per-adapter confidence

---

## Findings

### High

#### H1. The long-tail adapter expansion relies too heavily on blanket `startBlock` defaults, which weakens historical accuracy claims

Evidence:
- [worker/src/lib/mint-burn-contracts.ts:155](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-contracts.ts#L155) defines a large transfer-expansion spec with only `stablecoinId` and `dustThreshold`.
- [worker/src/lib/mint-burn-contracts.ts:726](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-contracts.ts#L726) maps that whole expansion to a hardcoded `startBlock: 21_900_000`.
- `74` configs in the file currently use `startBlock: 21_900_000`.
- The tests explicitly lock many expansion adapters to that same default instead of validating per-adapter provenance, e.g. [worker/src/lib/__tests__/mint-burn-contracts.test.ts:166](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/mint-burn-contracts.test.ts#L166), [worker/src/lib/__tests__/mint-burn-contracts.test.ts:224](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/mint-burn-contracts.test.ts#L224), [worker/src/lib/__tests__/mint-burn-contracts.test.ts:281](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/mint-burn-contracts.test.ts#L281), [worker/src/lib/__tests__/mint-burn-contracts.test.ts:359](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/mint-burn-contracts.test.ts#L359).

Why this matters:
- For many new adapters, historical completeness is only as good as that default start block.
- Coverage metadata softens the UX impact, but aggregate windows, per-coin `netFlow30dUsd` / `netFlow90dUsd`, and any downstream interpretation still inherit this assumption.
- The current tests mostly prove that the registry contains the intended addresses and defaults; they do not prove that each adapter begins at the right on-chain point.

Assessment:
- This is the biggest adapter-level weakness in the current module.
- It is not a parser bug. It is a coverage-confidence problem.

Recommendation:
- Introduce per-adapter provenance fields for `startBlock` and tracking confidence.
- Backfill/validate each expanded adapter against contract deployment block or first mint/burn evidence.
- Replace blanket tests with provenance/assertion tests for first known event or deployment block per adapter cohort.

#### H2. `backfill-mint-burn-prices` can rewrite historical event valuations using current prices

Evidence:
- [worker/src/api/backfill-mint-burn-prices.ts:17](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-mint-burn-prices.ts#L17) selects rows where any valuation/audit field is missing.
- [worker/src/api/backfill-mint-burn-prices.ts:38](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-mint-burn-prices.ts#L38) then sets `amount_usd = COALESCE(amount_usd, amount * ?)` using the current `price_cache` value.
- The test suite currently codifies that behavior rather than constraining it, see [worker/src/api/__tests__/backfill-mint-burn-prices.test.ts:71](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/backfill-mint-burn-prices.test.ts#L71).

Why this matters:
- Historical mint/burn events can be materially misvalued if repaired after the fact with current spot prices.
- This is especially problematic for non-USD-pegged or yield-bearing assets where current price is not a harmless approximation.
- Because the endpoint also rewrites audit provenance fields, the repaired rows can look complete even when the value is historically wrong.

Assessment:
- This is the clearest current data-accuracy hazard in the module.
- It is admin-only, but if used for remediation it can create silent historical distortion.

Recommendation:
- Split “repair provenance fields” from “repair missing USD valuation”.
- Only fill `amount_usd` when a time-appropriate historical price exists.
- If no historical price exists, keep `amount_usd = NULL` and mark the row explicitly unresolved.

### Medium

#### M1. `NULL` price healing is nondeterministic and can starve important rows

Evidence:
- [worker/src/lib/mint-burn-pipeline/price-heal.ts:47](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-pipeline/price-heal.ts#L47) fetches up to `500` recent `NULL`-price rows with `LIMIT 500`.
- There is no `ORDER BY`, priority rule, or stable paging key.

Why this matters:
- When the backlog exceeds `500`, the subset healed per run depends on D1 row order.
- The cron can repeatedly heal arbitrary rows rather than newest rows or highest-value rows first.
- This makes backlog behavior less predictable and weakens observability.

Recommendation:
- Add deterministic ordering, ideally by `timestamp DESC, id DESC` or by a value-aware priority.
- Emit oldest/newest unhealed timestamps in metadata.

#### M2. Cross-run roundtrip sweeping is also nondeterministic

Evidence:
- [worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts:25](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts#L25) selects candidate groups with `LIMIT 200`.
- There is no `ORDER BY`.
- The admin endpoint uses the same pattern, see [worker/src/api/reclassify-atomic-roundtrips.ts:26](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/reclassify-atomic-roundtrips.ts#L26).

Why this matters:
- If the sweep backlog grows, some groups can be starved indefinitely.
- This undermines the claim that roundtrip cleanup is continuously convergent.

Recommendation:
- Order by `MIN(timestamp)` ascending for oldest debt first, or descending for freshest-impact-first.
- Persist sweep cursor state if backlog becomes non-trivial.

#### M3. Price-context loading scales poorly with coverage growth

Evidence:
- [worker/src/cron/sync-mint-burn.ts:270](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-mint-burn.ts#L270) loads price context for all tracked stablecoin IDs each run.
- [worker/src/lib/mint-burn-pipeline/context.ts:42](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-pipeline/context.ts#L42) loads all `supply_history` price rows for those IDs without a time bound.

Why this matters:
- This is acceptable at the current size, but it scales with both coin count and retained history.
- As coverage expands, this becomes a steady overhead tax on every cron and backfill run.

Recommendation:
- Bound the historical price query to the earliest day required for the current scan window.
- Consider a dedicated compact event-valuation price table if this feature grows materially.

#### M4. The tracker still duplicates the core ingest loop between cron and admin backfill

Evidence:
- Cron path: [worker/src/cron/sync-mint-burn.ts:426](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-mint-burn.ts#L426) through [worker/src/cron/sync-mint-burn.ts:618](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-mint-burn.ts#L618)
- Backfill path: [worker/src/api/backfill-mint-burn.ts:225](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-mint-burn.ts#L225) through [worker/src/api/backfill-mint-burn.ts:306](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-mint-burn.ts#L306)

Why this matters:
- The repo already moved shared logic into `mint-burn-pipeline/*`, but the most failure-prone orchestration loop is still duplicated.
- Future fixes to fetch semantics, event-def handling, timestamp policy, or insert/update behavior must be applied twice.

Recommendation:
- Extract a shared “process one config range” helper that returns parsed rows, coverage frontier, counters, and affected hours.
- Keep cron/backfill policy differences at the call site only.

#### M5. Hourly re-aggregation SQL is duplicated in two places

Evidence:
- Shared path: [worker/src/lib/mint-burn-pipeline/persistence.ts:96](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-pipeline/persistence.ts#L96)
- Admin price-backfill path: [worker/src/api/backfill-mint-burn-prices.ts:62](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-mint-burn-prices.ts#L62)

Why this matters:
- This is exactly the kind of duplication that drifts during methodology changes.
- Any change to counted-row semantics, `flow_type`, or burn inclusion rules must be updated in both places.

Recommendation:
- Centralize hourly rebuild SQL behind one shared helper that supports both “recalc affected hours” and “rebuild whole coin”.

#### M6. Daily digest FTQ semantics still diverge from the API

Evidence:
- Public API uses report-card-bucket classification and ignores the neutral band, see [worker/src/api/mint-burn-flows.ts:376](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts#L376).
- Daily digest still buckets everything into `SAFE_HAVEN_IDS` vs “all others”, see [worker/src/cron/daily-digest/collectors.ts:364](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest/collectors.ts#L364).
- The hardcoded set still lives in [worker/src/lib/mint-burn-contracts.ts:776](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-contracts.ts#L776).

Why this matters:
- The same market state can produce different FTQ interpretations across product surfaces.
- That weakens trust in the signal even if both implementations are individually defensible.

Recommendation:
- Move daily digest onto the same classification source as the public API.
- If fallback is required, make it explicit and shared.

#### M7. Coverage metadata is useful but still derived mostly from config assumptions, not observed evidence

Evidence:
- [worker/src/api/mint-burn-flows-shared.ts:241](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows-shared.ts#L241) derives `startBlock` from config minima.
- [worker/src/api/mint-burn-flows-shared.ts:249](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows-shared.ts#L249) determines window readiness from `startBlock` and sync state.

Why this matters:
- A config can be marked “full” relative to its configured start block even if that start block is itself too recent.
- This makes coverage status internally consistent but not necessarily historically truthful.

Recommendation:
- Distinguish “ingestion coverage relative to configured start” from “historical confidence”.
- Add adapter provenance quality into coverage metadata.

### Low

#### L1. Numeric conversion is still `number`-based end to end

Evidence:
- [worker/src/lib/bigint.ts:4](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/bigint.ts#L4) converts decoded values to JS `number`.
- [worker/src/lib/mint-burn-pipeline/parse.ts:95](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-pipeline/parse.ts#L95) multiplies `amount * price` in floating point.

Impact:
- Probably acceptable today, but it is a structural precision ceiling for very large 18-decimal events or future expansion into more institutional tokens.

Recommendation:
- Not urgent, but worth tracking as technical debt if scope grows.

#### L2. Burn-classification updates do unnecessary second writes for newly inserted rows

Evidence:
- Rows are inserted with `burn_type` already populated in [worker/src/lib/mint-burn-pipeline/persistence.ts:12](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-pipeline/persistence.ts#L12).
- Sync then updates burn rows again in [worker/src/cron/sync-mint-burn.ts:577](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-mint-burn.ts#L577).
- Backfill does the same in [worker/src/api/backfill-mint-burn.ts:301](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-mint-burn.ts#L301).

Impact:
- Extra write volume and extra surface area for bugs.

Recommendation:
- Only update existing ignored rows, or move to a targeted upsert path.

#### L3. `readMintBurnSyncStateBatch()` still does one query per config

Evidence:
- [worker/src/lib/mint-burn-pipeline/sync-state.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-pipeline/sync-state.ts)

Impact:
- Fine today, but unnecessary query fan-out for a registry that keeps growing.

Recommendation:
- Replace with chunked `IN (...)` reads.

#### L4. The contract test suite overfits to implementation defaults instead of validating adapter truth

Evidence:
- The expansion tests mostly assert exact addresses, decimals, and the default `21_900_000` start block, e.g. [worker/src/lib/__tests__/mint-burn-contracts.test.ts:177](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/mint-burn-contracts.test.ts#L177), [worker/src/lib/__tests__/mint-burn-contracts.test.ts:235](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/mint-burn-contracts.test.ts#L235), [worker/src/lib/__tests__/mint-burn-contracts.test.ts:293](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/mint-burn-contracts.test.ts#L293), [worker/src/lib/__tests__/mint-burn-contracts.test.ts:371](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/mint-burn-contracts.test.ts#L371).

Impact:
- These tests protect the registry from accidental edits, but not from low-confidence defaults being wrong.

Recommendation:
- Convert part of this suite to adapter provenance tests.

#### L5. The aggregate handler carries some avoidable query duplication

Evidence:
- Same hourly SQL appears twice in [worker/src/api/mint-burn-flows.ts:159](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts#L159) and [worker/src/api/mint-burn-flows.ts:169](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts#L169).

Impact:
- Low, but it adds noise to an already dense handler.

Recommendation:
- Wrap recurring query shapes in helper builders.

---

## Mutualization / LOC Reduction Opportunities

Highest-value extractions:
- Shared config-range ingestion helper for cron and backfill
- Shared hourly rebuild helper for targeted and whole-coin recomputation
- Shared FTQ classification source for API and daily digest
- Shared typed adapter metadata model with optional provenance fields (`startBlockSource`, `validationStatus`, `notes`)

Likely outcome:
- lower bug surface
- fewer methodology drift points
- easier expansion reviews because adapters become declarative records with provenance instead of ad hoc objects

---

## Recommended Remediation Workstreams

### Workstream 1: Adapter confidence hardening

- Audit all `74` blanket-start-block configs.
- Add per-adapter provenance for `startBlock`.
- Prioritize highest-mcap and highest-signal adapters first.

### Workstream 2: Historical valuation safety

- Redesign `backfill-mint-burn-prices` so it cannot silently assign current prices to historical rows.
- Preserve unresolved rows as unresolved.

### Workstream 3: Deterministic backlog convergence

- Add ordering and progress semantics to `healNullPrices`, `sweepRecentRoundtrips`, and the admin reclassify path.

### Workstream 4: Shared ingestion simplification

- Collapse duplicated cron/backfill orchestration.
- Collapse duplicated hourly rebuild SQL.

### Workstream 5: Cross-surface semantic alignment

- Unify FTQ classification between public API and daily digest.
- Expose provenance/confidence more explicitly in public metadata.

---

## Verification Performed

- Reviewed docs: `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`, `docs/mint-burn-flows.md`, `docs/mint-burn-flows-timeline.md`
- Reviewed current internal audit notes and runbook
- Reviewed all current mint/burn config/adapter definitions
- Ran targeted mint/burn test slice:
  - `13` test files
  - `137` tests
  - all passing

Command used:

```bash
npx vitest run worker/src/lib/__tests__/mint-burn-contracts.test.ts worker/src/lib/__tests__/mint-burn-parse.test.ts worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts worker/src/lib/__tests__/mint-burn-pipeline.test.ts worker/src/lib/__tests__/mint-burn-price-heal.test.ts worker/src/lib/__tests__/mint-burn-roundtrip.test.ts worker/src/lib/__tests__/mint-burn-roundtrip-sweep.test.ts worker/src/lib/__tests__/mint-burn-scoring.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts worker/src/api/__tests__/mint-burn-events.test.ts worker/src/api/__tests__/backfill-mint-burn.test.ts worker/src/api/__tests__/backfill-mint-burn-prices.test.ts worker/src/cron/__tests__/sync-mint-burn.test.ts
```

---

## Overall Conclusion

The current mint/burn tracker is no longer primarily threatened by missing parser logic. It is now threatened by confidence debt:
- confidence in adapter metadata
- confidence in historical valuation repairs
- confidence that remediation jobs converge deterministically

The right next step is not another broad coverage increase. It is a focused remediation pass that hardens adapter provenance, removes unsafe repair behavior, and extracts the duplicated ingestion logic into shared primitives.
