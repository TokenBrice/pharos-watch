# 2026-03-21 Redemption Backstops Remediation Implementation Plan

> Execution plan for the redemption-backstops review performed after the coverage expansion from `66` to `136` configured stablecoins.
> Scope covers all `9` issues identified in that review: `3` high, `4` medium, `2` low.

## Objective

Bring the redemption-backstops subsystem to a healthier long-term baseline by:

- fixing degraded-path correctness before adding more coverage
- making "configured" vs "usable" vs "degraded" states explicit
- preventing partial or unreadable data from being reported as healthy coverage
- improving model reliability transparency without destabilizing the current score methodology
- making the registry, sync path, and consumer surfaces easier to maintain as coverage continues to grow

This plan is intentionally broader than a bugfix pass. The goal is not only to correct the current issues, but to make future coverage expansions safer and cheaper.

## Source Findings Covered

This plan covers every issue from the review. These identifiers are local to this plan so execution and validation can reference them cleanly.

| ID | Severity | Issue |
| --- | --- | --- |
| `RB1` | High | Missing-cache IDs are still written as modeled entries even when they have no usable capacity or score |
| `RB2` | High | `syncRedemptionBackstops()` can return `ok` on partial coverage |
| `RB3` | High | `loadRedemptionBackstopMap()` swallows read failures into `{}` and downstream consumers treat that as valid |
| `RB4` | Medium | Coverage breadth outpaced model fidelity; most new rows are heuristic rather than high-confidence |
| `RB5` | Medium | Coverage and consumer logic treat row presence as coverage even when `score === null` |
| `RB6` | Medium | Test and invariant coverage did not scale with the registry expansion |
| `RB7` | Medium | `shared/lib/redemption-backstops.ts` is now a maintenance hotspot |
| `RB8` | Low | Local simplification opportunities remain (`resolveDocs()` duplication, dead cost-model variant, duplicated DEX staleness logic) |
| `RB9` | Low | The current runtime shape is acceptable now, but will scale poorly if dynamic-capacity coverage grows materially |

## Constraints

- Keep the core scoring weights and route-family caps stable during this remediation unless a change is strictly required to fix a correctness issue.
- Preserve the current public concept set: `redemptionBackstopScore`, `effectiveExitScore`, and route-family labels remain the product language.
- Avoid broad external-source expansion in the same PRs as correctness hardening.
- Update the verified docs corpus for every contract, status, methodology-surface, or validation-gate change.
- Prefer additive API-contract changes over breaking changes where possible.
- Make degraded state fail loud, not fail quiet.

## Non-Goals

- No new public list page for redemption backstops.
- No immediate re-research of all `136` configs against third-party issuer docs in one pass.
- No scoring-methodology rewrite beyond separating resolution state from confidence state.
- No D1 schema churn unless it materially simplifies correctness or observability.

## Core Design Decisions

### D1. Separate Configured Coverage From Usable Coverage

The current implementation conflates three different concepts:

1. a route is configured
2. a current snapshot row exists
3. the route has a usable score

That conflation is the root cause of `RB1` and `RB5`.

Planned contract:

- A configured route may exist without being currently usable.
- Usable coverage means the entry resolved enough inputs to produce a score.
- Frontend coverage summaries and report-card uplift logic should only treat usable entries as "covered".
- The API should still be able to expose configured-but-unusable entries explicitly so operators can diagnose why a route is not usable.

Recommended field addition:

- Add `resolutionState` to `RedemptionBackstopEntry`.
- Proposed enum:
  - `resolved`
  - `missing-cache`
  - `missing-capacity`
  - `failed`

`sourceMode` remains about source freshness and derivation (`dynamic`, `estimated`, `static`).
`resolutionState` becomes the canonical usability signal.

### D2. Fail Closed On Snapshot Read Failures

The current `loadRedemptionBackstopMap()` behavior makes a DB read failure look like valid empty data. That is not acceptable for a risk surface.

Planned policy:

- `loadRedemptionBackstopMap()` must throw a typed error on query failure.
- `/api/redemption-backstops` must return `503` on unreadable current rows.
- Report-card snapshot building must not silently continue with an empty redemption map.
- Safety-score computations should degrade explicitly when redemption data is unavailable because the underlying report-card snapshot is unavailable.

