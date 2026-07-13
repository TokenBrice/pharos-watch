import type { DexExitEvidenceKind, LiquidityCoverageClass, LiquidityEvidenceClass } from "../types/market";

export interface ReportCardDexEvidenceInput {
  liquidityScore: number | null;
  coverageClass?: LiquidityCoverageClass | null;
  coverageConfidence?: number | null;
  liquidityEvidenceClass?: LiquidityEvidenceClass | null;
  hasMeasuredLiquidityEvidence?: boolean | null;
  effectiveTvlUsd?: number | null;
  balanceMeasuredTvlUsd?: number | null;
  organicMeasuredTvlUsd?: number | null;
  deploymentCoverage?: {
    observedPools: number;
    verifiedNoPools: number;
    providerInaccessible: number;
  } | null;
}

export interface ReportCardDexEvidencePolicy {
  observedScore: number | null;
  effectiveScore: number | null;
  evidenceKind: DexExitEvidenceKind | null;
  scoreCeiling: number | null;
  reason: string | null;
  legacyNeutral: boolean;
}

const EVIDENCE_CEILINGS: Readonly<Record<DexExitEvidenceKind, number | null>> = {
  "measured-executable-depth": null,
  "reserve-based-amm-simulation": 85,
  "direct-orderbook-depth": null,
  "generic-tvl-proxy": 60,
  "synthetic-or-fallback": 55,
  unobserved: null,
};

function classifyReportCardDexEvidence(
  input: Omit<ReportCardDexEvidenceInput, "liquidityScore">,
): DexExitEvidenceKind | null {
  const hasNewEvidence =
    input.coverageClass !== undefined ||
    input.coverageConfidence !== undefined ||
    input.liquidityEvidenceClass !== undefined ||
    input.balanceMeasuredTvlUsd !== undefined ||
    input.deploymentCoverage !== undefined;
  if (!hasNewEvidence) return null;
  if (input.coverageClass === "legacy") return null;
  if (input.liquidityEvidenceClass === "unobserved") return "unobserved";
  if (input.coverageClass === "fallback") {
    return "synthetic-or-fallback";
  }
  if (input.liquidityEvidenceClass === "observed_unmeasured" || input.hasMeasuredLiquidityEvidence === false) {
    return "generic-tvl-proxy";
  }
  if ((input.balanceMeasuredTvlUsd ?? 0) > 0) {
    return "reserve-based-amm-simulation";
  }
  return "generic-tvl-proxy";
}

export function applyReportCardDexEvidencePolicy(input: ReportCardDexEvidenceInput): ReportCardDexEvidencePolicy {
  const evidenceKind = classifyReportCardDexEvidence(input);
  if (input.liquidityScore == null) {
    return {
      observedScore: null,
      effectiveScore: null,
      evidenceKind,
      scoreCeiling: null,
      reason: null,
      legacyNeutral: evidenceKind == null,
    };
  }
  if (evidenceKind == null) {
    return {
      observedScore: input.liquidityScore,
      effectiveScore: input.liquidityScore,
      evidenceKind: null,
      scoreCeiling: null,
      reason: null,
      legacyNeutral: true,
    };
  }

  let scoreCeiling = EVIDENCE_CEILINGS[evidenceKind];
  let reason = scoreCeiling == null ? null : `${evidenceKind} evidence ceiling`;
  const deploymentCoverage = input.deploymentCoverage;
  if (
    deploymentCoverage != null &&
    deploymentCoverage.observedPools === 0 &&
    deploymentCoverage.verifiedNoPools === 0 &&
    deploymentCoverage.providerInaccessible > 0
  ) {
    scoreCeiling = Math.min(scoreCeiling ?? 100, 45);
    reason = "no observed deployment and at least one provider-inaccessible deployment";
  }
  if (input.coverageConfidence != null && input.coverageConfidence < 0.75) {
    scoreCeiling = Math.min(scoreCeiling ?? 100, 60);
    reason = reason ?? "DEX coverage confidence below 0.75";
  }

  return {
    observedScore: input.liquidityScore,
    effectiveScore: scoreCeiling == null ? input.liquidityScore : Math.min(input.liquidityScore, scoreCeiling),
    evidenceKind,
    scoreCeiling,
    reason,
    legacyNeutral: false,
  };
}
