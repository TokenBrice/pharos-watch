import type { OracleRiskProfile, StablecoinMeta } from "@shared/types";
import type { ReviewedOracleRiskBranchDisposition } from "@shared/data/coverage-dispositions/oracle-risk-branch-dispositions";

export type OracleRiskCoverageFindingKind =
  | "missing-profile"
  | "missing-review-metadata"
  | "missing-branch-applicability"
  | "branch-applicability-unresolved"
  | "missing-branches"
  | "missing-branch-evidence"
  | "reviewed-inoperable-branch-evidence"
  | "stale-branch-disposition"
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
  /**
   * Branches whose only outstanding evidence gap is covered by a reviewed
   * inoperable disposition. Deliberately excluded from `completeBranches` —
   * a researched impossibility is not the same claim as complete evidence.
   */
  reviewedInoperableBranches: number;
  findings: OracleRiskCoverageFinding[];
}

export interface OracleRiskCoverageOptions {
  asOf?: Date;
  staleDays?: number;
  /**
   * Reviewed branch/field exemptions to honour. The caller supplies them — the
   * real register lives in
   * `shared/data/coverage-dispositions/oracle-risk-branch-dispositions.ts` and is
   * wired in by `scripts/ci/check-oracle-risk-coverage.ts`, mirroring how the
   * redemption coverage audit passes its reviewed rows. Empty by default so the
   * analyzer stays a pure function of the coins it is given.
   */
  reviewedBranchDispositions?: readonly ReviewedOracleRiskBranchDisposition[];
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
    // A reviewed-uncallable branch has no delay to report; `liquidationState`
    // is the evidence for this field, and the schema forbids pairing it with
    // a `liquidationDelaySec` value.
    if (field === "liquidationDelaySec" && branch.liquidationState === "uncallable") return false;
    const value = branch[field];
    return value == null || (Array.isArray(value) && value.length === 0);
  });
}

function dispositionKey(id: string, branchId: string, field: string): string {
  return `${id}\0${branchId}\0${field}`;
}

export function analyzeOracleRiskCoverage(
  coins: readonly StablecoinMeta[],
  options: OracleRiskCoverageOptions = {},
): OracleRiskCoverageResult {
  const staleDays = options.staleDays ?? 180;
  const asOf = options.asOf ?? new Date();
  const inScope = coins.filter(isScoreActiveCryptoCdp);
  const findings: OracleRiskCoverageFinding[] = [];

  const reviewedDispositions = options.reviewedBranchDispositions ?? [];
  const dispositionsByKey = new Map<string, ReviewedOracleRiskBranchDisposition>();
  for (const row of reviewedDispositions) {
    dispositionsByKey.set(dispositionKey(row.id, row.branchId, row.field), row);
  }
  /** Rows proven to still describe a real, still-unrecordable gap this run. */
  const appliedDispositionKeys = new Set<string>();
  const reviewedInoperableBranchKeys = new Set<string>();

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
      const missingBranchFields: string[] = [];
      const reviewedInoperableFields: ReviewedOracleRiskBranchDisposition[] = [];
      for (const field of missingBranchEvidenceFields(branch)) {
        const key = dispositionKey(coin.id, branch.id, field);
        const reviewed = dispositionsByKey.get(key);
        if (reviewed) {
          appliedDispositionKeys.add(key);
          reviewedInoperableFields.push(reviewed);
          continue;
        }
        missingBranchFields.push(field);
      }

      if (missingBranchFields.length > 0) {
        findings.push({
          id: coin.id,
          symbol: coin.symbol,
          name: coin.name,
          kind: "missing-branch-evidence",
          detail: `${branch.id} branch missing ${missingBranchFields.join(", ")}`,
        });
      }

      if (reviewedInoperableFields.length > 0) {
        reviewedInoperableBranchKeys.add(`${coin.id}:${branch.id}`);
        for (const reviewed of reviewedInoperableFields) {
          findings.push({
            id: coin.id,
            symbol: coin.symbol,
            name: coin.name,
            kind: "reviewed-inoperable-branch-evidence",
            detail:
              `${branch.id} branch ${reviewed.field} reviewed inoperable (${reviewed.reasonCode}) `
              + `by ${reviewed.reviewer} on ${reviewed.reviewedDate} at ${reviewed.observedBlocks.join(", ")} — `
              + `${reviewed.finding} Evidence: ${reviewed.evidenceUrls.join(", ")}`,
          });
        }
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

  // A reviewed disposition is a claim about a specific gap that still exists.
  // Once the coin, branch, or field moves under it, the claim is no longer
  // evidence of anything — surface it as a blocking finding so the register
  // cannot quietly keep excusing a gap that changed shape.
  const coinsById = new Map(inScope.map((coin) => [coin.id, coin]));
  for (const row of reviewedDispositions) {
    const key = dispositionKey(row.id, row.branchId, row.field);
    if (appliedDispositionKeys.has(key)) continue;
    const coin = coinsById.get(row.id);
    const branch = coin?.oracleRisk?.branches?.find((entry) => entry.id === row.branchId);
    const reason = !coin
      ? "no active crypto-backed CDP with that id"
      : !branch
        ? "profile has no branch with that id"
        : `branch now records ${row.field}`;
    findings.push({
      id: row.id,
      symbol: coin?.symbol ?? row.id,
      name: coin?.name ?? row.id,
      kind: "stale-branch-disposition",
      detail: `${row.branchId} branch ${row.field} disposition no longer applies: ${reason}`,
    });
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
  // Reviewed-inoperable branches are deliberately not complete: the audit knows
  // why the field is blank, which is a different statement from having the
  // evidence. Count them apart so the report can say both things.
  for (const key of reviewedInoperableBranchKeys) incompleteBranchKeys.add(key);
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
    reviewedInoperableBranches: reviewedInoperableBranchKeys.size,
    findings: findings.sort((left, right) => left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind)),
  };
}
