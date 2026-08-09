/**
 * Shared Safety Score V9 fixed-input / extension fixture builders.
 *
 * Extracted from the builder prologue that `safety-score-v9-fact-set.test.ts`
 * grew and four other suites re-authored line for line. Defaults reproduce the
 * fact-set prologue byte for byte; every divergence the other suites relied on
 * is an explicit option so no caller has to fork the builder again.
 */
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { ReserveSlice } from "@shared/types/reserves";
import type { V9FactStatusV2 } from "@shared/types/safety-score-v9-facts";
import {
  computeReportCardsRegistryFingerprint,
  createReportCardsFixedInput,
  normalizeFixedInput,
  type ReportCardsFixedInputDraft,
} from "../lib/report-cards-fixed-input";
import type { SafetyScoreV9FactSetExtensionV2 } from "../lib/safety-score-v9-fact-set";
import {
  buildReviewedDeploymentRouteInventory,
  deriveReviewedDeploymentUnitPartition,
  expectedWmDeploymentIdentity,
  type ReviewedDeploymentSupplyObservation,
} from "../lib/safety-score-v9-supply-attribution-contract";

/** Shared timeout for the V9 evaluation suites; a full candidate build is slow. */
export const V9_EVALUATION_TEST_TIMEOUT_MS = 30_000;

/**
 * Synthetic epoch used by the general-purpose V9 fixtures. It is deliberately
 * far below any real reviewed-registry date, so it never needs re-pinning; the
 * suites that must sit *after* the newest registry review use
 * `v9TestClockSec()` instead.
 */
export const V9_FIXTURE_CLOCK_SEC = 10_000;
export const V9_FIXTURE_OBSERVED_AT_SEC = V9_FIXTURE_CLOCK_SEC - 100;

const DAY_SEC = 86_400;

/**
 * The derived clock at the time this helper was written (2026-08-10T00:00:00Z:
 * the 2026-08-09 xaut-tether mechanism-archetype review plus one day). Reviews
 * only ever move forward, so a derived clock below this floor means the coin
 * registry lost review dates — fail loudly instead of silently relaxing the
 * freshness gates every V9 suite depends on.
 */
export const V9_TEST_CLOCK_FLOOR_SEC = 1_786_320_000;

const REVIEW_DATE_KEYS = new Set(["reviewedAt", "compositionAsOf"]);

