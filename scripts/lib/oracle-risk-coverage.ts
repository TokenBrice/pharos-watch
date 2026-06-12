import type { OracleRiskProfile, StablecoinMeta } from "../../shared/types";

export type OracleRiskCoverageFindingKind = "missing-profile" | "missing-review-metadata" | "stale-review";

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
  findings: OracleRiskCoverageFinding[];
}

export interface OracleRiskCoverageOptions {
  asOf?: Date;
  staleDays?: number;
}

function isActiveCryptoCdp(coin: StablecoinMeta): boolean {
  return (
    (coin.status ?? "active") === "active" &&
    coin.flags.backing === "crypto-backed" &&
    coin.mechanismArchetype === "cdp"
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

export function analyzeOracleRiskCoverage(
  coins: readonly StablecoinMeta[],
  options: OracleRiskCoverageOptions = {},
): OracleRiskCoverageResult {
  const staleDays = options.staleDays ?? 180;
  const asOf = options.asOf ?? new Date();
  const inScope = coins.filter(isActiveCryptoCdp);
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
    findings.filter((finding) => finding.kind !== "stale-review").map((finding) => finding.id),
  );
  const completeProfiles = withOracleRisk - incompleteIds.size;

  return {
    totalCryptoCdp: inScope.length,
    withOracleRisk,
    missingOracleRisk,
    completeProfiles,
    findings: findings.sort((left, right) => left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind)),
  };
}
