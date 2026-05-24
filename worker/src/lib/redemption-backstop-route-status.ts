import type { RedemptionRouteStatus, RedemptionRouteStatusSource } from "@shared/types/redemption";
import type { RedemptionRouteAvailability } from "./redemption-backstop-availability";

export const REDEMPTION_ROUTE_STATUS_PRODUCER = {
  model: "live-reserve-adapters-plus-static-policy",
  fetchesDuringRedemptionSync: false,
  freshness: "sync-redemption-backstops-snapshot",
} as const;

export interface RedemptionRouteStatusEvidence {
  routeStatus: RedemptionRouteStatus;
  routeStatusSource: RedemptionRouteStatusSource;
  routeStatusReason?: string;
  routeStatusReviewedAt?: string;
}

export interface MergedRedemptionRouteStatus extends RedemptionRouteStatusEvidence {
  impaired: boolean;
  capsApplied: string[];
  notes: string[];
}

function normalizeEvidence(
  evidence: RedemptionRouteStatusEvidence | null | undefined,
): RedemptionRouteStatusEvidence | null {
  if (!evidence) return null;
  return {
    routeStatus: evidence.routeStatus,
    routeStatusSource: evidence.routeStatusSource,
    ...(evidence.routeStatusReason ? { routeStatusReason: evidence.routeStatusReason } : {}),
    ...(evidence.routeStatusReviewedAt ? { routeStatusReviewedAt: evidence.routeStatusReviewedAt } : {}),
  };
}

export function mergeRedemptionRouteStatus(args: {
  staticEvidence: RedemptionRouteStatusEvidence;
  liveEvidence?: RedemptionRouteStatusEvidence | null;
  severeMarketImplied?: RedemptionRouteAvailability | null;
  allowSevereMarketOpenException: boolean;
}): MergedRedemptionRouteStatus {
  const liveEvidence = normalizeEvidence(args.liveEvidence);
  const selected = liveEvidence ??
    normalizeEvidence(args.staticEvidence) ?? {
      routeStatus: "unknown" as const,
      routeStatusSource: "static-config" as const,
    };

  const selectedImpaired = selected.routeStatus !== "open" && selected.routeStatus !== "unknown";
  const severeOutputImpaired = args.severeMarketImplied?.outputImpairedDependencyId != null;
  const severeMarketImpaired =
    args.severeMarketImplied != null && (severeOutputImpaired || !args.allowSevereMarketOpenException);
  const finalEvidence = severeMarketImpaired ? (args.severeMarketImplied as RedemptionRouteStatusEvidence) : selected;
  const capsApplied: string[] = [];
  if (selectedImpaired) capsApplied.push("route-status-impairment");
  if (severeMarketImpaired) capsApplied.push("market-implied-depeg-impairment");

  const notes = new Set<string>();
  if (selected.routeStatusReason) notes.add(selected.routeStatusReason);
  if (severeMarketImpaired && args.severeMarketImplied?.routeStatusReason) {
    notes.add(args.severeMarketImplied.routeStatusReason);
  }

  return {
    ...finalEvidence,
    impaired: selectedImpaired || severeMarketImpaired,
    capsApplied,
    notes: [...notes],
  };
}
