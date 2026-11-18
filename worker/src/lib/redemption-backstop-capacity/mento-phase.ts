import { HOUR_SECONDS } from "@shared/lib/time-constants";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../live-reserve-policy";
import {
  resolveMentoFxMarketReopen,
  resolveStablecoinScheduledPriceClosures,
  STABLECOIN_MARKET_HOURS_CALENDARS,
} from "../stablecoin-publication-coverage";

export const mentoReview = STABLECOIN_MARKET_HOURS_CALENDARS.find(({ calendarId }) => calendarId === "mento-fx");
export const mentoFpmmIds = new Set<string>(mentoReview?.assets.filter(({ lane }) => lane === "mento-fpmm").map(({ stablecoinId }) => stablecoinId));

export function nextMentoHour(now: number): number {
  return (Math.floor(now / HOUR_SECONDS) + 1) * HOUR_SECONDS;
}

type PhaseField = "sourceTimestamp" | "freshnessKind" | "routeStatus" | "routeStatusSource" | "capacityKind" | "settlementDelaySec";

/** Reserve packets date the delay to the source block. Stored scores date it to their assessment. */
export function resolveMentoFpmmDelay(
  stablecoinId: string,
  evidence: { [K in PhaseField]?: RedemptionBackstopEntry[K] | null },
  delayAsOf: number | null | undefined,
  now: number,
  observedCapacityUsd: number | null,
): number | null {
  const observedAt = evidence.sourceTimestamp;
  if (observedAt == null || !Number.isSafeInteger(observedAt) || observedAt <= 0 ||
      delayAsOf == null || !Number.isSafeInteger(delayAsOf) || observedAt > delayAsOf || delayAsOf > now ||
      now - observedAt > LIVE_RESERVE_FRESHNESS_SEC ||
      evidence.freshnessKind !== "same-run-onchain" || evidence.routeStatusSource !== "onchain") return null;
  if (evidence.routeStatus === "paused") return observedCapacityUsd === 0 ? 0 : null;
  if (evidence.routeStatus !== "open") return null;

  const reopening = resolveMentoFxMarketReopen(now);
  const observedReopening = resolveMentoFxMarketReopen(observedAt);
  if (reopening != null) {
    if (observedReopening !== reopening || resolveMentoFxMarketReopen(delayAsOf) !== reopening ||
        evidence.capacityKind !== "documented-bound" || evidence.settlementDelaySec !== reopening - delayAsOf) return null;
    const reviewed = [observedAt, now].every(at =>
      resolveStablecoinScheduledPriceClosures([stablecoinId], at).get(stablecoinId)?.lane === "mento-fpmm");
    return reviewed ? reopening - now : null;
  }

  if (observedReopening != null || evidence.capacityKind !== "live-direct-bounded" ||
      evidence.settlementDelaySec !== 0) return null;
  for (let hour = nextMentoHour(observedAt); hour <= now; hour += HOUR_SECONDS) {
    if (resolveMentoFxMarketReopen(hour) != null) return null;
  }
  return 0;
}

export function projectMentoMarketPhase(
  entry: RedemptionBackstopEntry,
  now: number,
  delayClock: "current" | "stored" = "current",
): RedemptionBackstopEntry {
  if (!mentoFpmmIds.has(entry.stablecoinId)) return entry;
  const delay = resolveMentoFpmmDelay(entry.stablecoinId, entry, entry.updatedAt, now, entry.immediateCapacityUsd);
  if (delay != null) {
    // Immutable rows date the countdown to updatedAt. Readers project the remaining delay.
    return delayClock === "stored" || delay === entry.settlementDelaySec ? entry : { ...entry, settlementDelaySec: delay };
  }

  return withholdMentoMarketPhase(entry);
}

export function withholdMentoMarketPhase(entry: RedemptionBackstopEntry): RedemptionBackstopEntry {
  if (entry.resolutionState !== "resolved" && !entry.capacityProfile && entry.routeStatus === "unknown") return entry;
  return {
    ...entry,
    score: null,
    effectiveExitScore: null,
    capacityScore: null,
    eventualRedeemabilityScore: null,
    immediateCapacityUsd: null,
    immediateCapacityRatio: null,
    capacityProfile: undefined,
    capacityKind: undefined,
    capacityBasis: undefined,
    capacityConfidence: "heuristic",
    modelConfidence: "low",
    confidenceDetails: undefined,
    settlementDelaySec: undefined,
    capacityRejectionReason: "redeemable-capacity-unobserved",
    resolutionState: "missing-capacity",
    routeStatus: "unknown",
    routeStatusSource: "static-config",
    routeStatusReason: "Mento FPMM capacity requires an observation from the current market phase",
    routeStatusReviewedAt: undefined,
  };
}
