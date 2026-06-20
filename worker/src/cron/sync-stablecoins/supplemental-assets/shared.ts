import { CHAIN_META } from "@shared/lib/chains";
import { selectSupplementalOnchainSupplyProbeContract } from "@shared/lib/onchain-supply-probe";
import type { PriceObservedAtMode, StablecoinMeta } from "@shared/types/core";
import { fetchWithRetry } from "../../../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../../../lib/response-body";
import { CIRCUIT_SOURCE, DEFILLAMA_COINS } from "../../../lib/constants";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../../lib/circuit-breaker";
import { validatePricingSourceFreshness } from "../../../lib/pricing-source-freshness";
import { DefiLlamaCoinsPriceSchema, type DefiLlamaCoinsPriceResponse } from "../../../lib/upstream-schemas";
import type { PeggedAsset } from "../enrich-prices";

export type CoinGeckoMcapData = Record<string, { usd?: number; usd_market_cap?: number; last_updated_at?: number }>;
type SupplementalDefiLlamaPriceData = { coins: NonNullable<DefiLlamaCoinsPriceResponse["coins"]> };

export interface SupplementalPriceResolution {
  price: number;
  source: "defillama-contract" | "coingecko-mirror" | "coingecko" | "coingecko-low-volume";
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
}

export function pegTypeKey(meta: StablecoinMeta): string {
  return `pegged${meta.flags.pegCurrency}`;
}

export function toPositiveFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function normalizeFreshSupplementalPriceResolution(
  resolution: SupplementalPriceResolution,
  options: { requireObservedAt?: boolean } = {},
): SupplementalPriceResolution | null {
  const freshness = validatePricingSourceFreshness({
    source: resolution.source,
    observedAt: resolution.observedAt,
    observedAtMode: resolution.observedAtMode,
    requireObservedAt: options.requireObservedAt,
  });
  if (!freshness.accepted) return null;

  return {
    ...resolution,
    observedAt: freshness.observedAt,
    observedAtMode: freshness.observedAtMode,
  };
}

export function resolveLowVolumeCoinGeckoPrice(
  cgData: CoinGeckoMcapData,
  geckoId?: string,
): SupplementalPriceResolution | null {
  if (!geckoId) return null;

  const cgEntry = cgData[geckoId];
  const cgPrice = toPositiveFiniteNumber(cgEntry?.usd);
  if (cgPrice == null) return null;

  const observedAt = toPositiveFiniteNumber(cgEntry?.last_updated_at) ?? null;
  const freshness = validatePricingSourceFreshness({
    source: "coingecko-low-volume",
    observedAt,
    observedAtMode: observedAt != null ? "upstream" : "local_fetch",
    requireObservedAt: true,
  });
  if (!freshness.accepted) return null;

  return {
    price: cgPrice,
    source: "coingecko-low-volume",
    observedAt: freshness.observedAt,
    observedAtMode: freshness.observedAtMode,
  };
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
    const freshResolution = normalizeFreshSupplementalPriceResolution(resolution);
    if (freshResolution) return freshResolution;
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
    return normalizeFreshSupplementalPriceResolution(resolution);
  }

  return null;
}

export function getSupplementalDefiLlamaContractPriceKey(meta: StablecoinMeta): string | null {
  if (meta.geckoId) return null;

  const contract = selectSupplementalOnchainSupplyProbeContract(meta);
  if (!contract) return null;

  const address = CHAIN_META[contract.chain]?.type === "evm" ? contract.address.toLowerCase() : contract.address;
  return `${contract.chain}:${address}`;
}

export function resolveSupplementalContractPrice(
  priceData: SupplementalDefiLlamaPriceData,
  meta: StablecoinMeta,
): SupplementalPriceResolution | null {
  const priceKey = getSupplementalDefiLlamaContractPriceKey(meta);
  if (!priceKey) return null;

  const dlEntry = priceData.coins[priceKey];
  const dlPrice = toPositiveFiniteNumber(dlEntry?.price);
  if (dlPrice == null) return null;

  const observedAt = toPositiveFiniteNumber(dlEntry?.timestamp) ?? null;
  const resolution = {
    price: dlPrice,
    source: "defillama-contract" as const,
    observedAt,
    observedAtMode: observedAt != null ? "upstream" as const : null,
  };
  return normalizeFreshSupplementalPriceResolution(resolution, { requireObservedAt: true });
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
  db?: D1Database,
): Promise<SupplementalDefiLlamaPriceData> {
  if (metas.length === 0) return { coins: {} };

  const coinIds = metas
    .flatMap((token) => {
      const ids: string[] = [];
      if (token.geckoId) ids.push(`coingecko:${token.geckoId}`);
      const contractPriceKey = getSupplementalDefiLlamaContractPriceKey(token);
      if (contractPriceKey) ids.push(contractPriceKey);
      return ids;
    })
    .join(",");
  if (!coinIds) return { coins: {} };

  const dlAllowed = db ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_COINS) : true;
  if (!dlAllowed) {
    console.warn(`[${logPrefix}] DefiLlama coins circuit open; using CoinGecko simple price fallback when available`);
    return { coins: {} };
  }

  let priceRes: Response | null = null;
  try {
    priceRes = await fetchWithRetry(`${DEFILLAMA_COINS}/prices/current/${coinIds}`, signal ? { signal } : undefined);
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn(`[${logPrefix}] Price fetch threw; using CoinGecko simple price fallback when available`, err);
    if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.DL_COINS, false);
    return { coins: {} };
  }
  if (!priceRes || !priceRes.ok) {
    console.warn(
      `[${logPrefix}] Price fetch failed: ${priceRes?.status ?? "no response"}; using CoinGecko simple price fallback when available`,
    );
    await cancelResponseBodyQuietly(priceRes);
    if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.DL_COINS, false);
    return { coins: {} };
  }

  let rawPriceData: unknown;
  try {
    rawPriceData = await priceRes.json();
  } catch (err) {
    await cancelResponseBodyQuietly(priceRes);
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn(`[${logPrefix}] Price payload parse failed; using CoinGecko simple price fallback when available`, err);
    if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.DL_COINS, false);
    return { coins: {} };
  }

  const parsed = DefiLlamaCoinsPriceSchema.safeParse(rawPriceData);
  if (!parsed.success) {
    if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.DL_COINS, false);
    return { coins: {} };
  }

  if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.DL_COINS, true);
  return { coins: parsed.data.coins ?? {} };
}
