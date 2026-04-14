# Report Card Snapshot Simplification Research

Date: 2026-04-14

Target: complexity audit item 2, report-card snapshot assembly and blacklist-risk inference.

## Scope

Primary files:

- `worker/src/lib/report-cards-snapshot.ts`
- `shared/lib/report-card-blacklist-risk.ts`
- `shared/lib/report-card-peg-liquidity.ts`
- `shared/lib/report-card-overall.ts`
- `worker/src/api/report-cards.ts`

Docs reviewed:

- `docs/report-cards.md`
- `docs/report-cards-timeline.md`

Worktree note:

- This area is currently dirty in the worktree with v6.96 redemption-uplift changes. The remediation should be based on the settled final state of that work, not on the pre-change baseline.

## Current Behavior Map

`handleReportCards()` is thin. The complexity sits below it:

1. `loadReportCardsSnapshotInputs()` loads stablecoins cache, Bluechip cache, DEX liquidity, redemption backstops, and live reserves in parallel.
2. It fails hard for missing/corrupt stablecoins and unavailable redemption snapshots.
3. It degrades for Bluechip, DEX liquidity, and live reserves.
4. `buildReportCardsSnapshot()` derives peg analytics, resolves blacklist statuses, topologically sorts active metas, computes live cards, materializes defunct cards, sorts all cards, builds dependency graph edges, and attaches methodology/freshness metadata.
5. `computeCard()` resolves inherited NAV peg risk, DEX liquidity suppression on stale liquidity, redemption eligibility, live reserve slices, dependency risk, dimensions, overall grade, and raw inputs.
6. `resolveBlacklistStatuses()` computes direct/possible/inherited blacklist status via regex/name matching, explicit metadata, reserve slices, live reserve overrides, and fixed-point iteration across tracked metas.

The external output is one `/api/report-cards` JSON snapshot with:

- `cards`
- `methodology`
- `dependencyGraph`
- `updatedAt`
- `liquidityStale`
- optional `collateralDriftCoins`
- optional `liveToFallbackCoins`

## Why This Is A Good Simplification Target

The snapshot builder is a high-value first target because:

- API transport is already thin, so refactoring can stay below the handler.
- Most behavior can be characterized by existing unit tests.
- The current function boundaries do not match the real phases.
- The output shape is stable and easy to compare before/after.

The highest-risk logic is not general scoring math; it is dependency/order-sensitive and evidence-sensitive behavior:

- dependency topological order
- transitive blacklist inheritance
- live reserve vs curated reserve fallback
- redemption uplift eligibility during severe active depeg
- defunct-card materialization

## Invariants To Preserve

Do not change these in a first remediation tranche:

- Stablecoins cache unavailable or corrupt -> `ReportCardsSnapshotUnavailableError` -> API 503.
- Redemption backstop snapshot unavailable -> API 503.
- Bluechip cache malformed/unavailable -> continue without overlay.
- DEX liquidity snapshot unavailable/stale -> suppress DEX liquidity inputs and mark `liquidityStale`.
- Live reserve snapshot unavailable -> fallback to curated reserves and report live fallback metadata when applicable.
- Active stablecoins must be computed in topological dependency order so dependency scores can read upstream overall scores.
- Defunct cards remain permanent F with the existing raw-input defaults.
- Output sort remains descending `overallScore`, with `null` scores last.
- Methodology payload remains:
  - `version`
  - `weights`
  - `pegMultiplierExponent`
  - `thresholds`
- `rawInputs` fields remain populated with the same null/default conventions.
- `redemptionUsedForLiquidity` must use the same eligibility rule as `scoreLiquidity()`.
- NAV wrappers inherit peg risk only through configured `pegReferenceId`; pure NAV tokens remain neutral/NR as currently defined.
- Blacklist statuses retain these tiers:
  - `true` -> Yes
  - `"possible"` -> Possible
  - `"inherited"` -> Upstream
  - `false` -> No
- Explicit `canBeBlacklisted: false` continues to override reserve inference.

## Proposed Split

Recommended file shape:

1. Keep `worker/src/lib/report-cards-snapshot.ts` as a facade/coordinator:
   - `buildReportCardsSnapshot(db)`
   - maybe `topologicalOrder()` if external tests import it.