This is a deliberate behavior tightening. It is safer to surface temporary unavailability than to publish silently wrong liquidity inputs.

### D3. Expose Model Confidence Without Changing Score Math

The coverage expansion increased breadth far faster than fidelity. The plan addresses that by making confidence explicit first, then tightening the weakest high-impact routes.

Recommended config/runtime metadata:

- `capacityConfidence`: `dynamic`, `documented-bound`, `heuristic`
- `feeConfidence`: `fixed`, `formula`, `undisclosed-reviewed`
- derived `modelConfidence`: `high`, `medium`, `low`

These fields should not change score math in the first remediation pass. They exist to:

- quantify how much of the `136`-coin surface is high-confidence vs heuristic
- prioritize follow-on research
- prevent broad heuristic coverage from being mistaken for uniformly reliable coverage

### D4. Turn The Registry Into Maintained Data, Not A Giant Object Literal

The current single-file registry is still workable, but it is now large enough that reviewability and invariants are degrading.

Planned end state:

- `shared/lib/redemption-backstops/`
  - `types.ts`
  - `shared.ts`
  - `offchain-issuer.ts`
  - `psm-swap.ts`
  - `stablecoin-redeem.ts`
  - `collateral-redeem.ts`
  - `queue-redeem.ts`
  - `basket-redeem.ts`
  - `index.ts`

Each module owns one route family and uses the same typed builders.

## Workstream Overview

| Workstream | Covers | Goal |
| --- | --- | --- |
| `W0` | Baseline | Capture current behavior and lock the contract decisions before changing runtime semantics |
| `W1` | `RB1`, `RB5` | Introduce explicit resolution-state semantics and stop treating unresolved rows as usable coverage |
| `W2` | `RB2` | Tighten cron health semantics for partial coverage |
| `W3` | `RB3` | Propagate snapshot read failures instead of collapsing to empty maps |
| `W4` | `RB5` | Fix consumer behavior in report cards, coverage summaries, and detail UI |
| `W5` | `RB4` | Add fidelity metadata and a prioritized tightening program for heuristic-heavy coverage |
| `W6` | `RB6` | Expand tests and add durable invariants / guardrails |
| `W7` | `RB7`, `RB8` | Modularize the registry and remove local duplication / dead branches |
| `W8` | `RB9`, `RB8` | Preload dynamic dependencies, consolidate staleness loading, and keep runtime cost flat as dynamic coverage grows |
| `W9` | All | Update docs, rollout notes, and close with full regression validation |

## Phase 0 - Baseline And Design Lock

### W0. Capture Current Behavior Before Contract Changes

**Purpose**

Create a reliable before-state so that behavior changes are intentional rather than incidental.

**Files / Areas**

- `worker/src/cron/sync-redemption-backstops.ts`
- `worker/src/lib/redemption-backstop-sources.ts`
- `worker/src/lib/redemption-backstops-store.ts`
- `worker/src/lib/report-cards-snapshot.ts`
- `shared/lib/report-cards.ts`
- `src/lib/coverage.ts`
- `src/components/stablecoin-detail/redemption-backstop-card.tsx`

**Implementation Tasks**

1. Add characterization tests for:
   - partial coverage status semantics
   - unresolved entries with `score === null`
   - report-card detail text when a redemption route exists but is unusable
   - snapshot read failure behavior
2. Capture current registry statistics:
   - by route family
   - by capacity model
   - by cost model
   - by `score === null` vs non-null in a representative test fixture
3. Record the intended contract for:
   - `sourceMode`
   - `resolutionState`
   - coverage availability
   - failure propagation

**Exit Criteria**

- The delta between old and new behavior is explicit in tests and the plan.

## Phase 1 - Correctness Hardening

### W1. Introduce Explicit Resolution-State Semantics

**Covers:** `RB1`, `RB5`

**Files**

- `shared/types/redemption.ts`
- `worker/src/lib/redemption-backstop-sources.ts`
- `worker/src/lib/redemption-backstops-store.ts`
- `worker/src/api/redemption-backstops.ts`
- `src/lib/coverage.ts`
- `src/components/stablecoin-detail/redemption-backstop-card.tsx`

