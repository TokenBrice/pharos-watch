# Mint/Burn Flow Remediation Implementation Plan

Date: 2026-03-24

Companion audit:
- [2026-03-24-mint-burn-flow-comprehensive-audit.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-03-24-mint-burn-flow-comprehensive-audit.md)

Primary goals:
- Improve mint/burn data accuracy, especially for the March 24 coverage expansion
- Remove repair paths that can silently distort historical data
- Make convergence behavior deterministic and auditable
- Reduce duplicate logic and hotspot concentration in the mint/burn module
- Preserve current public contracts unless a methodology or API contract change is deliberate and documented

Verification baseline:
- Mint/burn-focused test slice currently passes
- Current focused regression gate:

```bash
npx vitest run worker/src/lib/__tests__/mint-burn-contracts.test.ts worker/src/lib/__tests__/mint-burn-parse.test.ts worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts worker/src/lib/__tests__/mint-burn-pipeline.test.ts worker/src/lib/__tests__/mint-burn-price-heal.test.ts worker/src/lib/__tests__/mint-burn-roundtrip.test.ts worker/src/lib/__tests__/mint-burn-roundtrip-sweep.test.ts worker/src/lib/__tests__/mint-burn-scoring.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts worker/src/api/__tests__/mint-burn-events.test.ts worker/src/api/__tests__/backfill-mint-burn.test.ts worker/src/api/__tests__/backfill-mint-burn-prices.test.ts worker/src/cron/__tests__/sync-mint-burn.test.ts
```

---

## Executive Delivery Strategy

Ship this work in six phases.

Order matters:
- Accuracy-safe repair behavior must land before any broader backfill or coverage-confidence work
- Deterministic convergence should land before large remediation backfills so the system does not re-accumulate debt unpredictably
- Shared ingestion refactors should happen after the accuracy semantics are locked, otherwise the refactor will need to be reopened
- Adapter-provenance hardening should end with a controlled historical remediation pass, not start with one

Recommended order:

| Phase | Focus | Primary Outcome | Size |
| --- | --- | --- | --- |
| 0 | Characterization and guardrails | Lock in current behavior, add missing tests, prepare safe execution | S |
| 1 | Historical valuation safety | Remove unsafe current-price rewrites and define repair semantics | M |
| 2 | Deterministic backlog convergence | Make heals and reclassification stable, ordered, and observable | M |
| 3 | Shared ingestion simplification | Remove duplicated cron/backfill and aggregation logic | L |
| 4 | Adapter provenance hardening | Replace blanket config assumptions with auditable coverage confidence | L |
| 5 | Cross-surface alignment and final cleanup | Unify FTQ semantics, shrink hotspots, finish docs and rollout | M |

---

## Success Criteria

Functional success:
- No admin or cron path can silently assign current prices to historical mint/burn events
- `NULL` price healing and roundtrip sweeping converge deterministically under backlog
- Expanded long-tail adapters no longer rely on undocumented blanket historical assumptions
- Coverage metadata distinguishes configured ingestion coverage from historical confidence
- Daily digest and public API use the same FTQ classification semantics

Engineering success:
- The core mint/burn config-range processing logic exists once, not separately in cron and backfill
- Hourly rebuild semantics exist once, not in multiple handwritten SQL blocks
- Adapter metadata becomes more declarative and auditable
- Tests validate adapter truth/provenance, not just registry shape

Operational success:
- Operators can tell what remediation debt remains and in what order it will be processed
- Backfill and repair jobs are safe to run repeatedly
- Post-remediation rollout can be executed coin cohort by coin cohort with explicit confidence progression

---

## Phase 0: Characterization and Safety Guardrails

Objective:
- Add the missing coverage needed to change behavior safely and make the next phases low-regret.

Primary files:
- `worker/src/api/__tests__/backfill-mint-burn-prices.test.ts`
- `worker/src/lib/__tests__/mint-burn-price-heal.test.ts`
- `worker/src/lib/__tests__/mint-burn-roundtrip-sweep.test.ts`
- `worker/src/api/__tests__/mint-burn-flows.test.ts`
- `worker/src/lib/__tests__/mint-burn-contracts.test.ts`

Implementation tasks:
- Add characterization tests that prove the current unsafe `backfill-mint-burn-prices` behavior before changing it
- Add tests for deterministic ordering requirements in:
  - `healNullPrices()`
  - `sweepRecentRoundtrips()`
  - `handleReclassifyAtomicRoundtrips()`
- Add tests for `buildCoinCoverageMap()` to capture current configured-start semantics before introducing historical-confidence metadata
- Add tests that separate:
  - configured coverage
  - observed historical coverage
  - public status rendering

Acceptance criteria:
- Every audit finding that will be addressed by behavior changes has a targeted regression test first
- There is an explicit failing test path for “historical row repaired from current price”

Verification:
```bash
npx vitest run worker/src/api/__tests__/backfill-mint-burn-prices.test.ts worker/src/lib/__tests__/mint-burn-price-heal.test.ts worker/src/lib/__tests__/mint-burn-roundtrip-sweep.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts worker/src/lib/__tests__/mint-burn-contracts.test.ts
```

