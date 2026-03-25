# PSI Remediation Implementation Plan

Date: 2026-03-24

Source audit: [2026-03-24-psi-implementation-audit.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/2026-03-24-psi-implementation-audit.md)

Goal: execute all PSI audit findings with minimal unnecessary churn, while preserving PSI’s defining behavior: major historical market traumas must still produce sharp, obvious regime deterioration.

## Execution Principles

- Fix correctness before expanding methodology.
- Separate score-changing work from score-neutral trust/consistency work.
- Introduce one canonical PSI domain model and one canonical PSI display model.
- Benchmark notable-event windows before shipping any replay/input change that can move historical scores.
- Prefer additive refactors and parallel paths first, then switch consumers once parity is proven.

## Success Criteria

At the end of this plan:

- live PSI, daily snapshot PSI, historical replay PSI, API PSI, digest PSI, KPI PSI, page PSI, and OG PSI all derive from consistent shared helpers
- backfill honors methodology-version semantics instead of replaying one generic approximation
- the PSI universe is explicit and shared across live and replay paths
- today/yesterday/streak logic is canonical and consistent across surfaces
- score-changing changes are benchmarked against major event windows before rollout
- PSI docs and methodology docs remain in sync with actual code

## Non-Negotiable Score Guardrails

Any work that can change PSI values must be evaluated against these historical windows before merge:

1. Tether Scare, Oct 2018
2. QuadrigaCX / flight-to-quality panic, Feb 2019
3. IRON Finance, Jun 2021
4. Tether DOJ probe stress window, Jul 2021
5. Fed crash, Jan-Feb 2022
6. UST collapse, May-Jun 2022
7. SVB weekend, Mar 2023

Acceptance rule:

- the event must still register as a sharp visible drop
- the band reached must remain directionally consistent with the product narrative
- any reduction in trough depth must be explained by methodology fidelity, not implementation drift
- if a proposed change materially flattens a crisis window, do not ship it without explicit methodology signoff

## Recommended Delivery Order

1. Workstream A: canonical PSI view-model and score-neutral consumer cleanup
2. Workstream B: OG polarity fix
3. Workstream C: canonical PSI universe model
4. Workstream D: historical replay engine rebuild behind benchmarks
5. Workstream E: backfill endpoint switch and operational safeguards
6. Workstream F: test expansion and permanent regression gates
7. Workstream G: optional PSI confidence/companion analytics

This order intentionally lands low-risk trust fixes before score-affecting replay changes.

## Workstream A: Canonical PSI View-Model

Objective: remove duplicated PSI presentation logic from API, frontend, digest, and related consumers.

### Problems addressed

- duplicated `avg24h ?? score` logic
- inconsistent “yesterday” comparison
- inconsistent “days in band” logic
- inconsistent handling of prepended today-running-average points

### Files to add

- `shared/lib/psi-view-model.ts`

### Files to modify

- `worker/src/api/stability-index.ts`
- `worker/src/cron/daily-digest.ts`
- `src/app/stability-index/client.tsx`
- `src/components/kpi-bar.tsx`
- `src/components/regime-bar.tsx`
- `src/components/psi-history-chart.tsx` if necessary for normalized chart input

### Implementation tasks

1. Add a shared runtime-neutral PSI selector module with helpers such as:
   - `resolveDisplayedPsi(current)`
   - `normalizePsiHistory(history, current, options)`
   - `getPsiPreviousDay(history, currentComputedAt)`
   - `getPsiDeltas(history, displayedScore, currentComputedAt)`
   - `getPsiBandStreak(history, displayedBand, currentComputedAt)`
2. Define explicit semantics for:
   - current live score
   - displayed score
   - displayed band
   - today running average synthetic point
   - previous completed UTC day
3. Update API assembly to use these helpers instead of ad hoc inline logic.
4. Update the dedicated page and KPI bar to consume the same semantics.
5. Remove any duplicated “skip today” or “add 1 for today” logic from components.

### Required behavioral decisions

- `history` should contain at most one “today” point, and it must be synthetic-only
- “vs yesterday” must compare against the previous completed UTC day, never today’s synthetic point
- “days in band” must count consecutive completed/synthetic daily points using one shared rule

### Acceptance criteria

- the page and KPI bar show identical PSI delta and streak semantics
- no duplicate today point appears in any PSI chart/history consumer
- no change to stored PSI samples or daily scores

## Workstream B: OG PSI Polarity Fix

Objective: correct the PSI OG card so it matches PSI’s real score direction.

### Problems addressed

- OG card currently treats high PSI as worse stability

### Files to modify

- `worker/src/lib/og-templates/stability-index-card.tsx`
- `worker/src/api/og.tsx` if any labels/delta semantics also need alignment

### Implementation tasks

1. Reverse thermometer positioning so high PSI maps to healthy/high end.
2. Fix delta color semantics:
   - positive delta in PSI = improvement = green
   - negative delta in PSI = deterioration = red
3. Review ATH/ATL labels if needed:
   - for PSI, all-time high is healthiest
   - all-time low is worst stress
