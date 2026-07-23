import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { createReportCardsFixedInput } from "../../report-cards-fixed-input";

const CLOCK_SEC = 2_000_000_000;
const DEX_UPDATED_AT_SEC = CLOCK_SEC - 100;

/**
 * Sparse but production-scale exact input for resource tests. Every active
 * registry overlay is compiled without coupling the gate to a production read.
 */
export function createSafetyScoreV9FullRegistryInput() {
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    capturedAt: new Date(CLOCK_SEC * 1_000).toISOString(),
    sourceGeneration: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${CLOCK_SEC}`,
    dexGenerationId: `dex-liquidity-${DEX_UPDATED_AT_SEC}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "safety-score-v9-resource-fixture",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: CLOCK_SEC,
    updatedAt: CLOCK_SEC,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: DEX_UPDATED_AT_SEC, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: Object.fromEntries(
      ACTIVE_STABLECOINS.map((coin) => [
        coin.id,
        {
          liquidityScore: null,
          concentrationHhi: null,
          poolCount: 0,
          chainCount: 0,
          methodologyVersion: "resource-fixture",
          updatedAt: DEX_UPDATED_AT_SEC,
        },
      ]),
    ),
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: Object.fromEntries(
      ACTIVE_STABLECOINS.map((coin) => [coin.id, false]),
    ),
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}
