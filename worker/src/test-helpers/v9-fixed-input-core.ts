import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import type { ReserveSlice } from "@shared/types/reserves";
import type { V9FactStatusV2 } from "@shared/types/safety-score-v9-facts";
import { createReportCardsFixedInput, type ReportCardsFixedInputDraft } from "../lib/report-cards-fixed-input";
import { V9_FIXTURE_CLOCK_SEC, V9_FIXTURE_OBSERVED_AT_SEC } from "./v9-fixed-input-observations";

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
            capabilityMatrixVersion: options.dexCapabilityMatrixVersion ?? "p4a.9",
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
