import { deriveIndicativeDeviationBps } from "@/lib/stablecoin-detail-derive";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { DEPEG_THRESHOLD_BPS, DEPEG_THRESHOLD_BPS_NON_USD } from "@shared/lib/depeg-config";
import { formatCompactUsd } from "@shared/lib/format";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import type { StablecoinListResponse } from "@shared/types";
import type {
  CommandPalettePegStatus,
  CommandPaletteStablecoinHealth,
  CommandPaletteStablecoinLiveMetadata,
} from "@/components/command-palette-model";
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

export const PEG_STATUS_DOT: Record<CommandPalettePegStatus, string> = {
  calm: "bg-[var(--severity-healthy)]",
  watch: "bg-[var(--severity-mild)]",
  alert: "bg-[var(--severity-severe)]",
};

const PEG_STATUS_LABEL: Record<CommandPalettePegStatus, string> = {
  calm: "At peg",
  watch: "Peg watch",
  alert: "Off peg",
};

export function getStablecoinHealthLabel(health: CommandPaletteStablecoinHealth): string {
  if (health.kind === "nav") return "NAV-priced token";
  return PEG_STATUS_LABEL[health.status];
}

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

  const { rates } = derivePegRates(peggedAssets, TRACKED_META_BY_ID, stablecoinsData.fxFallbackRates);
  for (const asset of peggedAssets) {
    const marketCapUsd = hasClock ? getCirculatingRawOrNull(asset) : null;
    const meta = TRACKED_META_BY_ID.get(asset.id);
    const peg = asset.pegType;
    let health: CommandPaletteStablecoinHealth | undefined;
    if (meta?.flags.navToken) {
      health = { kind: "nav" };
    } else if (isCurrent && peg && isObservedPrice(asset) && asset.price != null) {
      const reference = getPegReference(peg, rates, meta?.commodityOunces);
      const deviationBps = deriveIndicativeDeviationBps(asset.price, reference);
      if (deviationBps != null) {
        const bps = Math.abs(deviationBps);
        const threshold = peg === "peggedUSD" ? DEPEG_THRESHOLD_BPS : DEPEG_THRESHOLD_BPS_NON_USD;
        health = { kind: "peg", status: bps >= threshold ? "alert" : bps >= threshold / 2 ? "watch" : "calm" };
      }
    }
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
