import { logWorkerEventArgs } from "../../../lib/structured-log";
import { CHAIN_META } from "@shared/lib/chains";
import { selectSupplementalOnchainSupplyProbeContract } from "@shared/lib/onchain-supply-probe";
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import type { PriceObservedAtMode, StablecoinMeta } from "@shared/types/core";
import { fetchTextWithRetry } from "../../../lib/fetch-retry";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import { CIRCUIT_SOURCE, DEFILLAMA_COINS } from "../../../lib/constants";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../../lib/circuit-breaker";
import {
  buildPriceReasonablenessOptions,
  isReasonablePrice,
} from "../../../lib/price-validation";
import { validatePricingSourceFreshness } from "../../../lib/pricing-source-freshness";
import { DefiLlamaCoinsPriceSchema, type DefiLlamaCoinsPriceResponse } from "../../../lib/upstream-schemas";
import type { PeggedAsset } from "../enrich-prices";
import { fetchCuratedAggregateOnChainMcap } from "./onchain-supply";

export type CoinGeckoMcapData = Record<string, { usd?: number; usd_market_cap?: number; last_updated_at?: number }>;
type SupplementalDefiLlamaPriceData = { coins: NonNullable<DefiLlamaCoinsPriceResponse["coins"]> };
const SUPPLEMENTAL_DL_CONTRACT_MIN_CONFIDENCE = 0.8;

export interface SupplementalPriceResolution {
  price: number;
  source: "defillama-contract" | "coingecko-mirror" | "coingecko" | "coingecko-low-volume";
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
}

export function pegTypeKey(meta: { flags: { pegCurrency: string } }): string {
  return pegTypeFromCurrency(meta.flags.pegCurrency) ?? `pegged${meta.flags.pegCurrency}`;
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
  fxRates?: Record<string, number>,
): SupplementalPriceResolution | null {
  const priceKey = getSupplementalDefiLlamaContractPriceKey(meta);
  if (!priceKey) return null;

  const dlEntry = priceData.coins[priceKey];
  const dlPrice = toPositiveFiniteNumber(dlEntry?.price);
  if (dlPrice == null) return null;
  if (dlEntry?.symbol?.trim().toUpperCase() !== meta.symbol.trim().toUpperCase()) return null;
  if (
    typeof dlEntry.confidence !== "number" ||
    !Number.isFinite(dlEntry.confidence) ||
    dlEntry.confidence < SUPPLEMENTAL_DL_CONTRACT_MIN_CONFIDENCE
  ) {
    return null;
  }

  if (
    !isReasonablePrice(
      dlPrice,
      pegTypeKey(meta),
      fxRates,
      buildPriceReasonablenessOptions({
        navToken: meta.flags.navToken,
        commodityOunces: meta.commodityOunces,
      }),
    )
  ) {
    return null;
  }

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
  priceResolution: SupplementalPriceResolution | null;
  mcap: number;
  supplySource: string;
  chainCirculating?: PeggedAsset["chainCirculating"];
  circulatingPrevDay?: number | null;
  circulatingPrevWeek?: number | null;
  circulatingPrevMonth?: number | null;
}): PeggedAsset {
  const nowSec = Math.floor(Date.now() / 1000);
  const pKey = pegTypeKey(input.meta);
  const priceResolution = input.priceResolution;
  return {
    id: input.meta.id,
    name: input.meta.name,
    symbol: input.meta.symbol,
    geckoId: input.meta.geckoId,
    pegType: pKey,
    pegMechanism: input.meta.flags.backing,
    price: priceResolution?.price ?? null,
    priceSource: priceResolution?.source,
    priceConfidence: priceResolution ? "single-source" : null,
    priceUpdatedAt: priceResolution ? (priceResolution.observedAt ?? nowSec) : null,
    priceObservedAt: priceResolution ? (priceResolution.observedAt ?? nowSec) : null,
    priceObservedAtMode: priceResolution ? (priceResolution.observedAtMode ?? "local_fetch") : null,
    priceSyncedAt: priceResolution ? nowSec : null,
    supplySource: input.supplySource,
    circulating: { [pKey]: input.mcap },
    circulatingPrevDay: input.circulatingPrevDay != null ? { [pKey]: input.circulatingPrevDay } : null,
    circulatingPrevWeek: input.circulatingPrevWeek != null ? { [pKey]: input.circulatingPrevWeek } : null,
    circulatingPrevMonth: input.circulatingPrevMonth != null ? { [pKey]: input.circulatingPrevMonth } : null,
    chainCirculating: input.chainCirculating ?? {},
    chains: getSupplementalChainLabels(input.meta),
    commodityOunces: input.meta.commodityOunces,
  } as PeggedAsset;
}

