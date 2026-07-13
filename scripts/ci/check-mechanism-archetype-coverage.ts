#!/usr/bin/env tsx

import { analyzeMechanismArchetypeCoverage } from "../lib/mechanism-archetype-coverage";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";

const result = analyzeMechanismArchetypeCoverage(loadPerCoinStablecoinEntries().map((entry) => entry.coin));

process.stdout.write(
  `mechanism archetype coverage: ${result.resolved}/${result.active} resolved ` +
    `(${result.direct} direct, ${result.inherited} inherited); ` +
    `${result.reviewedUnresolved} reviewed unresolved.\n`,
);

for (const finding of result.findings) {
  process.stdout.write(`  - ${finding.id}: ${finding.kind} - ${finding.detail}\n`);
}

if (result.findings.length > 0) process.exit(1);
