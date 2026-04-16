# Safety Score Remediation Implementation Plan

Date: 2026-04-15

## Goal

Remediate the Safety Score audit findings from `agents/audits/2026-04-15-safety-score-implementation-audit.md` while keeping score changes explicit, versioned, documented, and tested.

## Success Criteria

- Safety Score methodology bumps from v6.96 to v6.97.
- Score-changing fixes are implemented intentionally:
  - peg dimension no longer applies the legacy active-depeg cap before the multiplier
  - `activeDepegBps` used by Safety Score is sourced from the active event peak, not current deviation
  - stale redemption backstop snapshots are suppressed from report-card liquidity inputs
  - partial missing dependency scores use a conservative unresolved-upstream policy instead of silently turning into self-backed weight
  - stress-test recomputation propagates through transitive downstream dependencies
- Score-preserving cleanup lands with the same change:
  - active-depeg thresholds/policy constants are centralized
  - report-card snapshots expose dependency/freshness metadata for DEX and redemption scoring inputs
  - dependency-risk details include declared/resolved/missing dependency diagnostics
  - report-card cache publication is owned by the report-card/safety snapshot path instead of yield sync
  - internal report-card snapshot types align with the public dependency graph schema
  - peg/liquidity scoring starts separating structured score facts from display detail formatting
  - methodology calculator copy/controls no longer overclaim full production scoring coverage
  - doc-sync checks cover active-depeg policy constants
- Runtime docs, methodology page copy, and scoring changelog copy are aligned.
- Focused tests and doc/data checks pass before final handoff.

## Implementation Steps

1. Add a shared active-depeg policy module.
   - Move/export final cap thresholds and scores from one shared source.
   - Add named policy for Safety Score active-depeg severity source: open active event peak.
   - Reuse the same 2500 bps severe threshold for redemption severe-depeg gating.

2. Start structured scorer/detail separation for peg and liquidity.
   - Introduce small internal result/facts helpers for peg and liquidity scoring.
   - Keep the public `ReportCardDimension` return shape unchanged.
   - Assert scores stay as intended while text changes remain methodology-aligned.

3. Fix peg stability scoring.
   - Remove the active-depeg peg score cap at 65.
   - Keep active-depeg detail visible without saying "capped at C".
   - Update tests that currently assert the legacy cap.

4. Source `activeDepegBps` from open-event peak in report-card snapshots.
   - Build an active-event peak map from `derivePegAnalyticsSnapshot().eventsByCoin`.
   - Pass that map into report-card card construction.
   - Store the peak-derived value in `RawDimensionInputs.activeDepegBps`.
   - Keep current deviation in peg-summary behavior unchanged.

5. Gate stale redemption inputs for report cards.
   - Add a redemption snapshot loader with `{ map, latestUpdatedAt }`.
   - In report-card input loading, suppress redemption rows when latest redemption data is missing or older than the 3600-second report-card redemption freshness budget.
   - Add `redemptionStale` and freshness metadata to the report-card snapshot response.

6. Make dependency-risk handling conservative for partially missing upstreams.
   - Preserve no-dependency behavior.
   - Preserve the full-unavailable fallback score of 70.
   - For partial missing upstream scores, apply score 70 to the missing dependency weights and include them in weak-dependency detection.
   - Include declared/resolved/missing weight diagnostics in details.

7. Make stress-test recomputation transitive.
   - Build a dependency graph from each card's `rawInputs.dependencies`.
   - Traverse from overridden ids to all downstream cards.
   - Recompute downstream cards in dependency order so newly affected scores feed later dependents.
   - Keep direct override behavior unchanged.

8. Move `report_card_cache` publication to the report-card/safety path.
   - Add a small shared writer that serializes non-defunct scored cards to the existing `report_card_cache` shape.
   - Add a DB-only `publish-report-card-cache` quarter-hourly job after a safe `sync-stablecoins` cache write so `/api/chains` keeps its existing 2-hour freshness contract.
   - Call the same writer from `snapshotSafetyGradeHistory()` after a successful daily history snapshot as a safety-net refresh.
   - Remove the cache-write side effect from `sync-yield-data`; yield keeps using live `computeSafetyScoresSnapshot()` for its own ranking run.
   - Preserve the existing cache shape consumed by `/api/chains`.

9. Strengthen score contract tests.
   - Add/update unit tests for:
     - direct peg passthrough during active depeg
     - active event peak D/F caps
     - stale redemption suppression
     - partial missing dependency scoring
     - transitive stress propagation
     - report-card freshness metadata
     - report-card cache publication from the safety snapshot path
   - Keep existing Safety Score focused tests passing.

10. Update docs and methodology surfaces.
   - `docs/report-cards.md`
   - `docs/report-cards-timeline.md`
   - `docs/api-reference.md` for report-card metadata additions
   - `docs/data-pipeline.md` for report-card cache ownership/freshness
   - `docs/architecture.md` and `docs/worker-and-api-limits.md` for the new DB-only report-card cache publication cron
   - `docs/worker-infrastructure.md` if the cron/status model copy needs the new job count or lane called out
   - `shared/lib/safety-score-version-data.ts`
   - `src/app/methodology/sections/core/safety-scores-section.tsx`
   - `src/app/methodology/scoring-changelog/content-v7-0.tsx`
   - `src/app/methodology/scoring-changelog/content-v6.tsx`
   - `src/app/methodology/page.tsx` if FAQ wording needs updated precision

