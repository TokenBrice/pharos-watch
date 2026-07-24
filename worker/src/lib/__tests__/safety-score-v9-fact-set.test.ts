import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v8/evaluation-build-manifest-v1";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import fraxMetaSource from "@shared/data/stablecoins/coins/frax-frax.json";
import flipcashMetaSource from "@shared/data/stablecoins/coins/usdf-flipcash.json";
import astherusMetaSource from "@shared/data/stablecoins/coins/usdf-astherus.json";
import megaMetaSource from "@shared/data/stablecoins/coins/usdm-mega.json";
import wrappedMSource from "@shared/data/stablecoins/coins/wm-m0.json";
import { compileV9FactSetV3 } from "@shared/lib/safety-score-v9/compile";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { buildV9DependencyEvaluationPlan } from "@shared/lib/safety-score-v9/dependencies";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import {
  evaluateV9Exit,
  projectV9ExitEvaluationRoute,
} from "@shared/lib/safety-score-v9/exit";
import {
  V9_CANDIDATE_POLICY_V1,
  resolveV9ReasonPolicy,
} from "@shared/lib/safety-score-v9/policy";
import { evaluateV9StressState } from "@shared/lib/safety-score-v9/stress";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { createReportCardsFixedInput, normalizeFixedInput } from "../report-cards-fixed-input";
import {
  compileSafetyScoreV9FactSetFromFixedInput,
  computeSafetyScoreV9ReserveExposureKey,
  type SafetyScoreV9FactSetExtensionV2,
} from "../safety-score-v9-fact-set";
import {
  buildReviewedReserveClassifications,
  buildSafetyScoreV9BaselineExtension,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9-extension";
import {
  buildSafetyScoreV9RetainedRedemptionRoutes,
  buildSafetyScoreV9RouteReviews,
} from "../safety-score-v9-extension-routes";
import { getSafetyScoreV9OperationalResilienceOverlay } from "../safety-score-v9-extension-operational-resilience";
import { selectSafetyScoreV9CdpShockMeasurement } from "../safety-score-v9-extension-shock";
import type { SafetyScoreV9ReviewedTransferFact } from "../safety-score-v9-extension-transfer";
import {
  buildReviewedDeploymentRouteInventory,
  deriveReviewedDeploymentUnitPartition,
  expectedWmDeploymentIdentity,
  type ReviewedDeploymentSupplyObservation,
} from "../safety-score-v9-supply-attribution-contract";

const AS_OF_SEC = 10_000;
const OBSERVED_AT_SEC = 9_900;

function status(observationState: "known" | "missing" = "known", policyRuleId = "fixture.review") {
  return {
    applicability: { state: "required" as const, policyRuleId, rationale: null, gapId: null },
    observationState,
    evidenceRefIds: observationState === "known" ? ["placeholder:evidence"] : [],
    gapIds: observationState === "known" ? [] : ["placeholder:gap"],
  };
}

function notApplicableStatus(policyRuleId: string) {
  return {
    applicability: {
      state: "not-applicable" as const,
      policyRuleId,
      rationale: "Reviewed as not applicable for the fixture.",
      gapId: null,
    },
    observationState: "known" as const,
    evidenceRefIds: ["placeholder:evidence"],
    gapIds: [],
  };
}

function route(
  routeId = "dex:primary",
  observedAt = OBSERVED_AT_SEC,
  chain = "ethereum",
  clockSec = AS_OF_SEC,
): ExitRouteObservation {
  return {
    routeId,
    routeFamily: "dex-amm",
    scope: { kind: "chain-contract", chain, contractOrPoolId: routeId, protocol: "fixture-dex" },
    requestedNotionalUsd: 100_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 80_000,
    completionRatio: 0.8,
    output: { kind: "fiat", currency: "USD", assetKeys: ["fiat:USD"] },
    evidenceKind: "reserve-based-amm-simulation",
    confidence: "high",
    scoreEligible: true,
    observedAt,
    freshnessSeconds: clockSec - observedAt,
    commonModeKeys: ["chain:ethereum", "protocol:fixture-dex"],
    capacityCurve: [
      {
        requestedNotionalUsd: 100_000,
        maxCostBps: 200,
        executableUsd: 80_000,
        completionRatio: 0.8,
      },
      {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        executableUsd: 400_000,
        completionRatio: 0.4,
      },
    ],
  };
}

function exactFixedInput(
  args: {
    assetId?: string;
    liquidityScore?: number;
    classifiedReserve?: boolean;
    omitPegRow?: boolean;
    pegScore?: number | null;
    currentDeviationBps?: number | null;
    activeDepeg?: boolean;
    activeDepegPeakBps?: number;
    routeChain?: string;
    omitLiveReserve?: boolean;
    chainSupplyByChain?: Record<
      string,
      {
        current: number;
        circulatingPrevDay: number;
        circulatingPrevWeek: number;
        circulatingPrevMonth: number;
      }
    >;
    aggregateCirculating?: Record<string, number>;
    supplyObservedAtSec?: number | null;
    clockSec?: number;
  } = {},
) {
  const assetId = args.assetId ?? "alpha";
  const clockSec = args.clockSec ?? AS_OF_SEC;
  const observedAtSec = clockSec - 100;
  const reserve = {
    name: "Custodied cash",
    pct: 100,
    risk: "very-low" as const,
    ...(args.classifiedReserve === false
      ? {}
      : {
          assetClass: "cash" as const,
          issuerOrObligor: `issuer:${assetId}`,
          riskFactors: ["custody" as const, "counterparty" as const],
          liquidityHorizon: "immediate" as const,
          maturityDaysMax: 0,
        }),
  };
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: [assetId],
    capturedAt: "2026-07-13T00:00:00.000Z",
    sourceGeneration: "report-cards:fixture:10000",
    dexGenerationId: `dex-liquidity-${observedAtSec}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "registry:fixture",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec,
    updatedAt: clockSec,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: observedAtSec, ageSeconds: clockSec - observedAtSec, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: args.omitPegRow
      ? {}
      : {
          [assetId]: {
            id: assetId,
            symbol: "ALPHA",
            name: "Alpha",
            pegType: "peggedUSD",
            pegCurrency: "USD",
            governance: "centralized",
            currentDeviationBps: args.currentDeviationBps === undefined ? 1 : args.currentDeviationBps,
            pegScore: args.pegScore === undefined ? 99 : args.pegScore,
            priceSource: "fixture-price",
            priceObservedAt: observedAtSec,
            pegPct: 99,
            severityScore: 0,
            spreadPenalty: 0,
            eventCount: 0,
            worstDeviationBps: 1,
            activeDepeg: args.activeDepeg ?? false,
            lastEventAt: null,
            trackingSpanDays: 365,
            methodologyVersion: "peg:fixture-v1",
          },
        },
    activeDepegPeakBpsById: args.activeDepegPeakBps === undefined ? {} : { [assetId]: args.activeDepegPeakBps },
    dexLiqMap: {
      [assetId]: {
        liquidityScore: args.liquidityScore ?? 12,
        concentrationHhi: 0.5,
        poolCount: 1,
        chainCount: 1,
        coverageClass: "primary",
        coverageConfidence: 1,
        liquidityEvidenceClass: "measured",
        hasMeasuredLiquidityEvidence: true,
        effectiveTvlUsd: 1_000_000,
        balanceMeasuredTvlUsd: 1_000_000,
        organicMeasuredTvlUsd: 1_000_000,
        exitRouteObservations: [route("dex:primary", observedAtSec, args.routeChain ?? "ethereum", clockSec)],
        exitRouteObservationCoverage: {
          status: "populated",
          capabilityMatrixVersion: "p4a.8",
          retainedPoolCount: 1,
          observationCount: 1,
          scoreEligibleObservationCount: 1,
          scoreEligiblePoolCount: 1,
          scoreEligibleCapabilityPoolCount: 1,
          unsupportedPoolCount: 0,
          evidenceCounts: { "reserve-based-amm-simulation": 1 },
          unsupportedReasons: {},
        },
        methodologyVersion: "dex:fixture-v1",
        updatedAt: observedAtSec,
      },
    },
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: { [assetId]: false },
    liveReserveMap: args.omitLiveReserve ? {} : { [assetId]: [reserve] },
    liveReserveProvenanceMap: args.omitLiveReserve
      ? {}
      : {
          [assetId]: { source: "fixture-reserve-api", fetchedAt: observedAtSec },
        },
    chainCirculatingById: {
      [assetId]: args.chainSupplyByChain ?? {
        ethereum: {
          current: 10_000_000,
          circulatingPrevDay: 10_000_000,
          circulatingPrevWeek: 10_000_000,
          circulatingPrevMonth: 10_000_000,
        },
      },
    },
    aggregateCirculatingById: args.aggregateCirculating
      ? {
          [assetId]: {
            circulating: args.aggregateCirculating,
            observedAtSec: args.supplyObservedAtSec === undefined ? observedAtSec : args.supplyObservedAtSec,
          },
        }
      : {},
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

function withWmReviewedDeploymentAttribution(
  fixedInput: ReturnType<typeof exactFixedInput>,
) {
  const aggregateSupplyUsd = Object.values(
    fixedInput.aggregateCirculatingById["wm-m0"]?.circulating ?? {},
  ).reduce((sum, value) => sum + value, 0);
  const inventory = buildReviewedDeploymentRouteInventory("wm-m0");
  if (!inventory) throw new Error("Missing wM route inventory");
  const observations: ReviewedDeploymentSupplyObservation[] = inventory.routes.map((route, index) => {
    const identity = expectedWmDeploymentIdentity(route.routeId);
    if (!identity) throw new Error(`Missing wM deployment identity ${route.routeId}`);
    const common = {
      routeId: route.routeId,
      chainId: route.chainId,
      contractAddress: route.contractAddress,
      decimals: route.decimals,
      rawSupply: route.chainId === "ethereum" ? "86712798085682" : route.chainId === "solana" ? "247794997129" : "1",
      blockNumberOrSlot: (25_000_000 + index).toString(),
      blockTimeSec: fixedInput.clockSec - 10 + index,
    };
    return identity.runtime === "evm"
      ? {
          ...common,
          blockHash: `0x${(index + 1).toString(16).repeat(64)}`,
          runtimeCodeSha256: identity.runtimeCodeSha256,
          implementationAddress: identity.implementationAddress,
          implementationCodeSha256: identity.implementationCodeSha256,
          underlyingTokenAddress: identity.underlyingTokenAddress,
          controllerAddress: identity.controllerAddress,
        }
      : {
          ...common,
          blockHash: "B".repeat(44),
          programOwner: identity.programOwner,
          mintAuthority: identity.mintAuthority,
          controllerAddress: identity.controllerAddress,
          controllerProgramOwner: identity.controllerProgramOwner,
        };
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

function exactTwoAssetFixedInput(options: { mapAlphaCollateral?: boolean; omitAlphaReserve?: boolean } = {}) {
  const alpha = exactFixedInput();
  const alphaDex = alpha.dexLiqMap.alpha!;
  const alphaPeg = alpha.pegDataById.alpha!;
  const {
    schemaVersion: omittedSchemaVersion,
    activeAssetIds: omittedActiveAssetIds,
    dexPayloadFingerprint: omittedDexPayloadFingerprint,
    redemptionPayloadFingerprint: omittedRedemptionPayloadFingerprint,
    registryFingerprint: omittedRegistryFingerprint,
    inputMethodologyVersions: omittedInputMethodologyVersions,
    baseInputGenerationId: omittedBaseInputGenerationId,
    ...draft
  } = alpha;
  void [
    omittedSchemaVersion,
    omittedActiveAssetIds,
    omittedDexPayloadFingerprint,
    omittedRedemptionPayloadFingerprint,
    omittedRegistryFingerprint,
    omittedInputMethodologyVersions,
    omittedBaseInputGenerationId,
  ];
  const liveReserveMap = structuredClone(alpha.liveReserveMap);
  if (options.omitAlphaReserve) delete liveReserveMap.alpha;
  return createReportCardsFixedInput({
    ...draft,
    activeAssetIds: ["alpha", "beta"],
    pegDataById: {
      ...alpha.pegDataById,
      beta: { ...alphaPeg, id: "beta", symbol: "BETA", name: "Beta" },
    },
    dexLiqMap: {
      ...alpha.dexLiqMap,
      beta: {
        ...alphaDex,
        exitRouteObservations: [route("dex:beta")],
      },
    },
    resolvedBlacklistStatuses: { alpha: false, beta: false },
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

function exactThreeAssetFixedInput(gammaCompletionRatio = 0.8) {
  const two = exactTwoAssetFixedInput();
  const {
    schemaVersion: omittedSchemaVersion,
    activeAssetIds: omittedActiveAssetIds,
    dexPayloadFingerprint: omittedDexPayloadFingerprint,
    redemptionPayloadFingerprint: omittedRedemptionPayloadFingerprint,
    registryFingerprint: omittedRegistryFingerprint,
    inputMethodologyVersions: omittedInputMethodologyVersions,
    baseInputGenerationId: omittedBaseInputGenerationId,
    ...draft
  } = two;
  void [
    omittedSchemaVersion,
    omittedActiveAssetIds,
    omittedDexPayloadFingerprint,
    omittedRedemptionPayloadFingerprint,
    omittedRegistryFingerprint,
    omittedInputMethodologyVersions,
    omittedBaseInputGenerationId,
  ];
  const gammaRoute = route("dex:gamma");
  gammaRoute.executableUsd = gammaRoute.requestedNotionalUsd * gammaCompletionRatio;
  gammaRoute.completionRatio = gammaCompletionRatio;
  gammaRoute.capacityCurve = gammaRoute.capacityCurve!.map((point) => ({
    ...point,
    executableUsd: point.requestedNotionalUsd * gammaCompletionRatio,
    completionRatio: gammaCompletionRatio,
  }));
  return createReportCardsFixedInput({
    ...draft,
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

function mechanismReview() {
  const component = {
    status: status(),
    quality: "strong" as const,
    failureDomains: [{ kind: "reserve-issuer" as const, key: "issuer:alpha" }],
  };
  return {
    archetype: "fiat-cash" as const,
    claimAndSegregation: component,
    custodyContinuity: component,
    assuranceAndReconciliation: component,
  };
}

function routeReview(routeId = "dex:primary", observedAt = OBSERVED_AT_SEC) {
  return {
    lane: "dex" as const,
    routeId,
    holderAccess: "permissionless" as const,
    executionModel: "market-depth" as const,
    executionCertainty: "bounded" as const,
    modelConfidence: "medium" as const,
    coverageClass: "exact-complete" as const,
    capacityScoringHorizon: "immediate" as const,
    settlementModel: "atomic" as const,
    settlementSlaSec: null,
    queueDepthUsd: null,
    dailyLimitUsd: null,
    minRedeemUsd: null,
    physicalResourceKeys: [`pool:${routeId}`],
    executionCosts: [
      { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executionCostBps: 180 },
      { requestedNotionalUsd: 100_000, maxCostBps: 200, executionCostBps: 120 },
    ],
    output: {
      kind: "fiat" as const,
      assetKeys: ["fiat:USD"],
      basketWeights: [],
      valuation: {
        basis: "reviewed-par" as const,
        referenceAssetKey: "fiat:USD",
        unitValueUsd: 1,
        expectedUnitValueUsd: 1,
        sourceId: "fixture-valuation",
        sourceGenerationId: "valuation:fixture-v1",
        observedAtSec: observedAt,
        maxAgeSec: 500,
        confidence: "high" as const,
        url: null,
        contentSha256: null,
      },
    },
    failureDomains: [
      { kind: "chain" as const, key: "ethereum" },
      { kind: "dex-protocol" as const, key: "fixture-dex" },
    ],
  };
}

function queuedRedemptionFixedInput(settlementHorizonSec = 30 * 86_400) {
  const base = exactFixedInput();
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
    scoreEligible: false,
    observedAt: OBSERVED_AT_SEC,
    freshnessSeconds: AS_OF_SEC - OBSERVED_AT_SEC,
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
    effectiveExitScore: null,
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
    sourceTimestamp: OBSERVED_AT_SEC,
    settlementDelaySec: 30 * 86_400,
    queueDepthUsd: 1_500_000,
    dailyLimitUsd: 1_000_000,
    minRedeemUsd: 1_000_000,
    feeBps: 0,
    queueEnabled: true,
    methodologyVersion: "4.18",
    updatedAt: OBSERVED_AT_SEC,
  };
  const {
    schemaVersion: _schemaVersion,
    dexPayloadFingerprint: _dexPayloadFingerprint,
    redemptionPayloadFingerprint: _redemptionPayloadFingerprint,
    registryFingerprint: _registryFingerprint,
    inputMethodologyVersions: _inputMethodologyVersions,
    baseInputGenerationId: _baseInputGenerationId,
    ...draft
  } = base;
  return createReportCardsFixedInput({
    ...draft,
    redemptionGenerationId: "redemption:fixture",
    redemptionBackstopMap: { alpha: redemption },
    redemptionStale: false,
    inputFreshness: {
      ...draft.inputFreshness,
      redemptionBackstops: {
        updatedAt: OBSERVED_AT_SEC,
        ageSeconds: AS_OF_SEC - OBSERVED_AT_SEC,
        stale: false,
      },
    },
  });
}

function boundedUnknownFeeRedemptionFixedInput() {
  const assetId = "usdc-circle";
  const base = exactFixedInput({ assetId });
  const redemption: RedemptionBackstopEntry = {
    stablecoinId: "usdc-circle",
    score: null,
    effectiveExitScore: null,
    dexLiquidityScore: null,
    accessScore: 40,
    settlementScore: 65,
    executionCertaintyScore: 60,
    capacityScore: null,
    outputAssetQualityScore: 100,
    costScore: 40,
    routeFamily: "offchain-issuer",
    accessModel: "issuer-api",
    settlementModel: "atomic",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-single",
    provider: "supply-full-model",
    sourceMode: "estimated",
    resolutionState: "resolved",
    routeStatus: "open",
    routeStatusSource: "static-config",
    holderEligibility: "any-holder",
    capacityConfidence: "documented-bound",
    capacitySemantics: "eventual-only",
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
    immediateCapacityUsd: null,
    immediateCapacityRatio: null,
    feeBps: null,
    queueEnabled: false,
    methodologyVersion: "4.18",
    updatedAt: OBSERVED_AT_SEC,
    docs: {
      label: "Fixture redemption terms",
      url: "https://example.com/redemption",
      reviewedAt: "1970-01-01",
    },
  };
  const {
    schemaVersion: _schemaVersion,
    dexPayloadFingerprint: _dexPayloadFingerprint,
    redemptionPayloadFingerprint: _redemptionPayloadFingerprint,
    registryFingerprint: _registryFingerprint,
    inputMethodologyVersions: _inputMethodologyVersions,
    baseInputGenerationId: _baseInputGenerationId,
    ...draft
  } = base;
  return createReportCardsFixedInput({
    ...draft,
    redemptionGenerationId: "redemption:bounded-unknown-fee",
    redemptionBackstopMap: { [assetId]: redemption },
    redemptionStale: false,
    inputFreshness: {
      ...draft.inputFreshness,
      redemptionBackstops: {
        updatedAt: OBSERVED_AT_SEC,
        ageSeconds: AS_OF_SEC - OBSERVED_AT_SEC,
        stale: false,
      },
    },
  });
}

function extension(): SafetyScoreV9FactSetExtensionV2 {
  return {
    schemaVersion: 2,
    registryFingerprint: exactFixedInput().registryFingerprint,
    compiledAtSec: AS_OF_SEC + 1,
    sources: {
      registryObservedAtSec: OBSERVED_AT_SEC,
      unavailableRedemptionObservedAtSec: OBSERVED_AT_SEC,
      liveReserves: { generationId: "reserves:fixture-v1", observedAtSec: OBSERVED_AT_SEC, maxAgeSec: 500 },
      chainSupply: { generationId: "supply:fixture-v1", observedAtSec: OBSERVED_AT_SEC, maxAgeSec: 500 },
      peg: { generationId: "peg:fixture-v1", observedAtSec: OBSERVED_AT_SEC, maxAgeSec: 500 },
      researchOverlays: { generationId: "research:fixture-v1", observedAtSec: OBSERVED_AT_SEC, maxAgeSec: 500 },
    },
    routeFreshness: { dexMaxAgeSec: 500, redemptionMaxAgeSec: 500, documentedTermsMaxAgeSec: 31_536_000 },
    assets: [
      {
        assetId: "alpha",
        archetype: "fiat-cash",
        launchedAtSec: 1_000,
        mechanismRiskReview: mechanismReview(),
        dependencies: {
          source: "none",
          baseSource: "none",
          dependencyFromLive: false,
          mappedLiveReserveWeight: null,
          fallbackReason: null,
          edges: [],
          diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
        },
        reserveApplicability: { state: "required" },
        reserveClassifications: [],
        routeReviews: [routeReview()],
        retainedRoutes: [],
        controlReview: {
          state: "no-privileged-controls",
          rationale: "The reviewed fixture implementation has no privileged deployment controls.",
        },
        economicControlReview: {
          mint: {
            status: notApplicableStatus("v9.control.mint-review"),
            controlKey: null,
            reconciliation: "not-applicable",
            supervision: "unknown",
            upgrade: { state: "not-applicable", controlKey: null },
          },
          oracle: {
            status: notApplicableStatus("v9.control.oracle-review"),
            tier: null,
            branches: [],
          },
          bridge: {
            status: notApplicableStatus("v9.control.bridge-review"),
            routes: [],
          },
        },
        accessReview: {
          transfer: { status: status("known", "v9.access.transfer-review"), posture: "permissionless" },
          freeze: {
            status: status("known", "v9.access.freeze-review"),
            reviews: [
              {
                reviewKey: "freeze:none-reviewed",
                source: "blacklist",
                status: status("known", "v9.access.freeze-review"),
                reach: "none",
                controlKey: null,
                upstreamAssetId: null,
                failureDomains: [],
              },
            ],
          },
        },
        pegReference: {
          referenceKind: "fiat",
          referenceKey: "USD",
          failureDomains: [{ kind: "oracle-feed", key: "fixture-price" }],
        },
        supplyReview: {
          selectedBridgeRoutes: [],
          selectedRouteSupplyShare: 0,
          // Single-chain native with no route rows conserves to unknown=1 (VER-007).
          unknownRouteSupplyShare: 1,
          unreviewedRouteSupplyShare: 0,
          failureDomains: [],
        },
        researchEvidence: [],
        componentEvidence: [],
      },
    ],
  };
}

type ExtensionDependencyEdge = NonNullable<
  SafetyScoreV9FactSetExtensionV2["assets"][number]["dependencies"]
>["edges"][number];

function roleExtension(
  fixed: ReturnType<typeof exactThreeAssetFixedInput>,
  edgesByAssetId: Readonly<Record<string, readonly ExtensionDependencyEdge[]>>,
): SafetyScoreV9FactSetExtensionV2 {
  const base = extension();
  return {
    ...base,
    registryFingerprint: fixed.registryFingerprint,
    assets: fixed.activeAssetIds.map((assetId) => {
      const asset = structuredClone(base.assets[0]!);
      const edges = [...(edgesByAssetId[assetId] ?? [])];
      const hasDependencyEvidence = edges.length > 0;
      return {
        ...asset,
        assetId,
        dependencies: {
          source: edges.length > 0 ? "manual" : "none",
          baseSource: edges.length > 0 ? "manual" : "none",
          dependencyFromLive: false,
          mappedLiveReserveWeight: null,
          fallbackReason: null,
          edges,
          diagnostics: {
            graphState: "valid",
            issueCodes: [],
            sccMemberAssetIds: [],
          },
        },
        routeReviews: [routeReview(assetId === "alpha" ? "dex:primary" : `dex:${assetId}`)],
        researchEvidence: hasDependencyEvidence
          ? [
              {
                evidenceKey: `dependencies:${assetId}`,
                sourceId: "fixture.role-dependencies",
                observedAtSec: OBSERVED_AT_SEC,
                publishedAtSec: null,
                url: `https://example.com/dependencies/${assetId}`,
                contentSha256: "d".repeat(64),
                confidence: "manual-review",
                maxAgeSec: 500,
              },
            ]
          : [],
        componentEvidence: hasDependencyEvidence
          ? [{ componentKey: "dependencies", evidenceKeys: [`dependencies:${assetId}`] }]
          : [],
      };
    }),
  };
}

