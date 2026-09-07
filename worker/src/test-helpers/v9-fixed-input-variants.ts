import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { createReportCardsFixedInput, normalizeFixedInput, type ReportCardsFixedInputDraft } from "../lib/report-cards-fixed-input";
import { makeSupplyFullRedemption } from "../lib/__tests__/redemption-backstops-store.test-support";
import { buildReviewedDeploymentRouteInventory, deriveReviewedDeploymentUnitPartition } from "../lib/safety-score-v9/supply-attribution-contract";
import { V9_FIXTURE_CLOCK_SEC, V9_FIXTURE_OBSERVED_AT_SEC, makeWmDeploymentObservations } from "./v9-fixed-input-observations";
import { makeV9FixedInput, type V9FixedInput, v9ExitRouteObservation } from "./v9-fixed-input-core";

/** Re-derive the identity-owned fields so a mutated draft can be re-sealed. */
function reseal(
  input: V9FixedInput,
  overrides: Partial<ReportCardsFixedInputDraft> & { activeAssetIds: string[] },
) {
  const {
    schemaVersion: _schemaVersion,
    activeAssetIds: _activeAssetIds,
    dexPayloadFingerprint: _dexPayloadFingerprint,
    redemptionPayloadFingerprint: _redemptionPayloadFingerprint,
    registryFingerprint: _registryFingerprint,
    inputMethodologyVersions: _inputMethodologyVersions,
    baseInputGenerationId: _baseInputGenerationId,
    ...draft
  } = input;
  return createReportCardsFixedInput({ ...draft, ...overrides });
}

/** Attach the reviewed wM deployment-unit supply attribution to a wM capture. */
export function withV9WmReviewedDeploymentAttribution(fixedInput: V9FixedInput) {
  const aggregateSupplyUsd = Object.values(
    fixedInput.aggregateCirculatingById["wm-m0"]?.circulating ?? {},
  ).reduce((sum, value) => sum + value, 0);
  const inventory = buildReviewedDeploymentRouteInventory("wm-m0");
  if (!inventory) throw new Error("Missing wM route inventory");
  const observations = makeWmDeploymentObservations({
    clockSec: fixedInput.clockSec,
    rawSupplyByRoute: Object.fromEntries(inventory.routes.map((route) => [
      route.routeId,
      route.chainId === "ethereum" ? "86712798085682" : route.chainId === "solana" ? "247794997129" : "1",
    ])),
    blockTimeByChain: Object.fromEntries(inventory.routes.map((route, index) => [
      route.chainId,
      fixedInput.clockSec - 10 + index,
    ])),
  });
  const attribution = deriveReviewedDeploymentUnitPartition({
    assetId: "wm-m0",
    aggregateSupplyUsd,
    registryFingerprint: fixedInput.registryFingerprint,
    scoringClockSec: fixedInput.clockSec,
    observations,
  });
  if (!attribution) throw new Error("Could not derive wM supply attribution");
  return normalizeFixedInput({
    ...fixedInput,
    safetyScoreV9SupplyAttributionById: { "wm-m0": attribution },
  });
}

/** `alpha` plus a `beta` clone, optionally mapping alpha's reserves onto beta. */
export function makeV9TwoAssetFixedInput(
  options: {
    mapAlphaCollateral?: boolean;
    omitAlphaReserve?: boolean;
    /** Assets that declare a live-reserve adapter but published no snapshot this run. */
    liveToFallbackCoins?: string[];
    clockSec?: number;
  } = {},
) {
  const alpha = makeV9FixedInput({ clockSec: options.clockSec });
  const alphaDex = alpha.dexLiqMap.alpha!;
  const alphaPeg = alpha.pegDataById.alpha!;
  const betaObservedAtSec = alpha.clockSec - 100;
  const liveReserveMap = structuredClone(alpha.liveReserveMap);
  if (options.omitAlphaReserve) delete liveReserveMap.alpha;
  return reseal(alpha, {
    activeAssetIds: ["alpha", "beta"],
    pegDataById: {
      ...alpha.pegDataById,
      beta: { ...alphaPeg, id: "beta", symbol: "BETA", name: "Beta" },
    },
    dexLiqMap: {
      ...alpha.dexLiqMap,
      beta: {
        ...alphaDex,
        exitRouteObservations: [v9ExitRouteObservation("dex:beta", betaObservedAtSec, "ethereum", alpha.clockSec)],
      },
    },
    resolvedBlacklistStatuses: { alpha: false, beta: false },
    ...(options.liveToFallbackCoins ? { liveToFallbackCoins: options.liveToFallbackCoins } : {}),
    liveReserveMap: {
      ...liveReserveMap,
      ...(options.mapAlphaCollateral
        ? {
            alpha: [
              {
                name: "Beta stablecoin",
                pct: 50,
                risk: "low" as const,
                coinId: "beta",
                depType: "collateral" as const,
                issuerOrObligor: "asset:beta",
                riskFactors: ["counterparty" as const],
                liquidityHorizon: "immediate" as const,
                maturityDaysMax: 0,
              },
              {
                name: "Custodied cash",
                pct: 50,
                risk: "very-low" as const,
                assetClass: "cash" as const,
                issuerOrObligor: "issuer:alpha",
                riskFactors: ["custody" as const, "counterparty" as const],
                liquidityHorizon: "immediate" as const,
                maturityDaysMax: 0,
              },
            ],
          }
        : {}),
      beta: [],
    },
    chainCirculatingById: {
      ...alpha.chainCirculatingById,
      beta: structuredClone(alpha.chainCirculatingById.alpha),
    },
  });
}

