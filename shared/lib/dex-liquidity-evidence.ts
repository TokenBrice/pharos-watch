export type LiquidityEvidenceClassification = {
  liquidityEvidenceClass: "unobserved" | "measured" | "partial_measured" | "observed_unmeasured";
  hasMeasuredLiquidityEvidence: boolean;
  trendworthy: boolean;
};

/**
 * Two DEX liquidity rows are a comparable pair only when they were scored under
 * the same liquidity methodology version (rows without a recorded version compare
 * only with each other). A methodology step is a recompute, not a market move,
 * so the digest rejects such a pair as `methodology-basis-change`.
 */
export function hasSameLiquidityMethodologyBasis(
  current: string | null | undefined,
  baseline: string | null | undefined,
): boolean {
  return (current ?? null) === (baseline ?? null);
}

/**
 * Liquidity methodology versions whose release changed how retained DEX TVL is
 * measured, as a one-step change with no market move behind it: 6.91 stopped
 * counting NEAR Intents custody as pool reserve (global TVL -8.0%, FRAX -29.7%),
 * and 6.92 stopped counting zero-trade single-sided pools against untracked
 * tokens (global -4.9%, eleven coins -40% to -98%). Version 6.93 removes
 * volume-derived CoinGecko ticker TVL, including legacy registry rows.
 * Versions that only reweight pools, change volume admission, or tighten discovery
 * admission (whose TVL effect ages in over the 14-day registry horizon) are not breaks. Ascending and
 * append-only: any future liquidity version that changes how retained TVL is
 * measured must be appended here in the same change that bumps
 * LIQUIDITY_METHODOLOGY_VERSION, or the 30-day stability series will mix bases.
 */
const LIQUIDITY_TVL_BASIS_BREAK_VERSIONS: readonly string[] = ["6.91", "6.92", "6.93"];

/**
 * TVL-measurement epoch of a persisted liquidity methodology version: the number
 * of LIQUIDITY_TVL_BASIS_BREAK_VERSIONS at or below it. Versions compare
 * numerically (ADR-3 decimal versions). A missing or unparseable version is a
 * legacy row and belongs to the earliest epoch (0).
 */
export function liquidityTvlBasisEpoch(methodologyVersion: string | null | undefined): number {
  const version = methodologyVersion == null ? Number.NaN : Number(methodologyVersion);
  if (!Number.isFinite(version)) return 0;
  return LIQUIDITY_TVL_BASIS_BREAK_VERSIONS.filter((breakVersion) => version >= Number(breakVersion)).length;
}

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
