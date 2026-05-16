#!/usr/bin/env tsx
/**
 * Reports active/pre-launch stablecoins missing the editorial `oneLiner`
 * field. Fails when any in-scope coin lacks one so the bulk-curated 100%
 * coverage does not silently regress when new coins land.
 *
 * Frozen coins are excluded (their oneLiner shifts to past tense and is
 * curated alongside the obituary block, not via this gate).
 */

import { analyzeOneLinerCoverage } from "../lib/one-liner-coverage";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";

const entries = loadPerCoinStablecoinEntries();
const result = analyzeOneLinerCoverage(entries.map((entry) => entry.coin));

if (result.withoutOneLiner > 0) {
  process.stderr.write(
    `oneLiner coverage gap: ${result.withoutOneLiner}/${result.total} active or pre-launch ` +
      `coins lack a oneLiner.\n`,
  );
  process.stderr.write("Missing oneLiner on:\n");
  for (const id of result.missingIds) {
    process.stderr.write(`  - ${id}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `oneLiner coverage OK: ${result.withOneLiner}/${result.total} active or pre-launch coins have one.\n`,
);
