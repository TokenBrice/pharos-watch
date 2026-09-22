#!/usr/bin/env tsx
/**
 * Blocking coverage guard for reviewed CDP oracle-risk metadata.
 *
 * Pass `--advisory` while backfilling to report structural gaps without
 * failing. Stale-review reminders remain advisory in either mode.
 */

import type { StablecoinMeta } from "@shared/types";
import {
  REVIEWED_ORACLE_RISK_BRANCH_DISPOSITIONS,
  type ReviewedOracleRiskBranchDisposition,
} from "@shared/data/coverage-dispositions/oracle-risk-branch-dispositions";
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
  reviewedBranchDispositions?: readonly ReviewedOracleRiskBranchDisposition[];
}

export function runOracleRiskCoverageCheck(
  coins: readonly StablecoinMeta[],
  argv: readonly string[] = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    reviewedBranchDispositions = REVIEWED_ORACLE_RISK_BRANCH_DISPOSITIONS,
  }: RunOracleRiskCoverageCheckOptions = {},
): number {
  const advisory = argv.includes("--advisory");
  const staleDaysArg = argv.find((arg) => arg.startsWith("--stale-days="));
  const staleDays = staleDaysArg ? Number.parseInt(staleDaysArg.slice("--stale-days=".length), 10) : 180;

  if (!Number.isFinite(staleDays) || staleDays <= 0) {
    stderr.write("--stale-days must be a positive integer\n");
    return 1;
  }

  const result = analyzeOracleRiskCoverage(coins, {
    staleDays,
    reviewedBranchDispositions,
  });
  const prefix = advisory ? "oracleRisk coverage advisory" : "oracleRisk coverage";

  stdout.write(
    `${prefix}: ${result.withOracleRisk}/${result.totalCryptoCdp} direct active crypto-backed CDPs have oracleRisk; ` +
      `${result.completeProfiles} complete profiles; ${result.completeBranches}/${result.branches} branches complete; ` +
      `${result.reviewedInoperableBranches} branches reviewed inoperable (evidence recorded, field inexpressible); ` +
      `${result.reviewedBranchApplicability} reviewed branch dispositions ` +
      `(${result.branchesRequired} required, ${result.branchNotApplicable} not applicable, ` +
      `${result.branchApplicabilityUnresolved} unresolved).\n`,
  );

  if (result.findings.length > 0) {
    stdout.write("Findings:\n");
    for (const finding of result.findings) {
      const tag = finding.kind === "reviewed-inoperable-branch-evidence"
        ? " (reviewed — not counted complete)"
        : !isBlockingOracleRiskCoverageFinding(finding)
          ? " (advisory)"
          : "";
      stdout.write(`  - ${finding.id} (${finding.symbol}): ${finding.kind}${tag} — ${finding.detail}\n`);
    }
  }

  return !advisory && result.findings.some(isBlockingOracleRiskCoverageFinding) ? 1 : 0;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  process.exitCode = runOracleRiskCoverageCheck(
    loadPerCoinStablecoinEntries().map((entry) => entry.coin),
  );
}
