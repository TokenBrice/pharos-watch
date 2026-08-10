import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import {
  hasUsableStablecoinsPayload,
  loadStablecoinsCache,
  type StablecoinsCacheLoadResult,
} from "../stablecoins-cache";
import type {
  PriceSourceDepthBucket,
  PriceSourceDepthDistribution,
} from "@shared/types/status";

export function createEmptySourceDepthDistribution(): PriceSourceDepthDistribution {
  return {
    "0": 0,
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    "5+": 0,
  };
}

export function bucketSourceDepth(count: number): PriceSourceDepthBucket {
  if (count >= 5) return "5+";
  if (count <= 0) return "0";
  return String(count) as PriceSourceDepthBucket;
}

function normalizeSourceCount(sources: unknown): number {
  if (!Array.isArray(sources)) return 0;
  let count = 0;
  for (const source of sources) {
    if (typeof source !== "string") continue;
    const normalized = source.trim();
    if (normalized.length > 0) count++;
  }
  return count;
}

export function buildSourceDepthDistribution(
  assets: Array<{ id: string; consensusSources?: unknown }>,
): PriceSourceDepthDistribution {
  const distribution = createEmptySourceDepthDistribution();

  for (const asset of assets) {
    if (!ACTIVE_IDS.has(asset.id)) continue;
    distribution[bucketSourceDepth(normalizeSourceCount(asset.consensusSources))] += 1;
  }

  return distribution;
}

export async function loadSourceDepthDistribution(
  db: D1Database,
  preloadedCache?: StablecoinsCacheLoadResult,
): Promise<PriceSourceDepthDistribution | null> {
  const stablecoinsCache = preloadedCache
    ?? (await loadStablecoinsCache(db, { mode: "lenient" }));
  if (!hasUsableStablecoinsPayload(stablecoinsCache)) {
    return null;
  }

  return buildSourceDepthDistribution(stablecoinsCache.payload.peggedAssets);
}
