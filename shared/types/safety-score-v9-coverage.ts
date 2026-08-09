/**
 * V9 release coverage floors.
 *
 * The wider release-cohort coverage cluster (manifest/report schemas,
 * `shared/lib/safety-score-v9/coverage.ts`, and the
 * `safety-score-v9:coverage` CLI) was deleted 2026-08-09: its producer was
 * removed 2026-07-23 and the release-cohort manifest the gate required never
 * existed, so nothing could run it. Migration 0211 rows stay historical.
 *
 * These floors survive on their own because they are still a live fail-closed
 * gate: `worker/src/lib/safety-score-v9-publication-runner.ts` refuses to
 * publish a V9 evaluation whose rateable-asset count regresses below
 * `minimumRateableAssets`.
 */

/** Locked V9-9 release floors. A release decision cannot weaken these at runtime. */
export const V9_RELEASE_COVERAGE_FLOORS = {
  // Re-derived 2026-07-22 (owner ruling, reshape-v2 D6): the original 305 was
  // calibrated against the pre-withhold engine. New floor = stacked-CF rateable
  // count 281 minus a 10-asset drift buffer; NR-insufficient withholds never
  // count toward it. The number is published in the release notes and the
  // readiness doc; a rated-count regression below it still blocks release.
  minimumRateableAssets: 271,
  minimumRateableWeightBps: 9_900,
  topCutoffPosition: 25,
  minimumArchetypeRateableAssets: 3,
  minimumArchetypeRateableWeightBps: 8_000,
  calibrationCohortAssets: 24,
  calibrationRequiredRateableAssets: 21,
  calibrationIntentionalEvidenceGapAssets: 3,
  minimumDexContributingAssets: 45,
  minimumRedemptionContributingAssets: 27,
} as const;
