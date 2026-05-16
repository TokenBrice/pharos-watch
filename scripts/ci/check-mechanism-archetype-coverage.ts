#!/usr/bin/env tsx
/**
 * Reports the share of editorial-cohort stablecoins missing
 * `mechanismArchetype`. The cohort is the top-N by canonical rank as
 * recorded in `scripts/lib/curation-baseline-caps.json` (a stable hand-
 * refreshed snapshot, so the gate does not flake on daily mcap shifts).
 *
 * Variants (`variantOf` set) inherit archetype from their parent and are
 * excluded from the gate per the methodology in
 * `docs/process/adding-a-stablecoin.md` Phase 3.
 *
 * Frozen coins are excluded — their archetype rarely changes meaningfully
 * after the freeze, and the field is allowed to lag.
 *
 * Ratchet plan (documented per `agents/curation-cadence-plan-2026-05-16.md`):
 *   - Initial threshold: 0.27 missing — sits ~5pp above the 2026-05-16
 *     baseline (9/41 non-variant in-segment coins missing).
 *   - Tighten to 0.15 once the long-tail Tradable/Apollo private-credit
 *     wrappers receive archetype assignments (or get retired from the
 *     baseline snapshot when they leave the top segment).
 *   - Target 0.05 once a `private-credit` archetype enum is added or
 *     equivalent classification covers the remaining gap.
 */

import {
  analyzeMechanismArchetypeCoverage,
  loadCurationBaselineCaps,
} from "../lib/mechanism-archetype-coverage";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";

const MISSING_RATIO_THRESHOLD = 0.27;

const baseline = loadCurationBaselineCaps();
const entries = loadPerCoinStablecoinEntries();
const result = analyzeMechanismArchetypeCoverage(
  entries.map((entry) => entry.coin),
  baseline,
);

const missingPct = (result.missingRatio * 100).toFixed(1);
const thresholdPct = (MISSING_RATIO_THRESHOLD * 100).toFixed(0);

if (result.unknownBaselineIds.length > 0) {
  process.stderr.write(
    `Curation baseline references coin IDs missing from the per-coin registry:\n`,
  );
  for (const id of result.unknownBaselineIds) {
    process.stderr.write(`  - ${id}\n`);
  }
  process.stderr.write(
    `Refresh scripts/lib/curation-baseline-caps.json or restore the missing per-coin JSON.\n`,
  );
  process.exit(1);
}

if (result.missingRatio > MISSING_RATIO_THRESHOLD) {
  process.stderr.write(
    `mechanismArchetype coverage below threshold for the ${baseline.segmentLabel} cohort: ` +
      `${result.withoutArchetype}/${result.segmentTracked} non-variant coins lack mechanismArchetype ` +
      `(${missingPct}% missing > ${thresholdPct}% threshold).\n`,
  );
  process.stderr.write("Missing mechanismArchetype on:\n");
  for (const id of result.missingIds) {
    process.stderr.write(`  - ${id}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `mechanismArchetype coverage OK for ${baseline.segmentLabel}: ` +
    `${result.withArchetype}/${result.segmentTracked} non-variant coins have an archetype ` +
    `(${missingPct}% missing <= ${thresholdPct}% threshold; ` +
    `${result.segmentVariants} variants and ${result.excludedFrozenIds.length} frozen excluded).\n`,
);
