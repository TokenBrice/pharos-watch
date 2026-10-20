#!/usr/bin/env tsx
/**
 * Blocking coverage guard for reviewed CDP oracle-risk metadata.
 *
 * Stale-review reminders remain advisory; structural gaps always fail.
 */

import type { StablecoinMeta } from "@shared/types";
import {
  analyzeOracleRiskCoverage,
  isBlockingOracleRiskCoverageFinding,
} from "../lib/oracle-risk-coverage";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

interface OutputWriter {
  write(value: string): unknown;
}

interface RunOracleRiskCoverageCheckOptions {
  stdout?: OutputWriter;
  stderr?: OutputWriter;
}

export function runOracleRiskCoverageCheck(
  coins: readonly StablecoinMeta[],
  argv: readonly string[] = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
  }: RunOracleRiskCoverageCheckOptions = {},
): number {
  const retiredArg = argv.find((arg) => arg === "--advisory" || arg.startsWith("--advisory="));
  if (retiredArg) {
    stderr.write(`Unknown argument: ${retiredArg}\n`);
    return 1;
  }
  const staleDaysArg = argv.find((arg) => arg.startsWith("--stale-days="));
  const staleDays = staleDaysArg ? Number.parseInt(staleDaysArg.slice("--stale-days=".length), 10) : 180;

  if (!Number.isFinite(staleDays) || staleDays <= 0) {
    stderr.write("--stale-days must be a positive integer\n");
    return 1;
  }

  const result = analyzeOracleRiskCoverage(coins, { staleDays });

  stdout.write(
    `oracleRisk coverage: ${result.withOracleRisk}/${result.totalCryptoCdp} direct active crypto-backed CDPs have oracleRisk; ` +
      `${result.completeProfiles} complete profiles; ${result.completeBranches}/${result.branches} branches complete; ` +
      `${result.reviewedBranchApplicability} reviewed branch dispositions ` +
      `(${result.branchesRequired} required, ${result.branchNotApplicable} not applicable, ` +
      `${result.branchApplicabilityUnresolved} unresolved).\n`,
  );

  if (result.findings.length > 0) {
    stdout.write("Findings:\n");
    for (const finding of result.findings) {
      const tag = !isBlockingOracleRiskCoverageFinding(finding) ? " (advisory)" : "";
      stdout.write(`  - ${finding.id} (${finding.symbol}): ${finding.kind}${tag} — ${finding.detail}\n`);
    }
  }

  return result.findings.some(isBlockingOracleRiskCoverageFinding) ? 1 : 0;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  process.exitCode = runOracleRiskCoverageCheck(
    loadPerCoinStablecoinEntries().map((entry) => entry.coin),
  );
}
