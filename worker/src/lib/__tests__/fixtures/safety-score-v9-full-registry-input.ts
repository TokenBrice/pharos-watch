import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { createReportCardsFixedInput } from "../../report-cards-fixed-input";
import {
  computeNativeDexLiquidityPayloadFingerprint,
  normalizeNativeV9Input,
  type NativeDexLiquidityRow,
  type NativeSafetyScoreV9Input,
} from "../../safety-score-v9-native-input";

// Keep reviewed registry evidence current at this deterministic V9 calibration snapshot.
const CLOCK_SEC = 1_786_060_800;
const DEX_UPDATED_AT_SEC = CLOCK_SEC - 100;

function resourceRoute(assetId: string) {
  const requestedNotionalUsd = 100_000;
  return {
    routeId: `dex:resource:${assetId}`,
    routeFamily: "dex-amm" as const,
    scope: {
      kind: "chain-contract" as const,
      chain: "ethereum",
      contractOrPoolId: `${assetId}:resource-pool`,
      protocol: "resource-fixture",
    },
    requestedNotionalUsd,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: requestedNotionalUsd * 0.8,
    completionRatio: 0.8,
    output: { kind: "fiat" as const, currency: "USD", assetKeys: ["fiat:USD"] },
    evidenceKind: "reserve-based-amm-simulation" as const,
    confidence: "high" as const,
    scoreEligible: true,
    observedAt: DEX_UPDATED_AT_SEC,
    freshnessSeconds: CLOCK_SEC - DEX_UPDATED_AT_SEC,
    commonModeKeys: ["chain:ethereum", "protocol:resource-fixture"],
    capacityCurve: [100_000, 1_000_000, 10_000_000, 100_000_000].map((notional) => ({
      requestedNotionalUsd: notional,
      maxCostBps: 200,
      executableUsd: notional * 0.8,
      completionRatio: 0.8,
    })),
  };
}

/**
 * Production-scale exact input for resource tests. It combines every active
 * registry overlay with deterministic peg, reserve, supply, and route rows
 * without coupling the gate to a production read.
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
    pegDataById: Object.fromEntries(
      ACTIVE_STABLECOINS.map((coin) => [
        coin.id,
        {
          id: coin.id,
          symbol: coin.symbol,
          name: coin.name,
          pegType: "peggedUSD",
          pegCurrency: "USD",
          governance: coin.flags.governance,
          currentDeviationBps: 1,
          pegScore: 100,
          priceSource: "resource-fixture",
          priceObservedAt: DEX_UPDATED_AT_SEC,
          pegPct: 100,
          severityScore: 100,
          spreadPenalty: 0,
          eventCount: 0,
          worstDeviationBps: null,
          activeDepeg: false,
          lastEventAt: null,
          trackingSpanDays: 365,
          historyCoverage: {
            startedAt: CLOCK_SEC - 365 * 24 * 60 * 60,
            source: "asset-age",
            status: "assumed",
          },
          methodologyVersion: "resource-fixture",
        },
      ]),
    ),
    activeDepegPeakBpsById: {},
    dexLiqMap: Object.fromEntries(
      ACTIVE_STABLECOINS.map((coin) => [
        coin.id,
        {
          liquidityScore: 80,
          concentrationHhi: 0.5,
          poolCount: 1,
          chainCount: 1,
          coverageClass: "primary",
          coverageConfidence: 1,
          liquidityEvidenceClass: "measured",
          hasMeasuredLiquidityEvidence: true,
          effectiveTvlUsd: 10_000_000,
          balanceMeasuredTvlUsd: 10_000_000,
          organicMeasuredTvlUsd: 10_000_000,
          exitRouteObservations: [resourceRoute(coin.id)],
          exitRouteObservationCoverage: {
            status: "populated",
            capabilityMatrixVersion: "p4a.4",
            retainedPoolCount: 1,
            observationCount: 1,
            scoreEligibleObservationCount: 1,
            scoreEligiblePoolCount: 1,
            scoreEligibleCapabilityPoolCount: 1,
            unsupportedPoolCount: 0,
            evidenceCounts: { "reserve-based-amm-simulation": 1 },
            unsupportedReasons: {},
          },
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
    liveReserveMap: Object.fromEntries(
      ACTIVE_STABLECOINS.map((coin) => [
        coin.id,
        [
          {
            name: "Resource fixture reserves",
            pct: 100,
            risk: "very-low",
            assetClass: "cash",
            issuerOrObligor: `issuer:${coin.id}`,
            riskFactors: ["custody", "counterparty"],
            liquidityHorizon: "immediate",
            maturityDaysMax: 0,
          },
        ],
      ]),
    ),
    liveReserveProvenanceMap: Object.fromEntries(
      ACTIVE_STABLECOINS.map((coin) => [
        coin.id,
        { source: "resource-fixture", fetchedAt: DEX_UPDATED_AT_SEC },
      ]),
    ),
    chainCirculatingById: Object.fromEntries(
      ACTIVE_STABLECOINS.map((coin) => [
        coin.id,
        {
          ethereum: {
            current: 10_000_000,
            circulatingPrevDay: 10_000_000,
            circulatingPrevWeek: 10_000_000,
            circulatingPrevMonth: 10_000_000,
          },
        },
      ]),
    ),
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

/**
 * The same production-scale capture in the native v4 shape. It is projected
 * from the v3 fixture rather than duplicated so both stay in lockstep while the
 * retained v3 lane still has V8-bound consumers.
 */
export function createNativeSafetyScoreV9FullRegistryInput(): NativeSafetyScoreV9Input {
  const legacy = createSafetyScoreV9FullRegistryInput();
  const {
    schemaVersion: _schemaVersion,
    captureKind: _captureKind,
    baseInputGenerationId: _baseInputGenerationId,
    bluechipMap: _bluechipMap,
    resolvedBlacklistStatuses: _resolvedBlacklistStatuses,
    collateralDriftCoins: _collateralDriftCoins,
    dexLiqMap: legacyDexLiqMap,
    chainCirculatingById: legacyChainCirculatingById,
    dexPayloadFingerprint: _dexPayloadFingerprint,
    ...rest
  } = legacy;
  const dexLiqMap: Record<string, NativeDexLiquidityRow> = Object.fromEntries(
    Object.entries(legacyDexLiqMap).map(([assetId, row]) => [
      assetId,
      {
        updatedAt: row.updatedAt,
        ...(row.exitRouteObservations !== undefined
          ? { exitRouteObservations: row.exitRouteObservations }
          : {}),
        ...(row.exitRouteObservationCoverage !== undefined
          ? { exitRouteObservationCoverage: row.exitRouteObservationCoverage }
          : {}),
      },
    ]),
  );
  return normalizeNativeV9Input({
    ...rest,
    schemaVersion: 4,
    captureKind: "native-v9-inputs",
    dexLiqMap,
    chainCirculatingById: Object.fromEntries(
      Object.entries(legacyChainCirculatingById).map(([assetId, chains]) => [
        assetId,
        Object.fromEntries(Object.entries(chains).map(([chain, bucket]) => [chain, { current: bucket.current }])),
      ]),
    ),
    dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(dexLiqMap, legacy.dexGenerationId),
  });
}