/**
 * Curated aggregate on-chain supply for supplemental lanes whose upstream row
 * carries no per-chain breakdown. Returns null unless the asset has a curated
 * aggregate config, a usable price, and every configured leg reads, so an
 * unreadable chain can never silently undercount.
 */
export async function resolveCuratedAggregateSupplementalSupply(
  meta: StablecoinMeta,
  priceData: SupplementalDefiLlamaPriceData,
  cgData: CoinGeckoMcapData,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<{ mcap: number; supplySource: string; chainCirculating: PeggedAsset["chainCirculating"] } | null> {
  const priceResolution = resolveSupplementalPrice(priceData, cgData, meta.geckoId);
  if (!priceResolution) return null;

  const aggregate = await fetchCuratedAggregateOnChainMcap(meta, priceResolution.price, chainRpcs, signal);
  if (!aggregate) return null;

  return {
    mcap: aggregate.mcap,
    supplySource: aggregate.supplySource,
    chainCirculating: Object.fromEntries(
      Object.entries(aggregate.chainCirculating ?? {}).map(([chainLabel, current]) => [
        chainLabel,
        {
          current,
          circulatingPrevDay: 0,
          circulatingPrevWeek: 0,
          circulatingPrevMonth: 0,
        },
      ]),
    ),
  };
}

export function buildPricedSupplementalAsset(
  meta: StablecoinMeta,
  priceData: SupplementalDefiLlamaPriceData,
  cgData: CoinGeckoMcapData,
  input: {
    mcap: number;
    supplySource: string;
    chainCirculating?: PeggedAsset["chainCirculating"];
    circulatingPrevDay?: number | null;
    circulatingPrevWeek?: number | null;
    circulatingPrevMonth?: number | null;
  },
): PeggedAsset | null {
  const priceResolution = resolveSupplementalPrice(priceData, cgData, meta.geckoId);
  // Price coverage is independent from row publication: positive upstream
  // market cap stays publishable with null price, while empty rows fail closed.
  if (!priceResolution && !(Number.isFinite(input.mcap) && input.mcap > 0)) return null;

  return buildSupplementalAsset({
    meta,
    priceResolution,
    mcap: input.mcap,
    supplySource: input.supplySource,
    chainCirculating: input.chainCirculating,
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
    logWorkerEventArgs("handler", "warn", `[${logPrefix}] DefiLlama coins circuit open; using CoinGecko simple price fallback when available`);
    return { coins: {} };
  }

  let priceResult: Awaited<ReturnType<typeof fetchTextWithRetry>> | null = null;
  try {
    priceResult = await fetchTextWithRetry(
      `${DEFILLAMA_COINS}/prices/current/${coinIds}`,
      signal ? { signal } : undefined,
      2,
      { returnFinalResponse: true },
    );
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("handler", "warn", `[${logPrefix}] Price fetch threw; using CoinGecko simple price fallback when available`, err);
    if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.DL_COINS, false);
    return { coins: {} };
  }
  if (!priceResult?.response.ok) {
    logWorkerEventArgs("handler", "warn",
      `[${logPrefix}] Price fetch failed: ${priceResult?.response.status ?? "no response"}; using CoinGecko simple price fallback when available`,
    );
    if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.DL_COINS, false);
    return { coins: {} };
  }

  let rawPriceData: unknown;
  try {
    rawPriceData = JSON.parse(priceResult.body);
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("handler", "warn", `[${logPrefix}] Price payload parse failed; using CoinGecko simple price fallback when available`, err);
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