**Implementation**

1. Extend `RedemptionBackstopEntry` with `resolutionState`.
2. Make `buildRedemptionBackstopEntry()` set:
   - `resolved` when a score is produced
   - `missing-cache` when a supply-backed model cannot resolve because the asset is absent from the stablecoins cache
   - `missing-capacity` when the route is configured but usable capacity could not be resolved
   - `failed` only when a per-coin resolution path throws and the failure is intentionally materialized instead of skipped
3. Realign `sourceMode` semantics:
   - `dynamic` = fresh telemetry-backed inputs
   - `estimated` = usable score from static or stale-but-usable inputs
   - `static` = no usable score
4. Stop labeling unresolved supply-backed rows as `estimated`.
5. Preserve backward compatibility by keeping `score`, `effectiveExitScore`, and existing fields unchanged in name and meaning.

**Acceptance Criteria**

- Every current row can be distinguished as usable vs configured-but-unusable without relying on `score === null` alone.
- `sourceMode` no longer misclassifies missing-cache unresolved rows as `estimated`.
- The frontend can render a configured-but-unrated state explicitly.

**Risks**

- Additive API contract change. All schema consumers must be updated in the same slice.

### W2. Tighten Cron Health And Metadata Semantics

**Covers:** `RB2`

**Files**

- `worker/src/cron/sync-redemption-backstops.ts`
- `worker/src/cron/__tests__/sync-redemption-backstops.test.ts`
- `docs/redemption-backstops.md`
- `docs/api-reference.md`

**Implementation**

1. Change cron status rules:
   - `ok` only when every configured ID that should resolve did resolve as usable or intentionally acceptable static-unrated state according to the new contract
   - `degraded` when any configured ID is missing from cache, unresolved unexpectedly, or failed
   - `error` when no usable snapshot exists
2. Expand cron metadata:
   - `resolved`
   - `unresolved`
   - `missingFromCache`
   - `failedIds`
   - `coverageRatio`
3. Update tests so partial coverage is no longer treated as `ok`.
4. Update docs to match runtime semantics exactly.

**Acceptance Criteria**

- Partial coverage can never report `ok`.
- Operators can see whether degradation came from cache gaps, unresolved capacity, or actual per-coin failures.

**Risks**

- Status will become noisier after rollout. This is intended, but docs and ops expectations need to be updated in the same PR.

### W3. Fail Closed On Snapshot Read Failures

**Covers:** `RB3`

**Files**

- `worker/src/lib/redemption-backstops-store.ts`
- `worker/src/api/redemption-backstops.ts`
- `worker/src/lib/report-cards-snapshot.ts`
- `worker/src/lib/safety-scores.ts`
- `worker/src/lib/__tests__/redemption-backstops-store.test.ts`
- `worker/src/lib/__tests__/report-cards-snapshot.test.ts`
- `worker/src/lib/__tests__/safety-scores.test.ts`

**Implementation**

1. Introduce a typed error such as `RedemptionBackstopSnapshotUnavailableError`.
2. Replace the catch-and-return-`{}` behavior in `loadRedemptionBackstopMap()`.
3. Make `buildRedemptionBackstopsSnapshot()` propagate unreadable-current-row failures.
4. Make `/api/redemption-backstops` return `503` on unreadable snapshot state.
5. Make `buildReportCardsSnapshot()` treat redemption snapshot load failure as a dependency-unavailable error instead of silently producing downgraded liquidity inputs.
6. Keep `computeSafetyScoresSnapshot()` in explicit degraded mode when the underlying report-card snapshot is unavailable.

**Acceptance Criteria**

- A D1 read failure can no longer erase redemption data silently.
- Public APIs fail or degrade explicitly instead of returning misleadingly complete responses.

**Rollout Note**

This should be staged:

1. land the typed error and tests
2. confirm no normal deploy path trips the new behavior unexpectedly
3. then keep the fail-closed behavior enabled permanently

## Phase 2 - Consumer Accuracy

### W4. Fix Coverage, Detail, And Report-Card Consumer Semantics

**Covers:** `RB5`

**Files**