2. New helper module, for example `worker/src/lib/report-cards-snapshot-inputs.ts`:
   - `loadReportCardsSnapshotInputs(db)`
   - owns degraded/fail-hard input policy.
3. New helper module, for example `worker/src/lib/report-cards-snapshot-card.ts`:
   - `computeReportCard(input)`
   - `resolvePegInput(...)`
   - owns live-card assembly and raw inputs.
4. New helper module, for example `worker/src/lib/report-cards-snapshot-finalize.ts`:
   - `buildDefunctReportCards()`
   - `sortReportCards()`
   - `buildSnapshotEnvelope(...)`
5. Keep `shared/lib/report-card-blacklist-risk.ts` behavior intact for first snapshot split.
6. Second pass for blacklist risk:
   - convert regex lists into declarative matcher groups:
     - direct stablecoin text
     - possible stablecoin text
     - direct collateral symbols
     - custody text
   - isolate fixed-point status convergence into `resolveBlacklistFixedPoint(...)`.

This order reduces snapshot complexity without mixing in a classification rewrite.

## Suggested File Touch Plan

Tranche A, behavior-preserving split:

- `worker/src/lib/report-cards-snapshot.ts`
  - reduce to orchestration and public exports.
- Add `worker/src/lib/report-cards-snapshot-inputs.ts`
  - move `ReportCardsSnapshotInputs`, `EMPTY_DEX_LIQUIDITY_SNAPSHOT`, `loadReportCardsSnapshotInputs()`.
- Add `worker/src/lib/report-cards-snapshot-card.ts`
  - move `ComputeCardInput`, `resolvePegInput()`, `computeCard()`.
- Add `worker/src/lib/report-cards-snapshot-finalize.ts`
  - move defunct-card builder and sorting.
- Keep `worker/src/api/report-cards.ts` unchanged.

Tranche B, blacklist simplification:

- `shared/lib/report-card-blacklist-risk.ts`
  - replace scattered regex constants with grouped declarative matcher arrays.
  - separate `reserveSliceBlacklistRisk()` from text matcher definitions.
  - isolate fixed-point resolver.
- Avoid methodology changes in the same PR.

## Tests To Add Or Reuse

Existing tests to run for Tranche A:

- `worker/src/lib/__tests__/report-cards-snapshot.test.ts`
- `worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts`
- `worker/src/api/__tests__/report-cards.test.ts`
- `shared/lib/__tests__/report-cards.test.ts`
- `src/lib/__tests__/report-cards.test.ts`

Characterization tests worth adding before Tranche A:

- Snapshot card order is identical for a fixture containing live, NR, and defunct cards.
- `liquidityStale` suppresses DEX liquidity but keeps redemption-only liquidity behavior unchanged.
- Redemption eligibility in raw inputs equals `isRedemptionEligibleForLiquidity()` for:
  - low confidence
  - impaired route
  - severe active depeg with static route
  - severe active depeg with strong live-direct route
- `liveToFallbackCoins` and `collateralDriftCoins` remain optional only when non-empty.

Characterization tests worth adding before Tranche B:

- A cyclic reserve graph converges independent of input order.
- Explicit `canBeBlacklisted: false` blocks inherited transitivity.
- Direct collateral blacklist symbols and custody text stay classified the same way as today.
- Sub-threshold direct reserve exposure returns `"possible"`, not `false` or `"inherited"`.

## Do Not Change Public Contracts

- `/api/report-cards` route behavior and response shape.
- Methodology version and changelog content unless behavior changes.
- Dependency graph edge construction from `buildDependencyGraphEdges(ACTIVE_STABLECOINS)`.
- `ReportCardsSnapshotUnavailableError` semantics.
- `topologicalOrder()` export until tests and any callers are updated.

## Open Questions Before Implementation

- Should `computeCard()` become an exported worker helper for direct tests, or stay private behind snapshot tests?
- Should defunct-card materialization live in worker code or move to shared code? It currently depends only on shared data/types, but moving it would broaden shared surface.
- Should blacklist matcher grouping be done in the same pass as snapshot splitting? Recommendation: no. Split snapshot first, then simplify blacklist inference.
