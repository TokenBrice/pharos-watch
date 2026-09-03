import type { RedemptionRouteStatus, RedemptionRouteStatusSource } from "@shared/types/redemption";
import type { RedemptionRouteAvailability } from "./availability";

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
  const marketOutputImpaired = args.severeMarketImplied?.outputImpairedDependencyId != null;
  const marketOverlayApplied =
    args.severeMarketImplied != null && (marketOutputImpaired || !args.allowSevereMarketOpenException);
  const finalEvidence = marketOverlayApplied ? (args.severeMarketImplied as RedemptionRouteStatusEvidence) : selected;
  const capsApplied: string[] = [];
  if (selectedImpaired) capsApplied.push("route-status-impairment");
  if (marketOverlayApplied) {
    capsApplied.push(
      args.severeMarketImplied?.routeStatus === "unknown"
        ? "market-implied-depeg-evidence-uncertain"
        : "market-implied-depeg-impairment",
    );
  }

  const notes = new Set<string>();
  if (selected.routeStatusReason) notes.add(selected.routeStatusReason);
  if (marketOverlayApplied && args.severeMarketImplied?.routeStatusReason) {
    notes.add(args.severeMarketImplied.routeStatusReason);
  }

  return {
    ...finalEvidence,
    impaired: selectedImpaired || marketOverlayApplied,
    capsApplied,
    notes: [...notes],
  };
}
