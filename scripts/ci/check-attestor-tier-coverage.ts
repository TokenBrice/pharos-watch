#!/usr/bin/env tsx
/**
 * Reports independent-audit stablecoins missing `proofOfReserves.attestorTier`.
 * Fails when more than MISSING_RATIO_THRESHOLD of independent-audit coins lack
 * the tier so curation gaps in the attestor-tier ladder do not silently widen.
 */

import { analyzeAttestorTierCoverage } from "../lib/attestor-tier-coverage";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";

const MISSING_RATIO_THRESHOLD = 0.2;

const entries = loadPerCoinStablecoinEntries();
const result = analyzeAttestorTierCoverage(entries.map((entry) => entry.coin));

const missingPct = (result.missingRatio * 100).toFixed(1);
const thresholdPct = (MISSING_RATIO_THRESHOLD * 100).toFixed(0);

if (result.missingRatio > MISSING_RATIO_THRESHOLD) {
  process.stderr.write(
    `attestorTier coverage below threshold: ${result.withoutTier}/${result.total} independent-audit coins ` +
      `lack proofOfReserves.attestorTier (${missingPct}% missing > ${thresholdPct}% threshold).\n`,
  );
  process.stderr.write("Missing attestorTier on:\n");
  for (const id of result.missingIds) {
    process.stderr.write(`  - ${id}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `attestorTier coverage OK: ${result.withTier}/${result.total} independent-audit coins have a tier ` +
    `(${missingPct}% missing <= ${thresholdPct}% threshold).\n`,
);
