#!/usr/bin/env tsx
/**
 * Warning-only coverage report for reviewed CDP oracle-risk metadata.
 *
 * Default mode exits 0 so the remaining CDP backfill can proceed in batches.
 * Pass `--enforce` once the reviewed batch is complete to turn any missing,
 * incomplete, or stale profile into a failing guardrail.
 */

import { analyzeOracleRiskCoverage } from "../lib/oracle-risk-coverage";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";

const ENFORCE = process.argv.includes("--enforce");
const staleDaysArg = process.argv.find((arg) => arg.startsWith("--stale-days="));
const staleDays = staleDaysArg ? Number.parseInt(staleDaysArg.slice("--stale-days=".length), 10) : 180;

if (!Number.isFinite(staleDays) || staleDays <= 0) {
  process.stderr.write("--stale-days must be a positive integer\n");
  process.exit(1);
}

const coins = loadPerCoinStablecoinEntries().map((entry) => entry.coin);
const result = analyzeOracleRiskCoverage(coins, { staleDays });
const prefix = ENFORCE ? "oracleRisk coverage" : "oracleRisk coverage warning";

process.stdout.write(
  `${prefix}: ${result.withOracleRisk}/${result.totalCryptoCdp} direct active crypto-backed CDPs have oracleRisk; ` +
    `${result.completeProfiles} complete profiles; ${result.completeBranches}/${result.branches} branches complete.\n`,
);

if (result.findings.length > 0) {
  process.stdout.write("Findings:\n");
  for (const finding of result.findings) {
    const tag = finding.kind === "stale-review" || finding.kind === "stale-branch-observation" ? " (advisory)" : "";
    process.stdout.write(`  - ${finding.id} (${finding.symbol}): ${finding.kind}${tag} — ${finding.detail}\n`);
  }
}

// Staleness is a maintenance reminder, not a structural gap — a review past the
// window still scores. Enforce only on missing/incomplete profiles so the merge
// gate cannot become a time-bomb that blocks unrelated work as reviews age.
const blockingFindings = result.findings.filter(
  (finding) => finding.kind !== "stale-review" && finding.kind !== "stale-branch-observation",
);

if (ENFORCE && blockingFindings.length > 0) {
  process.exit(1);
}
