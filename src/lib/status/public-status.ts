import { getBlacklistGapStatus } from "@shared/lib/status-thresholds";
import { getPublicMintBurnStatus, getStatusSeverity, type PublicStatusTone } from "@shared/lib/public-health";
import type { HealthResponse, StatusHealthValue } from "@shared/types";
import { getCacheFreshnessRatio, getCacheImpactStatus } from "@shared/lib/cache-health";

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

export interface PublicHealthWarningPresentation {
  title: string;
  detail: string;
}

type ActivePriceCoverage = NonNullable<HealthResponse["activePriceCoverage"]>;

const ACTIVE_PRICE_INCOMPLETE_PREFIX = "active-price-coverage-incomplete:";

function formatList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function getActivePriceAssetLabels(
  coverage: ActivePriceCoverage | undefined,
  fallbackIds: readonly string[],
): string[] {
  const symbolById = new Map(
    coverage?.missingActiveAssets.map((asset) => [asset.stablecoinId, asset.symbol] as const) ?? [],
  );
  const ids = coverage?.missingActiveIds.length ? coverage.missingActiveIds : fallbackIds;
  const labels = ids.map((id) => {
    const symbol = symbolById.get(id);
    return symbol && symbol !== "unknown" ? symbol : id;
  });
  return [...new Set(labels)];
}

function formatAffectedAssets(count: number, labels: readonly string[]): string {
  const effectiveCount = Math.max(count, labels.length);
  const visibleLabels = labels.slice(0, 6);
  const hiddenCount = Math.max(0, effectiveCount - visibleLabels.length);
  const displayLabels = hiddenCount > 0 ? [...visibleLabels, `${hiddenCount} more`] : visibleLabels;
  const countLabel = effectiveCount === 1
    ? "1 active asset"
    : effectiveCount > 1
      ? `${effectiveCount} active assets`
      : "active assets";
  return displayLabels.length > 0 ? `${countLabel}: ${formatList(displayLabels)}` : countLabel;
}

export function getActivePriceCoverageImpactDetail(coverage: ActivePriceCoverage): string {
  const labels = getActivePriceAssetLabels(coverage, coverage.missingActiveIds);
  const affectedAssets = formatAffectedAssets(coverage.missingPriceCount, labels);
  return `Live prices are unavailable for ${affectedAssets}. Stablecoin listings and price-dependent analytics may be incomplete until coverage recovers.`;
}

export function getPublicHealthWarningPresentation(
  warning: string,
  healthData: HealthResponse,
): PublicHealthWarningPresentation {
  if (warning.startsWith(ACTIVE_PRICE_INCOMPLETE_PREFIX)) {
    const fallbackIds = warning
      .slice(ACTIVE_PRICE_INCOMPLETE_PREFIX.length)
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0 && id !== "count-mismatch");
    const coverage = healthData.activePriceCoverage;
    const detail =
      coverage?.status === "incomplete"
        ? getActivePriceCoverageImpactDetail(coverage)
        : `Live prices are unavailable for ${formatAffectedAssets(fallbackIds.length, fallbackIds)}. Stablecoin listings and price-dependent analytics may be incomplete until coverage recovers.`;
    return { title: "Stablecoin price coverage", detail };
  }

  if (warning === "active-price-coverage-unknown") {
    return {
      title: "Stablecoin price coverage",
      detail:
        "Exact live-price coverage is unavailable. Stablecoin listings and price-dependent analytics may be incomplete until telemetry recovers.",
    };
  }

  return { title: "Health warning", detail: warning };
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


export function getPublicWorstCacheSummary(
  caches: HealthResponse["caches"],
): PublicCacheSummary {
  let ratio: number | null = null;
  let status: PublicStatusTone = "healthy";
  let sortRatio = Number.NEGATIVE_INFINITY;
  let impactedCount = 0;

  for (const [key, cache] of Object.entries(caches)) {
    const cacheStatus = getCacheImpactStatus(cache, key);
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

export type PublicDivergenceNotice =
  | { kind: "in-sync" }
  | { kind: "health-degraded-probes-ok"; detail: string }
  | { kind: "probes-degraded-health-ok"; detail: string }
  | { kind: "both-degraded-different-severity"; detail: string };

export function getPublicDivergenceNotice(
  healthStatus: StatusHealthValue,
  probeStatus: StatusHealthValue,
): PublicDivergenceNotice {
  const SEV = { healthy: 0, degraded: 1, stale: 2 } as const;
  const h = SEV[healthStatus];
  const p = SEV[probeStatus];
  if (h === p) return { kind: "in-sync" };
  if (h > 0 && p === 0) {
    return {
      kind: "health-degraded-probes-ok",
      detail: `Health endpoint reports ${healthStatus}, but browser probes are green. A data-quality or ingestion issue likely, not an API outage.`,
    };
  }
  if (p > 0 && h === 0) {
    return {
      kind: "probes-degraded-health-ok",
      detail: `Browser probes report ${probeStatus}, but health endpoint is green. Your network path may be the issue; refresh or try another network.`,
    };
  }
  return {
    kind: "both-degraded-different-severity",
    detail: `Health: ${healthStatus}. Probes: ${probeStatus}.`,
  };
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

  // Mirror the worker's public-impact gate (public-health-assessment.ts):
  // missing active prices remain warning-only. Unknown exact coverage still
  // fails closed because the public surface cannot prove its own price coverage.
  if (healthData.activePriceCoverage?.status === "unknown") {
    items.push({
      id: "active-price-coverage",
      title: "Stablecoin prices and dependent analytics",
      detail:
        "Exact live-price coverage is unavailable. Stablecoin listings and price-dependent analytics may be incomplete until telemetry recovers.",
      tone: "degraded",
    });
  }

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

    const tone = getCacheImpactStatus(cache, key);
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