---

## Phase 1: Historical Valuation Safety

Objective:
- Remove the highest-severity data-accuracy risk: current-price rewrites of historical events.

Primary files:
- `worker/src/api/backfill-mint-burn-prices.ts`
- `worker/src/lib/mint-burn-pipeline/context.ts`
- `worker/src/lib/mint-burn-pipeline/parse.ts`
- `worker/src/lib/mint-burn-pipeline/price-heal.ts`
- `worker/src/api/__tests__/backfill-mint-burn-prices.test.ts`
- `docs/mint-burn-flows.md`
- `docs/api-reference.md`

Implementation tasks:
- Redesign `backfill-mint-burn-prices` into two distinct semantics:
  - audit/provenance repair
  - valuation repair
- Prevent `amount_usd` from being filled from current `price_cache` unless that behavior is explicitly scoped to a documented emergency mode
- Introduce a historical-price-first repair policy:
  - prefer event-day `supply_history` price
  - optionally allow a narrow documented fallback when the event is very recent and the cache timestamp is close enough
  - otherwise keep `amount_usd = NULL`
- Keep provenance fields explicit when a row remains unresolved
- Decide whether `backfill-mint-burn-prices` should be renamed or split into two admin endpoints for clarity

Recommended policy:
- `amount_usd` may only be repaired when the price source is time-appropriate
- rows with missing historical prices remain unresolved rather than “best guessed”

Acceptance criteria:
- Historical events cannot silently receive a current spot valuation from the admin repair path
- Documentation clearly states what the repair endpoint can and cannot do
- The endpoint response distinguishes:
  - `rowsAudited`
  - `rowsValued`
  - `rowsStillUnpriced`

Verification:
```bash
npx vitest run worker/src/api/__tests__/backfill-mint-burn-prices.test.ts worker/src/lib/__tests__/mint-burn-price-heal.test.ts worker/src/lib/__tests__/mint-burn-parse.test.ts
cd worker && npx tsc --noEmit
```

Rollout note:
- Do not run broad price repairs until this phase is live.

---

## Phase 2: Deterministic Backlog Convergence

Objective:
- Make automated cleanup ordered, explainable, and resistant to backlog starvation.

Primary files:
- `worker/src/lib/mint-burn-pipeline/price-heal.ts`
- `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts`
- `worker/src/api/reclassify-atomic-roundtrips.ts`
- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/api/__tests__/backfill-mint-burn-prices.test.ts`
- `worker/src/lib/__tests__/mint-burn-price-heal.test.ts`
- `worker/src/lib/__tests__/mint-burn-roundtrip-sweep.test.ts`

Implementation tasks:
- Add deterministic ordering to `healNullPrices()`:
  - preferred default: `ORDER BY timestamp DESC, id DESC`
  - alternative: `ORDER BY ABS(amount) DESC, timestamp DESC` if value-first remediation is preferred
- Add deterministic ordering to `sweepRecentRoundtrips()` and admin reclassify:
  - recommended default: oldest debt first via `ORDER BY MIN(timestamp) ASC`
- Extend cron metadata with convergence signals:
  - oldest recent unpriced event timestamp
  - oldest pending roundtrip timestamp
  - backlog processed this run
  - backlog remaining estimate when available
- Decide on persistent cursoring only if ordered `LIMIT` processing is still insufficient

Acceptance criteria:
- Re-running the same job on the same backlog processes the same next items in the same order
- Operators can see whether backlog is shrinking and where the oldest unresolved debt lives
- Roundtrip cleanup no longer depends on implicit D1 row order

Verification:
```bash
npx vitest run worker/src/lib/__tests__/mint-burn-price-heal.test.ts worker/src/lib/__tests__/mint-burn-roundtrip-sweep.test.ts worker/src/cron/__tests__/sync-mint-burn.test.ts
```

---

## Phase 3: Shared Ingestion Simplification

Objective:
- Remove the duplicated logic that currently exists in cron and admin backfill paths.

Primary files:
- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/api/backfill-mint-burn.ts`
- `worker/src/lib/mint-burn-pipeline/persistence.ts`
- New: `worker/src/lib/mint-burn-pipeline/process-config-range.ts`
- Potentially new: `worker/src/lib/mint-burn-pipeline/rebuild-hourly.ts`
- `worker/src/lib/__tests__/mint-burn-pipeline.test.ts`
- `worker/src/cron/__tests__/sync-mint-burn.test.ts`
- `worker/src/api/__tests__/backfill-mint-burn.test.ts`

Implementation tasks:
- Extract a shared helper for “process this config over this block range”
  - fetch logs for all event defs
  - resolve timestamps
  - parse rows
  - classify burns
  - detect same-run atomic roundtrips
  - insert/update rows
  - return counters, affected hours, and coverage frontier
- Keep policy-specific decisions outside the helper:
  - cron degraded/error semantics
  - backfill monotonic sync-state mode
  - cron lane scheduling and budgets
- Extract hourly rebuild semantics into one shared helper usable by:
  - `recalcAffectedHours()`
  - whole-coin rebuilds after admin repair