/** `alpha`/`beta`/`gamma`, with gamma's route capacity tunable. */
export function makeV9ThreeAssetFixedInput(gammaCompletionRatio = 0.8) {
  const two = makeV9TwoAssetFixedInput();
  const gammaRoute = v9ExitRouteObservation("dex:gamma");
  gammaRoute.executableUsd = gammaRoute.requestedNotionalUsd * gammaCompletionRatio;
  gammaRoute.completionRatio = gammaCompletionRatio;
  gammaRoute.capacityCurve = gammaRoute.capacityCurve!.map((point) => ({
    ...point,
    executableUsd: point.requestedNotionalUsd * gammaCompletionRatio,
    completionRatio: gammaCompletionRatio,
  }));
  return reseal(two, {
    activeAssetIds: ["alpha", "beta", "gamma"],
    pegDataById: {
      ...two.pegDataById,
      gamma: { ...two.pegDataById.alpha!, id: "gamma", symbol: "GAMMA", name: "Gamma" },
    },
    dexLiqMap: {
      ...two.dexLiqMap,
      gamma: {
        ...two.dexLiqMap.alpha!,
        exitRouteObservations: [gammaRoute],
      },
    },
    resolvedBlacklistStatuses: { alpha: false, beta: false, gamma: false },
    liveReserveMap: { ...two.liveReserveMap, gamma: [] },
    chainCirculatingById: {
      ...two.chainCirculatingById,
      gamma: structuredClone(two.chainCirculatingById.alpha),
    },
  });
}

/**
 * The registry-wide capture: every active stablecoin, no peg rows, and one
 * placeholder DEX row per coin. Used by the fixed-input identity suites, which
 * exercise fingerprinting over the full active set rather than one asset.
 */
const V9_REGISTRY_FIXTURE_CLOCK_SEC = 1_783_891_200;
const V9_REGISTRY_FIXTURE_DEX_UPDATED_AT_SEC = V9_REGISTRY_FIXTURE_CLOCK_SEC - 100;