- `shared/lib/report-cards.ts`
- `worker/src/lib/report-cards-snapshot.ts`
- `src/lib/coverage.ts`
- `src/hooks/use-coverage-matrix-model.ts`
- `src/lib/stablecoin-detail-view-model.ts`
- `src/components/stablecoin-detail/redemption-backstop-card.tsx`
- `src/components/stablecoin-detail/overview-section.tsx`
- `src/lib/__tests__/coverage.test.ts`
- `src/components/stablecoin-detail/__tests__/redemption-backstop-card.test.tsx`

**Implementation**

1. Update `scoreLiquidity()` messaging so it distinguishes:
   - no route configured
   - route configured but unresolved
   - route resolved and scored
2. Update coverage summaries so "available redemption coverage" means `resolutionState === "resolved"`, not mere row presence.
3. Add a separate configured-vs-usable breakdown to the coverage model.
4. Update the detail card to display:
   - score badge
   - `sourceMode`
   - `resolutionState`
   - clearer explanatory copy when a route is configured but currently unrated
5. Ensure report-card raw inputs stay truthful when redemption data is configured but unusable.

**Acceptance Criteria**

- Coverage counts no longer overstate modeled usable coverage.
- Users can tell the difference between "not tracked", "tracked but unresolved", and "scored".
- Report-card detail text is no longer misleading when a route exists but is currently unusable.

## Phase 3 - Reliability Transparency And Data-Quality Tightening

### W5. Add Fidelity Metadata And Tighten The Highest-Impact Heuristics

**Covers:** `RB4`

**Files**

- `shared/lib/redemption-backstops.ts` (later modularized under `shared/lib/redemption-backstops/`)
- `worker/src/lib/redemption-backstop-sources.ts`
- `shared/types/redemption.ts`
- `src/lib/stablecoin-detail-view-model.ts`
- `src/components/stablecoin-detail/redemption-backstop-card.tsx`
- `docs/redemption-backstops.md`
- `docs/api-reference.md`
- `docs/report-cards.md`
- `docs/coverage-page.md`

**Implementation**

1. Add config-level fidelity metadata:
   - `capacityConfidence`
   - `feeConfidence`
   - derived `modelConfidence`
2. Populate those fields for all `136` configured routes via shared builders and family defaults.
3. Surface `modelConfidence` on the API contract and in the stablecoin detail redemption card so confidence is inspectable, not only inferred from internal config.
4. Add a coverage/fidelity audit output that reports:
   - total configured
   - total resolved
   - resolved by `modelConfidence`
   - heuristic routes by market-cap exposure
5. Prioritize a first tightening wave for the most impactful low-confidence routes:
   - high-market-cap entries still on `supply-full`
   - high-market-cap entries with `dynamic-or-unclear` fees and no bounded alternative
   - routes where a documented bounded ratio already exists but is not encoded
6. Keep score math unchanged in the first wave unless tightening the encoded route assumptions is clearly docs-backed.

**Acceptance Criteria**

- The subsystem can now answer "how much coverage is high-confidence?" rather than only "how many IDs are configured?"
- Confidence is visible on the API/detail surface, not only in internal development tooling.
- The biggest heuristic-heavy routes are visible and prioritized instead of buried in one aggregate count.

**Notes**

This workstream is what turns the current system from "broad but opaque" into "broad and diagnosable".

### W6. Expand Tests And Add Durable Guardrails

**Covers:** `RB6`

**Files**

- `shared/lib/__tests__/redemption-backstop-consistency.test.ts`
- `shared/lib/__tests__/redemption-backstops.test.ts`
- `shared/lib/__tests__/redemption-backstop-scoring.test.ts`
- `worker/src/cron/__tests__/sync-redemption-backstops.test.ts`
- `worker/src/lib/__tests__/redemption-backstops-store.test.ts`
- `worker/src/lib/__tests__/report-cards-snapshot.test.ts`
- `src/lib/__tests__/coverage.test.ts`
- `scripts/` for new guardrail(s)
- `package.json`
- `docs/testing.md`

**Implementation**

1. Convert config tests from spot checks to table-driven coverage:
   - every route family appears in assertions
   - every confidence tier appears in assertions
   - every config ID participates in invariant checks