Acceptance criteria:
- Cron and backfill differ mainly in scheduling/policy, not in row-processing implementation
- There is only one authoritative hourly aggregation SQL definition
- Future methodology changes to counted rows require updating one place

Verification:
```bash
npx vitest run worker/src/lib/__tests__/mint-burn-pipeline.test.ts worker/src/cron/__tests__/sync-mint-burn.test.ts worker/src/api/__tests__/backfill-mint-burn.test.ts
npm run check:hotspot-ratchet
```

---

## Phase 4: Adapter Provenance Hardening

Objective:
- Replace low-confidence registry defaults with explicit adapter provenance and confidence semantics.

Primary files:
- `worker/src/lib/mint-burn-contracts.ts`
- Potentially new: `worker/src/lib/mint-burn-adapter-provenance.ts`
- `worker/src/api/mint-burn-flows-shared.ts`
- `worker/src/api/mint-burn-flows.ts`
- `worker/src/lib/__tests__/mint-burn-contracts.test.ts`
- `docs/mint-burn-flows.md`
- `docs/mint-burn-flows-timeline.md`
- `shared/lib/mint-burn-flow-version.ts`

Implementation tasks:
- Introduce provenance fields into adapter/config metadata
  - `startBlockSource`
  - `startBlockConfidence`
  - optional `validationNote`
  - optional `historicalConfidence`
- Audit all blanket `startBlock: 21_900_000` adapters and split them into cohorts:
  - validated by deployment block
  - validated by first known mint/burn evidence
  - provisional / low-confidence
- Extend coverage metadata so public/API consumers can distinguish:
  - configured ingestion coverage
  - historical confidence
- Rework adapter tests:
  - keep address/decimals tests
  - add provenance assertions
  - stop overfitting to one blanket start block where evidence is weak

Recommended execution model:
- Work in cohorts, not one giant edit
- Start with highest market-cap and most user-visible long-tail assets
- Only after provenance is improved should broad historical backfill be scheduled

Acceptance criteria:
- Every long-tail adapter has explicit provenance semantics
- Public coverage metadata no longer implies the same confidence for all adapters
- The March 24 expansion is split into validated vs provisional coverage rather than a single flat coverage claim

Verification:
```bash
npx vitest run worker/src/lib/__tests__/mint-burn-contracts.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts
```

Methodology note:
- If public coverage semantics materially change, update:
  - `docs/mint-burn-flows.md`
  - `/methodology`
  - `docs/mint-burn-flows-timeline.md`
  - `shared/lib/mint-burn-flow-version.ts`

---

## Phase 5: Cross-Surface Alignment and Final Cleanup

Objective:
- Finish the semantic cleanup so product surfaces and internal tools tell the same story.

Primary files:
- `worker/src/api/mint-burn-flows.ts`
- `worker/src/cron/daily-digest/collectors.ts`
- `worker/src/lib/flight-to-quality-classification.ts`
- `worker/src/lib/mint-burn-pipeline/sync-state.ts`
- `docs/mint-burn-flows.md`
- `docs/api-reference.md`

Implementation tasks:
- Unify FTQ classification semantics between daily digest and public API
  - daily digest should use report-card-based safe/risky buckets
  - if fallback exists, it should be shared and explicit
- Replace `SAFE_HAVEN_IDS` comments and usage with one canonical classification policy
- Optimize `readMintBurnSyncStateBatch()` away from one-query-per-config behavior
- Reduce duplicated query builders in `mint-burn-flows.ts`
- Review whether `updateBurnClassifications()` can be limited to ignored/existing rows only

Acceptance criteria:
- FTQ signals agree across API and digest for the same underlying state
- There is one canonical safe/risky classification source
- Sync-state reads and aggregate handler structure are leaner without semantic changes

Verification:
```bash
npx vitest run worker/src/api/__tests__/mint-burn-flows.test.ts worker/src/cron/__tests__/daily-digest.test.ts worker/src/api/__tests__/mint-burn-events.test.ts
```

---

## Recommended Rollout Sequence

1. Ship Phase 0 tests first.
2. Ship Phase 1 by itself and block broad admin price repairs until live.
3. Ship Phase 2 and observe backlog convergence for several cron cycles.
4. Ship Phase 3 refactor behind unchanged behavior and re-run focused plus full mint/burn tests.
5. Execute Phase 4 in adapter cohorts with explicit provenance review.
6. Ship Phase 5 once semantics are stable.

Do not combine Phase 1 and Phase 3 in the same change. The first is behaviorally sensitive; the second is structural.

---

## Full Verification Gate Before Push

At minimum after any substantial phase:

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
```

Before pushing any branch:

```bash
npm run test:merge-gate
```

---

## Suggested First Execution Slice

If implementation starts immediately, the best first slice is:

1. Phase 0 characterization tests for unsafe valuation repair and nondeterministic backlog handling
2. Phase 1 rewrite of `backfill-mint-burn-prices`
3. Phase 2 deterministic ordering for heals and roundtrip sweeps

Reason:
- This sequence addresses the highest-risk accuracy issues first
- It is materially valuable even before any refactor or adapter-provenance work
- It creates a safer environment for the later historical remediation pass
