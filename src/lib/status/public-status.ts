import { getBlacklistGapStatus } from "@shared/lib/status-thresholds";
import { getPublicMintBurnStatus, type PublicStatusTone } from "@shared/lib/public-health";
import type { HealthResponse } from "@shared/types";
import { getCacheFreshnessRatio, getCacheImpactStatus } from "@/lib/status/cache-health";

export interface PublicCacheSummary {
  ratio: number | null;
  status: PublicStatusTone;
  impactedCount: number;
}

export interface PublicImpactedSurface {
  id: string;
  title: string;
  detail: string;
  tone: "degraded" | "stale";
}

export { getPublicMintBurnStatus };

const CACHE_IMPACT_COPY: Partial<Record<string, { title: string; detail: string }>> = {
  stablecoins: {
    title: "Core market listings",
    detail: "Homepage rankings, comparison tables, and market-cap driven views rely on the core stablecoin cache.",
  },
  "stablecoin-charts": {
    title: "Historical chart lanes",
    detail: "Stablecoin detail charts and historical trend panels can lag when chart snapshots fall behind.",
  },
  "usds-status": {
    title: "USDS status surface",
    detail: "USDS-specific status and reserve context can drift when this cache is stale.",
  },
  "fx-rates": {
    title: "Non-USD normalization",
    detail: "FX normalization affects non-USD peg interpretation and any view that translates source values into USD terms.",
  },
  "bluechip-ratings": {
    title: "Safety overlays",
    detail: "Bluechip-derived safety context and dependent report-card inputs can lag.",
  },
  "dex-liquidity": {
    title: "Liquidity analytics",
    detail: "Liquidity scores and related route panels depend on fresh DEX liquidity snapshots.",
  },
  "yield-data": {
    title: "Yield monitoring",
    detail: "Yield rankings and per-coin yield history can lag when yield snapshots are stale.",
  },
  dews: {
    title: "Stress and depeg warnings",
    detail: "DEWS and stress-warning surfaces can lag when the stress lane falls behind.",
  },
};

function getStatusSeverity(status: PublicStatusTone): number {
  if (status === "stale") return 2;
  if (status === "degraded") return 1;
  return 0;
}

export function getPublicWorstCacheSummary(
  caches: HealthResponse["caches"],
): PublicCacheSummary {
  let ratio: number | null = null;
  let status: PublicStatusTone = "healthy";
  let sortRatio = Number.NEGATIVE_INFINITY;
  let impactedCount = 0;

  for (const cache of Object.values(caches)) {
    const cacheStatus = getCacheImpactStatus(cache);
    if (cacheStatus !== "healthy") impactedCount++;

    const cacheRatio = getCacheFreshnessRatio(cache);
    const cacheSortRatio = cacheRatio ?? Number.POSITIVE_INFINITY;
    const severity = getStatusSeverity(cacheStatus);
    const currentSeverity = getStatusSeverity(status);

    if (severity > currentSeverity || (severity === currentSeverity && cacheSortRatio > sortRatio)) {
      ratio = cacheRatio;
      status = cacheStatus;
      sortRatio = cacheSortRatio;
    }
  }

  return { ratio, status, impactedCount };
}

export function getImpactedPublicSurfaces(
  healthData: HealthResponse,
): PublicImpactedSurface[] {
  const items: PublicImpactedSurface[] = [];
  const mintBurnStatus = getPublicMintBurnStatus(healthData.mintBurn.sync);
  const blacklistStatus = getBlacklistGapStatus({
    missingRatio: healthData.blacklist.missingRatio,
    recentMissingAmounts: healthData.blacklist.recentMissingAmounts,
  });

  if (mintBurnStatus !== "healthy" || healthData.mintBurn.majorStaleCount > 0) {
    items.push({
      id: "mint-burn",
      title: "Mint and burn flow surfaces",
      detail:
        "Mint/burn flows, event timelines, and any downstream checks that compare recent issuance or redemption activity can lag while the critical writer lane is outside its public health target.",
      tone: mintBurnStatus === "stale" ? "stale" : "degraded",
    });
  }

  if (blacklistStatus !== "healthy") {
    items.push({
      id: "blacklist",
      title: "Blacklist risk context",
      detail:
        "Blacklist event totals and amount-aware risk context are incomplete until missing blacklist amounts are backfilled.",
      tone: blacklistStatus,
    });
  }

  for (const [key, cache] of Object.entries(healthData.caches)) {
    const copy = CACHE_IMPACT_COPY[key];
    if (!copy) continue;

    const tone = getCacheImpactStatus(cache);
    if (tone === "healthy") continue;

    items.push({
      id: `cache-${key}`,
      title: copy.title,
      detail: copy.detail,
      tone,
    });
  }

  return items;
}
