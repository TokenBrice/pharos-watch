import { SAME_NOTIONAL_EXIT_REQUEST_POLICY } from "@shared/lib/redemption-backstop-scoring";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ExitRouteCapacityPoint, ExitRouteObservation, ExitRouteOutput } from "@shared/types/market";
import type {
  RedemptionBackstopEntry,
  RedemptionCapacityProfile,
  RedemptionLiveCapacityKind,
  RedemptionLiveFreshnessKind,
} from "@shared/types/redemption";

const REDEMPTION_CAPACITY_CURVE_REQUESTS_USD = [100_000, 1_000_000, 5_000_000, 25_000_000] as const;

interface BuildRedemptionExitRouteObservationInput {
  stablecoinId: string;
  config: RedemptionBackstopConfig;
  capacityProfile: RedemptionCapacityProfile | undefined;
  scoringCapacityUsd: number | null;
  supplyUsd: number | null;
  routeStatus: RedemptionBackstopEntry["routeStatus"];
  resolutionState: RedemptionBackstopEntry["resolutionState"];
  sourceMode: RedemptionBackstopEntry["sourceMode"];
  capacityConfidence: RedemptionBackstopEntry["capacityConfidence"];
  capacityKind?: RedemptionLiveCapacityKind;
  freshnessKind?: RedemptionLiveFreshnessKind;
  sourceTimestamp?: number;
  resolvedFeeBps: number | null;
  now: number;
}