function extensionRoleEdge(
  upstreamAssetId: string,
  economicRole: "exit-dependency" | "control-operator" | "oracle-nav",
  weight = 1,
): ExtensionDependencyEdge {
  const domain =
    economicRole === "exit-dependency"
      ? { kind: "redemption-rail" as const, key: `rail:${upstreamAssetId}` }
      : economicRole === "control-operator"
        ? { kind: "mint-control" as const, key: `operator:${upstreamAssetId}` }
        : { kind: "oracle-feed" as const, key: `oracle:${upstreamAssetId}` };
  return {
    upstreamAssetId,
    dependencyType: "mechanism",
    economicRole,
    weight,
    failureDomains: [domain],
  };
}

const V9_EVALUATION_TEST_TIMEOUT_MS = 30_000;

describe("Safety Score v9 exact base fact-set adapter", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("carries reviewed mechanism redemption into the exit evidence responsibility path", () => {
    const fixed = exactFixedInput();
    const profiled = extension();
    profiled.assets[0]!.mechanismExitFacts = [{
      factKey: "protocol-redemption",
      disposition: "supported",
      quality: "adequate",
    }];
    profiled.assets[0]!.routeReviews = [];
    profiled.assets[0]!.retainedRoutes = [];

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, profiled);
    const asset = compiled.assets[0]!;
    expect(asset.mechanismExitFacts).toEqual([
      expect.objectContaining({
        factKey: "protocol-redemption",
        disposition: "supported",
        quality: "adequate",
      }),
    ]);

    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(evaluated.scoreInput.pillars.exit.reasons).toContainEqual(
      expect.objectContaining({
        code: "missing-runtime-route-evidence",
        path: "exit:mechanism-profile:protocol-redemption",
        responsibility: "integration-missing",
      }),
    );
    expect(evaluated.scoreInput.pillars.exit.reasons).not.toContainEqual(
      expect.objectContaining({ code: "no-viable-exit-path" }),
    );
  });

  it("defaults retained v2 route reviews without modeled confidence to low", () => {
    const fixed = exactFixedInput();
    const retained = structuredClone(extension());
    delete (retained.assets[0]!.routeReviews[0] as unknown as Record<string, unknown>).modelConfidence;

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, retained);
    expect(compiled.assets[0]!.exitRoutes[0]).toMatchObject({ modelConfidence: "low" });
  });

  it("propagates post-role exit scores through three hops and never improves after adding an unmitigated role", () => {
    const evaluateChain = (gammaCompletionRatio: number) => {
      const fixed = exactThreeAssetFixedInput(gammaCompletionRatio);
      const profiled = roleExtension(fixed, {
        alpha: [extensionRoleEdge("beta", "exit-dependency")],
        beta: [extensionRoleEdge("gamma", "exit-dependency")],
      });
      const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, profiled);
      const alphaEdge = compiled.assets.find((asset) => asset.assetId === "alpha")!.dependencies.edges[0]!;
      expect(alphaEdge).toMatchObject({
        edgeKey: "exit-dependency:mechanism:beta",
        economicRole: "exit-dependency",
        pathKind: "local-component",
      });
      expect(alphaEdge.evidenceRefIds).not.toHaveLength(0);
      return evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1);
    };

    const stronger = evaluateChain(0.8);
    const weaker = evaluateChain(0.05);
    const exitScore = (set: ReturnType<typeof evaluateChain>, assetId: string) =>
      set.assets.find((asset) => asset.assetId === assetId)!.scoreInput.pillars.exit.score!;

    expect(exitScore(weaker, "gamma")).toBeLessThan(exitScore(stronger, "gamma"));
    expect(exitScore(weaker, "beta")).toBeLessThan(exitScore(stronger, "beta"));
    expect(exitScore(weaker, "alpha")).toBeLessThan(exitScore(stronger, "alpha"));

    const fixed = exactThreeAssetFixedInput(0.05);
    const withoutAddedRole = evaluateV9FactSet(
      compileSafetyScoreV9FactSetFromFixedInput(
        fixed,
        roleExtension(fixed, { alpha: [extensionRoleEdge("beta", "exit-dependency")] }),
      ),
      V9_CANDIDATE_POLICY_V1,
    );
    const withAddedRole = evaluateV9FactSet(
      compileSafetyScoreV9FactSetFromFixedInput(
        fixed,
        roleExtension(fixed, {
          alpha: [
            extensionRoleEdge("beta", "exit-dependency"),
            extensionRoleEdge("gamma", "exit-dependency"),
          ],
        }),
      ),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(exitScore(withAddedRole, "alpha")).toBeLessThanOrEqual(exitScore(withoutAddedRole, "alpha"));
  });

  it("propagates the effective oracle role subdimension through three hops", () => {
    const evaluateOracleChain = (tier: "redundant-with-failover" | "single-source-or-laggy") => {
      const fixed = exactThreeAssetFixedInput();
      const profiled = roleExtension(fixed, {
        alpha: [extensionRoleEdge("beta", "oracle-nav")],
        beta: [extensionRoleEdge("gamma", "oracle-nav")],
      });
      const gamma = profiled.assets.find((asset) => asset.assetId === "gamma")!;
      gamma.economicControlReview = {
        ...gamma.economicControlReview!,
        oracle: {
          status: status("known", "v9.control.oracle-review"),
          tier,
          branches: [],
        },
      };
      return evaluateV9FactSet(
        compileSafetyScoreV9FactSetFromFixedInput(fixed, profiled),
        V9_CANDIDATE_POLICY_V1,
      );
    };
    const stronger = evaluateOracleChain("redundant-with-failover");
    const weaker = evaluateOracleChain("single-source-or-laggy");
    const controlScore = (set: ReturnType<typeof evaluateOracleChain>, assetId: string) =>
      set.assets.find((asset) => asset.assetId === assetId)!.scoreInput.pillars.control.score!;

    expect(controlScore(weaker, "gamma")).toBeLessThan(controlScore(stronger, "gamma"));
    expect(controlScore(weaker, "beta")).toBeLessThan(controlScore(stronger, "beta"));
    expect(controlScore(weaker, "alpha")).toBeLessThan(controlScore(stronger, "alpha"));
  });

  it("contains a sub-material exit/control SCC to its role pillars without a serial-cycle NR reason", () => {
    const fixed = exactThreeAssetFixedInput();
    const evaluated = evaluateV9FactSet(
      compileSafetyScoreV9FactSetFromFixedInput(
        fixed,
        roleExtension(
          fixed,
          {
            alpha: [extensionRoleEdge("beta", "exit-dependency", 0.01)],
            beta: [extensionRoleEdge("alpha", "control-operator", 0.01)],
          },
        ),
      ),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(evaluated.dependencyPlan.cyclicComponents).toContainEqual(["alpha", "beta"]);
    expect(evaluated.dependencyPlan.serialCycleAssetIds).toEqual([]);
    for (const assetId of ["alpha", "beta"]) {
      const asset = evaluated.assets.find((candidate) => candidate.assetId === assetId)!;
      expect(
        asset.trace.finalGrade,
        JSON.stringify({
          nrReasons: asset.trace.nrReasons,
          dependencyReasons: asset.scoreInput.dependencyReasons,
          pillars: asset.scoreInput.pillars,
        }),
      ).not.toBe("NR");
      expect(asset.scoreInput.dependencyReasons.map((reason) => reason.code)).not.toContain(
        "implementation-parent-cycle",
      );
      expect(asset.scoreInput.dependencyReasons.map((reason) => reason.code)).not.toContain("parent-cycle");
      expect(asset.dependencyInputs.roleInputs).toEqual([
        expect.objectContaining({ cycleBlocked: true, boundedUnknown: true, score: null }),
      ]);
    }
    const alpha = evaluated.assets.find((asset) => asset.assetId === "alpha")!;
    const beta = evaluated.assets.find((asset) => asset.assetId === "beta")!;
    expect(alpha.scoreInput.pillars.exit.reasons.map((reason) => reason.code)).toContain(
      "nonmaterial-dependency-unavailable",
    );
    expect(alpha.scoreInput.pillars.control.reasons.map((reason) => reason.code)).not.toContain(
      "nonmaterial-dependency-unavailable",
    );
    expect(beta.scoreInput.pillars.control.reasons.map((reason) => reason.code)).toContain(
      "nonmaterial-dependency-unavailable",
    );
    expect(beta.scoreInput.pillars.exit.reasons.map((reason) => reason.code)).not.toContain(
      "nonmaterial-dependency-unavailable",
    );
  });

  it("loads every economic role from reviewed production metadata and preserves the Frax WTGXX non-link", () => {
    const productionMeta = [
      fraxMetaSource,
      flipcashMetaSource,
      astherusMetaSource,
      megaMetaSource,
      wrappedMSource,
    ] as unknown as V9ExtensionRegistryMeta[];
    const metaById = new Map(productionMeta.map((meta) => [meta.id, meta] as const));
    const expectedRoles = [
      ["wm-m0", "m-m0", "serial-claim"],
      ["usdf-flipcash", "usdc-circle", "basket-exposure"],
      ["usdf-astherus", "usdt-tether", "exit-dependency"],
      ["usdm-mega", "usdtb-ethena", "control-operator"],
      ["usdf-astherus", "usdt-tether", "oracle-nav"],
    ] as const;
    for (const [assetId, upstreamAssetId, role] of expectedRoles) {
      expect(metaById.get(assetId)?.dependencyReview?.relationships).toContainEqual(
        expect.objectContaining({ id: upstreamAssetId, economicRole: role }),
      );
    }

    const frax = metaById.get("frax-frax")!;
    const wtgxx = frax.reserves!.find((reserve) => reserve.name.startsWith("WTGXX"))!;
    expect(frax.reserveReview?.nonLinkDispositions).toContainEqual(
      expect.objectContaining({
        reserveIndex: frax.reserves!.indexOf(wtgxx),
        disposition: "untracked-exogenous-asset",
        candidateCoinIds: ["wtgxx-wisdomtree"],
      }),
    );
    const classifications = buildReviewedReserveClassifications(
      [{ ...wtgxx, coinId: "wtgxx-wisdomtree", depType: "collateral" }],
      frax,
      Date.parse("2026-07-23T00:00:00.000Z") / 1_000,
    );
    expect(classifications).toEqual([
      expect.objectContaining({ trackedAssetDisposition: "reviewed-non-link" }),
    ]);
  });

  it("builds a conservative baseline overlay without inventing missing reviews", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash",
            launchDate: "2020-01-01",
          },
        ],
      ]),
    });
    expect(baseline.assets[0]).toMatchObject({
      assetId: "alpha",
      archetype: "fiat-cash",
      // The reviewed cash reserve backs the claim/custody components at the
      // bounded quality; assurance stays missing without a proof-of-reserves
      // report, and the captured DEX observation yields a derived exit route.
      mechanismRiskReview: {
        archetype: "fiat-cash",
        claimAndSegregation: { status: { observationState: "bounded-unknown" } },
        custodyContinuity: { status: { observationState: "bounded-unknown" } },
        assuranceAndReconciliation: { status: { observationState: "missing" } },
      },
      controlReview: null,
      economicControlReview: null,
      accessReview: null,
      routeReviews: [{ lane: "dex", routeId: "dex:primary", coverageClass: "exact-complete" }],
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    expect(compiled.assets[0]!.gaps.map((gap) => gap.reasonCode)).toEqual(
      expect.arrayContaining(["missing-access-review"]),
    );
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace.finalGrade).not.toBe("NR");
  });

  it("compiles clock-valid operational-resilience claims with one evidence record per cited source", () => {
    const clockSec = Date.parse("2026-07-24T00:00:00Z") / 1_000;
    const fixed = exactFixedInput({ assetId: "usdt-tether", clockSec });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "usdt-tether",
          {
            id: "usdt-tether",
            mechanismArchetype: "fiat-cash",
            launchDate: "2014-10-06",
          },
        ],
      ]),
    });
    const overlay = getSafetyScoreV9OperationalResilienceOverlay("usdt-tether", clockSec);
    expect(baseline.assets[0]!.operationalResilience).toEqual(
      overlay,
    );
    expect(overlay).not.toBeNull();

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const asset = compiled.assets[0]!;
    const operationalEvidence = asset.evidence.filter((evidence) =>
      evidence.evidenceId.startsWith("usdt-tether:operational-resilience:"),
    );
    expect(operationalEvidence).toHaveLength(23);
    expect(new Set(operationalEvidence.map((evidence) => evidence.sourceId))).toEqual(
      new Set(overlay!.sources.map((source) => source.sourceId)),
    );
    expect(asset.operationalResilience).toMatchObject({
      schemaVersion: 1,
      redemptionThroughput: {
        cumulativeLifetimeRedeemedSupplyRatio: null,
        stressWindows: [
          {
            episodeKey: "terra-ust-market-stress-2022-05",
            redeemedSupplyRatioLowerBound: 0.12,
            settlement: { state: "settled-in-full", verification: "issuer-reported" },
            confidence: "issuer-reported",
          },
        ],
      },
      stressEpisodes: [
        {
          episodeKey: "terra-ust-market-stress-2022-05",
          recoveredWithinSec: null,
          confidence: "issuer-reported",
        },
      ],
      reserveReconciliation: {
        reportHistory: {
          firstReportPeriodEnd: "2021-03-31",
          latestReportPeriodEnd: "2026-03-31",
          observedReportHistoryMonths: 60,
          reportedCadence: "quarterly",
          continuityEvidence: "independently-verified",
          missedMaterialPeriods: 0,
          confidence: "independent-assurance",
        },
        latestAssurance: {
          level: "reasonable-assurance",
          confidence: "independent-assurance",
        },
      },
      incidentReview: { state: "not-reviewed" },
    });
    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(evaluated.operationalResilience).toMatchObject({
      eligible: true,
      rawPillarCredits: { backing: 2.55, exit: 1.5, control: 2.55 },
      pillarCredits: { backing: 2.55, exit: 1.5, control: 2.55 },
    });
    expect(
      evaluated.operationalResilience?.contributions.map(
        ({ component, pillar, confidence, confidenceMultiplier, points }) => ({
          component,
          pillar,
          confidence,
          confidenceMultiplier,
          points,
        }),
      ),
    ).toEqual([
      {
        component: "stress-redemption",
        pillar: "exit",
        confidence: "issuer-reported",
        confidenceMultiplier: 0.5,
        points: 1.5,
      },
      {
        component: "reserve-reconciliation",
        pillar: "backing",
        confidence: "independent-assurance",
        confidenceMultiplier: 0.85,
        points: 2.55,
      },
      {
        component: "reserve-reconciliation",
        pillar: "control",
        confidence: "independent-assurance",
        confidenceMultiplier: 0.85,
        points: 2.55,
      },
    ]);
    expect(evaluated.scoreInput.pillars.exit.score).toBe(
      Math.min(100, evaluated.exit.score! + 1.5),
    );
    expect(evaluated.scoreInput.pillars.backing.score).toBe(
      Math.min(100, evaluated.backing.score! + 2.55),
    );
    expect(evaluated.scoreInput.pillars.control.score).toBe(
      Math.min(100, evaluated.control.score! + 2.55),
    );
    expect(evaluated.trace.operationalResilience).toEqual(evaluated.operationalResilience);

    const retainedCore = structuredClone(compiled);
    const removedEvidenceId = operationalEvidence[0]!.evidenceId;
    retainedCore.assets[0]!.evidence = retainedCore.assets[0]!.evidence.filter(
      (evidence) => evidence.evidenceId !== removedEvidenceId,
    );
    const { v9FactSetDigest: _digest, ...core } = retainedCore;
    expect(() => compileV9FactSetV3(core)).toThrow(`Unknown evidence reference ${removedEvidenceId}`);
  });

  it("keeps pre-review operational-resilience captures explicit null", () => {
    const clockSec = Date.parse("2026-07-23T12:37:18Z") / 1_000;
    const fixed = exactFixedInput({ assetId: "usdt-tether", clockSec });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "usdt-tether",
          {
            id: "usdt-tether",
            mechanismArchetype: "fiat-cash",
            launchDate: "2014-10-06",
          },
        ],
      ]),
    });
    expect(baseline.assets[0]!.operationalResilience).toBeNull();
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    expect(compiled.assets[0]!.operationalResilience).toBeNull();
    expect(
      compiled.assets[0]!.evidence.some((evidence) =>
        evidence.evidenceId.startsWith("usdt-tether:operational-resilience:"),
      ),
    ).toBe(false);

    const futureOverlay = getSafetyScoreV9OperationalResilienceOverlay(
      "usdt-tether",
      Date.parse("2026-07-24T00:00:00Z") / 1_000,
    );
    expect(futureOverlay).not.toBeNull();
    const injected = structuredClone(baseline);
    injected.assets[0]!.operationalResilience = futureOverlay;
    expect(() => compileSafetyScoreV9FactSetFromFixedInput(fixed, injected)).toThrow(
      /outside its exact review window/,
    );
  });

  it("marks pure NAV tokens as reviewed not-applicable for fixed-peg scoring", () => {
    const fixed = exactFixedInput({ omitPegRow: true });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash",
            launchDate: "2020-01-01",
            flags: {
              backing: "rwa-backed",
              pegCurrency: "USD",
              governance: "centralized",
              yieldBearing: true,
              rwa: true,
              navToken: true,
            },
          },
        ],
      ]),
    });

    expect(baseline.assets[0]!.pegReference).toEqual({
      referenceKind: "nav",
      referenceKey: "nav:alpha",
      failureDomains: [],
    });
    expect(compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline).assets[0]!.peg).toMatchObject({
      status: { applicability: { state: "not-applicable" }, observationState: "known" },
      referenceKind: "nav",
      referenceKey: "nav:alpha",
      pegScore: null,
    });
  });

  it("keeps reviewed fallback collateral bounded until an exact reserve exposure maps it", () => {
    const fixed = exactTwoAssetFixedInput();
    const dependencyReview = {
      reviewedAt: "1970-01-01",
      reviewer: "Fixture reviewer",
      confidence: "manual-review" as const,
      sources: [{ label: "Fixture dependency analysis", url: "https://example.com/dependencies/alpha" }],
      rationale: "Beta is a reviewed collateral dependency.",
      relationships: [
        {
          id: "beta",
          weight: 0.5,
          type: "collateral" as const,
          reason: "Half of the reviewed backing is Beta.",
        },
      ],
    };
    const metaById = new Map<string, V9ExtensionRegistryMeta>([
      [
        "alpha",
        {
          id: "alpha",
          mechanismArchetype: "fiat-cash" as const,
          launchDate: "1970-01-01",
          dependencies: [{ id: "beta", weight: 0.5, type: "collateral" as const }],
          dependencyReview,
        },
      ],
      [
        "beta",
        {
          id: "beta",
          mechanismArchetype: "fiat-cash" as const,
          launchDate: "1970-01-01",
        },
      ],
    ]);

    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
    const alpha = baseline.assets.find((asset) => asset.assetId === "alpha")!;
    expect(alpha.dependencies).toMatchObject({
      source: "manual",
      diagnostics: {
        graphState: "unresolved",
        issueCodes: ["collateral-edge-exposure-unmapped:beta"],
      },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });
    expect(alpha.researchEvidence).toEqual([
      expect.objectContaining({
        sourceId: "stablecoin-meta.dependency-review",
        url: "https://example.com/dependencies/alpha",
        confidence: "manual-review",
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(alpha.componentEvidence).toEqual([expect.objectContaining({ componentKey: "dependencies" })]);

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const compiledAlpha = compiled.assets.find((asset) => asset.assetId === "alpha")!;
    expect(compiledAlpha.dependencies.status).toMatchObject({ observationState: "bounded-unknown" });
    expect(compiledAlpha.dependencies.diagnostics.issueCodes).toContain("collateral-edge-exposure-unmapped:beta");
    expect(compiledAlpha.dependencies.edges[0]!.evidenceRefIds).toEqual(
      compiledAlpha.dependencies.status.evidenceRefIds,
    );
    expect(compiledAlpha.dependencies.status.evidenceRefIds[0]).toContain("stablecoin-meta.dependency-review");
    expect(
      evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyReasons.map((reason) => reason.code),
    ).toContain("unreviewed-dependency-relationships");

    const weightDriftMeta = new Map(metaById);
    weightDriftMeta.set("alpha", {
      ...metaById.get("alpha")!,
      dependencyReview: {
        ...dependencyReview,
        relationships: [{ ...dependencyReview.relationships[0]!, weight: 0.4 }],
      },
    });
    const weightDrift = buildSafetyScoreV9BaselineExtension(fixed, { metaById: weightDriftMeta });
    expect(weightDrift.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      diagnostics: {
        graphState: "unresolved",
        issueCodes: ["collateral-edge-exposure-unmapped:beta"],
      },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });

    const structuralDriftMeta = new Map(metaById);
    structuralDriftMeta.set("alpha", {
      ...metaById.get("alpha")!,
      dependencyReview: {
        ...dependencyReview,
        relationships: [{ ...dependencyReview.relationships[0]!, id: "gamma" }],
      },
    });
    const structuralDrift = buildSafetyScoreV9BaselineExtension(fixed, { metaById: structuralDriftMeta });
    expect(structuralDrift.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      diagnostics: {
        graphState: "unresolved",
        issueCodes: expect.arrayContaining(["dependency-review-mismatch"]),
      },
      edges: [
        expect.objectContaining({
          upstreamAssetId: "beta",
          dependencyType: "collateral",
          economicRole: "basket-exposure",
          weight: 0.5,
        }),
      ],
    });

    const mappedFixed = exactTwoAssetFixedInput({ mapAlphaCollateral: true });
    const mapped = buildSafetyScoreV9BaselineExtension(mappedFixed, { metaById });
    expect(mapped.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      source: "live-reserve",
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });
    const compiledMapped = compileSafetyScoreV9FactSetFromFixedInput(mappedFixed, mapped);
    const compiledMappedAlpha = compiledMapped.assets.find((asset) => asset.assetId === "alpha")!;
    expect(compiledMappedAlpha.dependencies.status.observationState).toBe("known");
    expect(compiledMappedAlpha.reserveExposures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trackedAssetId: "beta",
          assetClass: "stablecoin",
          weight: 0.5,
          status: expect.objectContaining({ observationState: "known" }),
        }),
      ]),
    );
    expect(
      evaluateV9FactSet(compiledMapped, V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyReasons.map((reason) => reason.code),
    ).not.toContain("unreviewed-dependency-relationships");

    const reviewedLiveLinkMeta = new Map(metaById);
    reviewedLiveLinkMeta.set("alpha", {
      ...metaById.get("alpha")!,
      reserves: [
        {
          name: "Beta stablecoin",
          pct: 50,
          risk: "low",
          coinId: "beta",
          depType: "collateral",
          assetClass: "stablecoin",
          issuerOrObligor: "Beta issuer",
          riskFactors: ["counterparty"],
          liquidityHorizon: "immediate",
        },
        {
          name: "Custodied cash",
          pct: 50,
          risk: "very-low",
          assetClass: "cash",
          issuerOrObligor: "issuer:alpha",
          riskFactors: ["custody", "counterparty"],
          liquidityHorizon: "immediate",
          maturityDaysMax: 0,
        },
      ],
      reserveReview: {
        reviewedAt: "1970-01-01",
        reviewer: "Fixture reviewer",
        confidence: "verified",
        sources: [{ label: "Fixture reserve review", url: "https://example.com/reserves/alpha" }],
        rationale: "The live Beta reserve row is linked by a reviewed one-to-one identity.",
        compositionBasis: "Fixture composition",
        compositionAsOf: "1970-01-01",
        scope: "full-composition",
        knownUnknownExposure: "No unknown exposure.",
        knownUnknownExposurePct: 0,
      },
    });
    const reviewedLiveLinkOriginal = exactTwoAssetFixedInput({ mapAlphaCollateral: true });
    const reviewedLiveReserveMap = structuredClone(reviewedLiveLinkOriginal.liveReserveMap);
    delete reviewedLiveReserveMap.alpha![0]!.coinId;
    delete reviewedLiveReserveMap.alpha![0]!.depType;
    const {
      schemaVersion: omittedReviewedSchemaVersion,
      activeAssetIds: omittedReviewedActiveAssetIds,
      dexPayloadFingerprint: omittedReviewedDexPayloadFingerprint,
      redemptionPayloadFingerprint: omittedReviewedRedemptionPayloadFingerprint,
      registryFingerprint: omittedReviewedRegistryFingerprint,
      inputMethodologyVersions: omittedReviewedInputMethodologyVersions,
      baseInputGenerationId: omittedReviewedBaseInputGenerationId,
      ...reviewedLiveLinkDraft
    } = reviewedLiveLinkOriginal;
    void [
      omittedReviewedSchemaVersion,
      omittedReviewedActiveAssetIds,
      omittedReviewedDexPayloadFingerprint,
      omittedReviewedRedemptionPayloadFingerprint,
      omittedReviewedRegistryFingerprint,
      omittedReviewedInputMethodologyVersions,
      omittedReviewedBaseInputGenerationId,
    ];
    const reviewedLiveLinkFixed = createReportCardsFixedInput({
      ...reviewedLiveLinkDraft,
      activeAssetIds: ["alpha", "beta"],
      liveReserveMap: reviewedLiveReserveMap,
    });
    const reviewedLiveLink = buildSafetyScoreV9BaselineExtension(reviewedLiveLinkFixed, {
      metaById: reviewedLiveLinkMeta,
    });
    expect(reviewedLiveLink.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      source: "live-reserve",
      dependencyFromLive: true,
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });
    const compiledReviewedLiveLink = compileSafetyScoreV9FactSetFromFixedInput(
      reviewedLiveLinkFixed,
      reviewedLiveLink,
    );
    expect(
      compiledReviewedLiveLink.assets
        .find((asset) => asset.assetId === "alpha")!
        .reserveExposures.find((exposure) => exposure.trackedAssetId === "beta"),
    ).toMatchObject({
      weight: 0.5,
      assetClass: "stablecoin",
      status: { observationState: "known" },
    });

    const retainedNullClassification = structuredClone(mapped);
    retainedNullClassification.assets
      .find((asset) => asset.assetId === "alpha")!
      .reserveClassifications.find((classification) => classification.issuerOrObligorKey === "asset:beta")!.assetClass =
      null;
    expect(
      compileSafetyScoreV9FactSetFromFixedInput(mappedFixed, retainedNullClassification)
        .assets.find((asset) => asset.assetId === "alpha")!
        .reserveExposures.find((exposure) => exposure.trackedAssetId === "beta"),
    ).toMatchObject({ assetClass: "stablecoin", status: { observationState: "known" } });

    const mismatchedMapping = structuredClone(mapped);
    mismatchedMapping.assets.find((asset) => asset.assetId === "alpha")!.dependencies!.edges[0]!.weight = 0.4;
    const compiledMismatch = compileSafetyScoreV9FactSetFromFixedInput(mappedFixed, mismatchedMapping);
    expect(compiledMismatch.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      status: { observationState: "bounded-unknown" },
      diagnostics: {
        graphState: "unresolved",
        issueCodes: ["collateral-edge-exposure-weight-mismatch:beta"],
      },
    });
  });

  it("compiles duplicate reviewed relationships as distinct role-specific V3 paths", () => {
    const fixed = exactTwoAssetFixedInput({ omitAlphaReserve: true });
    const metaById = new Map<string, V9ExtensionRegistryMeta>([
      [
        "alpha",
        {
          id: "alpha",
          mechanismArchetype: "fiat-cash",
          launchDate: "1970-01-01",
          dependencies: [{ id: "beta", weight: 1, type: "mechanism" }],
          dependencyReview: {
            reviewedAt: "1970-01-01",
            reviewer: "Fixture reviewer",
            confidence: "verified",
            sources: [{ label: "Role review", url: "https://example.com/dependencies/alpha" }],
            rationale: "Beta supplies both the reviewed exit asset and reference unit.",
            relationships: [
              {
                id: "beta",
                weight: 1,
                type: "mechanism",
                economicRole: "exit-dependency",
                reason: "Beta is the redemption output.",
              },
              {
                id: "beta",
                weight: 1,
                type: "mechanism",
                economicRole: "oracle-nav",
                reason: "Beta is the reference unit.",
              },
            ],
          },
        },
      ],
      ["beta", { id: "beta", mechanismArchetype: "fiat-cash", launchDate: "1970-01-01" }],
    ]);
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
    expect(baseline.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [
        expect.objectContaining({ upstreamAssetId: "beta", economicRole: "exit-dependency" }),
        expect.objectContaining({ upstreamAssetId: "beta", economicRole: "oracle-nav" }),
      ],
    });

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const edges = compiled.assets.find((asset) => asset.assetId === "alpha")!.dependencies.edges;
    expect(edges).toEqual([
      expect.objectContaining({
        edgeKey: "exit-dependency:mechanism:beta",
        pathKind: "local-component",
        economicRole: "exit-dependency",
        evidenceRefIds: expect.any(Array),
      }),
      expect.objectContaining({
        edgeKey: "oracle-nav:mechanism:beta",
        pathKind: "local-component",
        economicRole: "oracle-nav",
        evidenceRefIds: expect.any(Array),
      }),
    ]);
    expect(edges.every((edge) => edge.evidenceRefIds.length > 0)).toBe(true);
  });

  it("derives native savings facts and shares documented-redemption admission with exit evaluation", () => {
    const original = exactTwoAssetFixedInput({ mapAlphaCollateral: true });
    const {
      schemaVersion: omittedSchemaVersion,
      activeAssetIds: omittedActiveAssetIds,
      dexPayloadFingerprint: omittedDexPayloadFingerprint,
      redemptionPayloadFingerprint: omittedRedemptionPayloadFingerprint,
      registryFingerprint: omittedRegistryFingerprint,
      inputMethodologyVersions: omittedInputMethodologyVersions,
      baseInputGenerationId: omittedBaseInputGenerationId,
      ...draft
    } = original;
    void [
      omittedSchemaVersion,
      omittedActiveAssetIds,
      omittedDexPayloadFingerprint,
      omittedRedemptionPayloadFingerprint,
      omittedRegistryFingerprint,
      omittedInputMethodologyVersions,
      omittedBaseInputGenerationId,
    ];
    const parentReserve = structuredClone(original.liveReserveMap.alpha![0]!);
    parentReserve.pct = 100;
    const documentedRedemptionInput = queuedRedemptionFixedInput();
    const documentedRedemption = structuredClone(documentedRedemptionInput.redemptionBackstopMap.alpha!);
    const documentedObservation = documentedRedemption.capacityProfile!.exitRouteObservations![0]!;
    documentedObservation.requestedNotionalUsd = 10_000_000;
    documentedObservation.executableUsd = 10_000_000;
    documentedObservation.completionRatio = 1;
    documentedObservation.capacityCurve = [
      ...documentedObservation.capacityCurve!,
      {
        requestedNotionalUsd: 10_000_000,
        maxCostBps: 200,
        executableUsd: 10_000_000,
        completionRatio: 1,
      },
    ];
    const fixed = createReportCardsFixedInput({
      ...draft,
      activeAssetIds: ["alpha", "beta"],
      liveReserveMap: { ...draft.liveReserveMap, alpha: [parentReserve] },
      redemptionGenerationId: documentedRedemptionInput.redemptionGenerationId,
      redemptionBackstopMap: { alpha: documentedRedemption },
      redemptionStale: false,
      inputFreshness: {
        ...draft.inputFreshness,
        redemptionBackstops: documentedRedemptionInput.inputFreshness.redemptionBackstops,
      },
    });
    const metaById = new Map<string, V9ExtensionRegistryMeta>([
      [
        "alpha",
        {
          id: "alpha",
          mechanismArchetype: "fiat-cash",
          launchDate: "1970-01-01",
          variantOf: "beta",
          variantKind: "savings-passthrough",
          flags: {
            backing: "crypto-backed",
            pegCurrency: "USD",
            governance: "decentralized",
            yieldBearing: true,
            rwa: false,
            navToken: true,
          },
        },
      ],
      ["beta", { id: "beta", mechanismArchetype: "fiat-cash", launchDate: "1970-01-01" }],
    ]);
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
    const alpha = baseline.assets.find((asset) => asset.assetId === "alpha")!;
    alpha.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");
    alpha.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, "alpha");
    alpha.economicControlReview = {
      mint: {
        status: notApplicableStatus("v9.control.mint-review"),
        controlKey: null,
        reconciliation: "not-applicable",
        supervision: "none",
        upgrade: { state: "not-applicable", controlKey: null },
      },
      oracle: {
        status: notApplicableStatus("v9.control.oracle-review"),
        tier: null,
        branches: [],
      },
      bridge: {
        status: notApplicableStatus("v9.control.bridge-review"),
        routes: [],
      },
    };

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const compiledAlpha = compiled.assets.find((asset) => asset.assetId === "alpha")!;
    const documentedRoute = compiledAlpha.exitRoutes.find((route) => route.lane === "redemption")!;
    expect(documentedRoute).toMatchObject({
      scoreEligible: false,
      status: { observationState: "known" },
    });
    const evaluatedExit = evaluateV9Exit(
      {
        circulatingUsd: compiledAlpha.supply.circulatingUsd,
        portfolioStatus: "reviewed-complete",
        routes: compiledAlpha.exitRoutes.map(projectV9ExitEvaluationRoute),
      },
      V9_CANDIDATE_POLICY_V1,
    );
    const evaluatedDocumentedRoute = evaluatedExit.routes.find(
      (route) => route.routeKey === documentedRoute.routeKey,
    );
    expect(evaluatedDocumentedRoute, JSON.stringify(evaluatedDocumentedRoute)).toMatchObject({
      included: true,
    });
    expect(compiledAlpha.economicControlReview.mint).toMatchObject({
      status: { observationState: "known" },
      reconciliation: "not-applicable",
    });
    expect(compiledAlpha.peg.status.observationState).toBe("known");
    expect(compiledAlpha.peg.referenceKind).toBe("nav");
    const wrapper = compiledAlpha.wrapperLocalFacts;
    expect(wrapper).toMatchObject({
      applicability: "wrapper",
      form: "native-staked",
      facts: {
        custodyEscrow: { disposition: "issuer-undisclosed", assessment: null },
        strategyComplexity: { disposition: "reviewed", assessment: "low" },
        leverage: { disposition: "issuer-undisclosed", assessment: null },
        rehypothecationCorrelation: { disposition: "issuer-undisclosed", assessment: null },
        shareAccountingNavOracle: { disposition: "reviewed", assessment: "moderate" },
        measuredUnwind: {
          disposition: "reviewed",
          assessment: "none",
          signals: expect.arrayContaining(["wrapper-measured-unwind-route-count:2"]),
        },
      },
    });
    if (wrapper.applicability !== "wrapper") throw new Error("Expected wrapper-local facts");
    for (const factKey of [
      "strategyComplexity",
      "shareAccountingNavOracle",
    ] as const) {
      expect(wrapper.facts[factKey].evidenceRefIds.length).toBeGreaterThan(0);
    }
  });

  it("reconciles curated collateral only when no live reserve snapshot exists", () => {
    const metaById = new Map<string, V9ExtensionRegistryMeta>([
      [
        "alpha",
        {
          id: "alpha",
          mechanismArchetype: "fiat-cash",
          launchDate: "1970-01-01",
          reserves: [{ name: "Beta stablecoin", pct: 50, risk: "low", coinId: "beta", depType: "collateral" }],
        },
      ],
      ["beta", { id: "beta", mechanismArchetype: "fiat-cash", launchDate: "1970-01-01" }],
    ]);
    const noLiveSnapshot = exactTwoAssetFixedInput({ omitAlphaReserve: true });

    const curated = buildSafetyScoreV9BaselineExtension(noLiveSnapshot, { metaById });
    expect(curated.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      source: "curated-reserve",
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });

    const liveSnapshot = exactTwoAssetFixedInput();
    const liveMismatch = buildSafetyScoreV9BaselineExtension(liveSnapshot, { metaById });
    expect(liveMismatch.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      source: "curated-reserve",
      diagnostics: {
        graphState: "unresolved",
        issueCodes: ["collateral-edge-exposure-unmapped:beta"],
      },
    });
  });

  it("compiles eligible issuer-attested reserves and gives live rows precedence", () => {
    const meta: V9ExtensionRegistryMeta = {
      id: "alpha",
      mechanismArchetype: "fiat-cash",
      launchDate: "1970-01-01",
      reserves: [
        {
          name: "Treasury bills",
          pct: 70.01,
          risk: "very-low",
          assetClass: "treasury-bill",
          issuerOrObligor: "United States Treasury",
          riskFactors: ["duration", "liquidity", "custody"],
          liquidityHorizon: "one-day",
          maturityDaysMax: 30,
        },
        {
          name: "Cash",
          pct: 30,
          risk: "very-low",
          assetClass: "bank-deposit",
          issuerOrObligor: "Commercial banks",
          riskFactors: ["counterparty", "custody"],
          liquidityHorizon: "immediate",
        },
      ],
      reserveReview: {
        reviewedAt: "1970-01-01",
        reviewer: "Fixture reviewer",
        confidence: "verified",
        sources: [{ label: "Composition", url: "https://example.com/composition" }],
        rationale: "Complete composition from the signed report.",
        compositionBasis: "Signed report",
        compositionAsOf: "1970-01-01",
        scope: "full-composition",
        knownUnknownExposure: "None",
        knownUnknownExposurePct: 0,
      },
      proofOfReserves: {
        type: "independent-audit",
        url: "https://example.com/transparency",
        provider: "Independent LLP",
        attestorTier: "regional",
        cadence: "monthly",
        latestReport: {
          periodEnd: "1970-01-01",
          publishedAt: "1970-01-01",
          assuranceMethod: "examination",
          scope: "assets-and-liabilities",
          liabilityReconciliation: "full",
          reviewer: "Fixture reviewer",
          confidence: "verified",
          sources: [{ label: "Signed report", url: "https://example.com/report.pdf" }],
        },
      },
      mintAuthority: {
        mintPath: "issuer-direct-mint",
        authorityPosture: "concentrated-admin",
        confidence: "verified",
        summary: "Prudential issuer fixture.",
        supervision: "prudential",
        review: {
          sources: [{ label: "Supervisor", url: "https://example.com/supervisor" }],
          evidence: "The issuer is prudentially supervised.",
          reviewer: "Fixture reviewer",
          reviewedAt: "1970-01-01",
        },
      },
    };
    const metaById = new Map([["alpha", meta]]);
    const noLive = exactFixedInput({ omitLiveReserve: true });
    const issuerAttested = buildSafetyScoreV9BaselineExtension(noLive, { metaById });
    expect(issuerAttested.assets[0]!.reviewedStaticReserveRows).toMatchObject({
      evidenceClass: "issuer-attested",
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(noLive, issuerAttested).assets[0]!;
    expect(compiled.reserveExposures).toHaveLength(2);
    expect(compiled.reserveExposures.every((exposure) => exposure.evidenceClass === "issuer-attested")).toBe(true);
    expect(compiled.reserveExposures.reduce((sum, exposure) => sum + exposure.weight, 0)).toBeCloseTo(1, 12);

    const reportSources = meta.proofOfReserves!.latestReport!.sources;
    const independentlyExaminedMeta: V9ExtensionRegistryMeta = {
      ...meta,
      reserveReview: {
        ...meta.reserveReview!,
        sources: reportSources,
      },
    };
    const independentExtension = buildSafetyScoreV9BaselineExtension(noLive, {
      metaById: new Map([["alpha", independentlyExaminedMeta]]),
    });
    expect(independentExtension.assets[0]!.reviewedStaticReserveRows).toMatchObject({
      evidenceClass: "independent",
    });
    const independentlyCompiled = compileSafetyScoreV9FactSetFromFixedInput(
      noLive,
      independentExtension,
    ).assets[0]!;
    expect(
      independentlyCompiled.reserveExposures.every((exposure) => exposure.evidenceClass === "independent"),
    ).toBe(true);

    const withLive = exactFixedInput();
    const liveFirst = buildSafetyScoreV9BaselineExtension(withLive, { metaById });
    expect(liveFirst.assets[0]!.reviewedStaticReserveRows).toBeNull();
    const liveExposures = compileSafetyScoreV9FactSetFromFixedInput(withLive, liveFirst).assets[0]!.reserveExposures;
    expect(liveExposures).toEqual([expect.objectContaining({ provenance: "live", weight: 1 })]);
    expect(liveExposures[0]).not.toHaveProperty("evidenceClass");
  });

  it("compiles exact base facts and explicit reviews without consulting v8 score outputs", () => {
    const fixed = exactFixedInput();
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension());
    const alpha = compiled.assets[0]!;

    expect(compiled.baseInputGenerationId).toBe(fixed.baseInputGenerationId);
    expect(compiled.asOfSec).toBe(AS_OF_SEC);
    expect(compiled.sourceFingerprints.dex).toMatchObject({
      generationId: fixed.dexGenerationId,
      payloadSha256: fixed.dexPayloadFingerprint,
      observedAtSec: OBSERVED_AT_SEC,
    });
    expect(compiled.activeAssetIds).toEqual(["alpha"]);
    expect(
      compiled.assets.every((asset) => Object.prototype.hasOwnProperty.call(asset.supply, "chainDistribution")),
    ).toBe(true);
    expect(alpha.mechanismRiskReview.review?.archetype).toBe("fiat-cash");
    expect(alpha.economicControlReview.mint.status.applicability.state).toBe("not-applicable");
    expect(alpha.accessReview.transfer.posture).toBe("permissionless");
    expect(alpha.reserveStatus.observationState).toBe("known");
    expect(alpha.supply).toMatchObject({
      sourceKind: "usd-denominated-circulating",
      referencePriceUsd: null,
      circulatingUsd: 10_000_000,
      chainDistribution: {
        chains: [{ chainId: "ethereum", supplyUsd: 10_000_000, supplyShare: 1 }],
        unattributedSupplyUsd: 0,
        unattributedSupplyShare: 0,
      },
    });
    expect(alpha.exitRoutes[0]).toMatchObject({
      routeId: "dex:primary",
      modelConfidence: "medium",
      status: { observationState: "known" },
      scoreEligible: true,
    });
    expect(alpha.gaps).toEqual([]);

    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1);
    expect(evaluated.assets).toHaveLength(1);
    expect(evaluated.assets[0]!.trace).toMatchObject({ finalGrade: "B+", finalScore: 77 });
    expect(evaluated.assets[0]!.access).toMatchObject({
      transfer: "permissionless",
      freezeExposure: "none-known",
      primaryExit: "permissionless",
    });
    expect(evaluateV9StressState(evaluated.assets[0]!.stressState, V9_CANDIDATE_POLICY_V1)).toEqual(
      evaluated.assets[0]!.trace,
    );

    const low = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput({ liquidityScore: 1 }), extension());
    const high = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput({ liquidityScore: 99 }), extension());
    expect(low.assets).toEqual(high.assets);
    expect(low.baseInputGenerationId).not.toBe(high.baseInputGenerationId);
  });

  it("preserves live queued terms through the production review and fact boundary", () => {
    const fixed = queuedRedemptionFixedInput();
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
    const redemption = compiled.assets[0]!.exitRoutes.find((route) => route.lane === "redemption")!;
    expect(redemption).toMatchObject({
      capacityScoringHorizon: "queued",
      settlementModel: "queued",
      settlementSlaSec: 30 * 86_400,
      queueDepthUsd: 1_500_000,
      dailyLimitUsd: 1_000_000,
      minRedeemUsd: 1_000_000,
      request: { settlementHorizonSec: 30 * 86_400 },
    });

    const exit = evaluateV9Exit(
      {
        circulatingUsd: 10_000_000,
        portfolioStatus: "reviewed-complete",
        routes: [projectV9ExitEvaluationRoute(redemption)],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(exit.score).toBeGreaterThan(0);
    expect(exit.horizons.immediate).toEqual({ primaryRouteKey: null, score: null });
    expect(exit.horizons.queued.primaryRouteKey).toBe(redemption.routeKey);
    expect(exit.routes[0]).toMatchObject({
      horizon: "queued",
      settlementDelaySec: 30 * 86_400,
      capsApplied: expect.arrayContaining(["queue-backlog:0.65", "minimum-redeem:0.75"]),
    });
  });

  it("never shortens a captured route below the conservative reviewed settlement horizon", () => {
    const fixed = queuedRedemptionFixedInput(86_400);
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");

    const redemption = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!.exitRoutes.find(
      (route) => route.lane === "redemption",
    )!;
    expect(redemption.request?.settlementHorizonSec).toBe(30 * 86_400);
  });

  it("preserves reviewed capacity and applies the bounded-unknown fee ceiling end to end", () => {
    const fixed = boundedUnknownFeeRedemptionFixedInput();
    const reviewed = structuredClone(extension());
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.assetId = "usdc-circle";
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "usdc-circle");
    reviewed.assets[0]!.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, "usdc-circle");

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
    const redemption = compiled.assets[0]!.exitRoutes.find((route) => route.lane === "redemption")!;
    expect(redemption).toMatchObject({
      feeEvidence: "undisclosed-reviewed",
      scoreEligible: false,
      status: { observationState: "known" },
    });
    expect(redemption.capacityCurve.every((point) => point.executableUsd > 0)).toBe(true);

    const exit = evaluateV9Exit(
      {
        circulatingUsd: 10_000_000,
        portfolioStatus: "reviewed-complete",
        routes: [projectV9ExitEvaluationRoute(redemption)],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    const ceiling = V9_CANDIDATE_POLICY_V1.policy.semantic.exit.undisclosedFeeRouteScoreCeiling;
    expect(exit.score).toBeGreaterThan(0);
    expect(exit.score).toBeLessThanOrEqual(ceiling);
    expect(exit.routes[0]).toMatchObject({
      included: true,
      capsApplied: expect.arrayContaining(["fee-evidence:undisclosed-reviewed"]),
    });
  });

  it("carries measured route history into v9 facts and evaluation traces", () => {
    const fixed = structuredClone(exactFixedInput());
    const observation = fixed.dexLiqMap.alpha!.exitRouteObservations![0]!;
    observation.evidenceKind = "measured-executable-depth";
    observation.observationHistory = {
      completeProducerCycleCount: 3,
      successfulObservationCount: 2,
      consecutiveSuccessCount: 0,
      observationWindowStartedAt: observation.observedAt - 200,
      observationWindowEndedAt: observation.observedAt,
      latestOperationalFailureAt: observation.observedAt,
      conservativeStatistic: "pointwise-minimum",
      conservativeCapacityCurve: observation.capacityCurve!,
    };
    fixed.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixed);
    const reviewed = structuredClone(extension());
    reviewed.assets[0]!.routeReviews[0]!.modelConfidence = "high";

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
    expect(compiled.assets[0]!.exitRoutes[0]).toMatchObject({
      routeFamily: "dex-amm",
      modelConfidence: "high",
      observationHistory: {
        completeProducerCycleCount: 3,
        successfulObservationCount: 2,
        latestOperationalFailureAt: observation.observedAt,
        conservativeStatistic: "pointwise-minimum",
      },
    });

    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(evaluated.exit.routes[0]).toMatchObject({
      routeFamily: "dex-amm",
      observationConfidence: "high",
      modelConfidence: "high",
      observationHistory: {
        successfulObservationCount: 2,
        latestOperationalFailureAt: observation.observedAt,
      },
    });
    expect(evaluated.scoreInput.pillars.exit.evidenceLevel).toBe("strong");

    const immatureFixed = structuredClone(exactFixedInput());
    immatureFixed.dexLiqMap.alpha!.exitRouteObservations![0]!.evidenceKind = "measured-executable-depth";
    immatureFixed.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(immatureFixed);
    const immature = evaluateV9FactSet(
      compileSafetyScoreV9FactSetFromFixedInput(immatureFixed, extension()),
      V9_CANDIDATE_POLICY_V1,
    ).assets[0]!;
    expect(immature.scoreInput.pillars.exit.evidenceLevel).not.toBe("strong");
  });

  it("aggregates chain aliases and conserves unresolved source supply without price multiplication", () => {
    const original = exactFixedInput();
    const template = original.chainCirculatingById.alpha!.ethereum!;
    const fixed = exactFixedInput({
      chainSupplyByChain: {
        Ethereum: { ...template, current: 6_000_000 },
        ethereum: { ...template, current: 4_000_000 },
        "Hyperliquid L1": { ...template, current: 3_000_000 },
        "hyperliquid-l1": { ...template, current: 2_000_000 },
        "Future Network": { ...template, current: 1_000_000 },
        "Zero Network": { ...template, current: 0 },
      },
    });

    const supply = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension()).assets[0]!.supply;
    expect(supply.referencePriceUsd).toBeNull();
    expect(supply.circulatingUsd).toBe(16_000_000);
    expect(supply.chainDistribution).toEqual({
      chains: [
        { chainId: "ethereum", supplyUsd: 10_000_000, supplyShare: 10 / 16 },
        { chainId: "hyperliquid", supplyUsd: 5_000_000, supplyShare: 5 / 16 },
      ],
      unattributedSupplyUsd: 1_000_000,
      unattributedSupplyShare: 1 / 16,
    });
    expect(supply.failureDomains).toEqual(
      expect.arrayContaining([
        { kind: "chain", key: "future network" },
        { kind: "chain", key: "hyperliquid" },
        { kind: "chain", key: "zero network" },
      ]),
    );
  });

  it("falls back to the aggregate circulating bucket when no per-chain rows exist", () => {
    const fixed = exactFixedInput({
      chainSupplyByChain: {},
      aggregateCirculating: { peggedUSD: 4_000_000, peggedEUR: 1_000_000 },
    });

    const supply = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension()).assets[0]!.supply;
    expect(supply.status.observationState).toBe("known");
    expect(supply.sourceKind).toBe("aggregate-circulating");
    // Summed, never multiplied by price: list circulating is already USD.
    expect(supply.circulatingUsd).toBe(5_000_000);
    expect(supply.referencePriceUsd).toBeNull();
    expect(supply.circulatingUnits).toBeNull();
    // Per-chain attribution genuinely does not exist, so it is not synthesized.
    expect(supply.chainDistribution).toBeNull();
    expect(supply.failureDomains).toEqual([]);
    expect(supply.selectedBridgeRoutes).toEqual([]);
    expect(supply.selectedRouteSupplyShare).toBeNull();
    expect(supply.unknownRouteSupplyShare).toBeNull();
    expect(supply.unreviewedRouteSupplyShare).toBeNull();
  });

  it("compiles exact wM route shares without bridge-materiality uncertainty", () => {
    const clockSec = Date.parse("2026-07-24T09:00:00Z") / 1_000;
    const fixed = withWmReviewedDeploymentAttribution(
      exactFixedInput({
        assetId: "wm-m0",
        clockSec,
        chainSupplyByChain: {},
        aggregateCirculating: { peggedUSD: 87_020_618.58982982 },
        omitLiveReserve: true,
      }),
    );
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        ["wm-m0", wrappedMSource as unknown as V9ExtensionRegistryMeta],
      ]),
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const wm = compiled.assets[0]!;

    expect(wm.supply.status.observationState).toBe("known");
    expect(wm.supply.selectedBridgeRoutes).toHaveLength(5);
    expect(wm.supply.selectedRouteSupplyShare).toBe(1);
    expect(wm.supply.unknownRouteSupplyShare).toBe(0);
    expect(wm.supply.unreviewedRouteSupplyShare).toBe(0);
    expect(wm.gaps.map((gap) => gap.reasonCode)).not.toContain(
      "runtime-bridge-materiality-unavailable",
    );
    expect(
      wm.evidence.find((evidence) => evidence.evidenceId === "wm-m0:chain-supply"),
    ).toMatchObject({ sourceId: "safety-score-v9-reviewed-deployment-attribution" });

    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(evaluated.scoreInput.pillars.control.reasons.map((reason) => reason.code)).not.toContain(
      "runtime-bridge-materiality-unavailable",
    );
  });

  it("restores the bridge-materiality cap when the wM packet is absent", () => {
    const fixed = exactFixedInput({
      assetId: "wm-m0",
      clockSec: Date.parse("2026-07-24T09:00:00Z") / 1_000,
      chainSupplyByChain: {},
      aggregateCirculating: { peggedUSD: 87_020_618.58982982 },
      omitLiveReserve: true,
    });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        ["wm-m0", wrappedMSource as unknown as V9ExtensionRegistryMeta],
      ]),
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const wm = compiled.assets[0]!;

    expect(wm.supply.chainDistribution).toBeNull();
    expect(wm.gaps.map((gap) => gap.reasonCode)).toContain(
      "missing-bridge-routes",
    );
    const evaluated = evaluateV9FactSet(
      compiled,
      V9_CANDIDATE_POLICY_V1,
    ).assets[0]!;
    expect(
      evaluated.scoreInput.pillars.control.reasons.map((reason) => reason.code),
    ).toContain("runtime-bridge-materiality-unavailable");
  });

  it("keeps supply missing when neither per-chain rows nor a positive aggregate bucket exist", () => {
    const absent = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput({ chainSupplyByChain: {} }), extension())
      .assets[0]!.supply;
    expect(absent.status.observationState).not.toBe("known");
    expect(absent.circulatingUsd).toBeNull();
    expect(absent.sourceKind).toBe("usd-denominated-circulating");
    expect(absent.chainDistribution).toBeNull();

    const zero = compileSafetyScoreV9FactSetFromFixedInput(
      exactFixedInput({ chainSupplyByChain: {}, aggregateCirculating: { peggedUSD: 0 } }),
      extension(),
    ).assets[0]!.supply;
    expect(zero.status.observationState).not.toBe("known");
    expect(zero.circulatingUsd).toBeNull();
    expect(zero.sourceKind).toBe("usd-denominated-circulating");
  });

  it("ages aggregate supply against the supplemental carry-forward ceiling, not the chain-supply cron window", () => {
    const supplyObservedAtSec = AS_OF_SEC - 4_000;
    const fixed = exactFixedInput({
      chainSupplyByChain: {},
      aggregateCirculating: { peggedUSD: 4_000_000 },
      supplyObservedAtSec,
    });

    const alpha = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension()).assets[0]!;
    const evidence = alpha.evidence.find((entry) => entry.evidenceId === "alpha:aggregate-supply")!;
    // Carried-forward supply legitimately predates the chain-supply lane's own
    // window (500s in this fixture); it is bounded by the 7-day intake ceiling.
    expect(evidence.freshness.maxAgeSec).toBe(7 * 86400);
    expect(evidence.observedAtSec).toBe(supplyObservedAtSec);
    expect(evidence.freshness.ageSec).toBe(4_000);
    expect(evidence.freshness.state).toBe("current");
    expect(alpha.supply.status.observationState).toBe("known");
  });

  it("leaves chain-attributed supply untouched when per-chain rows are present", () => {
    const withoutAggregate = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), extension()).assets[0]!
      .supply;
    // An aggregate bucket that disagrees must not displace real chain attribution.
    const withAggregate = compileSafetyScoreV9FactSetFromFixedInput(
      exactFixedInput({ aggregateCirculating: { peggedUSD: 999_000_000 } }),
      extension(),
    ).assets[0]!.supply;

    expect(withoutAggregate.sourceKind).toBe("usd-denominated-circulating");
    expect(withoutAggregate.circulatingUsd).toBe(10_000_000);
    expect(withoutAggregate.chainDistribution).toEqual({
      chains: [{ chainId: "ethereum", supplyUsd: 10_000_000, supplyShare: 1 }],
      unattributedSupplyUsd: 0,
      unattributedSupplyShare: 0,
    });
    expect(withAggregate).toEqual(withoutAggregate);
  });

  it("joins route display names and supply IDs into one canonical chain common mode", () => {
    const original = exactFixedInput();
    const template = original.chainCirculatingById.alpha!.ethereum!;
    const fixed = exactFixedInput({
      routeChain: "Monad",
      chainSupplyByChain: { monad: { ...template, current: 10_000_000 } },
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension());
    const alpha = compiled.assets[0]!;

    expect(alpha.exitRoutes[0]!.failureDomains).toContainEqual({ kind: "chain", key: "monad" });
    expect(alpha.supply.failureDomains).toContainEqual({ kind: "chain", key: "monad" });
    const group = buildV9DependencyEvaluationPlan(compiled).commonModeGroups.find(
      (candidate) => candidate.failureDomain.kind === "chain" && candidate.failureDomain.key === "monad",
    );
    expect(group?.members).toEqual([
      { assetId: "alpha", owner: "exit", pathKey: alpha.exitRoutes[0]!.routeKey },
      { assetId: "alpha", owner: "supply", pathKey: "supply" },
    ]);
  });

  it("attributes chain-contract redemption routes to a redemption rail, not a DEX protocol", () => {
    const fixed = queuedRedemptionFixedInput();
    const observation = fixed.redemptionBackstopMap.alpha!.capacityProfile!.exitRouteObservations![0]!;
    observation.routeFamily = "protocol-redemption";
    observation.scope = {
      kind: "chain-contract",
      chain: "ethereum",
      contractOrPoolId: "0x2397321b301b80a1c0911d6f9ed4b6033d43cf51",
      protocol: "frax",
    };
    const reviewed = extension();
    reviewed.assets[0]!.routeReviews.push({
      ...routeReview(observation.routeId),
      lane: "redemption",
      failureDomains: [],
    });

    const {
      schemaVersion: omittedSchemaVersion,
      dexPayloadFingerprint: omittedDexPayloadFingerprint,
      redemptionPayloadFingerprint: omittedRedemptionPayloadFingerprint,
      registryFingerprint: omittedRegistryFingerprint,
      inputMethodologyVersions: omittedInputMethodologyVersions,
      baseInputGenerationId: omittedBaseInputGenerationId,
      ...draft
    } = fixed;
    void [
      omittedSchemaVersion,
      omittedDexPayloadFingerprint,
      omittedRedemptionPayloadFingerprint,
      omittedRegistryFingerprint,
      omittedInputMethodologyVersions,
      omittedBaseInputGenerationId,
    ];
    const rebuilt = createReportCardsFixedInput(draft);
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(rebuilt, reviewed);
    const redemptionRoute = compiled.assets[0]!.exitRoutes.find((candidate) => candidate.lane === "redemption")!;

    expect(redemptionRoute.failureDomains).toContainEqual({ kind: "chain", key: "ethereum" });
    expect(redemptionRoute.failureDomains).toContainEqual({ kind: "redemption-rail", key: "frax" });
    expect(redemptionRoute.failureDomains).not.toContainEqual({ kind: "dex-protocol", key: "frax" });
  });

  it("keeps shaped diagnostic pools out of the DEX completeness denominator without hiding exact gates", () => {
    const fixedWithCoverage = (exactCapabilityPoolCount: number) => {
      const original = exactFixedInput();
      const {
        schemaVersion: omittedSchemaVersion,
        activeAssetIds: omittedActiveAssetIds,
        dexPayloadFingerprint: omittedDexPayloadFingerprint,
        redemptionPayloadFingerprint: omittedRedemptionPayloadFingerprint,
        registryFingerprint: omittedRegistryFingerprint,
        inputMethodologyVersions: omittedInputMethodologyVersions,
        baseInputGenerationId: omittedBaseInputGenerationId,
        ...draft
      } = original;
      void [
        omittedSchemaVersion,
        omittedActiveAssetIds,
        omittedDexPayloadFingerprint,
        omittedRedemptionPayloadFingerprint,
        omittedRegistryFingerprint,
        omittedInputMethodologyVersions,
        omittedBaseInputGenerationId,
      ];
      return createReportCardsFixedInput({
        ...draft,
        activeAssetIds: ["alpha"],
        dexLiqMap: {
          alpha: {
            ...original.dexLiqMap.alpha!,
            exitRouteObservationCoverage: {
              status: "populated",
              capabilityMatrixVersion: "p4a.8",
              retainedPoolCount: 2_380 + exactCapabilityPoolCount,
              observationCount: 1,
              scoreEligibleObservationCount: 1,
              scoreEligiblePoolCount: 1,
              scoreEligibleCapabilityPoolCount: exactCapabilityPoolCount,
              unsupportedPoolCount: 2_379 + exactCapabilityPoolCount,
              evidenceCounts: { "reserve-based-amm-simulation": 1 },
              unsupportedReasons: {
                "nonExecutableEvidence:defillama-pool-shaped": 1_449,
                "nonExecutableEvidence:curve-stableswap-shaped": 11,
                "nonExecutableEvidence:direct-api-amm-shaped": 653,
                "nonExecutableEvidence:discovery-pool-shaped": 267,
                ...(exactCapabilityPoolCount > 1
                  ? { "executionCapabilityGate:curve-stableswap:rate-bearing-inputs": 1 }
                  : {}),
              },
            },
          },
        },
      });
    };

    const complete = compileSafetyScoreV9FactSetFromFixedInput(fixedWithCoverage(1), extension()).assets[0]!;
    expect(complete.exitStatus.observationState).toBe("known");
    expect(complete.gaps.map((gap) => gap.reasonCode)).not.toContain("incomplete-dex-route-coverage");

    const gated = compileSafetyScoreV9FactSetFromFixedInput(fixedWithCoverage(2), extension()).assets[0]!;
    expect(gated.exitStatus.observationState).toBe("bounded-unknown");
    expect(gated.gaps.map((gap) => gap.reasonCode)).toContain("incomplete-dex-route-coverage");
  });

  it("treats a pure NAV peg reference as not-applicable while fiat assets still require a peg row", () => {
    const withoutPegRow = () => exactFixedInput({ omitPegRow: true });
    const navExtension = extension();
    navExtension.assets[0]!.pegReference = { referenceKind: "nav", referenceKey: "nav:alpha", failureDomains: [] };
    const navCompiled = compileSafetyScoreV9FactSetFromFixedInput(withoutPegRow(), navExtension);
    const navPeg = navCompiled.assets[0]!.peg;
    expect(navPeg.status.applicability.state).toBe("not-applicable");
    expect(navPeg.status.observationState).toBe("known");
    expect(navPeg.pegScore).toBeNull();
    const navEvaluated = evaluateV9FactSet(navCompiled, V9_CANDIDATE_POLICY_V1);
    expect(navEvaluated.assets[0]!.trace.finalGrade).not.toBe("NR");

    const fiatCompiled = compileSafetyScoreV9FactSetFromFixedInput(withoutPegRow(), extension());
    expect(fiatCompiled.assets[0]!.peg.status.observationState).toBe("missing");
    // A missing producer row is an availability failure, not measured peg
    // safety. The latent peg multiplier remains visible and the rating remains
    // provisional under the configured bounded-evidence ceiling.
    const fiatTrace = evaluateV9FactSet(fiatCompiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace;
    const missingPegCeiling = resolveV9ReasonPolicy(
      V9_CANDIDATE_POLICY_V1,
      "missing-peg-input",
    ).ceiling!;
    expect(fiatTrace.finalGrade).not.toBe("NR");
    expect(fiatTrace.finalScore).toBeLessThanOrEqual(missingPegCeiling.limit);
    expect(fiatTrace.pegMultiplier).toBe(1);
    expect(fiatTrace.caps).toContainEqual(
      expect.objectContaining({
        source: "evidence",
        kind: missingPegCeiling.kind,
        limit: missingPegCeiling.limit,
      }),
    );
    expect(fiatTrace.unresolvedFacts).toContainEqual(
      expect.objectContaining({ code: "missing-peg-input", responsibility: "producer-failed" }),
    );
    expect(fiatTrace.nrReasons).toEqual([]);
  });

  it("retains an independently observed active depeg when current deviation is unavailable", () => {
    const fixed = exactFixedInput({
      pegScore: 27,
      currentDeviationBps: null,
      activeDepeg: true,
      activeDepegPeakBps: 5_783,
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension());

    expect(compiled.assets[0]!.peg).toMatchObject({
      status: { observationState: "bounded-unknown" },
      pegScore: 27,
      currentDeviationBps: null,
      activeDepeg: true,
      activeDepegBps: 5_783,
    });
    const trace = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace;
    expect(trace.pegMultiplier).toBeCloseTo(0.592305, 6);
    expect(trace.caps).toContainEqual(
      expect.objectContaining({ source: "active-depeg", kind: "active-depeg:f", limit: 39 }),
    );
    const missingPeak = exactFixedInput({ pegScore: 27, currentDeviationBps: null, activeDepeg: true });
    const missingPeakTrace = evaluateV9FactSet(
      compileSafetyScoreV9FactSetFromFixedInput(missingPeak, extension()),
      V9_CANDIDATE_POLICY_V1,
    ).assets[0]!.trace;
    expect(trace.finalGrade).toBe("F");
    expect(trace.nrReasons).toEqual([]);
    expect(missingPeakTrace.finalGrade).not.toBe("NR");
    expect(missingPeakTrace.nrReasons).toEqual([]);
    expect(trace.preCapScore).toBeLessThan(missingPeakTrace.preCapScore!);
  });

  it("keeps an active peg row suppressed when its depeg peak is absent", () => {
    const fixed = exactFixedInput({ pegScore: 27, currentDeviationBps: null, activeDepeg: true });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension());

    expect(compiled.assets[0]!.peg).toMatchObject({
      status: { observationState: "bounded-unknown" },
      pegScore: null,
      currentDeviationBps: null,
      activeDepeg: null,
      activeDepegBps: null,
    });
    const trace = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace;
    const missingPegCeiling = resolveV9ReasonPolicy(
      V9_CANDIDATE_POLICY_V1,
      "missing-peg-input",
    ).ceiling!;
    expect(trace.finalGrade).not.toBe("NR");
    expect(trace.finalScore).toBeLessThanOrEqual(missingPegCeiling.limit);
    expect(trace.caps).toContainEqual(
      expect.objectContaining({
        source: "evidence",
        kind: missingPegCeiling.kind,
        limit: missingPegCeiling.limit,
      }),
    );
    expect(trace.unresolvedFacts).toContainEqual(
      expect.objectContaining({ code: "missing-peg-input", responsibility: "producer-failed" }),
    );
    expect(trace.nrReasons).toEqual([]);
    expect(trace.caps.some((cap) => cap.source === "active-depeg")).toBe(false);
  });

  it("canonicalizes extension ordering and produces a deterministic digest", () => {
    const ordered = extension();
    const reversed = structuredClone(ordered);
    const review = reversed.assets[0]!.routeReviews[0]!;
    review.executionCosts.reverse();
    review.failureDomains.reverse();
    review.physicalResourceKeys.reverse();
    const reversedMechanism = reversed.assets[0]!.mechanismRiskReview!;
    if (reversedMechanism.archetype !== "fiat-cash") throw new Error("Fixture archetype changed");
    reversedMechanism.claimAndSegregation.status.evidenceRefIds = ["other:placeholder"];
    const left = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), ordered);
    const right = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), reversed);
    expect(right).toEqual(left);
    expect(right.v9FactSetDigest).toBe(left.v9FactSetDigest);
  });

  it("rebinds CDP not-applicable metric evidence refs to the mechanism review evidence", () => {
    const cdp = extension();
    cdp.assets[0]!.archetype = "cdp";
    cdp.assets[0]!.mechanismRiskReview = {
      archetype: "cdp",
      collateralizationRatio: 1.5,
      liquidationCapacityRatio: null,
      metricApplicability: {
        collateralizationRatio: { state: "measured" },
        liquidationCapacityRatio: {
          state: "not-applicable",
          rationale: "No liquidation venue exists for this fixture branch.",
          evidenceRefIds: ["extension-evidence:mechanism:liquidation-capacity-ratio"],
        },
      },
      collateralizationParameters: {
        status: status("known", "v9.backing.mechanism-review"),
        quality: "strong",
        failureDomains: [],
      },
      liquidationMechanics: {
        status: status("known", "v9.backing.mechanism-review"),
        quality: "strong",
        failureDomains: [],
      },
      backstop: {
        status: status("known", "v9.backing.mechanism-review"),
        quality: "strong",
        failureDomains: [],
      },
      branchIsolation: {
        status: status("known", "v9.backing.mechanism-review"),
        quality: "strong",
        failureDomains: [],
      },
      shutdownAndBadDebt: {
        status: status("known", "v9.backing.mechanism-review"),
        quality: "strong",
        failureDomains: [],
      },
      structuralRedemption: {
        status: status("known", "v9.backing.mechanism-review"),
        quality: "strong",
        failureDomains: [],
      },
    };

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), cdp).assets[0]!;
    if (compiled.mechanismRiskReview.review?.archetype !== "cdp") throw new Error("Fixture archetype changed");

    const applicability = compiled.mechanismRiskReview.review.metricApplicability.liquidationCapacityRatio;
    expect(applicability.state).toBe("not-applicable");
    if (applicability.state !== "not-applicable") throw new Error("Fixture applicability changed");
    const metricEvidenceRefs = applicability.evidenceRefIds;
    expect(metricEvidenceRefs).toEqual(compiled.mechanismRiskReview.status.evidenceRefIds);
    expect(metricEvidenceRefs).toEqual(["alpha:research-overlay"]);
    expect(compiled.evidence.map((evidence) => evidence.evidenceId)).toContain(metricEvidenceRefs[0]);
  });

  it("turns unavailable classifications, valuation, dependencies, and controls into typed gaps", () => {
    const incomplete = extension();
    const asset = incomplete.assets[0]!;
    asset.mechanismRiskReview = null;
    asset.dependencies = null;
    asset.controlReview = null;
    asset.economicControlReview = null;
    asset.accessReview = null;
    asset.supplyReview = null;
    asset.routeReviews[0]!.output!.valuation = null;

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(
      exactFixedInput({ classifiedReserve: false }),
      incomplete,
    );
    expect(compiled.schemaVersion).toBe(3);
    const alpha = compiled.assets[0]!;
    const reasons = alpha.gaps.map((gap) => gap.reasonCode);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "material-reserve-slice-unstructured",
        "unresolved-exit-output",
        "unreviewed-dependency-relationships",
        "missing-upgradeability-review",
        "missing-mint-authority",
        "missing-oracle-profile",
        "missing-bridge-routes",
        "runtime-bridge-materiality-unavailable",
      ]),
    );
    expect(alpha.reserveExposures[0]).toMatchObject({
      assetClass: null,
      status: { observationState: "bounded-unknown" },
    });
    expect(alpha.exitRoutes[0]!.output).toMatchObject({ valuation: null, status: { observationState: "missing" } });
    expect(alpha.controls).toEqual([]);
    expect(alpha.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reasonCode: "material-reserve-slice-unstructured",
          responsibility: "integration-missing",
        }),
        expect.objectContaining({
          reasonCode: "unresolved-exit-output",
          responsibility: "integration-missing",
        }),
        expect.objectContaining({
          reasonCode: "missing-upgradeability-review",
          responsibility: "integration-missing",
        }),
      ]),
    );
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace.unresolvedFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "material-reserve-slice-unstructured",
          responsibility: "integration-missing",
        }),
        expect.objectContaining({
          code: "unresolved-exit-output",
          responsibility: "integration-missing",
        }),
      ]),
    );
  });

  it("preserves supplied stale and rejected last-known route observations", () => {
    const withRetained = extension();
    const asset = withRetained.assets[0]!;
    asset.retainedRoutes = [
      { lane: "dex", observation: route("dex:stale", 8_000), disposition: "observed", rejection: null },
      {
        lane: "dex",
        observation: route("dex:rejected", 9_800),
        disposition: "rejected",
        rejection: { code: "unsupported-pool", reason: "Producer rejected the pool model.", rejectedAtSec: 9_900 },
      },
    ];
    asset.routeReviews = [routeReview(), routeReview("dex:stale", 8_000), routeReview("dex:rejected", 9_800)];

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), withRetained);
    const stale = compiled.assets[0]!.exitRoutes.find((candidate) => candidate.routeId === "dex:stale")!;
    const rejected = compiled.assets[0]!.exitRoutes.find((candidate) => candidate.routeId === "dex:rejected")!;
    expect(stale).toMatchObject({
      status: { observationState: "stale" },
      request: { requestedNotionalUsd: 100_000 },
    });
    expect(stale.capacityCurve).toHaveLength(2);
    expect(rejected).toMatchObject({ status: { observationState: "unsupported" }, scoreEligible: false });
    const rejectedEvidence = compiled.assets[0]!.evidence.find((evidence) =>
      rejected.status.evidenceRefIds.includes(evidence.evidenceId),
    );
    expect(rejectedEvidence).toMatchObject({ disposition: "rejected", rejection: { code: "unsupported-pool" } });
  });

  it("rejects reconstructed/report-card inputs, score-shaped extension fields, and active-set drift", () => {
    expect(() => compileSafetyScoreV9FactSetFromFixedInput({ cards: [], overallScore: 99 }, extension())).toThrow(
      /Malformed fixed report-card input/,
    );
    expect(() =>
      compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), { ...extension(), overallScore: 99 }),
    ).toThrow(/Unrecognized key/);
    const scoreShapedAsset = extension();
    expect(() =>
      compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), {
        ...scoreShapedAsset,
        assets: [{ ...scoreShapedAsset.assets[0]!, dimensions: {}, baseScore: 99 }],
      }),
    ).toThrow(/Unrecognized key/);
    const wrongAsset = extension();
    wrongAsset.assets[0]!.assetId = "beta";
    expect(() => compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), wrongAsset)).toThrow(
      /active set mismatch/,
    );

    const conflictingOutput = extension();
    conflictingOutput.assets[0]!.routeReviews[0]!.output!.assetKeys = ["fiat:EUR"];
    expect(() => compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), conflictingOutput)).toThrow(
      /output review conflicts with exact base facts/,
    );
  });

  it("prefers reviewed deployment transfer facts and preserves the absent-fact fallback", () => {
    const fixed = exactFixedInput();
    const reviewBase = {
      sources: [{ label: "Reviewed token controls", url: "https://example.com/token-controls" }],
      evidence: "The reviewed token controls establish the authored blacklist status.",
      reviewer: "Fixture reviewer",
      reviewedAt: "1970-01-01",
    };
    const transferFact = (
      posture: "permissionless" | "restrictable" | "permissioned",
    ): SafetyScoreV9ReviewedTransferFact => ({
      assetId: "alpha",
      reviewedAt: "1970-01-01",
      reviewer: "Fixture reviewer",
      deployments: [
        {
          chainId: "ethereum",
          contractOrTokenId: "0xalpha",
          scope: "canonical",
          posture,
          evidence: "The verified token implementation establishes this deployment posture.",
          sources: [{ label: "Verified token source", url: "https://example.com/token-source" }],
        },
      ],
    });
    const build = (
      reviewedStatus: true | false | "possible",
      transferReview?: SafetyScoreV9ReviewedTransferFact,
      input = fixed,
      options: {
        blacklistReviewedAt?: string;
        contracts?: Array<{ chain: string; address: string; decimals: number }>;
      } = {},
    ) =>
      buildSafetyScoreV9BaselineExtension(input, {
        metaById: new Map([
          [
            "alpha",
            {
              id: "alpha",
              mechanismArchetype: "fiat-cash" as const,
              contracts: options.contracts ?? [
                { chain: "ethereum", address: "0xalpha", decimals: 18 },
                { chain: "base", address: "0xbeta", decimals: 18 },
              ],
              blacklistabilityReview: {
                ...reviewBase,
                reviewedAt: options.blacklistReviewedAt ?? reviewBase.reviewedAt,
                reviewedStatus,
              },
            },
          ],
        ]),
        reviewedTransferFacts: new Map(transferReview ? [["alpha", transferReview]] : []),
      });

    const restrictable = compileSafetyScoreV9FactSetFromFixedInput(fixed, build(true)).assets[0]!;
    expect(restrictable.accessReview.transfer).toMatchObject({
      posture: "restrictable",
      status: { observationState: "known" },
    });
    expect(restrictable.accessReview.freeze.reviews[0]).toMatchObject({
      source: "blacklist",
      reach: "individual",
      status: { observationState: "known" },
    });
    expect(
      restrictable.evidence.find((candidate) => candidate.sourceId === "stablecoin-meta.blacklistability-review"),
    ).toMatchObject({
      url: "https://example.com/token-controls",
      freshness: { state: "current", maxAgeSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC },
    });

    const noBlacklist = compileSafetyScoreV9FactSetFromFixedInput(fixed, build(false)).assets[0]!;
    expect(noBlacklist.accessReview.transfer).toMatchObject({
      posture: null,
      status: { observationState: "missing" },
    });
    expect(noBlacklist.accessReview.freeze.reviews[0]).toMatchObject({ reach: "none" });

    const possible = compileSafetyScoreV9FactSetFromFixedInput(fixed, build("possible")).assets[0]!;
    expect(possible.accessReview.transfer).toMatchObject({
      posture: null,
      status: { observationState: "bounded-unknown" },
    });
    expect(possible.accessReview.freeze.reviews[0]).toMatchObject({
      reach: "possible",
      status: { observationState: "bounded-unknown" },
    });

    for (const posture of ["permissionless", "restrictable", "permissioned"] as const) {
      const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, build(true, transferFact(posture))).assets[0]!;
      expect(compiled.accessReview.transfer).toMatchObject({ posture, status: { observationState: "known" } });
      expect(compiled.accessReview.freeze.reviews[0]).toMatchObject({
        reach: "individual",
        status: { observationState: "known" },
      });
      expect(
        compiled.evidence.find((candidate) => candidate.sourceId === "safety-score-v9.reviewed-transfer-overlay"),
      ).toMatchObject({
        url: "https://example.com/token-source",
        freshness: { state: "current", maxAgeSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC },
      });
    }

    const multiChain = exactFixedInput({
      chainSupplyByChain: {
        ethereum: {
          current: 9_000_000,
          circulatingPrevDay: 9_000_000,
          circulatingPrevWeek: 9_000_000,
          circulatingPrevMonth: 9_000_000,
        },
        base: {
          current: 1_000_000,
          circulatingPrevDay: 1_000_000,
          circulatingPrevWeek: 1_000_000,
          circulatingPrevMonth: 1_000_000,
        },
      },
    });
    const incomplete = compileSafetyScoreV9FactSetFromFixedInput(
      multiChain,
      build(true, transferFact("permissionless"), multiChain),
    ).assets[0]!;
    expect(incomplete.accessReview.transfer).toMatchObject({
      posture: null,
      status: { observationState: "bounded-unknown" },
    });

    const wrongContract = transferFact("permissionless");
    wrongContract.deployments[0]!.contractOrTokenId = "0xwrong";
    expect(
      compileSafetyScoreV9FactSetFromFixedInput(fixed, build(true, wrongContract)).assets[0]!.accessReview.transfer,
    ).toMatchObject({ posture: null, status: { observationState: "bounded-unknown" } });

    const wrongScope: SafetyScoreV9ReviewedTransferFact = {
      ...transferFact("permissionless"),
      deployments: [
        { ...transferFact("permissionless").deployments[0]!, scope: "additional" },
        {
          ...transferFact("permissionless").deployments[0]!,
          chainId: "base",
          contractOrTokenId: "0xbeta",
        },
      ],
    };
    expect(
      compileSafetyScoreV9FactSetFromFixedInput(fixed, build(true, wrongScope)).assets[0]!.accessReview.transfer,
    ).toMatchObject({ posture: null, status: { observationState: "bounded-unknown" } });

    expect(
      compileSafetyScoreV9FactSetFromFixedInput(
        fixed,
        build(true, transferFact("permissionless"), fixed, {
          contracts: [
            { chain: "ethereum", address: "0xalpha", decimals: 18 },
            { chain: "ethereum", address: "0xalpha2", decimals: 18 },
          ],
        }),
      ).assets[0]!.accessReview.transfer,
    ).toMatchObject({ posture: null, status: { observationState: "bounded-unknown" } });

    const staleInput = exactFixedInput({ clockSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC + 1 });
    const stale = compileSafetyScoreV9FactSetFromFixedInput(
      staleInput,
      build(true, transferFact("permissionless"), staleInput, { blacklistReviewedAt: "1971-01-01" }),
    ).assets[0]!;
    expect(stale.accessReview.transfer).toMatchObject({ posture: null, status: { observationState: "stale" } });
    expect(stale.accessReview.freeze.status.observationState).toBe("known");
    expect(
      stale.evidence.find((candidate) => candidate.sourceId === "safety-score-v9.reviewed-transfer-overlay"),
    ).toMatchObject({ freshness: { state: "stale", maxAgeSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC } });

    expect(build(true).registryFingerprint).toBe(build(true, transferFact("permissionless")).registryFingerprint);
    expect(SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST).toBe(
      "47ff7e12f20cb577f29a0aec4348b4b6068f4c6d0143183a486d078d38f06bd1",
    );
  });

  it("derives reviewed bridge/mint/oracle research freshness on the D11 review cadence", () => {
    const clockSec = Date.UTC(2026, 6, 19) / 1_000;
    const researchReviewMeta = (reviewedAt: string): V9ExtensionRegistryMeta => ({
      id: "alpha",
      mechanismArchetype: "cdp" as const,
      oracleRisk: {
        tier: "redundant-with-failover" as const,
        summary: "The fixture has reviewed oracle and liquidation branch behavior.",
        branchModel: "multi-branch" as const,
        branchApplicability: {
          disposition: "branches-required" as const,
          reviewedAt,
          reviewer: "Fixture reviewer",
          rationale: "The collateral market requires explicit branch evidence.",
          sources: [{ label: "Branch docs", url: "https://example.com/branches" }],
        },
        reviewedAt,
        reviewer: "Fixture reviewer",
        confidence: "verified" as const,
        sources: [{ label: "Oracle docs", url: "https://example.com/oracle" }],
        branches: [
          {
            id: "eth",
            label: "ETH branch",
            tier: "redundant-with-failover" as const,
            summary: "The ETH branch has complete reviewed controls.",
            feeds: [{ provider: "Fixture", path: "ETH/USD", chain: "ethereum" }],
            collateralParameters: [{ asset: "ETH", minimumCollateralRatioPct: 120 }],
            liquidationMechanism: "Immediate permissionless liquidation through the branch.",
            liquidationDelaySec: 0,
            backstop: "A dedicated stability pool absorbs liquidated debt.",
            shutdownOrBadDebtBehavior: "The branch shuts down and exposes residual bad debt explicitly.",
            sources: [{ label: "Branch docs", url: "https://example.com/branches" }],
          },
        ],
      },
      mintAuthority: {
        mintPath: "issuer-direct-mint" as const,
        authorityPosture: "concentrated-admin" as const,
        confidence: "verified" as const,
        summary: "The fixture token is reviewed immutable with no direct mint control.",
        upgradeability: {
          model: "immutable" as const,
          canChangeMintLogic: false,
          sources: [{ label: "Mint docs", url: "https://example.com/mint" }],
        },
        controls: [],
        review: {
          sources: [{ label: "Mint docs", url: "https://example.com/mint" }],
          evidence: "The fixture mint path is reviewed and immutable.",
          reviewer: "Fixture reviewer",
          reviewedAt,
        },
      },
      bridgeRouteRisk: {
        tier: "external-lock-mint" as const,
        summary: "A reviewed external bridge route represents the fixture token.",
        reviewedAt,
        reviewer: "Fixture reviewer",
        confidence: "verified" as const,
        sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
        routes: [
          {
            id: "ethereum:0x1111111111111111111111111111111111111111",
            destinationChain: "ethereum",
            canonicalChain: "ethereum",
            contractAddress: "0x1111111111111111111111111111111111111111",
            protocol: "Fixture native issuance",
            issuanceModel: "native-issuance" as const,
            routeClass: "native" as const,
            riskTier: "single-chain-or-native" as const,
            semantics: "native-mint" as const,
            scope: "canonical" as const,
            reviewDisposition: "reviewed" as const,
            observedAt: reviewedAt,
            sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
          },
          {
            id: "base:0x3333333333333333333333333333333333333333",
            sourceChain: "ethereum",
            destinationChain: "base",
            canonicalChain: "ethereum",
            contractAddress: "0x3333333333333333333333333333333333333333",
            protocol: "Fixture bridge",
            issuanceModel: "bridge-representation" as const,
            routeClass: "third-party" as const,
            riskTier: "external-lock-mint" as const,
            semantics: "lock-mint" as const,
            scope: "peripheral" as const,
            reviewDisposition: "reviewed" as const,
            observedAt: reviewedAt,
            sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
          },
        ],
      },
    });
    const researchSourceIds = [
      "stablecoin-meta.bridge-route-risk",
      "stablecoin-meta.mint-authority",
      "stablecoin-meta.oracle-risk",
    ];
    const compileWithReview = (reviewedAt: string) => {
      const fixed = exactFixedInput({ clockSec });
      const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([["alpha", researchReviewMeta(reviewedAt)]]),
      });
      return { baseline, compiled: compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline).assets[0]! };
    };

    // A same-day review is inside the 365-day review window and stays current.
    const current = compileWithReview("2026-07-19");
    expect(current.baseline.assets[0]!.controlReview).toMatchObject({ state: "reviewed-controls" });
    expect(current.compiled.economicControlReview.oracle.status.observationState).toBe("known");
    expect(current.compiled.economicControlReview.mint.status.observationState).toBe("known");
    expect(current.compiled.economicControlReview.bridge.status.observationState).toBe("known");
    for (const sourceId of researchSourceIds) {
      expect(
        current.compiled.evidence.find((candidate) => candidate.sourceId === sourceId),
        `${sourceId} must derive current inside the review window`,
      ).toMatchObject({ freshness: { state: "current", maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC } });
    }

    // A 2024 review is beyond the window: the facts degrade to stale honestly,
    // and the stale reviews no longer carry the umbrella control inventory.
    const stale = compileWithReview("2024-01-01");
    expect(stale.baseline.assets[0]!.controlReview).toBeNull();
    expect(stale.compiled.economicControlReview.oracle.status.observationState).toBe("stale");
    expect(stale.compiled.economicControlReview.mint.status.observationState).toBe("stale");
    expect(stale.compiled.economicControlReview.bridge.status.observationState).toBe("stale");
    for (const sourceId of researchSourceIds) {
      expect(
        stale.compiled.evidence.find((candidate) => candidate.sourceId === sourceId),
        `${sourceId} must derive stale beyond the review window`,
      ).toMatchObject({ freshness: { state: "stale", maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC } });
    }
  });

  it("derives route output valuation freshness on the D11 review cadence", () => {
    const clockSec = Date.UTC(2026, 6, 19) / 1_000;
    const fixed = exactFixedInput({ clockSec });
    const buildBaseline = () =>
      buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([["alpha", { id: "alpha", mechanismArchetype: "fiat-cash" as const }]]),
      });

    const current = compileSafetyScoreV9FactSetFromFixedInput(fixed, buildBaseline()).assets[0]!;
    expect(current.evidence.find((candidate) => candidate.evidenceId.includes(":route-valuation:"))).toMatchObject({
      freshness: { state: "current", maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC },
    });

    const staleExtension = buildBaseline();
    staleExtension.assets[0]!.routeReviews[0]!.output!.valuation!.observedAtSec =
      clockSec - V9_REVIEW_EVIDENCE_MAX_AGE_SEC - 1;
    const stale = compileSafetyScoreV9FactSetFromFixedInput(fixed, staleExtension).assets[0]!;
    expect(stale.evidence.find((candidate) => candidate.evidenceId.includes(":route-valuation:"))).toMatchObject({
      freshness: { state: "stale", maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC },
    });
    expect(stale.exitRoutes[0]!.output.status.observationState).toBe("stale");
  });

  it("derives cdp shock-coverage freshness on the D12 72-hour policy window", () => {
    const maxAgeSec =
      V9_CANDIDATE_POLICY_V1.policy.semantic.backing.structural.cdp.stressMeasurementFreshness.maxAgeSec;
    expect(maxAgeSec).toBe(259_200);
    const measurement = selectSafetyScoreV9CdpShockMeasurement("lusd-liquity", 1_784_225_942);
    if (!measurement || measurement.source === null) throw new Error("Expected a pinned LUSD shock measurement");
    const blockSec = measurement.source.block.timestampUnix;
    const cdpComponent = () => ({ status: status(), quality: "strong" as const, failureDomains: [] });

    const compileWithShockClock = (clockSec: number) => {
      const fixed = exactFixedInput({ clockSec, assetId: "lusd-liquity" });
      const ext = extension();
      ext.compiledAtSec = clockSec;
      ext.registryFingerprint = fixed.registryFingerprint;
      ext.sources.researchOverlays.observedAtSec = clockSec - 100;
      const asset = ext.assets[0]!;
      asset.assetId = "lusd-liquity";
      asset.archetype = "cdp";
      asset.mechanismRiskReview = {
        archetype: "cdp" as const,
        collateralizationRatio: 1.5,
        liquidationCapacityRatio: 0.25,
        metricApplicability: {
          collateralizationRatio: { state: "measured" as const },
          liquidationCapacityRatio: { state: "measured" as const },
        },
        collateralizationParameters: cdpComponent(),
        liquidationMechanics: cdpComponent(),
        backstop: cdpComponent(),
        branchIsolation: cdpComponent(),
        shutdownAndBadDebt: cdpComponent(),
        structuralRedemption: cdpComponent(),
      };
      asset.cdpStressCoverage = measurement;
      return compileSafetyScoreV9FactSetFromFixedInput(fixed, ext).assets[0]!;
    };

    // A measurement inside the 72-hour window stays current.
    const current = compileWithShockClock(blockSec + 100);
    expect(
      current.evidence.find((candidate) => candidate.evidenceId.startsWith("lusd-liquity:cdp-shock-coverage:")),
    ).toMatchObject({ freshness: { state: "current", maxAgeSec } });

    // A measurement older than 72 hours derives stale honestly.
    const stale = compileWithShockClock(blockSec + maxAgeSec + 1);
    expect(
      stale.evidence.find((candidate) => candidate.evidenceId.startsWith("lusd-liquity:cdp-shock-coverage:")),
    ).toMatchObject({ freshness: { state: "stale", maxAgeSec } });
  });

  it("maps only explicit oracle branch families and remains NR without a mechanism review", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            oracleRisk: {
              tier: "redundant-with-failover" as const,
              summary: "The fixture has reviewed oracle and liquidation branch behavior.",
              branchModel: "multi-branch" as const,
              branchApplicability: {
                disposition: "branches-required" as const,
                reviewedAt: "1970-01-01",
                reviewer: "Fixture reviewer",
                rationale: "The collateral market requires explicit branch evidence.",
                sources: [{ label: "Branch docs", url: "https://example.com/branches" }],
              },
              reviewedAt: "1970-01-01",
              reviewer: "Fixture reviewer",
              confidence: "verified" as const,
              sources: [{ label: "Oracle docs", url: "https://example.com/oracle" }],
              branches: [
                {
                  id: "eth",
                  label: "ETH branch",
                  tier: "redundant-with-failover" as const,
                  summary: "The ETH branch has complete reviewed controls.",
                  feeds: [{ provider: "Fixture", path: "ETH/USD", chain: "ethereum" }],
                  collateralParameters: [{ asset: "ETH", minimumCollateralRatioPct: 120 }],
                  liquidationMechanism: "Immediate permissionless liquidation through the branch.",
                  liquidationDelaySec: 0,
                  backstop: "A dedicated stability pool absorbs liquidated debt.",
                  shutdownOrBadDebtBehavior: "The branch shuts down and exposes residual bad debt explicitly.",
                  sources: [{ label: "Branch docs", url: "https://example.com/branches" }],
                },
              ],
            },
          },
        ],
      ]),
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const oracle = compiled.assets[0]!.economicControlReview.oracle;
    expect(oracle.status.observationState).toBe("known");
    expect(oracle.tier).toBe("redundant-with-failover");
    expect(oracle.branches.map((branch) => [branch.branch, branch.status.observationState])).toEqual([
      ["backstop", "known"],
      ["collateral-parameter", "known"],
      ["feed", "known"],
      ["liquidation", "known"],
      ["shutdown-bad-debt", "known"],
    ]);
    expect(oracle.branches.every((branch) => branch.mechanismKey !== null && branch.controlKey === null)).toBe(true);
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace.finalGrade).not.toBe("NR");

    const withoutOracle = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([["alpha", { id: "alpha", mechanismArchetype: "cdp" as const }]]),
    });
    expect(withoutOracle.assets[0]!.economicControlReview).toBeNull();
  });

  it("retains mint controls while leaving reconciliation, incidents, and upgrades unresolved", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "issuer-direct-mint" as const,
              authorityPosture: "concentrated-admin" as const,
              confidence: "verified" as const,
              summary: "A reviewed issuer backend can mint the fixture token directly.",
              controls: [
                {
                  chain: "ethereum",
                  address: "0x1111111111111111111111111111111111111111",
                  label: "Issuer minter",
                  role: "direct-minter" as const,
                  authorityType: "issuer-backend" as const,
                  directMintAbility: "direct" as const,
                  sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                },
              ],
              review: {
                sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                evidence: "The issuer minter path is reviewed, but reconciliation and upgrades are not established.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
                // Open questions keep the review incomplete, so the control is
                // retained while reconciliation, incidents, and upgrades stay
                // unresolved (bounded-unknown).
                unresolvedQuestions: ["Reconciliation cadence and upgrade authority are not yet established."],
              },
            },
          },
        ],
      ]),
    });
    expect(baseline.assets[0]!.controlReview).toMatchObject({ state: "partially-reviewed-controls" });
    expect(baseline.assets[0]!.economicControlReview?.mint).toMatchObject({
      status: { observationState: "bounded-unknown" },
      reconciliation: "unknown",
      upgrade: { state: "unknown", controlKey: null },
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    expect(compiled.assets[0]!.controls[0]).toMatchObject({
      status: { observationState: "bounded-unknown" },
      capSemantics: { kind: "unbounded", bound: null },
      claimImpairment: "unbounded",
      economicLossScope: "global-claim",
      incidentState: "unknown",
    });
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace.finalGrade).not.toBe("NR");
  });

  it("keeps a reviewed upgrade control known inside a partial control inventory", () => {
    const fixed = exactFixedInput();
    const mixed = extension();
    const asset = mixed.assets[0]!;
    const bridgeDeploymentKey = "ethereum:0x3333333333333333333333333333333333333333";
    const bridgeControlKey = "bridge:unresolved";
    const mintControlKey = "mint:unresolved";
    const upgradeControlKey = "upgrade:reviewed";

    asset.controlReview = {
      state: "partially-reviewed-controls",
      rationale: "The upgrade authority is reviewed, while bridge and direct-minter identities remain unresolved.",
      controls: [
        {
          controlKey: bridgeControlKey,
          deploymentKey: bridgeDeploymentKey,
          controlKind: "bridge",
          scope: "deployment",
          capabilities: ["bridge-mint"],
          capSemantics: { kind: "unbounded", bound: null },
          claimImpairment: "unbounded",
          economicLossScope: "deployment",
          authority: { authorityKey: `bridge-route:${bridgeDeploymentKey}`, model: "unknown", threshold: null },
          delaySec: null,
          materialSupplyShare: 1,
          incidentState: "none",
          failureDomains: [{ kind: "bridge-route", key: bridgeDeploymentKey }],
        },
        {
          controlKey: mintControlKey,
          deploymentKey: "asset:alpha",
          controlKind: "mint",
          scope: "global",
          capabilities: ["mint"],
          capSemantics: { kind: "raiseable", bound: null },
          claimImpairment: "bounded",
          economicLossScope: "global-claim",
          authority: null,
          delaySec: null,
          materialSupplyShare: null,
          incidentState: "none",
          failureDomains: [],
        },
        {
          controlKey: upgradeControlKey,
          deploymentKey: "asset:alpha",
          controlKind: "upgrade",
          scope: "global",
          capabilities: ["upgrade"],
          capSemantics: { kind: "not-applicable", bound: null },
          claimImpairment: "unbounded",
          economicLossScope: "global-claim",
          authority: {
            authorityKey: "ethereum:0x4444444444444444444444444444444444444444",
            model: "multisig",
            threshold: { required: 3, total: 6 },
          },
          delaySec: null,
          materialSupplyShare: null,
          incidentState: "none",
          failureDomains: [{ kind: "upgrade-control", key: "ethereum:0x4444444444444444444444444444444444444444" }],
        },
      ],
    };
    asset.economicControlReview = {
      ...asset.economicControlReview!,
      mint: {
        status: status("known", "v9.control.mint-review"),
        controlKey: mintControlKey,
        reconciliation: "not-applicable",
        supervision: "unknown",
        upgrade: { state: "reviewed", controlKey: upgradeControlKey },
      },
      bridge: {
        status: {
          applicability: {
            state: "required",
            policyRuleId: "v9.control.bridge-review",
            rationale: null,
            gapId: null,
          },
          observationState: "bounded-unknown",
          evidenceRefIds: ["placeholder:evidence"],
          gapIds: ["extension-gap:bridge:alpha"],
        },
        routes: [],
      },
    };
    asset.supplyReview = {
      selectedBridgeRoutes: [
        {
          deploymentRouteKey: bridgeDeploymentKey,
          supplyUsd: 10_000_000,
          supplyShare: 1,
          reviewState: "selected-unresolved",
        },
      ],
      selectedRouteSupplyShare: 0,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 1,
      failureDomains: [{ kind: "bridge-route", key: bridgeDeploymentKey }],
    };

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, mixed).assets[0]!;
    expect(compiled.controlStatus).toMatchObject({ observationState: "bounded-unknown" });
    expect(compiled.controls.find((control) => control.controlKey === upgradeControlKey)?.status).toMatchObject({
      observationState: "known",
      gapIds: [],
    });
    for (const unresolvedControlKey of [bridgeControlKey, mintControlKey]) {
      expect(compiled.controls.find((control) => control.controlKey === unresolvedControlKey)?.status).toMatchObject({
        observationState: "bounded-unknown",
        gapIds: [expect.stringContaining(unresolvedControlKey)],
      });
    }

    const evaluated = evaluateV9FactSet(compileSafetyScoreV9FactSetFromFixedInput(fixed, mixed), V9_CANDIDATE_POLICY_V1)
      .assets[0]!;
    expect(evaluated.control.reasons.map((reason) => reason.code)).not.toContain("missing-upgradeability-review");
    expect(evaluated.control.reasons.some((reason) => reason.path.includes(bridgeControlKey))).toBe(true);
    expect(evaluated.control.reasons.some((reason) => reason.path.includes(mintControlKey))).toBe(true);
  });

  it("joins a capped minter to its separately reviewed cap-raising governor", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "user-collateralized-governed" as const,
              authorityPosture: "partially-bounded-admin" as const,
              confidence: "verified" as const,
              summary: "A protocol adapter mints within a cap that a separate governor can raise.",
              upgradeability: {
                model: "immutable" as const,
                canChangeMintLogic: false,
                sources: [{ label: "Contract source", url: "https://example.com/source" }],
              },
              controls: [
                {
                  chain: "ethereum",
                  address: "0x1111111111111111111111111111111111111111",
                  label: "Capped protocol minter",
                  role: "direct-minter" as const,
                  authorityType: "contract" as const,
                  directMintAbility: "cap-limited" as const,
                  canRaiseCap: false,
                  sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                },
                {
                  chain: "ethereum",
                  address: "0x2222222222222222222222222222222222222222",
                  label: "Cap governor",
                  role: "governor" as const,
                  authorityType: "dao-governor" as const,
                  directMintAbility: "parameter-only" as const,
                  canRaiseCap: true,
                  sources: [{ label: "Governance docs", url: "https://example.com/governance" }],
                },
              ],
              review: {
                sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                evidence: "The capped mint path and the separate cap-raising governor are both reviewed.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
              },
            },
          },
        ],
      ]),
    });

    const controlReview = baseline.assets[0]!.controlReview;
    expect(controlReview).toMatchObject({ state: "reviewed-controls" });
    if (controlReview?.state !== "reviewed-controls") {
      throw new Error("expected reviewed controls");
    }
    expect(controlReview.controls[0]).toMatchObject({
      capSemantics: { kind: "raiseable", bound: null },
      claimImpairment: "bounded",
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    expect(compiled.assets[0]!.controls[0]!.capSemantics).toEqual({ kind: "raiseable", bound: null });
  });

  it("does not join a capped minter to a cap raiser on another chain", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "user-collateralized-governed" as const,
              authorityPosture: "partially-bounded-admin" as const,
              confidence: "verified" as const,
              summary: "A capped minter and an unrelated cross-chain cap raiser.",
              upgradeability: {
                model: "immutable" as const,
                canChangeMintLogic: false,
                sources: [{ label: "Contract source", url: "https://example.com/source" }],
              },
              controls: [
                {
                  chain: "ethereum",
                  address: "0x1111111111111111111111111111111111111111",
                  label: "Ethereum capped minter",
                  role: "direct-minter" as const,
                  authorityType: "contract" as const,
                  directMintAbility: "cap-limited" as const,
                  canRaiseCap: false,
                  sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                },
                {
                  chain: "arbitrum",
                  address: "0x2222222222222222222222222222222222222222",
                  label: "Arbitrum cap governor",
                  role: "governor" as const,
                  authorityType: "dao-governor" as const,
                  directMintAbility: "parameter-only" as const,
                  canRaiseCap: true,
                  sources: [{ label: "Governance docs", url: "https://example.com/governance" }],
                },
              ],
              review: {
                sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                evidence: "Both controls are reviewed but operate on different chains.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
              },
            },
          },
        ],
      ]),
    });

    const controlReview = baseline.assets[0]!.controlReview;
    expect(controlReview).toMatchObject({ state: "partially-reviewed-controls" });
    if (controlReview?.state !== "partially-reviewed-controls") {
      throw new Error("expected partially reviewed controls");
    }
    expect(controlReview.controls[0]).toMatchObject({ capSemantics: { kind: "unknown", bound: null } });
  });

  it("does not infer immutable upgradeability from an immutable mint path", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "immutable-user-collateralized" as const,
              authorityPosture: "none-resolved" as const,
              confidence: "verified" as const,
              summary: "Protocol contracts mediate issuance and no privileged issuer minter is resolved.",
              controls: [
                {
                  chain: "ethereum",
                  address: "0x2222222222222222222222222222222222222222",
                  label: "Protocol token",
                  role: "other" as const,
                  authorityType: "contract" as const,
                  directMintAbility: "none" as const,
                  sources: [{ label: "Token docs", url: "https://example.com/token" }],
                },
              ],
              review: {
                sources: [{ label: "Token docs", url: "https://example.com/token" }],
                evidence: "The token mint path is reviewed without a separate upgradeability conclusion.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
              },
            },
          },
        ],
      ]),
    });
    expect(baseline.assets[0]!.economicControlReview?.mint.upgrade).toEqual({
      state: "unknown",
      controlKey: null,
    });
  });

  it("resolves reviewed zero-share bridge semantics without contaminating the control aggregate", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash" as const,
            bridgeRouteRisk: {
              tier: "external-lock-mint" as const,
              summary: "A reviewed external bridge route represents the fixture token.",
              reviewedAt: "1970-01-01",
              reviewer: "Fixture reviewer",
              confidence: "verified" as const,
              sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
              routes: [
                {
                  id: "ethereum:0x1111111111111111111111111111111111111111",
                  destinationChain: "ethereum",
                  canonicalChain: "ethereum",
                  contractAddress: "0x1111111111111111111111111111111111111111",
                  protocol: "Fixture native issuance",
                  issuanceModel: "native-issuance" as const,
                  routeClass: "native" as const,
                  riskTier: "single-chain-or-native" as const,
                  semantics: "native-mint" as const,
                  scope: "canonical" as const,
                  reviewDisposition: "reviewed" as const,
                  observedAt: "1970-01-01",
                  sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                },
                {
                  id: "base:0x3333333333333333333333333333333333333333",
                  sourceChain: "ethereum",
                  destinationChain: "base",
                  canonicalChain: "ethereum",
                  contractAddress: "0x3333333333333333333333333333333333333333",
                  protocol: "Fixture bridge",
                  issuanceModel: "bridge-representation" as const,
                  routeClass: "third-party" as const,
                  riskTier: "external-lock-mint" as const,
                  semantics: "lock-mint" as const,
                  scope: "peripheral" as const,
                  reviewDisposition: "reviewed" as const,
                  observedAt: "1970-01-01",
                  sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                },
              ],
            },
          },
        ],
      ]),
    });
    expect(baseline.assets[0]!.economicControlReview?.bridge).toMatchObject({
      status: { observationState: "known" },
      routes: [{ tier: "external-lock-mint" }],
    });
    // The reviewed bridge-representation route resolves cap, claim, and incident
    // semantics. Its unknown controller remains visible on the exact zero-share
    // control without making the aggregate partially reviewed.
    const bridgeControl =
      baseline.assets[0]!.controlReview?.state === "reviewed-controls"
        ? baseline.assets[0]!.controlReview.controls[0]
        : null;
    expect(bridgeControl).toMatchObject({
      materialSupplyShare: 0,
      authority: { model: "unknown" },
      capSemantics: { kind: "unbounded" },
      claimImpairment: "unbounded",
      incidentState: "none",
    });
  });

  it("keeps a present empty bridge profile fail-closed on a single exact deployment", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash" as const,
            bridgeRouteRisk: {
              tier: "opaque-or-unknown" as const,
              summary: "The profile is present but has no reviewed deployment rows.",
              reviewedAt: "1970-01-01",
              reviewer: "Fixture reviewer",
              confidence: "verified" as const,
              sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
              routes: [],
            },
          },
        ],
      ]),
    });

    expect(baseline.assets[0]!.supplyReview?.selectedBridgeRoutes).toEqual([
      {
        deploymentRouteKey: "unmatched-chain:alpha:ethereum",
        supplyUsd: 10_000_000,
        supplyShare: 1,
        reviewState: "unmatched",
      },
    ]);
    expect(baseline.assets[0]!.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");
    expect(baseline.assets[0]!.controlReview).toMatchObject({
      state: "partially-reviewed-controls",
      controls: [expect.objectContaining({ deploymentKey: "unmatched-chain:alpha:ethereum", materialSupplyShare: 1 })],
    });
  });

  it("retains exact route shares while only material unresolved deployments contaminate the control aggregate", () => {
    const totalSupply = 1_000;
    const reviewedShare = 0.05;
    const baselineFor = (unresolvedShare: number | null) => {
      const row = (current: number) => ({
        current,
        circulatingPrevDay: current,
        circulatingPrevWeek: current,
        circulatingPrevMonth: current,
      });
      const fixed = exactFixedInput({
        chainSupplyByChain:
          unresolvedShare === null
            ? {}
            : {
                ethereum: row(totalSupply * (1 - reviewedShare - unresolvedShare)),
                base: row(totalSupply * reviewedShare),
                polygon: row(totalSupply * unresolvedShare),
              },
      });
      const extension = buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([
          [
            "alpha",
            {
              id: "alpha",
              mechanismArchetype: "fiat-cash" as const,
              bridgeRouteRisk: {
                tier: "canonical-rollup-bridge" as const,
                summary: "A reviewed canonical route coexists with an unresolved peripheral deployment.",
                reviewedAt: "1970-01-01",
                reviewer: "Fixture reviewer",
                confidence: "verified" as const,
                sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                routes: [
                  {
                    id: "ethereum:0x1111111111111111111111111111111111111111",
                    destinationChain: "ethereum",
                    canonicalChain: "ethereum",
                    contractAddress: "0x1111111111111111111111111111111111111111",
                    protocol: "Fixture native issuance",
                    issuanceModel: "native-issuance" as const,
                    routeClass: "native" as const,
                    riskTier: "single-chain-or-native" as const,
                    semantics: "native-mint" as const,
                    scope: "canonical" as const,
                    reviewDisposition: "reviewed" as const,
                    observedAt: "1970-01-01",
                    sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                  },
                  {
                    id: "base:0x2222222222222222222222222222222222222222",
                    sourceChain: "ethereum",
                    destinationChain: "base",
                    canonicalChain: "ethereum",
                    contractAddress: "0x2222222222222222222222222222222222222222",
                    protocol: "Fixture canonical bridge",
                    issuanceModel: "bridge-representation" as const,
                    routeClass: "canonical" as const,
                    riskTier: "canonical-rollup-bridge" as const,
                    semantics: "lock-mint" as const,
                    scope: "peripheral" as const,
                    reviewDisposition: "reviewed" as const,
                    observedAt: "1970-01-01",
                    sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                  },
                  {
                    id: "polygon:0x3333333333333333333333333333333333333333",
                    destinationChain: "polygon",
                    contractAddress: "0x3333333333333333333333333333333333333333",
                    protocol: "Unresolved fixture route",
                    issuanceModel: "unknown" as const,
                    routeClass: "unknown" as const,
                    riskTier: "opaque-or-unknown" as const,
                    semantics: "unknown" as const,
                    scope: "unknown" as const,
                    reviewDisposition: "unresolved" as const,
                    reviewNote: "The route controller and issuance semantics remain unresolved.",
                    observedAt: "1970-01-01",
                  },
                ],
              },
            },
          ],
        ]),
      });
      return { fixed, extension, asset: extension.assets[0]! };
    };

    const threshold = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
    const peripheralFixture = baselineFor(threshold - 0.001);
    const peripheral = peripheralFixture.asset;
    expect(peripheral.controlReview).toMatchObject({ state: "reviewed-controls" });
    expect(peripheral.economicControlReview?.bridge.status.observationState).toBe("known");
    if (peripheral.controlReview?.state !== "reviewed-controls") {
      throw new Error("expected below-threshold deployment controls to be reviewed");
    }
    expect(
      peripheral.controlReview.controls.find((control) => control.deploymentKey.startsWith("base:")),
    ).toMatchObject({ materialSupplyShare: reviewedShare });
    expect(
      peripheral.controlReview.controls.find((control) => control.deploymentKey.startsWith("polygon:")),
    ).toMatchObject({
      materialSupplyShare: threshold - 0.001,
      capSemantics: { kind: "unknown" },
      claimImpairment: "unknown",
      incidentState: "unknown",
    });
    const compiledPeripheral = compileSafetyScoreV9FactSetFromFixedInput(
      peripheralFixture.fixed,
      peripheralFixture.extension,
    ).assets[0]!;
    expect(compiledPeripheral.controlStatus).toMatchObject({ observationState: "known" });
    expect(compiledPeripheral.controls.find((control) => control.deploymentKey.startsWith("base:"))).toMatchObject({
      authority: { model: "unknown" },
      status: { observationState: "bounded-unknown" },
    });
    const compiledPeripheralUnresolved = compiledPeripheral.controls.find((control) =>
      control.deploymentKey.startsWith("polygon:"),
    )!;
    expect(compiledPeripheralUnresolved.status).toMatchObject({ observationState: "bounded-unknown" });
    expect(compiledPeripheralUnresolved.status.gapIds).toHaveLength(1);
    expect(
      evaluateV9FactSet(
        compileSafetyScoreV9FactSetFromFixedInput(peripheralFixture.fixed, peripheralFixture.extension),
        V9_CANDIDATE_POLICY_V1,
      ).assets[0]!.control.reasons.some((reason) => reason.path.includes(compiledPeripheralUnresolved.controlKey)),
    ).toBe(false);

    for (const unresolvedShare of [threshold, threshold + 0.01, null]) {
      const materialFixture = baselineFor(unresolvedShare);
      const material = materialFixture.asset;
      expect(material.controlReview).toMatchObject({ state: "partially-reviewed-controls" });
      expect(material.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");
      const compiledMaterial = compileSafetyScoreV9FactSetFromFixedInput(
        materialFixture.fixed,
        materialFixture.extension,
      );
      const evaluatedMaterial = evaluateV9FactSet(compiledMaterial, V9_CANDIDATE_POLICY_V1).assets[0]!;
      expect(evaluatedMaterial.control.reasons.some((reason) => reason.code === "unresolved-control-identity")).toBe(
        true,
      );
    }
  });

  it("exempts only complete independently subthreshold unmatched bridge inventories", () => {
    const row = (current: number) => ({
      current,
      circulatingPrevDay: current,
      circulatingPrevWeek: current,
      circulatingPrevMonth: current,
    });
    const route = (id: string, disposition: "reviewed" | "unresolved" = "unresolved") => ({
      id,
      destinationChain: id.slice(0, id.indexOf(":")),
      contractAddress: id.slice(id.indexOf(":") + 1),
      protocol: disposition === "reviewed" ? "Fixture native issuance" : "Unresolved fixture route",
      issuanceModel: disposition === "reviewed" ? ("native-issuance" as const) : ("unknown" as const),
      routeClass: disposition === "reviewed" ? ("native" as const) : ("unknown" as const),
      riskTier: disposition === "reviewed" ? ("single-chain-or-native" as const) : ("opaque-or-unknown" as const),
      semantics: disposition === "reviewed" ? ("native-mint" as const) : ("unknown" as const),
      scope: disposition === "reviewed" ? ("canonical" as const) : ("unknown" as const),
      reviewDisposition: disposition,
      reviewNote: disposition === "unresolved" ? "The route semantics remain unresolved." : undefined,
      observedAt: "1970-01-01",
      sources: disposition === "reviewed" ? [{ label: "Bridge docs", url: "https://example.com/bridge" }] : undefined,
    });
    const baselineFor = (chainShares: Record<string, number>, extraRoutes: ReturnType<typeof route>[] = []) => {
      const fixed = exactFixedInput({
        chainSupplyByChain: Object.fromEntries(
          Object.entries(chainShares).map(([chain, share]) => [chain, row(share * 10_000)]),
        ),
      });
      const extension = buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([
          [
            "alpha",
            {
              id: "alpha",
              mechanismArchetype: "fiat-cash" as const,
              bridgeRouteRisk: {
                tier: "canonical-rollup-bridge" as const,
                summary: "Fixture bridge inventory for exact deployment materiality.",
                reviewedAt: "1970-01-01",
                reviewer: "Fixture reviewer",
                confidence: "verified" as const,
                sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                routes: [route("ethereum:0x1111111111111111111111111111111111111111", "reviewed"), ...extraRoutes],
              },
            },
          ],
        ]),
      });
      return { fixed, extension, asset: extension.assets[0]! };
    };

    const independent = baselineFor({
      ethereum: 0.5005,
      base: 0.0999,
      polygon: 0.0999,
      arbitrum: 0.0999,
      optimism: 0.0999,
      avalanche: 0.0999,
    });
    expect(independent.asset.economicControlReview?.bridge.status.observationState).toBe("known");
    expect(independent.asset.controlReview).toMatchObject({ state: "reviewed-controls" });
    const independentControls =
      independent.asset.controlReview?.state === "reviewed-controls"
        ? independent.asset.controlReview.controls.filter((control) => control.controlKind === "bridge")
        : [];
    expect(independentControls).toHaveLength(5);
    expect(independentControls.every((control) => control.materialSupplyShare === 0.0999)).toBe(true);
    const independentEvaluation = evaluateV9FactSet(
      compileSafetyScoreV9FactSetFromFixedInput(independent.fixed, independent.extension),
      V9_CANDIDATE_POLICY_V1,
    ).assets[0]!;
    expect(
      independentEvaluation.control.reasons.some((reason) => reason.code === "material-bridge-supply-unmatched"),
    ).toBe(false);

    const exactThreshold = baselineFor({ ethereum: 0.9, base: 0.1 });
    expect(exactThreshold.asset.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");

    const pooledBelow = baselineFor({ ethereum: 0.9001, "Future Chain": 0.0499, future_chain: 0.05 });
    expect(pooledBelow.asset.economicControlReview?.bridge.status.observationState).toBe("known");
    expect(
      pooledBelow.asset.supplyReview?.selectedBridgeRoutes.find((candidate) => candidate.reviewState === "unmatched"),
    ).toMatchObject({ deploymentRouteKey: "unmatched-chain-label-pool:alpha", supplyShare: 0.0999 });

    const pooledAtThreshold = baselineFor({ ethereum: 0.9, "Future Chain": 0.05, future_chain: 0.05 });
    expect(pooledAtThreshold.asset.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");

    const ambiguous = baselineFor({ ethereum: 0.95, base: 0.05 }, [
      route("base:0x2222222222222222222222222222222222222222"),
      route("base:0x3333333333333333333333333333333333333333"),
    ]);
    expect(ambiguous.asset.supplyReview?.selectedBridgeRoutes).toContainEqual(
      expect.objectContaining({ deploymentRouteKey: "ambiguous-chain:alpha:base", supplyShare: 0.05 }),
    );
    expect(ambiguous.asset.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");

    const canonicalOrphan = baselineFor({ ethereum: 1 }, [
      route("hyperevm:0x4444444444444444444444444444444444444444"),
    ]);
    expect(canonicalOrphan.asset.economicControlReview?.bridge.status.observationState).toBe("known");
    expect(
      canonicalOrphan.asset.controlReview?.state === "reviewed-controls"
        ? canonicalOrphan.asset.controlReview.controls.find((control) => control.deploymentKey.startsWith("hyperevm:"))
        : null,
    ).toMatchObject({ materialSupplyShare: 0, capSemantics: { kind: "unknown" } });

    const uncanonicalizableOrphan = baselineFor({ ethereum: 1 }, [
      route("futurechain:0x5555555555555555555555555555555555555555"),
    ]);
    expect(uncanonicalizableOrphan.asset.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");
  });

  it("does not let an unresolved access-only control contaminate a resolved aggregate", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "immutable-user-collateralized" as const,
              authorityPosture: "none-resolved" as const,
              confidence: "verified" as const,
              summary: "Immutable user issuance includes a non-claiming control with no privileged authority identity.",
              upgradeability: {
                model: "immutable" as const,
                canChangeMintLogic: false,
                sources: [{ label: "Token source", url: "https://example.com/token" }],
              },
              controls: [
                {
                  label: "Non-claiming protocol surface",
                  role: "other" as const,
                  authorityType: "none" as const,
                  directMintAbility: "none" as const,
                  canRaiseCap: false,
                  sources: [{ label: "Token source", url: "https://example.com/token" }],
                },
              ],
              review: {
                sources: [{ label: "Token source", url: "https://example.com/token" }],
                evidence: "The reviewed surface cannot mint or impair the protocol claim.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
              },
            },
          },
        ],
      ]),
    });

    expect(baseline.assets[0]!.controlReview).toMatchObject({
      state: "reviewed-controls",
      controls: [
        expect.objectContaining({
          economicLossScope: "access-only",
          authority: null,
        }),
      ],
    });
  });

  it("rejects registry drift, future reviews, and stale evidence claimed as known", () => {
    const fixed = exactFixedInput();
    expect(() =>
      buildSafetyScoreV9BaselineExtension(fixed, {
        registryFingerprint: "f".repeat(64),
        metaById: new Map([["alpha", { id: "alpha", mechanismArchetype: "fiat-cash" as const }]]),
      }),
    ).toThrow(/registry fingerprint/);
    expect(() =>
      buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([
          [
            "alpha",
            {
              id: "alpha",
              mechanismArchetype: "fiat-cash" as const,
              blacklistabilityReview: {
                reviewedStatus: true,
                sourceFreeRationale: "Fixture-only review.",
                evidence: "This future-dated review must not enter an earlier candidate.",
                reviewer: "Fixture reviewer",
                reviewedAt: "2026-07-14",
              },
            },
          ],
        ]),
      }),
    ).toThrow(/later than the scoring clock/);

    const staleKnown = extension();
    staleKnown.assets[0]!.researchEvidence = [
      {
        evidenceKey: "stale-control-review",
        sourceId: "fixture.stale-control-review",
        observedAtSec: 8_000,
        publishedAtSec: null,
        url: "https://example.com/stale",
        contentSha256: "a".repeat(64),
        confidence: "verified",
        maxAgeSec: 500,
      },
    ];
    staleKnown.assets[0]!.componentEvidence = [{ componentKey: "control", evidenceKeys: ["stale-control-review"] }];
    expect(() => compileSafetyScoreV9FactSetFromFixedInput(fixed, staleKnown)).toThrow(/cannot be known with stale/);
  });

  it("exports stable reserve exposure identities for exact overlay joins", () => {
    const slice = exactFixedInput().liveReserveMap.alpha![0]!;
    expect(computeSafetyScoreV9ReserveExposureKey(slice)).toMatch(/^reserve:[a-f0-9]{24}$/);
    expect(computeSafetyScoreV9ReserveExposureKey({ ...slice, pct: 50 })).toBe(
      computeSafetyScoreV9ReserveExposureKey(slice),
    );
  });
});