11. Update doc-sync checks.
   - Check Safety Score active-depeg cap thresholds/scores against docs.
   - Check the severe redemption active-depeg threshold against docs.
   - Check report-card docs mention stale redemption suppression once implemented.

12. Validate.
   - `npm test -- shared/lib/__tests__/report-cards.test.ts src/lib/__tests__/report-cards.test.ts worker/src/lib/__tests__/report-cards-snapshot.test.ts worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts worker/src/lib/__tests__/safety-scores.test.ts worker/src/api/__tests__/report-cards.test.ts src/hooks/__tests__/use-stress-test.test.ts worker/src/__tests__/index.scheduled.test.ts`
   - `npm run check:doc-sync`
   - `npm run check:cron-sync`
   - `npm run check:stablecoin-data`
   - `npm run lint`
   - Broader `npm test` if focused changes pass and runtime remains stable.

## Score Impact Disclosure

Expected live score movement based on the audit's 2026-04-15 production inspection:

- Removing the legacy peg cap should raise `USDA` from 58 to about 61.
- Removing the legacy peg cap should raise `meUSD` from 58 to about 59.
- Switching `activeDepegBps` to open-event peak should cap `EURS` from 52 to 49 if its active event remains above 1000 bps.
- Stale redemption gating has no deterministic live impact unless the redemption snapshot is stale at read time; during stale periods, redemption-only or redemption-uplifted liquidity scores can fall back to DEX-only or NR.
- Partial missing dependency handling has no expected live impact because the current live dependency graph has no unresolved upstream scores.
- Transitive stress-test propagation changes simulation output only, not live Safety Scores.

## Review Loop

Pass 1 findings:

- Major: plan omitted `report_card_cache` ownership cleanup.
- Minor: plan omitted API/data-pipeline documentation for new report-card metadata and cache ownership.
- Minor: plan omitted the scorer/detail separation cleanup.

Pass 1 fixes:

- Added implementation step 8 for cache ownership.
- Added docs targets for API reference and data pipeline.
- Added implementation step 2 for structured peg/liquidity scoring facts.

Status: revised after pass 1; ready for pass 2 review.

Pass 2 findings:

- Major: publishing `report_card_cache` only from the daily safety-grade history job would violate `/api/chains`' current 2-hour cache freshness expectation.

Pass 2 fixes:

- Changed cache ownership step to add a DB-only quarter-hourly `publish-report-card-cache` job after safe stablecoin cache writes, with the daily grade-history job as a fallback writer.
- Added `npm run check:cron-sync` to validation because cron metadata changes are now in scope.

Status: revised after pass 2; ready for pass 3 review.

Pass 3 findings:

- Minor: plan did not include worker/cron architecture docs even though adding a status-tracked scheduled job changes the documented job inventory.

Pass 3 fixes:

- Added architecture, worker/API limits, and worker infrastructure docs to the documentation update scope where applicable.

Status: revised after pass 3; ready for pass 4 review.

Pass 4 findings:

- Minor: validation list did not include scheduled-handler tests even though the quarter-hourly slot changes.

Pass 4 fixes:

- Added `worker/src/__tests__/index.scheduled.test.ts` to the focused test command.

Status: pass 4 clean; zero known plan issues remain.

## Implementation Record

Implemented after the clean pass 4 review.

Runtime changes completed:

- Added shared active-depeg policy constants and cap helper.
- Removed the legacy active-depeg peg-dimension cap.
- Switched report-card `activeDepegBps` to open-event peak severity.
- Added stale redemption suppression and report-card input freshness metadata.
- Made partial missing dependency scoring use the 70-point unavailable fallback for missing weights.
- Made stress-test recomputation transitive.
- Moved `report_card_cache` publication to a DB-only quarter-hourly Safety Score cache job, with daily grade-history snapshot as fallback writer.

Documentation/versioning completed:

- Bumped Safety Score methodology to v6.97.
- Updated report-card docs, timeline, methodology page/changelog, API reference, data-pipeline, redemption-backstops, architecture, and worker limit/infrastructure docs.
- Expanded doc-sync checks for active-depeg and stale redemption policy.

Validation completed:

- Focused Safety Score/Yield/Chains tests: passed, 14 files / 285 tests.
- `npm run check:doc-sync`: passed.
- `npm run check:cron-sync`: passed.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm run check:doc-counts`: passed.
- `npm run check:unused-code`: passed.
- `npm run check:stablecoin-data`: passed.
- `git diff --check`: passed.

Known unrelated validation blockers:

- Full `npm test` currently fails in unrelated dirty digest/weekly-recap tests.
- `cd worker && npx tsc --noEmit` currently fails in unrelated dirty digest test code (`daily-digest.test.ts` references `editorialCandidates` on a fixture type that lacks it).