4. Add snapshot-style tests or deterministic render assertions.

### Acceptance criteria

- a score like `92` renders in the healthy region
- a score like `15` renders in the crisis region
- delta coloring matches the product’s real PSI meaning

## Workstream C: Canonical PSI Universe Model

Objective: make the PSI universe explicit and shared between live and replay paths.

### Problems addressed

- PSI eligibility defined centrally but populated through different live/replay mechanisms
- shadow assets handled implicitly rather than through one canonical builder

### Files to add

- `shared/lib/psi-universe.ts` or `worker/src/lib/psi-universe.ts` depending on runtime constraints

### Files to modify

- `worker/src/cron/stability-index.ts`
- `worker/src/lib/psi-recompute.ts`
- potentially `worker/src/cron/compute-dews.ts`
- possibly `shared/lib/psi-eligible.ts` if it becomes pure metadata only

### Implementation tasks

1. Define a canonical `PsiUniverseMember` shape:
   - `id`
   - `symbol`
   - `isShadow`
   - `mcapUsd`
   - `prevWeekMcapUsd`
   - `priceUsd`
   - `priceSourceMode`
   - `eligibleForSeverity`
   - `eligibleForTrendDenominator`
2. Add one live builder for the current snapshot.
3. Add one replay builder for a historical day.
4. Make stored PSI input snapshots include enough metadata to audit universe composition:
   - `eligibleUniverseCount`
   - `coveredUniverseCount`
   - `shadowCoverageCount`
   - possibly `unpricedOpenDepegCount`

### Acceptance criteria

- live compute and replay both operate on explicit PSI universe objects
- universe filtering is no longer implied by whichever table/query happened to be loaded

## Workstream D: Historical Replay Engine Rebuild

Objective: replace the current approximation-based backfill inputs with a methodology-aware replay engine.

### Problems addressed

- replay omits `stressBreadth`
- replay uses `peak_deviation_bps`
- replay uses unrestricted supply history for denominators
- replay is not version-aware beyond the final stored version tag

### Files to add

- `worker/src/lib/psi-replay.ts`
- `worker/src/lib/psi-methodology-adapters.ts`

### Files to deprecate or replace

- `worker/src/lib/psi-recompute.ts`

### Implementation tasks

1. Split replay into two layers:
   - base historical input reconstruction
   - methodology-version adapter
2. Base historical input reconstruction should resolve, per day:
   - canonical PSI universe market cap
   - depeg state per coin
   - historical deviation input
   - DEWS stress breadth input where available
3. Create methodology adapters for:
   - `v1.x`
   - `v2.x`
   - `v3.x`
4. Make adapters explicit about which components are active:
   - severity
   - breadth
   - stress breadth
   - trend
   - historical component omissions if relevant
5. Decide replay strategy for deviation semantics:
   - preferred: day-level replayed deviation if reconstructible from stored data
   - fallback: keep peak-based semantics only where historical data is insufficient
6. Record replay provenance in `input_snapshot`, for example:
   - `replayMode`
   - `deviationSource`
   - `stressBreadthSource`
   - `coverageFlags`

### Critical design decision

The current plan should not blindly switch from peak replay to day-level replay without comparative benchmarking. Implement the engine so both modes can be compared first.

### Benchmark harness requirements

Create a fixture-driven comparison tool or test helper that can:

- compute old replay output
- compute new replay output
- print per-window diffs for notable events
- show:
  - minimum score
  - date of minimum
  - band distribution
  - duration below STEADY / below TREMOR / below FRACTURE

### Acceptance criteria

- `v3.0+` replay includes `stressBreadth`
- replay denominator is PSI-universe bounded
- methodology version affects replay behavior, not just stored metadata
- crisis-window benchmark output is reviewed before enabling new replay semantics in production backfill

## Workstream E: Backfill Endpoint Hardening

Objective: make the admin backfill path safe, auditable, and aligned with daily-snapshot semantics.

### Problems addressed

- backfill currently writes through today
- backfill swaps the full table using a replay path that is not yet canonical
- limited operator visibility into what changed

### Files to modify

- `worker/src/api/backfill-stability-index.ts`
- potentially API docs and admin UI action descriptions

### Implementation tasks

1. Stop rebuilding through `todayMidnight`; the rebuild target should end at the last completed UTC day.
2. Add dry-run mode if not already available for PSI, or add a preview-only response path:
   - days evaluated
   - days changed
   - max absolute score delta
   - notable-event diffs summary
3. Include richer response metadata:
   - `daysBackfilled`
   - `daysChanged`
   - `daysSkippedInsufficientData`
   - `methodologyBreakdown`
4. Add an option to rebuild only a bounded range for targeted remediation.
5. Preserve atomic swap semantics after the replay engine is replaced.

### Acceptance criteria

- no daily PSI row is generated for today by the backfill endpoint
- operators can preview impact before replacing `stability_index`
- rebuild output is explainable and range-bounded

## Workstream F: Testing And Regression Gates

