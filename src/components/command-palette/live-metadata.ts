import { formatCompactUsd } from "@shared/lib/format";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import type { StablecoinListResponse } from "@shared/types/supply";
import type { CommandPaletteStablecoinLiveMetadata } from "@/components/command-palette/command-palette-model";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { compareFiniteDesc } from "@shared/lib/sort";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import type { ApiMeta } from "@/lib/api";

export interface StablecoinLiveQueryState {
  dataUpdatedAt: number;
  meta: ApiMeta | null | undefined;
  error?: unknown;
}

const POPULAR_STABLECOIN_COUNT = 6;

export function formatCommandPaletteMarketCap(marketCap: number): string {
  return formatCompactUsd(marketCap);
}

export function buildStablecoinLiveMetadata(
  stablecoinsData: StablecoinListResponse | undefined,
  query: StablecoinLiveQueryState,
  nowMs?: number,
): Map<string, CommandPaletteStablecoinLiveMetadata> {
  const map = new Map<string, CommandPaletteStablecoinLiveMetadata>();
  const peggedAssets = stablecoinsData?.peggedAssets;
  if (!peggedAssets) return map;
  // A receipt is not a producer generation. Undated cached data cannot supply live facts.
  const producerAt = query.meta?.updatedAt;
  const hasClock = typeof producerAt === "number" && Number.isFinite(producerAt) && producerAt > 0;
  const healthInfo = deriveDataHealth({
    ...DATA_HEALTH_PRESETS.stablecoins,
    ...query,
    hasData: true,
    meta: hasClock ? query.meta : { updatedAt: null, ageSeconds: null, status: "unknown", reason: "producer-timestamp-unavailable" },
  }, nowMs);
  const isCurrent = hasClock && healthInfo.state === "fresh";

  // Peg and incident state is not derived here: rows read the coin-state ladder (`useCoinStates`).
  for (const asset of peggedAssets) {
    const marketCapUsd = hasClock ? getCirculatingRawOrNull(asset) : null;
    const health = TRACKED_META_BY_ID.get(asset.id)?.flags.navToken ? { kind: "nav" as const } : undefined;
    if (marketCapUsd !== null || health) {
      map.set(asset.id, {
        ...(marketCapUsd !== null ? { marketCapUsd } : {}),
        ...(!isCurrent && marketCapUsd !== null && hasClock ? { marketCapAsOf: producerAt } : {}),
        ...(health ? { health } : {}),
      });
    }
  }
  return map;
}

export function buildPopularStablecoinIds(
  stablecoinsData: StablecoinListResponse | undefined,
  liveMetadata: ReadonlyMap<string, CommandPaletteStablecoinLiveMetadata>,
): string[] {
  const peggedAssets = stablecoinsData?.peggedAssets;
  if (!peggedAssets) return [];

  return [...peggedAssets]
    .filter((asset) => !asset.frozen)
    .sort(compareFiniteDesc((asset) => liveMetadata.get(asset.id)?.marketCapUsd ?? Number.NaN))
    .slice(0, POPULAR_STABLECOIN_COUNT)
    .map((asset) => asset.id);
}
