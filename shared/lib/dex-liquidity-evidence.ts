export type LiquidityEvidenceClassification = {
  liquidityEvidenceClass: "unobserved" | "measured" | "partial_measured" | "observed_unmeasured";
  hasMeasuredLiquidityEvidence: boolean;
  trendworthy: boolean;
};

export function isTrendworthyLiquiditySnapshot(
  totalTvlUsd: number,
  coverageClass: string | null,
  coverageConfidence: number | null,
): boolean {
  if (totalTvlUsd <= 0) return false;
  if ((coverageConfidence ?? 0) < 0.75) return false;
  return coverageClass === "primary" || coverageClass === "mixed";
}

export function classifyLiquidityEvidence(
  totalTvlUsd: number,
  coverageClass: string | null,
  coverageConfidence: number | null,
): LiquidityEvidenceClassification {
  if (totalTvlUsd <= 0) {
    return {
      liquidityEvidenceClass: "unobserved",
      hasMeasuredLiquidityEvidence: false,
      trendworthy: false,
    };
  }
  const trendworthy = isTrendworthyLiquiditySnapshot(totalTvlUsd, coverageClass, coverageConfidence);
  if (trendworthy && coverageClass === "primary") {
    return {
      liquidityEvidenceClass: "measured",
      hasMeasuredLiquidityEvidence: true,
      trendworthy,
    };
  }
  if (trendworthy) {
    return {
      liquidityEvidenceClass: "partial_measured",
      hasMeasuredLiquidityEvidence: true,
      trendworthy,
    };
  }
  return {
    liquidityEvidenceClass: "observed_unmeasured",
    hasMeasuredLiquidityEvidence: false,
    trendworthy,
  };
}