2. Add explicit regression tests for:
   - unresolved entries not counting as coverage
   - partial coverage returning `degraded`
   - snapshot read failure propagation
   - report-card liquidity messaging for configured-but-unrated routes
3. Add a dedicated guardrail, e.g. `check:redemption-backstops`, to verify:
   - registry counts
   - no unknown IDs
   - no invalid confidence metadata
   - documented coverage counts remain aligned with code
4. Add tests for future dynamic-capacity batching helpers once introduced.

**Acceptance Criteria**

- The redemption subsystem has the same style of invariants and degraded-path coverage as the stronger pipelines in the repo.
- A future coverage expansion cannot silently weaken correctness semantics.

## Phase 4 - Structural Simplification And Scale Readiness

### W7. Modularize The Registry And Remove Local Duplication

**Covers:** `RB7`, `RB8`

**Files**

- `shared/lib/redemption-backstops.ts` -> `shared/lib/redemption-backstops/*`
- `worker/src/lib/redemption-backstop-sources.ts`
- `worker/src/lib/dex-liquidity.ts`
- `worker/src/cron/sync-redemption-backstops.ts`
- `worker/src/lib/report-cards-snapshot.ts`

**Implementation**

1. Split the registry by route family using typed builders and shared defaults.
2. Move shared constants and helpers into `shared.ts`.
3. Cache `resolveDocs()` once per entry build instead of calling it twice.
4. Remove or actually use the dead `manual-or-unbounded` cost-model branch.
5. Consolidate DEX-liquidity map loading and staleness lookup behind one helper so sync and report-card snapshot stop duplicating staleness logic.

**Acceptance Criteria**

- The registry is reviewable by route family rather than as one giant object literal.
- There is a single DEX-liquidity staleness helper and no dead cost-model branch.

### W8. Preload Dynamic Dependencies And Flatten Future Runtime Cost

**Covers:** `RB9`, `RB8`

**Files**

- `worker/src/lib/live-reserves-store.ts`
- `worker/src/lib/redemption-backstop-sources.ts`
- `worker/src/cron/sync-redemption-backstops.ts`
- `worker/src/lib/dex-liquidity.ts`
- tests under `worker/src/cron/__tests__/` and `worker/src/lib/__tests__/`

**Implementation**

1. Add a bulk loader for reserve-sync state keyed by stablecoin ID.
2. Preload dynamic-capacity inputs for all `reserve-sync-metadata` routes once per cron run.
3. Keep resolution logic pure by passing preloaded state into entry builders.
4. Return DEX-liquidity map and latest `updated_at` together from one helper.
5. If the dynamic route cohort grows materially, introduce a small bounded concurrency layer for per-entry work rather than serial awaits.

**Acceptance Criteria**

- Adding more dynamic-capacity routes does not implicitly add one D1 round-trip per coin.
- Sync and report-card snapshot each perform one DEX-liquidity staleness read path, not two independent implementations.

## Phase 5 - Docs, Rollout, And Closure

### W9. Docs And Final Regression Closure

**Covers:** All

**Docs To Update**

- `docs/redemption-backstops.md`
- `docs/api-reference.md`
- `docs/report-cards.md`
- `docs/coverage-page.md`
- `docs/testing.md`
- `docs/architecture.md`

**Implementation**

1. Update docs to reflect:
   - `resolutionState`
   - new cron status semantics
   - configured vs usable coverage
   - confidence metadata and its meaning
   - new guardrail commands
2. Add rollout notes for the fail-closed read-path change.
3. Run the full validation suite and confirm docs sync.

**Acceptance Criteria**

- The verified docs corpus matches the new runtime contract exactly.
- Operators and future maintainers have a clear explanation of what "configured", "resolved", "estimated", and "degraded" now mean.

## Recommended PR Sequence

```text
PR 1  W0 + W1               Resolution-state contract
PR 2  W2 + W3               Cron status hardening + fail-closed snapshot reads
PR 3  W4 + W6 (part 1)      Consumer correctness + degraded-path tests
PR 4  W5                    Fidelity metadata + first tightening wave
PR 5  W7                    Registry modularization + local simplification
PR 6  W8 + W6 (part 2)      Bulk preload/perf hardening + remaining guardrails
PR 7  W9                    Docs sync + final regression closure
```

