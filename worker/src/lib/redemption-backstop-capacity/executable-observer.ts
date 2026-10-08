import type { RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import { REDEMPTION_BACKSTOP_PROVIDER_IDS } from "@shared/lib/redemption-backstop-providers";
import { SAME_NOTIONAL_EXIT_REQUEST_POLICY } from "@shared/lib/redemption-backstop-scoring";
import { EXECUTABLE_REDEMPTION_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/redemption-backstop-capacity";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";
import { STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { getExecutableRedemptionObserver } from "../../cron/reserve-adapters/executable-redemption-observers";
import { decimalNumberFromBigInt } from "../../cron/reserve-adapters/helpers";
import { buildBoundedCapacityFields, type CapacityResolution, type CapacityResolverContext } from "./profile";

/** Admit native output evidence before any USD arithmetic. No static fallback exists. */
export function resolveExecutableObserverCapacity(
  model: Extract<RedemptionCapacityModel, { kind: "executable-observer" }>,
  context: CapacityResolverContext,
): CapacityResolution {
  const descriptor = getExecutableRedemptionObserver(model.observerId);
  const observation = context.options.executableRedemptionObservation;
  const missing: CapacityResolution = {
    immediateCapacityUsd: null, immediateCapacityRatio: null,
    scoringCapacityUsd: null, scoringCapacityRatio: null,
    eventualCapacityUsd: null, eventualCapacityRatio: null,
    capacityProfile: {
      immediateUsd: null, eventualUsd: null, scoringUsd: null,
      scoringHorizon: "unknown", capacityProfileConfidence: "heuristic",
    },
    provider: REDEMPTION_BACKSTOP_PROVIDER_IDS.EXECUTABLE_OBSERVER,
    sourceMode: "dynamic", resolutionState: "missing-capacity",
    capacityConfidence: "heuristic",
    capacitySemantics: model.capacityUse === "diagnostic-only" ? "eventual-only" : "immediate-bounded",
    capacityRejectionReason: "redeemable-capacity-unobserved",
    notes: ["redemption-capacity-unquantified"],
  };
  if (!descriptor || descriptor.coinId !== context.stablecoinId || descriptor.sourceLane !== "direct" || !observation) return missing;
  const required = model.requiredOutputAssetKeys;
  const outputBound = required.length === descriptor.outputAssetKeys.length &&
    required.every((key) => descriptor.outputAssetKeys.includes(key)) &&
    required.length === observation.outputAssetKeys.length &&
    required.every((key) => observation.outputAssetKeys.includes(key));
  if (!outputBound) return { ...missing, capacityRejectionReason: "route-output-identity-unobserved", notes: ["route-output-identity-unobserved"] };
  if (!Number.isSafeInteger(observation.blockNumber) || observation.blockNumber <= 0) return { ...missing, capacityRejectionReason: "missing-block-number" };
  if (!Number.isSafeInteger(observation.sourceTimestamp) || observation.sourceTimestamp <= 0) return { ...missing, capacityRejectionReason: "missing-source-timestamp" };
  if (observation.sourceTimestamp > context.now + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) return { ...missing, capacityRejectionReason: "future-source-timestamp" };
  if (observation.sourceTimestamp < context.now - EXECUTABLE_REDEMPTION_OBSERVATION_MAX_AGE_SEC) return { ...missing, capacityRejectionReason: "stale-source-timestamp" };
  const facts: CapacityResolution = {
    ...missing,
    sourceTimestamp: observation.sourceTimestamp, evidenceObservedAt: observation.sourceTimestamp,
    sourceUrls: observation.sourceUrls, freshnessKind: observation.freshnessKind,
    routeStatus: observation.routeStatus, routeStatusSource: observation.routeStatusSource,
    routeStatusReason: observation.routeStatusReason, liveHolderEligibility: observation.holderEligibility,
    ...(observation.settlementBoundUnproven ? {
      settlementBoundUnproven: true,
      capacityProfile: { ...missing.capacityProfile!, settlementBoundUnproven: true },
    } : {}),
    ...(observation.settlementDelaySec != null ? { settlementDelaySec: observation.settlementDelaySec } : {}),
  };
  if (model.capacityUse === "diagnostic-only" || descriptor.capacityCapability !== "measured" || observation.capacityState === "unquantified") return facts;
  if (observation.settlementBoundUnproven || observation.settlementDelaySec == null ||
      !Number.isFinite(observation.settlementDelaySec) || observation.settlementDelaySec < 0) {
    return { ...facts, capacityRejectionReason: "settlement-bound-unproven" };
  }
  const valuation = context.options.executableObserverValuation;
  if (required.length !== 1 || !valuation || valuation.outputAssetKey !== required[0] ||
      !Number.isFinite(valuation.priceUsd) || valuation.priceUsd <= 0 ||
      !Number.isSafeInteger(valuation.observedAt) || valuation.observedAt <= 0 ||
      valuation.observedAt > context.now || context.now - valuation.observedAt > STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC) {
    return { ...facts, capacityRejectionReason: "output-valuation-unobserved", notes: ["output-valuation-unobserved"] };
  }
  if (observation.allInFeeBps == null || !Number.isFinite(observation.allInFeeBps) ||
      observation.allInFeeBps < 0 || observation.allInFeeBps > 10_000) {
    return { ...facts, capacityRejectionReason: "all-in-cost-unobserved", notes: ["all-in-cost-unobserved"] };
  }
  if (observation.capacityRaw < 0n || !Number.isInteger(observation.underlyingDecimals) ||
      observation.underlyingDecimals < 0 || observation.underlyingDecimals > 36 ||
      (observation.capacityState === "closed" && observation.capacityRaw !== 0n)) return facts;
  const rawCapacityUsd = decimalNumberFromBigInt(observation.capacityRaw, observation.underlyingDecimals) * valuation.priceUsd;
  if (!Number.isFinite(rawCapacityUsd) || rawCapacityUsd < 0) return facts;
  if (observation.settlementDelaySec > SAME_NOTIONAL_EXIT_REQUEST_POLICY.settlementHorizonSec) {
    const bounded = buildBoundedCapacityFields({ rawCapacityUsd, supplyUsd: context.supplyUsd,
      capacityProfileConfidence: "documented-bound", applyDailyLimit: false });
    return {
      ...facts,
      eventualCapacityUsd: bounded.immediateCapacityUsd,
      eventualCapacityRatio: bounded.immediateCapacityRatio,
      capacityConfidence: "documented-bound", capacityKind: "documented-bound",
      capacitySemantics: "eventual-only", capacityRejectionReason: undefined,
      resolutionState: "resolved", capacityBasis: "live-direct-telemetry",
      capacityProfile: {
        immediateUsd: null, scoringUsd: null, eventualUsd: bounded.immediateCapacityUsd,
        scoringHorizon: "queued", capacityProfileConfidence: "documented-bound",
      },
      notes: [],
    };
  }
  return {
    ...facts,
    ...buildBoundedCapacityFields({ rawCapacityUsd, supplyUsd: context.supplyUsd,
      capacityProfileConfidence: "live-direct", applyDailyLimit: false }),
    capacityConfidence: "live-direct", capacityBasis: "live-direct-telemetry",
    capacityKind: observation.capacityKind, capacityRejectionReason: undefined,
    resolutionState: "resolved", notes: [],
  };
}
