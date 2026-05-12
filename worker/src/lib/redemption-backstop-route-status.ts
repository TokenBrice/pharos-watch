import type { RedemptionRouteStatus, RedemptionRouteStatusSource } from "@shared/types/redemption";
import type { RedemptionRouteAvailability } from "./redemption-backstop-availability";

export const REDEMPTION_ROUTE_STATUS_PRODUCER = {
  model: "live-reserve-adapters-plus-static-policy",
  fetchesDuringRedemptionSync: false,
  overrideStore: "static-config",
  freshness: "sync-redemption-backstops-snapshot",
} as const;

export interface RedemptionRouteStatusEvidence {
  routeStatus: RedemptionRouteStatus;
  routeStatusSource: RedemptionRouteStatusSource;
  routeStatusReason?: string;
  routeStatusReviewedAt?: string;
}

export interface RedemptionRouteStatusFeedEntry extends RedemptionRouteStatusEvidence {
  origin: "operator-override" | "protocol-feed";
}

export interface MergedRedemptionRouteStatus extends RedemptionRouteStatusEvidence {
  impaired: boolean;
  capsApplied: string[];
  notes: string[];
}

const STATIC_ROUTE_STATUS_OVERRIDES: Readonly<Record<string, RedemptionRouteStatusFeedEntry>> = {};

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

export function getStaticRedemptionRouteStatusFeed(stablecoinId: string): RedemptionRouteStatusFeedEntry | null {
  return STATIC_ROUTE_STATUS_OVERRIDES[stablecoinId] ?? null;
}

export function loadStaticRedemptionRouteStatusFeedMap(
  stablecoinIds: readonly string[],
): Map<string, RedemptionRouteStatusFeedEntry> {
  const result = new Map<string, RedemptionRouteStatusFeedEntry>();
  for (const stablecoinId of stablecoinIds) {
    const entry = getStaticRedemptionRouteStatusFeed(stablecoinId);
    if (entry) result.set(stablecoinId, entry);
  }
  return result;
}

export function countStaticRedemptionRouteStatusOverrides(): number {
  return Object.keys(STATIC_ROUTE_STATUS_OVERRIDES).length;
}

export function mergeRedemptionRouteStatus(args: {
  staticEvidence: RedemptionRouteStatusEvidence;
  liveEvidence?: RedemptionRouteStatusEvidence | null;
  feedEvidence?: RedemptionRouteStatusFeedEntry | null;
  severeMarketImplied?: RedemptionRouteAvailability | null;
  allowSevereMarketOpenException: boolean;
}): MergedRedemptionRouteStatus {
  const liveEvidence = normalizeEvidence(args.liveEvidence);
  const feedEvidence = normalizeEvidence(args.feedEvidence);
  const selected = liveEvidence ??
    feedEvidence ??
    normalizeEvidence(args.staticEvidence) ?? {
      routeStatus: "unknown" as const,
      routeStatusSource: "static-config" as const,
    };

  const selectedImpaired = selected.routeStatus !== "open" && selected.routeStatus !== "unknown";
  const severeMarketImpaired = args.severeMarketImplied != null && !args.allowSevereMarketOpenException;
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
