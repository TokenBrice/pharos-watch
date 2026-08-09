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
import { REVIEWED_ORACLE_RISK_BRANCH_DISPOSITIONS } from "@shared/data/coverage-dispositions/oracle-risk-branch-dispositions";

const ENFORCE = process.argv.includes("--enforce");
const staleDaysArg = process.argv.find((arg) => arg.startsWith("--stale-days="));
const staleDays = staleDaysArg ? Number.parseInt(staleDaysArg.slice("--stale-days=".length), 10) : 180;

if (!Number.isFinite(staleDays) || staleDays <= 0) {
  process.stderr.write("--stale-days must be a positive integer\n");
  process.exit(1);
}

const coins = loadPerCoinStablecoinEntries().map((entry) => entry.coin);
const result = analyzeOracleRiskCoverage(coins, {
  staleDays,
  reviewedBranchDispositions: REVIEWED_ORACLE_RISK_BRANCH_DISPOSITIONS,
});
const prefix = ENFORCE ? "oracleRisk coverage" : "oracleRisk coverage warning";

process.stdout.write(
  `${prefix}: ${result.withOracleRisk}/${result.totalCryptoCdp} direct active crypto-backed CDPs have oracleRisk; ` +
    `${result.completeProfiles} complete profiles; ${result.completeBranches}/${result.branches} branches complete; ` +
    `${result.reviewedInoperableBranches} branches reviewed inoperable (evidence recorded, field inexpressible); ` +
    `${result.reviewedBranchApplicability} reviewed branch dispositions ` +
    `(${result.branchesRequired} required, ${result.branchNotApplicable} not applicable, ` +
    `${result.branchApplicabilityUnresolved} unresolved).\n`,
);

const ADVISORY_FINDING_KINDS = [
  "stale-review",
  "stale-branch-observation",
  "missing-branch-applicability",
  "branch-applicability-unresolved",
];

if (result.findings.length > 0) {
  process.stdout.write("Findings:\n");
  for (const finding of result.findings) {
    const tag = finding.kind === "reviewed-inoperable-branch-evidence"
      ? " (reviewed — not counted complete)"
      : ADVISORY_FINDING_KINDS.includes(finding.kind)
        ? " (advisory)"
        : "";
    process.stdout.write(`  - ${finding.id} (${finding.symbol}): ${finding.kind}${tag} — ${finding.detail}\n`);
  }
}

// Staleness is a maintenance reminder, not a structural gap — a review past the
// window still scores. Enforce only on missing/incomplete profiles so the merge
// gate cannot become a time-bomb that blocks unrelated work as reviews age.
//
// `reviewed-inoperable-branch-evidence` is also non-blocking: the gap is
// researched, evidenced, and unrecordable in the current schema, so the honest
// state is "reviewed", not "outstanding work". The paired
// `stale-branch-disposition` kind stays blocking — it is what stops that
// exemption from outliving the situation that earned it.
const blockingFindings = result.findings.filter(
  (finding) =>
    ![...ADVISORY_FINDING_KINDS, "reviewed-inoperable-branch-evidence"].includes(finding.kind),
);

if (ENFORCE && blockingFindings.length > 0) {
  process.exit(1);
}