Objective: add PSI-specific test coverage where the current suite is weakest.

### Problems addressed

- current tests do not strongly defend methodology fidelity or historical shape preservation
- API tests use obsolete component/band examples
- backfill tests mock too much

### Files to add or expand

- `worker/src/lib/__tests__/psi-replay.test.ts`
- `worker/src/api/__tests__/backfill-stability-index.test.ts`
- `worker/src/api/__tests__/stability-index.test.ts`
- `src/components/__tests__/` or `src/lib/__tests__/` for shared PSI selector logic
- `worker/src/lib/og-templates/__tests__/` if snapshot coverage exists there

### Required new test categories

1. View-model tests
   - displayed score selection
   - previous-day delta
   - band streak
   - no duplicate today point
2. API contract tests
   - canonical PSI band names only
   - canonical component keys only
   - detail mode today-point semantics
3. Replay engine tests
   - methodology-version branching
   - stress-breadth inclusion for `v3.0+`
   - PSI-universe denominator filtering
4. Notable-event benchmark tests
   - bounded expectations for trough band/range
5. Backfill endpoint tests
   - excludes current UTC day
   - dry-run response shape
   - changed-day accounting
6. OG polarity tests
   - score and delta directionality

### Acceptance criteria

- PSI tests fail on any regression in display semantics, replay semantics, or OG polarity
- fixture names and expectations reflect the actual PSI model, not legacy “Stable”/`pricePeg` terminology

## Workstream G: PSI Confidence And Companion Analytics

Objective: improve PSI interpretability without contaminating the core score.

This work should ship only after Workstreams A-F.

### Candidate additions using existing data

1. PSI confidence metadata
   - dependency health
   - coverage ratios
   - replay-price fallback counts
2. Stress concentration metrics
   - top-1 severity share
   - top-3 severity share
   - long-tail breadth share
3. Flight-to-quality companion metric
   - concentration into USDT/USDC during PSI deterioration
4. Recovery analytics
   - trough-to-recovery timing
   - days back above STEADY

### Scope rule

- these should be companion fields and UI context first
- do not fold them into PSI score without a separate methodology review

## Documentation Updates Required

If Workstreams A-F land, update:

- `docs/stability-index.md`
- `docs/stability-index-timeline.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `/methodology` PSI section if public semantics change
- `/methodology/stability-index-changelog/` if score-affecting behavior changes

Specific doc sync points:

- clarify today synthetic point semantics
- clarify previous-day comparison semantics
- document replay methodology and backfill limits
- document confidence metadata if added

## Rollout Strategy

### Phase 1: Score-neutral cleanup

- Workstream A
- Workstream B
- test updates for view-model and OG

Risk: low

### Phase 2: Canonical domain model

- Workstream C
- scaffolding for replay engine

Risk: low to medium

### Phase 3: Replay rebuild in shadow mode

- implement Workstream D without switching production backfill yet
- run benchmark comparisons
- review crisis-window diffs

Risk: medium to high

### Phase 4: Backfill endpoint switch

- Workstream E
- range-limited dry runs first
- targeted rebuild in staging-like/operator review flow if possible

Risk: high

### Phase 5: Permanent hardening

- Workstream F
- optional Workstream G

Risk: medium

## Concrete Merge Strategy

To stay surgical, split the work into these PRs:

1. `psi-view-model-cleanup`
   - shared selector helpers
   - API/page/KPI consistency
   - no score changes
2. `psi-og-polarity-fix`
   - OG direction fix
   - tests
3. `psi-universe-canonicalization`
   - explicit universe objects
   - no replay switch yet
4. `psi-replay-engine`
   - new replay module
   - benchmark fixtures
   - no production backfill switch yet
5. `psi-backfill-hardening`
   - endpoint switch
   - dry-run and range limiting
6. `psi-regression-gates`
   - notable-event benchmark tests
   - contract hardening
7. `psi-confidence-metadata`
   - optional companion improvements

## Pre-Merge Validation Per PR

For every PSI PR:

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit
```

For any PR touching public/frontend PSI consumers:

```bash
npm run build
```

Before push:

```bash
npm run test:merge-gate
```

For replay/backfill PRs, additionally run:

- notable-event benchmark suite
- targeted manual inspection of PSI history page and homepage PSI surfaces

## Recommended Immediate Next Step

Start with Workstream A.

Reason:

- it is score-neutral
- it removes existing user-visible inconsistencies
- it creates the shared selector layer needed by later replay and backfill work
- it reduces the number of places that need to be reasoned about when score-changing work begins

## Deliverable Checklist

- [ ] Shared PSI view-model helpers exist and are adopted
- [ ] Dedicated page and KPI bar use identical PSI display semantics
- [ ] OG polarity is corrected
- [ ] PSI universe is explicit and shared
- [ ] Historical replay is methodology-aware
- [ ] Backfill excludes current UTC day and supports preview/range-limited operation
- [ ] Notable-event regression benchmarks exist
- [ ] PSI docs and methodology docs are updated