function collectReviewDateSecs(value: unknown, into: number[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectReviewDateSecs(entry, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (REVIEW_DATE_KEYS.has(key) && typeof child === "string") {
      const parsed = Date.parse(child);
      if (Number.isFinite(parsed)) into.push(Math.floor(parsed / 1_000));
    }
    collectReviewDateSecs(child, into);
  }
}

/** Latest `reviewedAt` / `compositionAsOf` second recorded on one coin's registry entry. */
export function v9CoinMaxReviewedAtSec(coinId: string): number {
  const coin = ACTIVE_STABLECOINS.find((entry) => entry.id === coinId);
  if (coin === undefined) throw new Error(`v9CoinMaxReviewedAtSec: ${coinId} is not an active stablecoin`);
  const seconds: number[] = [];
  collectReviewDateSecs(coin, seconds);
  if (seconds.length === 0) throw new Error(`v9CoinMaxReviewedAtSec: ${coinId} has no review dates`);
  return Math.max(...seconds);
}

let cachedRegistryReviewMaxSec: number | null = null;

/**
 * A scoring clock that always sits one day past the newest reviewed date in the
 * tracked coin registry. Replaces the hand-pinned absolute clocks that had to be
 * bumped every time a curation pass moved a review forward — the V9 producer
 * rejects a `reviewedAt` later than the scoring clock, so those literals went
 * stale on every authoring pass.
 */
export function v9TestClockSec(): number {
  if (cachedRegistryReviewMaxSec === null) {
    const seconds: number[] = [];
    collectReviewDateSecs(ACTIVE_STABLECOINS, seconds);
    if (seconds.length === 0) {
      throw new Error("v9TestClockSec: no reviewedAt/compositionAsOf dates found in the coin registry");
    }
    cachedRegistryReviewMaxSec = Math.max(...seconds);
  }
  const clockSec = cachedRegistryReviewMaxSec + DAY_SEC;
  if (clockSec < V9_TEST_CLOCK_FLOOR_SEC) {
    throw new Error(
      `v9TestClockSec: derived clock ${clockSec} went backwards past the ${V9_TEST_CLOCK_FLOOR_SEC} floor`,
    );
  }
  return clockSec;
}

// --------------------------------------------------------------------------
// Fact-status fixtures
// --------------------------------------------------------------------------

/** A `required` fact status with placeholder evidence/gap refs. */
export function v9Status(
  observationState: "known" | "missing" = "known",
  policyRuleId = "fixture.review",
  refs: { evidenceRefId?: string; gapId?: string } = {},
): V9FactStatusV2 {
  const evidenceRefId = refs.evidenceRefId ?? "placeholder:evidence";
  const gapId = refs.gapId ?? "placeholder:gap";
  return {
    applicability: { state: "required", policyRuleId, rationale: null, gapId: null },
    observationState,
    evidenceRefIds: observationState === "known" ? [evidenceRefId] : [],
    gapIds: observationState === "known" ? [] : [gapId],
  };
}

/** A reviewed `not-applicable` fact status. */
export function v9NotApplicableStatus(
  policyRuleId: string,
  options: { rationale?: string; evidenceRefIds?: readonly string[] } = {},
): V9FactStatusV2 {
  return {
    applicability: {
      state: "not-applicable",
      policyRuleId,
      rationale: options.rationale ?? "Reviewed as not applicable for the fixture.",
      gapId: null,
    },
    observationState: "known",
    evidenceRefIds: [...(options.evidenceRefIds ?? ["placeholder:evidence"])],
    gapIds: [],
  };
}

// --------------------------------------------------------------------------
// Route / review fixtures
// --------------------------------------------------------------------------

/** A measured DEX exit-route observation. */
export function v9ExitRouteObservation(
  routeId = "dex:primary",
  observedAt = V9_FIXTURE_OBSERVED_AT_SEC,
  chain = "ethereum",
  clockSec = V9_FIXTURE_CLOCK_SEC,
  contractOrPoolId = routeId,
): ExitRouteObservation {
  return {
    routeId,
    routeFamily: "dex-amm",
    scope: { kind: "chain-contract", chain, contractOrPoolId, protocol: "fixture-dex" },
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

/** A strong three-component fiat-cash mechanism review. */
export function v9MechanismReview() {
  const component = {
    status: v9Status(),
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

/** A reviewed bounded DEX route review matching `v9ExitRouteObservation`. */
export function v9RouteReview(routeId = "dex:primary", observedAt = V9_FIXTURE_OBSERVED_AT_SEC) {
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

// --------------------------------------------------------------------------
// Fixed input
// --------------------------------------------------------------------------

type FixedDexRow = ReportCardsFixedInputDraft["dexLiqMap"][string];

export interface V9FixedInputOptions {
  assetId?: string;
  clockSec?: number;
  /** Identity strings the V9 suites vary to keep independent captures distinct. */
  sourceGeneration?: string;
  registryRevision?: string;
  // DEX row
  liquidityScore?: number;
  routeChain?: string;
  routeContractOrPoolId?: string;
  includeDexObservations?: boolean;
  includeDexCoverage?: boolean;
  dexCapabilityMatrixVersion?: string;
  dexMethodologyVersion?: string;
  dexOverrides?: Partial<FixedDexRow>;
  // Peg row
  omitPegRow?: boolean;
  pegMethodologyVersion?: string;
  pegScore?: number | null;
  currentDeviationBps?: number | null;
  depegEventCoverageLimited?: boolean;
  pegPct?: number;
  severityScore?: number;
  spreadPenalty?: number;
  eventCount?: number;
  worstDeviationBps?: number | null;
  pegObservedAtSec?: number;
  activeDepeg?: boolean;
  lastEventAt?: number | null;
  activeDepegPeakBps?: number;
  // Reserves
  classifiedReserve?: boolean;
  omitLiveReserve?: boolean;
  reserves?: readonly ReserveSlice[];
  // Supply
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
}

/** Drop `undefined`-valued keys so optional knobs never widen the canonical payload. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * The exact-publication fixed input every V9 suite replays. Defaults reproduce
 * a single-asset `alpha` capture with one measured DEX route and a fully
 * classified cash reserve.
 */
export function makeV9FixedInput(options: V9FixedInputOptions = {}) {
  const assetId = options.assetId ?? "alpha";
  const clockSec = options.clockSec ?? V9_FIXTURE_CLOCK_SEC;
  const observedAtSec = clockSec - 100;
  const reserve = {
    name: "Custodied cash",
    pct: 100,
    risk: "very-low" as const,
    ...(options.classifiedReserve === false
      ? {}
      : {
          assetClass: "cash" as const,
          issuerOrObligor: `issuer:${assetId}`,
          riskFactors: ["custody" as const, "counterparty" as const],
          liquidityHorizon: "immediate" as const,
          maturityDaysMax: 0,
        }),
  };
  const reserves = options.reserves ?? [reserve];
  const dexRow = {
    liquidityScore: options.liquidityScore ?? 12,
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
    exitRouteObservations:
      options.includeDexObservations === false
        ? []
        : [
            v9ExitRouteObservation(
              "dex:primary",
              observedAtSec,
              options.routeChain ?? "ethereum",
              clockSec,
              options.routeContractOrPoolId ?? "dex:primary",
            ),
          ],
    ...(options.includeDexCoverage === false
      ? {}
      : {
          exitRouteObservationCoverage: {
            status: "populated",
            capabilityMatrixVersion: options.dexCapabilityMatrixVersion ?? "p4a.8",
            retainedPoolCount: 1,
            observationCount: 1,
            scoreEligibleObservationCount: 1,
            scoreEligiblePoolCount: 1,
            scoreEligibleCapabilityPoolCount: 1,
            unsupportedPoolCount: 0,
            evidenceCounts: { "reserve-based-amm-simulation": 1 },
            unsupportedReasons: {},
          },
        }),
    methodologyVersion: options.dexMethodologyVersion ?? "dex:fixture-v1",
    updatedAt: observedAtSec,
  } as FixedDexRow;
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: [assetId],
    capturedAt: "2026-07-13T00:00:00.000Z",
    sourceGeneration: options.sourceGeneration ?? `report-cards:fixture:${V9_FIXTURE_CLOCK_SEC}`,
    dexGenerationId: `dex-liquidity-${observedAtSec}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: options.registryRevision ?? "registry:fixture",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec,
    updatedAt: clockSec,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: observedAtSec, ageSeconds: clockSec - observedAtSec, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: options.omitPegRow
      ? {}
      : {
          [assetId]: {
            id: assetId,
            symbol: "ALPHA",
            name: "Alpha",
            pegType: "peggedUSD",
            pegCurrency: "USD",
            governance: "centralized",
            currentDeviationBps: options.currentDeviationBps === undefined ? 1 : options.currentDeviationBps,
            ...(options.depegEventCoverageLimited === undefined
              ? {}
              : { depegEventCoverageLimited: options.depegEventCoverageLimited }),
            pegScore: options.pegScore === undefined ? 99 : options.pegScore,
            priceSource: "fixture-price",
            priceObservedAt: options.pegObservedAtSec ?? observedAtSec,
            pegPct: options.pegPct ?? 99,
            severityScore: options.severityScore ?? 0,
            spreadPenalty: options.spreadPenalty ?? 0,
            eventCount: options.eventCount ?? 0,
            worstDeviationBps: options.worstDeviationBps === undefined ? 1 : options.worstDeviationBps,
            activeDepeg: options.activeDepeg ?? false,
            lastEventAt: options.lastEventAt === undefined ? null : options.lastEventAt,
            trackingSpanDays: 365,
            methodologyVersion: options.pegMethodologyVersion ?? "peg:fixture-v1",
          },
        },
    activeDepegPeakBpsById:
      options.activeDepegPeakBps === undefined ? {} : { [assetId]: options.activeDepegPeakBps },
    dexLiqMap: { [assetId]: compact({ ...dexRow, ...options.dexOverrides }) },
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: { [assetId]: false },
    liveReserveMap: options.omitLiveReserve ? {} : { [assetId]: [...reserves] },
    liveReserveProvenanceMap: options.omitLiveReserve
      ? {}
      : {
          [assetId]: { source: "fixture-reserve-api", fetchedAt: observedAtSec },
        },
    chainCirculatingById: {
      [assetId]: options.chainSupplyByChain ?? {
        ethereum: {
          current: 10_000_000,
          circulatingPrevDay: 10_000_000,
          circulatingPrevWeek: 10_000_000,
          circulatingPrevMonth: 10_000_000,
        },
      },
    },
    ...(options.aggregateCirculating
      ? {
          aggregateCirculatingById: {
            [assetId]: {
              circulating: options.aggregateCirculating,
              observedAtSec:
                options.supplyObservedAtSec === undefined ? observedAtSec : options.supplyObservedAtSec,
            },
          },
        }
      : {}),
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

export type V9FixedInput = ReturnType<typeof makeV9FixedInput>;

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

/** `alpha` plus a `beta` clone, optionally mapping alpha's reserves onto beta. */
export function makeV9TwoAssetFixedInput(
  options: {
    mapAlphaCollateral?: boolean;
    omitAlphaReserve?: boolean;
    /** Assets that declare a live-reserve adapter but published no snapshot this run. */
    liveToFallbackCoins?: string[];
  } = {},
) {
  const alpha = makeV9FixedInput();
  const alphaDex = alpha.dexLiqMap.alpha!;
  const alphaPeg = alpha.pegDataById.alpha!;
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
        exitRouteObservations: [v9ExitRouteObservation("dex:beta")],
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
export const V9_REGISTRY_FIXTURE_CLOCK_SEC = 1_783_891_200;
export const V9_REGISTRY_FIXTURE_DEX_UPDATED_AT_SEC = V9_REGISTRY_FIXTURE_CLOCK_SEC - 100;

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
export function makeV9BoundedUnknownFeeRedemptionFixedInput() {
  const assetId = "usdc-circle";
  const base = makeV9FixedInput({ assetId });
  const redemption: RedemptionBackstopEntry = {
    stablecoinId: "usdc-circle",
    score: null,
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
    updatedAt: V9_FIXTURE_OBSERVED_AT_SEC,
    docs: {
      label: "Fixture redemption terms",
      url: "https://example.com/redemption",
      reviewedAt: "1970-01-01",
    },
  };
  return resealSingleAsset(base, {
    redemptionGenerationId: "redemption:bounded-unknown-fee",
    redemptionBackstopMap: { [assetId]: redemption },
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

// --------------------------------------------------------------------------
// Extension
// --------------------------------------------------------------------------

/** The reviewed V2 extension that pairs with `makeV9FixedInput()`. */
export function makeV9Extension(
  options: {
    assetId?: string;
    clockSec?: number;
    observedAtSec?: number;
    registryFingerprint?: string;
  } = {},
): SafetyScoreV9FactSetExtensionV2 {
  const assetId = options.assetId ?? "alpha";
  const clockSec = options.clockSec ?? V9_FIXTURE_CLOCK_SEC;
  const observedAtSec = options.observedAtSec ?? clockSec - 100;
  return {
    schemaVersion: 2,
    registryFingerprint: options.registryFingerprint ?? computeReportCardsRegistryFingerprint(),
    compiledAtSec: clockSec + 1,
    sources: {
      registryObservedAtSec: observedAtSec,
      unavailableRedemptionObservedAtSec: observedAtSec,
      liveReserves: { generationId: "reserves:fixture-v1", observedAtSec, maxAgeSec: 500 },
      chainSupply: { generationId: "supply:fixture-v1", observedAtSec, maxAgeSec: 500 },
      peg: { generationId: "peg:fixture-v1", observedAtSec, maxAgeSec: 500 },
      researchOverlays: { generationId: "research:fixture-v1", observedAtSec, maxAgeSec: 500 },
    },
    routeFreshness: { dexMaxAgeSec: 500, redemptionMaxAgeSec: 500, documentedTermsMaxAgeSec: 31_536_000 },
    assets: [
      {
        assetId,
        archetype: "fiat-cash",
        launchedAtSec: 1_000,
        mechanismRiskReview: v9MechanismReview(),
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
        routeReviews: [v9RouteReview("dex:primary", observedAtSec)],
        retainedRoutes: [],
        controlReview: {
          state: "no-privileged-controls",
          rationale: "The reviewed fixture implementation has no privileged deployment controls.",
        },
        economicControlReview: {
          mint: {
            status: v9NotApplicableStatus("v9.control.mint-review"),
            controlKey: null,
            reconciliation: "not-applicable",
            supervision: "unknown",
            latestResolvedIncidentAtSec: null,
            upgrade: { state: "not-applicable", controlKey: null },
          },
          oracle: {
            status: v9NotApplicableStatus("v9.control.oracle-review"),
            tier: null,
            branches: [],
          },
          bridge: {
            status: v9NotApplicableStatus("v9.control.bridge-review"),
            routes: [],
          },
        },
        accessReview: {
          transfer: { status: v9Status("known", "v9.access.transfer-review"), posture: "permissionless" },
          freeze: {
            status: v9Status("known", "v9.access.freeze-review"),
            reviews: [
              {
                reviewKey: "freeze:none-reviewed",
                source: "blacklist",
                status: v9Status("known", "v9.access.freeze-review"),
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

export type V9ExtensionDependencyEdge = NonNullable<
  SafetyScoreV9FactSetExtensionV2["assets"][number]["dependencies"]
>["edges"][number];

/** Fan `makeV9Extension()` across a multi-asset capture, wiring reviewed roles. */
export function makeV9RoleExtension(
  fixed: { registryFingerprint: string; activeAssetIds: readonly string[] },
  edgesByAssetId: Readonly<Record<string, readonly V9ExtensionDependencyEdge[]>>,
  observedAtSec = V9_FIXTURE_OBSERVED_AT_SEC,
): SafetyScoreV9FactSetExtensionV2 {
  const base = makeV9Extension();
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
        routeReviews: [v9RouteReview(assetId === "alpha" ? "dex:primary" : `dex:${assetId}`)],
        researchEvidence: hasDependencyEvidence
          ? [
              {
                evidenceKey: `dependencies:${assetId}`,
                sourceId: "fixture.role-dependencies",
                observedAtSec,
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

/** A reviewed dependency edge carrying one economic role. */
export function v9ExtensionRoleEdge(
  upstreamAssetId: string,
  economicRole: "exit-dependency" | "control-operator" | "oracle-nav",
  weight = 1,
): V9ExtensionDependencyEdge {
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