## Dependency Order

```text
W0 -> W1 -> W2 -> W3 -> W4
                 \-> W6
W1 -> W5
W5 -> W7
W7 -> W8
W2/W3/W4/W5/W6/W7/W8 -> W9
```

Rationale:

- `W1` defines the contract that `W2`, `W4`, and `W5` depend on.
- `W3` should land before any confidence/fidelity work so failures stop hiding under empty maps.
- `W7` should not start before the contract and metadata fields settle, otherwise the refactor has to be redone.

## Validation Gates

### Mandatory After Each PR

```bash
npm run lint
cd worker && npx tsc --noEmit
npm test
npm run build
```

### Targeted Redemption Validation

```bash
npx vitest run \
  shared/lib/__tests__/redemption-backstop-consistency.test.ts \
  shared/lib/__tests__/redemption-backstops.test.ts \
  shared/lib/__tests__/redemption-backstop-scoring.test.ts \
  worker/src/cron/__tests__/sync-redemption-backstops.test.ts \
  worker/src/api/__tests__/redemption-backstops.test.ts \
  worker/src/lib/__tests__/redemption-backstops-store.test.ts \
  worker/src/lib/__tests__/report-cards-snapshot.test.ts \
  worker/src/lib/__tests__/safety-scores.test.ts \
  src/lib/__tests__/coverage.test.ts \
  src/components/stablecoin-detail/__tests__/redemption-backstop-card.test.tsx \
  src/components/__tests__/overview-section.test.tsx
```

### Guardrails To Add And Then Run

```bash
npm run check:redemption-backstops
npm run check:doc-sync
```

## Definition Of Done

- `RB1` through `RB9` are all closed.
- Unresolved rows are explicit and no longer counted as usable coverage.
- Partial coverage cannot return `ok`.
- Snapshot read failures cannot collapse silently into empty maps.
- Coverage fidelity is measurable and visible.
- The registry is modularized and reviewable by family.
- The redemption subsystem has durable invariants and regression tests for degraded paths.
- Docs are in sync with runtime behavior.

## Issue-To-Workstream Matrix

| Issue | Primary Workstreams |
| --- | --- |
| `RB1` | `W1`, `W2` |
| `RB2` | `W2`, `W6` |
| `RB3` | `W3`, `W6` |
| `RB4` | `W5`, `W9` |
| `RB5` | `W1`, `W4`, `W6` |
| `RB6` | `W6` |
| `RB7` | `W7` |
| `RB8` | `W7`, `W8` |
| `RB9` | `W8` |

## Plan Validation Loop

Validation rubric used:

1. Every review finding must map to at least one concrete workstream.
2. Every workstream must have file scope, acceptance criteria, and validation guidance.
3. High-severity issues must be addressed before fidelity or refactor work.
4. Contract changes must specify rollout safety and docs impact.
5. The plan must include a regression-prevention mechanism, not only one-time cleanup.

### Iteration 1

Initial draft gaps found:

- `Medium` The unresolved-entry contract was not explicit enough; `sourceMode` and usability were still partially conflated.
- `Medium` Fail-closed read-path changes were not staged, creating rollout ambiguity for `/api/report-cards`.
- `Medium` Fidelity work improved visibility but did not yet guarantee a durable guardrail.

Actions taken:

- Added `D1` and `W1` with an explicit `resolutionState` contract.
- Added staged rollout notes under `W3`.
- Expanded `W6` to include a dedicated redemption guardrail and doc-count alignment.

### Iteration 2

Second-pass gaps found:

- `Medium` Registry modularization was underspecified; the target module layout was not explicit.
- `Low` Docs impact was implied but not enumerated clearly enough.

Actions taken:

- Added `D4` with the exact target module layout.
- Added explicit docs file lists under `W9`.

### Iteration 3

Result:

- `0` medium-grade planning gaps remain.
- Remaining residual concerns are implementation risks, not plan-completeness gaps.

## Final Planning Assessment

This plan is ready to execute.

The highest-leverage order is:

1. contract correctness
2. health/failure propagation
3. consumer truthfulness
4. fidelity transparency
5. structural simplification
6. scale hardening

That sequence fixes what is currently misleading before it optimizes what is merely awkward.
