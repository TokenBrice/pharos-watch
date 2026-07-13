import type { OracleRiskProfile, StablecoinMeta } from "../../shared/types";

export type OracleRiskCoverageFindingKind =
  | "missing-profile"
  | "missing-review-metadata"
  | "missing-branch-applicability"
  | "branch-applicability-unresolved"
  | "missing-branches"
  | "missing-branch-evidence"
  | "stale-review"
  | "stale-branch-observation";

export interface OracleRiskCoverageFinding {
  id: string;
  symbol: string;
  name: string;
  kind: OracleRiskCoverageFindingKind;
  detail: string;
}

export interface OracleRiskCoverageResult {
  totalCryptoCdp: number;
  withOracleRisk: number;
  missingOracleRisk: number;
  completeProfiles: number;
  reviewedBranchApplicability: number;
  branchesRequired: number;
  branchNotApplicable: number;
  branchApplicabilityUnresolved: number;
  branchProfiles: number;
  branches: number;
  completeBranches: number;
  findings: OracleRiskCoverageFinding[];
}

export interface OracleRiskCoverageOptions {
  asOf?: Date;
  staleDays?: number;
}

function isScoreActiveCryptoCdp(coin: StablecoinMeta): boolean {
  return (
    (coin.status ?? "active") === "active" &&
    coin.flags.backing === "crypto-backed" &&
    coin.mechanismArchetype === "cdp" &&
    !coin.variantOf
  );
}

function parseReviewDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(left: Date, right: Date): number {
  return Math.floor((left.getTime() - right.getTime()) / 86_400_000);
}

function missingReviewFields(profile: OracleRiskProfile): string[] {
  const missing: string[] = [];
  if (!profile.reviewedAt) missing.push("reviewedAt");
  if (!profile.reviewer) missing.push("reviewer");
  if (!profile.confidence) missing.push("confidence");
  return missing;
}

const REQUIRED_BRANCH_EVIDENCE_FIELDS = [
  "feeds",
  "fallbackBehavior",
  "observedAt",
  "collateralParameters",
  "liquidationMechanism",
  "liquidationDelaySec",
  "backstop",
  "shutdownOrBadDebtBehavior",
  "sources",
] as const;

function missingBranchEvidenceFields(branch: NonNullable<OracleRiskProfile["branches"]>[number]): string[] {
  return REQUIRED_BRANCH_EVIDENCE_FIELDS.filter((field) => {
    const value = branch[field];
    return value == null || (Array.isArray(value) && value.length === 0);
  });
}

export function analyzeOracleRiskCoverage(
  coins: readonly StablecoinMeta[],
  options: OracleRiskCoverageOptions = {},
): OracleRiskCoverageResult {
  const staleDays = options.staleDays ?? 180;
  const asOf = options.asOf ?? new Date();
  const inScope = coins.filter(isScoreActiveCryptoCdp);
  const findings: OracleRiskCoverageFinding[] = [];

  for (const coin of inScope) {
    const profile = coin.oracleRisk;
    if (!profile) {
      findings.push({
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        kind: "missing-profile",
        detail: "crypto-backed CDP has no oracleRisk profile",
      });
      continue;
    }

    const missingFields = missingReviewFields(profile);
    if (missingFields.length > 0) {
      findings.push({
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        kind: "missing-review-metadata",
        detail: `oracleRisk missing ${missingFields.join(", ")}`,
      });
    }

    const branchApplicability = profile.branchApplicability;
    if (!branchApplicability) {
      findings.push({
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        kind: "missing-branch-applicability",
        detail: "oracleRisk has no reviewed branch applicability disposition",
      });
    } else if (branchApplicability.disposition === "unresolved") {
      findings.push({
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        kind: "branch-applicability-unresolved",
        detail: `branch applicability remains unresolved: ${branchApplicability.rationale}`,
      });
    }

    if (branchApplicability?.disposition === "branches-required" && !profile.branches?.length) {
      findings.push({
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        kind: "missing-branches",
        detail: "branch-required oracleRisk profile has no branch rows",
      });
    }

    for (const branch of profile.branches ?? []) {
      const missingBranchFields = missingBranchEvidenceFields(branch);
      if (missingBranchFields.length > 0) {
        findings.push({
          id: coin.id,
          symbol: coin.symbol,
          name: coin.name,
          kind: "missing-branch-evidence",
          detail: `${branch.id} branch missing ${missingBranchFields.join(", ")}`,
        });
      }

      const observedAt = parseReviewDate(branch.observedAt);
      if (observedAt && daysBetween(asOf, observedAt) > staleDays) {
        findings.push({
          id: coin.id,
          symbol: coin.symbol,
          name: coin.name,
          kind: "stale-branch-observation",
          detail: `${branch.id} branch observation is older than ${staleDays} days`,
        });
      }
    }

    const reviewedAt = parseReviewDate(profile.reviewedAt);
    if (reviewedAt && daysBetween(asOf, reviewedAt) > staleDays) {
      findings.push({
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        kind: "stale-review",
        detail: `oracleRisk review is older than ${staleDays} days`,
      });
    }
  }

  const withOracleRisk = inScope.filter((coin) => coin.oracleRisk != null).length;
  const missingOracleRisk = inScope.length - withOracleRisk;
  const incompleteIds = new Set(
    findings
      .filter(
        (finding) =>
          ![
            "stale-review",
            "stale-branch-observation",
            "missing-branch-applicability",
            "branch-applicability-unresolved",
          ].includes(finding.kind),
      )
      .map((finding) => finding.id),
  );
  const completeProfiles = withOracleRisk - incompleteIds.size;
  const branchProfiles = inScope.filter((coin) => (coin.oracleRisk?.branches?.length ?? 0) > 0).length;
  const branches = inScope.reduce((sum, coin) => sum + (coin.oracleRisk?.branches?.length ?? 0), 0);
  const incompleteBranchKeys = new Set(
    findings
      .filter((finding) => finding.kind === "missing-branch-evidence")
      .map((finding) => `${finding.id}:${finding.detail.split(" branch missing", 1)[0]}`),
  );
  const reviewedBranchApplicability = inScope.filter((coin) => coin.oracleRisk?.branchApplicability != null).length;
  const branchesRequired = inScope.filter(
    (coin) => coin.oracleRisk?.branchApplicability?.disposition === "branches-required",
  ).length;
  const branchNotApplicable = inScope.filter(
    (coin) => coin.oracleRisk?.branchApplicability?.disposition === "not-applicable",
  ).length;
  const branchApplicabilityUnresolved = inScope.filter(
    (coin) => coin.oracleRisk?.branchApplicability?.disposition === "unresolved",
  ).length;

  return {
    totalCryptoCdp: inScope.length,
    withOracleRisk,
    missingOracleRisk,
    completeProfiles,
    reviewedBranchApplicability,
    branchesRequired,
    branchNotApplicable,
    branchApplicabilityUnresolved,
    branchProfiles,
    branches,
    completeBranches: branches - incompleteBranchKeys.size,
    findings: findings.sort((left, right) => left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind)),
  };
}