export function makeV9RegistryFixedInput(
  options: {
    captureKind?: ReportCardsFixedInputDraft["captureKind"];
    sourceGeneration?: string;
    redemptionStale?: boolean;
    resolvedBlacklistStatuses?: Record<string, boolean>;
    dexLiqMap?: ReportCardsFixedInputDraft["dexLiqMap"];
  } = {},
) {
  const dexUpdatedAt =
    Object.values(options.dexLiqMap ?? {})[0]?.updatedAt ?? V9_REGISTRY_FIXTURE_DEX_UPDATED_AT_SEC;
  return createReportCardsFixedInput({
    captureKind: options.captureKind ?? "exact-publication-inputs",
    capturedAt: "2026-07-12T22:00:00.000Z",
    sourceGeneration:
      options.sourceGeneration ??
      `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${V9_REGISTRY_FIXTURE_CLOCK_SEC}`,
    dexGenerationId: `dex-liquidity-${dexUpdatedAt}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "fixture-revision",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: V9_REGISTRY_FIXTURE_CLOCK_SEC,
    updatedAt: V9_REGISTRY_FIXTURE_CLOCK_SEC,
    liquidityStale: false,
    redemptionStale: options.redemptionStale ?? true,
    inputFreshness: {
      dexLiquidity: { updatedAt: dexUpdatedAt, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap:
      options.dexLiqMap ??
      Object.fromEntries(
        ACTIVE_STABLECOINS.map((coin) => [
          coin.id,
          {
            liquidityScore: null,
            concentrationHhi: null,
            poolCount: 0,
            chainCount: 0,
            methodologyVersion: "fixture",
            updatedAt: dexUpdatedAt,
          },
        ]),
      ),
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses:
      options.resolvedBlacklistStatuses ??
      Object.fromEntries(ACTIVE_STABLECOINS.map((coin) => [coin.id, false])),
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

/** Re-derive the payload identities after mutating a single-asset capture. */
function resealSingleAsset(input: V9FixedInput, overrides: Partial<ReportCardsFixedInputDraft>) {
  const {
    schemaVersion: _schemaVersion,
    dexPayloadFingerprint: _dexPayloadFingerprint,
    redemptionPayloadFingerprint: _redemptionPayloadFingerprint,
    registryFingerprint: _registryFingerprint,
    inputMethodologyVersions: _inputMethodologyVersions,
    baseInputGenerationId: _baseInputGenerationId,
    ...draft
  } = input;
  return createReportCardsFixedInput({ ...draft, ...overrides });
}

/** `alpha` with a live queued issuer-redemption backstop attached. */
export function makeV9QueuedRedemptionFixedInput(
  settlementHorizonSec = 30 * 86_400,
  scoreEligible = false,
) {
  const base = makeV9FixedInput();
  const observation: ExitRouteObservation = {
    routeId: "redemption:alpha:queue",
    routeFamily: "issuer-redemption",
    scope: { kind: "issuer", issuerId: "alpha" },
    requestedNotionalUsd: 1_000_000,
    settlementHorizonSec,
    maxCostBps: 200,
    executableUsd: 1_000_000,
    completionRatio: 1,
    output: { kind: "fiat", currency: "USD" },
    evidenceKind: "live-reserve-state",
    confidence: "high",
    scoreEligible,
    observedAt: V9_FIXTURE_OBSERVED_AT_SEC,
    freshnessSeconds: V9_FIXTURE_CLOCK_SEC - V9_FIXTURE_OBSERVED_AT_SEC,
    commonModeKeys: ["issuer:alpha"],
    capacityCurve: [
      {
        requestedNotionalUsd: 100_000,
        maxCostBps: 200,
        executableUsd: 100_000,
        completionRatio: 1,
      },
      {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        executableUsd: 1_000_000,
        completionRatio: 1,
      },
    ],
  };
  const redemption: RedemptionBackstopEntry = {
    stablecoinId: "alpha",
    score: null,
    dexLiquidityScore: null,
    accessScore: 40,
    settlementScore: 20,
    executionCertaintyScore: 60,
    capacityScore: 40,
    outputAssetQualityScore: 100,
    costScore: 100,
    routeFamily: "offchain-issuer",
    accessModel: "issuer-api",
    settlementModel: "queued",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-single",
    provider: "reserve-sync-metadata",
    sourceMode: "dynamic",
    resolutionState: "resolved",
    routeStatus: "open",
    routeStatusSource: "protocol-api",
    holderEligibility: "verified-customer",
    capacityConfidence: "live-direct",
    capacitySemantics: "immediate-bounded",
    capacityProfile: {
      immediateUsd: 1_000_000,
      dailyLimitUsd: 1_000_000,
      queuedUsd: 1_500_000,
      scoringUsd: 1_000_000,
      scoringHorizon: "queued",
      capacityProfileConfidence: "live-direct",
      modeledExitSizeUsd: 1_000_000,
      exitRouteObservations: [observation],
    },
    feeConfidence: "fixed",
    feeModelKind: "fixed-bps",
    modelConfidence: "high",
    immediateCapacityUsd: 1_000_000,
    immediateCapacityRatio: 0.1,
    capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-api",
    sourceTimestamp: V9_FIXTURE_OBSERVED_AT_SEC,
    settlementDelaySec: 30 * 86_400,
    queueDepthUsd: 1_500_000,
    dailyLimitUsd: 1_000_000,
    minRedeemUsd: 1_000_000,
    feeBps: 0,
    queueEnabled: true,
    methodologyVersion: "4.18",
    updatedAt: V9_FIXTURE_OBSERVED_AT_SEC,
  };
  return resealSingleAsset(base, {
    redemptionGenerationId: "redemption:fixture",
    redemptionBackstopMap: { alpha: redemption },
    redemptionStale: false,
    inputFreshness: {
      ...base.inputFreshness,
      redemptionBackstops: {
        updatedAt: V9_FIXTURE_OBSERVED_AT_SEC,
        ageSeconds: V9_FIXTURE_CLOCK_SEC - V9_FIXTURE_OBSERVED_AT_SEC,
        stale: false,
      },
    },
  });
}

/** `usdc-circle` with a documented-terms redemption whose fee is undisclosed. */
export function makeV9BoundedUnknownFeeRedemptionFixedInput(
  options: { clockSec?: number } = {},
) {
  const assetId = "usdc-circle";
  const base = makeV9FixedInput({ assetId, clockSec: options.clockSec });
  const observedAtSec = base.clockSec - 100;
  const redemption = makeSupplyFullRedemption({
    holderEligibility: "any-holder",
    capacityProfile: {
      immediateUsd: null,
      eventualUsd: 10_000_000,
      scoringUsd: null,
      scoringHorizon: "eventual",
      capacityProfileConfidence: "documented-bound",
      modeledExitSizeUsd: 10_000_000,
    },
    feeConfidence: "undisclosed-reviewed",
    feeModelKind: "documented-variable",
    modelConfidence: "high",
    feeBps: null,
    updatedAt: observedAtSec,
    docs: {
      label: "Fixture redemption terms",
      url: "https://example.com/redemption",
      reviewedAt: "1970-01-01",
    },
  });
  return resealSingleAsset(base, {
    redemptionGenerationId: "redemption:bounded-unknown-fee",
    redemptionBackstopMap: { [assetId]: redemption },
    redemptionStale: false,
    inputFreshness: {
      ...base.inputFreshness,
      redemptionBackstops: {
        updatedAt: observedAtSec,
        ageSeconds: base.clockSec - observedAtSec,
        stale: false,
      },
    },
  });
}
