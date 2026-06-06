import { CHAIN_META } from "@shared/lib/chains";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import type { PriceObservedAtMode, StablecoinMeta } from "@shared/types/core";
import { fetchWithRetry } from "../../../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../../../lib/response-body";
import { DEFILLAMA_COINS } from "../../../lib/constants";
import { DefiLlamaCoinsPriceSchema, type DefiLlamaCoinsPriceResponse } from "../../../lib/upstream-schemas";
import type { PeggedAsset } from "../enrich-prices";

export type CoinGeckoMcapData = Record<string, { usd?: number; usd_market_cap?: number; last_updated_at?: number }>;
type SupplementalDefiLlamaPriceData = { coins: NonNullable<DefiLlamaCoinsPriceResponse["coins"]> };

export interface SupplementalPriceResolution {
  price: number;
  source: "coingecko-mirror" | "coingecko" | "coingecko-low-volume";
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
}

export function pegTypeKey(meta: StablecoinMeta): string {
  return `pegged${meta.flags.pegCurrency}`;
}

export function toPositiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isFreshSupplementalPrice(source: SupplementalPriceResolution["source"], observedAt: number | null): boolean {
  if (observedAt == null) return true;
  const maxTrustedAgeSec = getPricingSourceRegistryEntry(source)?.maxTrustedAgeSec ?? 15 * 60;
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec - observedAt <= maxTrustedAgeSec;
}

export function resolveSupplementalPrice(
  priceData: SupplementalDefiLlamaPriceData,
  cgData: CoinGeckoMcapData,
  geckoId?: string,
): SupplementalPriceResolution | null {
  if (!geckoId) return null;

  const dlEntry = priceData.coins[`coingecko:${geckoId}`];
  const dlPrice = toPositiveFiniteNumber(dlEntry?.price);
  if (dlPrice != null) {
    const observedAt = toPositiveFiniteNumber(dlEntry?.timestamp) ?? null;
    const resolution = {
      price: dlPrice,
      source: "coingecko-mirror" as const,
      observedAt,
      observedAtMode: observedAt != null ? "upstream" as const : null,
    };
    if (isFreshSupplementalPrice(resolution.source, resolution.observedAt)) return resolution;
  }

  const cgEntry = cgData[geckoId];
  const cgPrice = toPositiveFiniteNumber(cgEntry?.usd);
  if (cgPrice != null) {
    const observedAt = toPositiveFiniteNumber(cgEntry?.last_updated_at) ?? null;
    const resolution = {
      price: cgPrice,
      source: "coingecko" as const,
      observedAt,
      observedAtMode: observedAt != null ? "upstream" as const : null,
    };
    return isFreshSupplementalPrice(resolution.source, resolution.observedAt) ? resolution : null;
  }

  return null;
}

export function getSupplementalChainLabels(meta: StablecoinMeta): string[] {
  const labels = (meta.contracts ?? [])
    .map((contract) => CHAIN_META[contract.chain]?.name ?? contract.chain)
    .filter((label): label is string => typeof label === "string" && label.length > 0);

  return Array.from(new Set(labels));
}

export function buildSupplementalAsset(input: {
  meta: StablecoinMeta;
  priceResolution: SupplementalPriceResolution;
  mcap: number;
  supplySource: string;
  circulatingPrevDay?: number | null;
  circulatingPrevWeek?: number | null;
  circulatingPrevMonth?: number | null;
}): PeggedAsset {
  const nowSec = Math.floor(Date.now() / 1000);
  const pKey = pegTypeKey(input.meta);
  return {
    id: input.meta.id,
    name: input.meta.name,
    symbol: input.meta.symbol,
    geckoId: input.meta.geckoId,
    pegType: pKey,
    pegMechanism: input.meta.flags.backing,
    price: input.priceResolution.price,
    priceSource: input.priceResolution.source,
    priceConfidence: "single-source",
    priceUpdatedAt: input.priceResolution.observedAt ?? nowSec,
    priceObservedAt: input.priceResolution.observedAt ?? nowSec,
    priceObservedAtMode: input.priceResolution.observedAtMode ?? "local_fetch",
    priceSyncedAt: nowSec,
    supplySource: input.supplySource,
    circulating: { [pKey]: input.mcap },
    circulatingPrevDay: input.circulatingPrevDay != null ? { [pKey]: input.circulatingPrevDay } : null,
    circulatingPrevWeek: input.circulatingPrevWeek != null ? { [pKey]: input.circulatingPrevWeek } : null,
    circulatingPrevMonth: input.circulatingPrevMonth != null ? { [pKey]: input.circulatingPrevMonth } : null,
    chainCirculating: {},
    chains: getSupplementalChainLabels(input.meta),
    commodityOunces: input.meta.commodityOunces,
  } as PeggedAsset;
}

export function buildPricedSupplementalAsset(
  meta: StablecoinMeta,
  priceData: SupplementalDefiLlamaPriceData,
  cgData: CoinGeckoMcapData,
  input: {
    mcap: number;
    supplySource: string;
    circulatingPrevDay?: number | null;
    circulatingPrevWeek?: number | null;
    circulatingPrevMonth?: number | null;
  },
): PeggedAsset | null {
  const priceResolution = resolveSupplementalPrice(priceData, cgData, meta.geckoId);
  if (!priceResolution) return null;

  return buildSupplementalAsset({
    meta,
    priceResolution,
    mcap: input.mcap,
    supplySource: input.supplySource,
    circulatingPrevDay: input.circulatingPrevDay,
    circulatingPrevWeek: input.circulatingPrevWeek,
    circulatingPrevMonth: input.circulatingPrevMonth,
  });
}

export async function fetchSupplementalPriceData(
  metas: StablecoinMeta[],
  logPrefix: string,
  signal?: AbortSignal,
): Promise<SupplementalDefiLlamaPriceData> {
  if (metas.length === 0) return { coins: {} };

  const coinIds = metas.map((token) => token.geckoId).filter(Boolean).map((id) => `coingecko:${id}`).join(",");
  if (!coinIds) return { coins: {} };

  const priceRes = await fetchWithRetry(`${DEFILLAMA_COINS}/prices/current/${coinIds}`, signal ? { signal } : undefined);
  if (!priceRes || !priceRes.ok) {
    console.warn(
      `[${logPrefix}] Price fetch failed: ${priceRes?.status ?? "no response"}; using CoinGecko simple price fallback when available`,
    );
    await cancelResponseBodyQuietly(priceRes);
    return { coins: {} };
  }

  const parsed = DefiLlamaCoinsPriceSchema.safeParse(await priceRes.json());
  if (!parsed.success) {
    return { coins: {} };
  }

  return { coins: parsed.data.coins ?? {} };
}