function reviewedAtSec(reviewedAt: string | undefined): number | null {
  if (!reviewedAt) return null;
  const timestamp = Date.parse(`${reviewedAt}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : null;
}

function resolveRouteEvidence(input: BuildRedemptionExitRouteObservationInput): {
  evidenceKind: ExitRouteObservation["evidenceKind"];
  confidence: ExitRouteObservation["confidence"];
  observedAt: number;
  supportsScoring: boolean;
} {
  const liveDirect = input.capacityKind === "live-direct" || input.capacityKind === "live-direct-bounded";
  const directFreshness =
    input.freshnessKind === "verified-source-timestamp" ||
    input.freshnessKind === "same-run-onchain" ||
    input.freshnessKind === "same-run-api";
  if (liveDirect && input.sourceMode === "dynamic" && directFreshness) {
    return {
      evidenceKind: input.freshnessKind === "same-run-onchain" ? "onchain-contract-state" : "live-reserve-state",
      confidence: "high",
      observedAt: input.sourceTimestamp ?? input.now,
      supportsScoring: true,
    };
  }

  const reviewTimestamp = reviewedAtSec(input.config.reviewedAt);
  const hasReviewedTerms = reviewTimestamp != null && (input.config.docs?.length ?? 0) > 0;
  if (input.capacityConfidence === "documented-bound" && hasReviewedTerms) {
    return {
      evidenceKind: "documented-terms",
      confidence: "medium",
      observedAt: reviewTimestamp,
      supportsScoring: true,
    };
  }

  return {
    evidenceKind: hasReviewedTerms ? "documented-terms" : "manual-review",
    confidence: input.capacityConfidence === "heuristic" ? "low" : "unknown",
    observedAt: reviewTimestamp ?? input.sourceTimestamp ?? input.now,
    supportsScoring: false,
  };
}

function resolveOutput(stablecoinId: string, config: RedemptionBackstopConfig): ExitRouteOutput {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (config.routeFamily === "offchain-issuer") {
    return { kind: "fiat", ...(meta?.flags.pegCurrency ? { currency: meta.flags.pegCurrency } : {}) };
  }
  if (config.outputAssetType === "stable-single") {
    const parentId = meta?.variantOf;
    return parentId ? { kind: "tracked-stablecoin", trackedAssetIds: [parentId] } : { kind: "unresolved-asset" };
  }
  if (config.outputAssetType === "stable-basket") return { kind: "unresolved-basket" };
  if (config.outputAssetType === "bluechip-collateral" || config.outputAssetType === "mixed-collateral") {
    return { kind: "collateral" };
  }
  return { kind: "unresolved-asset" };
}

function resolveCostBps(
  config: RedemptionBackstopConfig,
  resolvedFeeBps: number | null,
  requestedNotionalUsd: number,
): number | null {
  const cost = config.costModel;
  const variableFeeBps =
    cost.stressFeeBps ??
    cost.feeBpsMax ??
    resolvedFeeBps ??
    (cost.kind === "fee-bps" ? cost.feeBps : (cost.feeBpsMin ?? null));
  const fixedCostUsd = (cost.flatFeeUsd ?? 0) + (cost.gasOrBridgeCostUsd ?? 0);
  if (variableFeeBps == null && fixedCostUsd === 0 && cost.minFeeUsd == null) return null;
  const variableFeeUsd = Math.max(((variableFeeBps ?? 0) * requestedNotionalUsd) / 10_000, cost.minFeeUsd ?? 0);
  return ((variableFeeUsd + fixedCostUsd) / requestedNotionalUsd) * 10_000;
}

function buildCapacityPoint(
  requestedNotionalUsd: number,
  scoringCapacityUsd: number,
  config: RedemptionBackstopConfig,
  resolvedFeeBps: number | null,
): ExitRouteCapacityPoint {
  const costBps = resolveCostBps(config, resolvedFeeBps, requestedNotionalUsd);
  const executableUsd =
    costBps != null && costBps <= SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps
      ? Math.min(requestedNotionalUsd, scoringCapacityUsd)
      : 0;
  return {
    requestedNotionalUsd,
    maxCostBps: SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps,
    executableUsd,
    completionRatio: executableUsd / requestedNotionalUsd,
  };
}

/**
 * Projects an existing reviewed redemption capacity into P4's common request.
 * Eventual, daily, queued, stale, or cost-unbounded evidence remains visible
 * through the legacy profile but is intentionally not published as immediate
 * score-eligible capacity.
 */
export function buildRedemptionExitRouteObservation(
  input: BuildRedemptionExitRouteObservationInput,
): ExitRouteObservation | null {
  const modeledExitSizeUsd = input.capacityProfile?.modeledExitSizeUsd;
  if (
    !input.capacityProfile ||
    modeledExitSizeUsd == null ||
    !Number.isFinite(modeledExitSizeUsd) ||
    modeledExitSizeUsd <= 0 ||
    input.scoringCapacityUsd == null ||
    !Number.isFinite(input.scoringCapacityUsd) ||
    input.scoringCapacityUsd < 0
  ) {
    return null;
  }

  const evidence = resolveRouteEvidence(input);
  const routeIsImmediate =
    input.capacityProfile.scoringHorizon === "immediate" &&
    (input.config.settlementModel === "atomic" || input.config.settlementModel === "immediate");
  const mainCostBps = resolveCostBps(input.config, input.resolvedFeeBps, modeledExitSizeUsd);
  const scoreEligible =
    input.resolutionState === "resolved" &&
    input.routeStatus === "open" &&
    routeIsImmediate &&
    evidence.supportsScoring &&
    mainCostBps != null &&
    mainCostBps <= SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps;
  const maxCurveRequest = input.supplyUsd != null && input.supplyUsd > 0 ? input.supplyUsd : modeledExitSizeUsd;
  const requests = [...new Set([...REDEMPTION_CAPACITY_CURVE_REQUESTS_USD, modeledExitSizeUsd])]
    .filter((request) => request <= Math.max(modeledExitSizeUsd, maxCurveRequest))
    .sort((left, right) => left - right);
  const capacityCurve = requests.map((request) =>
    buildCapacityPoint(request, input.scoringCapacityUsd!, input.config, input.resolvedFeeBps),
  );
  const point = capacityCurve.find((candidate) => candidate.requestedNotionalUsd === modeledExitSizeUsd)!;
  const meta = TRACKED_META_BY_ID.get(input.stablecoinId);
  const chain = meta?.contracts?.length === 1 ? meta.contracts[0]!.chain : undefined;
  const commonModeKeys = [
    input.config.routeFamily === "offchain-issuer"
      ? `issuer:${input.stablecoinId}`
      : `protocol:${meta?.protocolSlug ?? input.stablecoinId}`,
    ...(meta?.variantOf ? [`parent:${meta.variantOf}`] : []),
    ...(chain ? [`chain:${chain}`] : []),
  ];

  return {
    routeId: `redemption:${input.stablecoinId}:${input.config.routeFamily}`,
    routeFamily: input.config.routeFamily === "offchain-issuer" ? "issuer-redemption" : "protocol-redemption",
    scope:
      input.config.routeFamily === "offchain-issuer"
        ? { kind: "issuer", issuerId: input.stablecoinId }
        : { kind: "protocol", protocol: meta?.protocolSlug ?? input.stablecoinId, ...(chain ? { chain } : {}) },
    ...point,
    settlementHorizonSec: SAME_NOTIONAL_EXIT_REQUEST_POLICY.settlementHorizonSec,
    output: resolveOutput(input.stablecoinId, input.config),
    evidenceKind: evidence.evidenceKind,
    confidence: evidence.confidence,
    scoreEligible,
    observedAt: evidence.observedAt,
    freshnessSeconds: Math.max(0, input.now - evidence.observedAt),
    commonModeKeys,
    capacityCurve,
  };
}
