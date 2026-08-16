import { deriveDeviationBps } from "@/lib/stablecoin-detail-derive";
import { DEPEG_THRESHOLD_BPS, DEPEG_THRESHOLD_BPS_NON_USD } from "@shared/lib/depeg-config";
import { formatCompactUsd } from "@shared/lib/format";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { getCirculatingRaw } from "@shared/lib/supply";
import type { StablecoinListResponse } from "@shared/types";
import type {
  CommandPalettePegStatus,
  CommandPaletteStablecoinHealth,
  CommandPaletteStablecoinLiveMetadata,
} from "@/components/command-palette-model";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

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
): Map<string, CommandPaletteStablecoinLiveMetadata> {
  const map = new Map<string, CommandPaletteStablecoinLiveMetadata>();
  const peggedAssets = stablecoinsData?.peggedAssets;
  if (!peggedAssets) return map;

  const { rates } = derivePegRates(peggedAssets, TRACKED_META_BY_ID, stablecoinsData.fxFallbackRates);
  for (const asset of peggedAssets) {
    const marketCapUsd = getCirculatingRaw(asset);
    const meta = TRACKED_META_BY_ID.get(asset.id);
    const peg = asset.pegType;
    let health: CommandPaletteStablecoinHealth | undefined;
    if (meta?.flags.navToken) {
      health = { kind: "nav" };
    } else if (peg && asset.price != null) {
      const reference = getPegReference(peg, rates, meta?.commodityOunces);
      const deviationBps = deriveDeviationBps(asset.price, reference);
      if (deviationBps != null) {
        const bps = Math.abs(deviationBps);
        const threshold = peg === "peggedUSD" ? DEPEG_THRESHOLD_BPS : DEPEG_THRESHOLD_BPS_NON_USD;
        health = { kind: "peg", status: bps >= threshold ? "alert" : bps >= threshold / 2 ? "watch" : "calm" };
      }
    }
    if (marketCapUsd > 0 || health) {
      map.set(asset.id, {
        ...(marketCapUsd > 0 ? { marketCapUsd } : {}),
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
    .sort((a, b) => {
      const aMarketCap = liveMetadata.get(a.id)?.marketCapUsd ?? 0;
      const bMarketCap = liveMetadata.get(b.id)?.marketCapUsd ?? 0;
      return bMarketCap - aMarketCap;
    })
    .slice(0, POPULAR_STABLECOIN_COUNT)
    .map((asset) => asset.id);
}
