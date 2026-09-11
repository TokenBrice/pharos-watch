import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import { createReportCardsFixedInput } from "../../src/lib/report-cards-fixed-input";

export interface ReplayFixedInputOptions {
  activeAssetIds?: string[];
  supplyById?: Record<string, number>;
  sourceGeneration?: string;
  registryRevision?: string;
}

function dexLiquidityRow(observedAtSec: number) {
  return {
    liquidityScore: 90,
    concentrationHhi: 0.5,
    poolCount: 1,
    chainCount: 1,
    coverageClass: "primary" as const,
    coverageConfidence: 1,
    liquidityEvidenceClass: "measured" as const,
    hasMeasuredLiquidityEvidence: true,
    effectiveTvlUsd: 1_000_000,
    balanceMeasuredTvlUsd: 1_000_000,
    organicMeasuredTvlUsd: 1_000_000,
    methodologyVersion: "dex:fixture-v1",
    updatedAt: observedAtSec,
  };
}

function chainSupply(current: number) {
  return {
    ethereum: {
      current,
      circulatingPrevDay: current,
      circulatingPrevWeek: current,
      circulatingPrevMonth: current,
    },
  };
}

export function createReplayFixedInput(clockSec: number, options: ReplayFixedInputOptions = {}) {
  const observedAtSec = clockSec - 100;
  const activeAssetIds = options.activeAssetIds ?? ["usdc-circle"];
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds,
    capturedAt: new Date(clockSec * 1_000).toISOString(),
    sourceGeneration: options.sourceGeneration ?? `report-cards:fixture:${clockSec}`,
    dexGenerationId: `dex-liquidity-${observedAtSec}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: options.registryRevision ?? "registry:calibration-analysis-fixture",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec,
    updatedAt: clockSec,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: observedAtSec, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: Object.fromEntries(activeAssetIds.map((assetId) => [assetId, dexLiquidityRow(observedAtSec)])),
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: Object.fromEntries(activeAssetIds.map((assetId) => [assetId, false])),
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: Object.fromEntries(
      activeAssetIds.map((assetId) => [assetId, chainSupply(options.supplyById?.[assetId] ?? 10_000_000)]),
    ),
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}
