import { CHAIN_META } from "@shared/lib/chains";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { PriceObservedAtMode, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import { CIRCUIT_SOURCE, DEFILLAMA_API, DEFILLAMA_COINS, USER_AGENT } from "../../lib/constants";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { resolveMarketCap } from "../../lib/resolve-market-cap";
import { throwIfAborted } from "../../lib/abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { encodeBalanceOfCallData } from "../../lib/evm-selectors";
import { fetchOnchainUint256, probeTrackedTokenSupply } from "../reserve-adapters/helpers";
import type { DefiLlamaCoinPrice, PeggedAsset } from "./enrich-prices";
import {
  buildZephyrProtocolPeggedAsset,
  fetchZephyrProtocolStats,
  isZephyrScannerAssetId,
} from "./zephyr-zsd";

const COMMODITY_TOKENS = ACTIVE_STABLECOINS.filter(
  (stablecoin) => stablecoin.flags.pegCurrency === "GOLD" || stablecoin.flags.pegCurrency === "SILVER",
);

const GOLD_METAS = ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.flags.pegCurrency === "GOLD");
const SILVER_METAS = ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.flags.pegCurrency === "SILVER");
const FIAT_CG_METAS = ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.detailProvider === "coingecko");

const CURATED_ONCHAIN_SUPPLY_CONTRACTS: Record<string, { chain: string; rpcUrl?: string; fallbackRpcUrl?: string }> = {
  // No upstream market row exists for Spark Savings USDC yet, but the Ethereum
  // vault supply plus the guarded protocol-redeem price keeps the asset visible.
  "susdc-spark": { chain: "ethereum" },
};

type SupplementalOnChainSupplySource = "onchain-total-supply" | "onchain-circulating-supply";

interface OnChainSupplyExclusionConfig {
  chain: string;
  holderAddresses: string[];
  supplySource: SupplementalOnChainSupplySource;
}

const CURATED_ONCHAIN_SUPPLY_EXCLUSIONS: Record<string, OnChainSupplyExclusionConfig> = {
  // Tangent mints USG inventory to PegKeeper contracts that deposit/withdraw
  // from protocol liquidity pools. Tangent's own UI excludes those live
  // balances from circulating USG, so the fallback mirrors that on-chain rule.
  "usg-tangent": {
    chain: "ethereum",
    holderAddresses: [
      "0xf89615f75c8161dc185c03020240905f6b66bad9",
      "0x8a7f16508d1e8b48bdf36023f378cc04d9506d4e",
    ],
    supplySource: "onchain-circulating-supply",
  },
};

function pegTypeKey(meta: StablecoinMeta): string {
  return `pegged${meta.flags.pegCurrency}`;
}

export type CoinGeckoMcapData = Record<string, { usd?: number; usd_market_cap?: number; last_updated_at?: number }>;

interface SupplementalPriceResolution {
  price: number;
  source: "coingecko-mirror" | "coingecko" | "coingecko-low-volume";
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
}

function toPositiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isFreshSupplementalPrice(source: SupplementalPriceResolution["source"], observedAt: number | null): boolean {
  if (observedAt == null) return true;
  const maxTrustedAgeSec = getPricingSourceRegistryEntry(source)?.maxTrustedAgeSec ?? 15 * 60;
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec - observedAt <= maxTrustedAgeSec;
}

export function resolveSupplementalPrice(
  priceData: { coins: Record<string, DefiLlamaCoinPrice> },
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

function buildSupplementalAsset(input: {
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

function getSupplementalChainLabels(meta: StablecoinMeta): string[] {
  const labels = (meta.contracts ?? [])
    .map((contract) => CHAIN_META[contract.chain]?.name ?? contract.chain)
    .filter((label): label is string => typeof label === "string" && label.length > 0);

  return Array.from(new Set(labels));
}

async function fetchSupplementalPriceData(
  metas: StablecoinMeta[],
  logPrefix: string,
  signal?: AbortSignal,
): Promise<{ coins: Record<string, DefiLlamaCoinPrice> }> {
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

  return (await priceRes.json()) as { coins: Record<string, DefiLlamaCoinPrice> };
}

async function fetchCoinGeckoCirculatingSupplyMap(
  metas: StablecoinMeta[],
  logPrefix: string,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<Map<string, number>> {
  const cgIds = metas.map((token) => token.geckoId).filter(Boolean).join(",");
  if (!cgIds) return new Map();

  const cgMarketsRes = await fetchWithRetry(
    cgUrl(`/coins/markets?vs_currency=usd&ids=${cgIds}`, coingeckoApiKey ?? null),
    {
      headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
      signal,
    },
  );

  if (!cgMarketsRes?.ok) {
    await cancelResponseBodyQuietly(cgMarketsRes);
    console.warn(
      `[${logPrefix}] CG markets fetch failed (${cgMarketsRes?.status ?? "no response"}), falling back to cgData mcap`,
    );
    return new Map();
  }

  let cgMarketsRaw: unknown;
  try {
    cgMarketsRaw = await cgMarketsRes.json();
  } catch (err) {
    await cancelResponseBodyQuietly(cgMarketsRes);
    console.warn(`[${logPrefix}] CG markets payload parse failed:`, err);
    return new Map();
  }
  if (!Array.isArray(cgMarketsRaw)) {
    console.warn(`[${logPrefix}] CG markets returned unexpected shape, falling back to cgData mcap`);
    return new Map();
  }

  const supplyMap = new Map<string, number>();
  for (const item of cgMarketsRaw as Array<{ id: string; circulating_supply?: number }>) {
    if (item.circulating_supply != null && item.circulating_supply > 0) {
      supplyMap.set(item.id, item.circulating_supply);
    }
  }
  return supplyMap;
}

function buildPricedSupplementalAsset(
  meta: StablecoinMeta,
  priceData: { coins: Record<string, DefiLlamaCoinPrice> },
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

function findNearestTvl(
  history: { date: number; totalLiquidityUSD: number }[],
  targetSec: number,
): number | null {
  if (history.length === 0) return null;

  let closest: { date: number; totalLiquidityUSD: number } | null = null;
  let closestDist = Infinity;

  for (const point of history) {
    const dist = Math.abs(point.date - targetSec);
    if (dist < closestDist) {
      closestDist = dist;
      closest = point;
    }
  }

  return closest && closestDist < 2 * DAY_SECONDS ? closest.totalLiquidityUSD : null;
}

async function fetchSilverTokens(
  cgData: CoinGeckoMcapData,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<PeggedAsset[]> {
  if (SILVER_METAS.length === 0) return [];
  throwIfAborted(signal);

  try {
    const [priceData, cgSupplyMap] = await Promise.all([
      fetchSupplementalPriceData(SILVER_METAS, "silver", signal),
      fetchCoinGeckoCirculatingSupplyMap(SILVER_METAS, "silver", signal, coingeckoApiKey),
    ]);

    const mcapMap: Record<string, number> = {};
    for (const token of SILVER_METAS) {
      if (!token.geckoId) continue;
      const cgMcap = cgData[token.geckoId]?.usd_market_cap;
      const circulatingSupply = cgSupplyMap.get(token.geckoId);
      const priceResolution = resolveSupplementalPrice(priceData, cgData, token.geckoId);
      const price = priceResolution?.price ?? 0;
      const mcap = resolveMarketCap(cgMcap, circulatingSupply, price);

      if (mcap > 0) {
        if (circulatingSupply && cgMcap && Math.abs(cgMcap - mcap) / mcap > 0.01) {
          console.warn(
            `[silver] ${token.symbol}: cgMcap=${cgMcap.toFixed(0)} rejected, using computed=${mcap.toFixed(0)} (supply=${circulatingSupply.toFixed(0)} × price=${price.toFixed(2)})`,
          );
        }
        mcapMap[token.id] = mcap;
      }
    }

    return SILVER_METAS
      .map((meta) => {
        const mcap = mcapMap[meta.id] ?? 0;
        if (!mcap) {
          console.warn(`[silver] No mcap for ${meta.symbol}, including with mcap=0`);
        }

        return buildPricedSupplementalAsset(meta, priceData, cgData, {
          mcap,
          supplySource: "coingecko-fallback",
        });
      })
      .filter((token): token is PeggedAsset => token !== null);
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.error("[silver] fetchSilverTokens failed:", err);
    return [];
  }
}

async function fetchGoldTokens(cgData: CoinGeckoMcapData, signal?: AbortSignal): Promise<PeggedAsset[]> {
  throwIfAborted(signal);
  try {
    const priceData = await fetchSupplementalPriceData(GOLD_METAS, "gold", signal);

    const mcapMap: Record<string, number> = {};
    const mcapSourceById: Record<string, "defillama" | "coingecko-fallback"> = {};
    const tvlHistoryMap: Record<string, { date: number; totalLiquidityUSD: number }[]> = {};
    const tokensWithProtocol = GOLD_METAS.filter((token) => token.protocolSlug);
    const PROTOCOL_BATCH = 3;
    for (let pi = 0; pi < tokensWithProtocol.length; pi += PROTOCOL_BATCH) {
      const batch = tokensWithProtocol.slice(pi, pi + PROTOCOL_BATCH);
      await Promise.all(batch.map(async (token) => {
        try {
          const res = await fetchWithRetry(`${DEFILLAMA_API}/protocol/${token.protocolSlug}`, {
            headers: { "User-Agent": USER_AGENT },
            signal,
          });
          if (!res) return;

          const data = (await res.json()) as { mcap?: number; tvl?: { date: number; totalLiquidityUSD: number }[] };
          if (data.mcap) {
            mcapMap[token.id] = data.mcap;
            mcapSourceById[token.id] = "defillama";
          }
          if (data.tvl) tvlHistoryMap[token.id] = data.tvl;
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn(`[sync-stablecoins] Protocol fetch failed for ${token.protocolSlug}:`, err);
        }
      }));
    }

    for (const token of GOLD_METAS) {
      if (mcapMap[token.id] != null && mcapMap[token.id] > 0) continue;
      const mcap = token.geckoId ? toPositiveFiniteNumber(cgData[token.geckoId]?.usd_market_cap) : undefined;
      if (mcap != null) {
        mcapMap[token.id] = mcap;
        mcapSourceById[token.id] = "coingecko-fallback";
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const dayAgo = nowSec - DAY_SECONDS;
    const weekAgo = nowSec - 7 * DAY_SECONDS;
    const monthAgo = nowSec - 30 * DAY_SECONDS;

    return GOLD_METAS
      .map((meta) => {
        const mcap = mcapMap[meta.id] ?? 0;
        if (!mcap) {
          console.warn(`[gold] No mcap for ${meta.symbol}, including with mcap=0`);
        }

        const history = tvlHistoryMap[meta.id];
        let usableHistory: typeof history | undefined;

        if (history && history.length > 0 && mcap > 0) {
          const latestTvl = history[history.length - 1].totalLiquidityUSD;
          const ratio = mcap / latestTvl;
          if (ratio > 0.85 && ratio < 1.15) {
            usableHistory = history;
          } else {
            console.warn(`[gold] ${meta.symbol}: mcap/tvl divergence (ratio=${ratio.toFixed(3)}), skipping TVL history`);
          }
        }

        const prevDay = usableHistory ? findNearestTvl(usableHistory, dayAgo) : null;
        const prevWeek = usableHistory ? findNearestTvl(usableHistory, weekAgo) : null;
        const prevMonth = usableHistory ? findNearestTvl(usableHistory, monthAgo) : null;

        return buildPricedSupplementalAsset(meta, priceData, cgData, {
          mcap,
          supplySource: mcapSourceById[meta.id] ?? "coingecko-fallback",
          circulatingPrevDay: prevDay,
          circulatingPrevWeek: prevWeek,
          circulatingPrevMonth: prevMonth,
        });
      })
      .filter((token): token is PeggedAsset => token !== null);
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.error("[gold] fetchGoldTokens failed:", err);
    return [];
  }
}

function isSupportedOnChainSupplyContract(contract: NonNullable<StablecoinMeta["contracts"]>[number]): boolean {
  return contract.chain === "solana" || (contract.chain !== "stellar" && contract.chain !== "tron");
}

export function selectSingleOnChainSupplyContract(meta: StablecoinMeta): NonNullable<StablecoinMeta["contracts"]>[number] | null {
  const contracts = meta.contracts ?? [];
  if (contracts.length !== 1) return null;
  const [contract] = contracts;
  return contract && isSupportedOnChainSupplyContract(contract) ? contract : null;
}

export function selectSupplementalOnChainSupplyContract(
  meta: StablecoinMeta,
): NonNullable<StablecoinMeta["contracts"]>[number] | null {
  const curated = CURATED_ONCHAIN_SUPPLY_CONTRACTS[meta.id];
  if (curated) {
    const contract = meta.contracts?.find((entry) => entry.chain === curated.chain);
    return contract && isSupportedOnChainSupplyContract(contract) ? contract : null;
  }

  return selectSingleOnChainSupplyContract(meta);
}

export function computeExcludedBalanceAdjustedSupplyRaw(
  totalSupplyRaw: bigint,
  excludedBalancesRaw: readonly bigint[],
): bigint | null {
  if (totalSupplyRaw <= 0n) return null;

  let excludedRaw = 0n;
  for (const balanceRaw of excludedBalancesRaw) {
    if (balanceRaw < 0n) return null;
    excludedRaw += balanceRaw;
  }

  const adjustedRaw = totalSupplyRaw - excludedRaw;
  return adjustedRaw > 0n ? adjustedRaw : null;
}

async function adjustOnChainSupplyForExcludedBalances(input: {
  meta: StablecoinMeta;
  supplyContract: NonNullable<StablecoinMeta["contracts"]>[number];
  totalSupplyRaw: bigint;
  signal: AbortSignal;
  chainRpc?: ChainRpcConfig;
  curatedRpc?: { rpcUrl?: string; fallbackRpcUrl?: string };
}): Promise<{ raw: bigint; supplySource: SupplementalOnChainSupplySource } | null> {
  const exclusionConfig = CURATED_ONCHAIN_SUPPLY_EXCLUSIONS[input.meta.id];
  if (!exclusionConfig) return null;

  if (input.supplyContract.chain === "solana" || input.supplyContract.chain !== exclusionConfig.chain) {
    throw new Error(
      `configured supply exclusions require ${exclusionConfig.chain}, selected ${input.supplyContract.chain}`,
    );
  }

  const balances = await Promise.all(
    exclusionConfig.holderAddresses.map((holderAddress) =>
      fetchOnchainUint256({
        contract: input.supplyContract.address,
        data: encodeBalanceOfCallData(holderAddress),
        signal: input.signal,
        rpcUrl: input.curatedRpc?.rpcUrl ?? input.chainRpc?.rpcUrl,
        fallbackRpcUrl: input.curatedRpc?.fallbackRpcUrl ?? input.chainRpc?.fallbackRpcUrl,
        rpcMode: "public-rpc",
        chain: input.supplyContract.chain,
      }),
    ),
  );

  if (balances.some((balance): balance is null => balance == null)) {
    throw new Error("configured excluded-balance read returned null");
  }

  const adjustedRaw = computeExcludedBalanceAdjustedSupplyRaw(input.totalSupplyRaw, balances as bigint[]);
  if (adjustedRaw == null) {
    throw new Error("configured excluded balances are greater than or equal to total supply");
  }

  return {
    raw: adjustedRaw,
    supplySource: exclusionConfig.supplySource,
  };
}

/** Fetch supply from one unambiguous on-chain contract and return mcap = supply × price. */
async function fetchOnChainMcap(
  meta: StablecoinMeta,
  priceUsd: number,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<{ mcap: number; supplySource: SupplementalOnChainSupplySource } | null> {
  const curated = CURATED_ONCHAIN_SUPPLY_CONTRACTS[meta.id];
  const supplyContract = selectSupplementalOnChainSupplyContract(meta);
  if (!supplyContract) {
    if (!curated && (meta.contracts?.length ?? 0) > 1) {
      console.warn(`[fiat-cg] ${meta.symbol}: skipping on-chain supply fallback because multiple contracts could undercount global supply`);
    }
    return null;
  }

  const probeInput: LiveReserveInput = supplyContract.chain === "solana"
    ? { kind: "onchain-solana" }
    : { kind: "onchain-evm", chain: supplyContract.chain, rpcMode: "public-rpc" };
  const supplySignal = signal ?? AbortSignal.timeout(10_000);
  const chainRpc = supplyContract.chain === "solana"
    ? undefined
    : chainRpcs?.get(supplyContract.chain);

  try {
    const raw = await probeTrackedTokenSupply(
      meta,
      probeInput,
      supplySignal,
      "fiat-cg",
      undefined,
      curated?.rpcUrl ?? chainRpc?.rpcUrl,
      curated?.fallbackRpcUrl ?? chainRpc?.fallbackRpcUrl,
    );
    if (raw <= 0n) return null;

    const adjustment = await adjustOnChainSupplyForExcludedBalances({
      meta,
      supplyContract,
      totalSupplyRaw: raw,
      signal: supplySignal,
      chainRpc,
      curatedRpc: curated,
    });
    const supplyRaw = adjustment?.raw ?? raw;
    const supplySource = adjustment?.supplySource ?? "onchain-total-supply";
    const decimals = supplyContract.decimals ?? (supplyContract.chain === "solana" ? 6 : 18);
    const supply = Number(supplyRaw) / 10 ** decimals;
    const mcap = supply * priceUsd;
    if (Number.isFinite(mcap) && mcap > 0) {
      const chainLabel = supplyContract.chain === "solana" ? "Solana" : "On-chain";
      console.log(`[fiat-cg] ${chainLabel} supply fallback for ${meta.symbol}: ${supply.toFixed(2)} units → $${mcap.toFixed(2)} mcap`);
      return { mcap, supplySource };
    }
  } catch (err) {
    const chainLabel = supplyContract.chain === "solana" ? "Solana" : "EVM";
    console.warn(`[fiat-cg] ${chainLabel} supply probe failed for ${meta.symbol}: ${String(err).slice(0, 200)}`);
  }

  return null;
}

async function fetchFiatCoinGeckoTokens(
  cgData: CoinGeckoMcapData,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  fxFallbackRates?: Record<string, number>,
): Promise<PeggedAsset[]> {
  if (FIAT_CG_METAS.length === 0) return [];
  throwIfAborted(signal);

  try {
    const hasZephyrScannerAsset = FIAT_CG_METAS.some((meta) => isZephyrScannerAssetId(meta.id));
    const [priceData, zephyrProtocolStats] = await Promise.all([
      fetchSupplementalPriceData(FIAT_CG_METAS, "fiat-cg", signal),
      hasZephyrScannerAsset ? fetchZephyrProtocolStats(signal) : Promise.resolve(null),
    ]);

    const mcapMap: Record<string, number> = {};
    for (const token of FIAT_CG_METAS) {
      const mcap = token.geckoId ? toPositiveFiniteNumber(cgData[token.geckoId]?.usd_market_cap) : undefined;
      if (mcap && mcap > 0) mcapMap[token.id] = mcap;
    }

    const results = await Promise.all(
      FIAT_CG_METAS.map(async (meta) => {
        const nowSec = Math.floor(Date.now() / 1000);
        const pKey = pegTypeKey(meta);
        // Strict path first (15-min freshness gate). If that rejects but CG returned
        // a valid price, fall back to the relaxed `coingecko-low-volume` lane so
        // CG-only stablecoins with slow upstream tickers don't surface as
        // `priceSource: missing`. Diagnosis pattern: detailProvider="coingecko"
        // with llamaId=null + low volume → upstream last_updated_at exceeds 15min.
        let priceResolution = resolveSupplementalPrice(priceData, cgData, meta.geckoId);
        if (!priceResolution && meta.geckoId) {
          const cgEntry = cgData[meta.geckoId];
          const cgPrice = toPositiveFiniteNumber(cgEntry?.usd);
          if (cgPrice != null) {
            const observedAt = toPositiveFiniteNumber(cgEntry?.last_updated_at) ?? null;
            priceResolution = {
              price: cgPrice,
              source: "coingecko-low-volume",
              observedAt,
              observedAtMode: observedAt != null ? "upstream" : "local_fetch",
            };
          }
        }
        const pegReferencePrice = toPositiveFiniteNumber(fxFallbackRates?.[pKey]);
        // USD is the base currency; fxFallbackRates omits peggedUSD. Default to 1.0 for
        // USD-pegged coins with no CG/DL price source so the on-chain fallback can compute mcap.
        const usdPegDefault = meta.flags.pegCurrency === "USD" ? 1.0 : undefined;
        const priceForSupply = priceResolution?.price ?? pegReferencePrice ?? usdPegDefault;

        if (isZephyrScannerAssetId(meta.id)) {
          if (!zephyrProtocolStats) {
            console.log(`[fiat-cg] No Zephyr scanner supply for ${meta.symbol}, skipping`);
            return null;
          }
          return buildZephyrProtocolPeggedAsset(meta, zephyrProtocolStats, priceResolution, nowSec);
        }

        let mcap = mcapMap[meta.id];
        let supplySource: string = "coingecko-fallback";

        // Fallback: on-chain totalSupply × market/peg-reference price when CG has no market cap.
        // This keeps preview-only fiat assets in supply coverage without inventing a live market quote.
        if (!mcap && priceForSupply != null) {
          const onChainMcap = await fetchOnChainMcap(meta, priceForSupply, chainRpcs, signal);
          if (onChainMcap) {
            mcap = onChainMcap.mcap;
            supplySource = onChainMcap.supplySource;
          }
        }

        if (!mcap) {
          console.log(`[fiat-cg] No mcap for ${meta.symbol}, skipping`);
          return null;
        }

        const priceConfidence: PeggedAsset["priceConfidence"] = priceResolution
          ? priceResolution.source === "coingecko-low-volume"
            ? "fallback"
            : "single-source"
          : null;
        return {
          id: meta.id,
          name: meta.name,
          symbol: meta.symbol,
          geckoId: meta.geckoId,
          pegType: pKey,
          pegMechanism: meta.flags.backing,
          price: priceResolution?.price ?? null,
          priceSource: priceResolution?.source,
          priceConfidence,
          priceUpdatedAt: priceResolution ? priceResolution.observedAt ?? nowSec : null,
          priceObservedAt: priceResolution ? priceResolution.observedAt ?? nowSec : null,
          priceObservedAtMode: priceResolution ? priceResolution.observedAtMode ?? "local_fetch" : null,
          priceSyncedAt: priceResolution ? nowSec : null,
          supplySource,
          circulating: { [pKey]: mcap },
          circulatingPrevDay: null,
          circulatingPrevWeek: null,
          circulatingPrevMonth: null,
          chainCirculating: {},
          chains: getSupplementalChainLabels(meta),
        } as PeggedAsset;
      }),
    );

    return results.filter((token): token is PeggedAsset => token !== null);
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.error("[fiat-cg] fetchFiatCoinGeckoTokens failed:", err);
    return [];
  }
}

export async function fetchCoinGeckoMarketData(db: D1Database, signal?: AbortSignal, coingeckoApiKey?: string | null): Promise<CoinGeckoMcapData> {
  const ids = [
    // Protocol-backed commodity tokens still need CoinGecko spot + mcap fallback
    // when DefiLlama omits their `coins.llama.fi` price or protocol mcap.
    ...COMMODITY_TOKENS.map((token) => token.geckoId).filter(Boolean),
    ...FIAT_CG_METAS.map((token) => token.geckoId).filter(Boolean),
  ].join(",");

  if (!ids) return {};
  throwIfAborted(signal);

  const cgAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_MCAP);
  if (!cgAllowed) {
    console.warn("[sync-stablecoins] CoinGecko market-cap circuit open — skipping supplemental mcap fetch");
    return {};
  }

  const res = await fetchWithRetry(
    cgUrl(`/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true&include_last_updated_at=true`, coingeckoApiKey ?? null),
    {
      headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
      signal,
    },
  );

  if (!res || !res.ok) {
    await cancelResponseBodyQuietly(res);
    console.error(`[sync-stablecoins] CoinGecko batch mcap fetch failed: ${res?.status ?? "no response"}`);
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.CG_MCAP, false);
    return {};
  }

  try {
    const data = (await res.json()) as CoinGeckoMcapData;
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.CG_MCAP, true);
    return data;
  } catch (err) {
    await cancelResponseBodyQuietly(res);
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.error("[sync-stablecoins] CoinGecko batch mcap payload parse failed:", err);
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.CG_MCAP, false);
    return {};
  }
}

export async function fetchSupplementalTrackedTokens(
  cgData: CoinGeckoMcapData,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
  fxFallbackRates?: Record<string, number>,
): Promise<{
  goldTokens: PeggedAsset[];
  silverTokens: PeggedAsset[];
  fiatCgTokens: PeggedAsset[];
}> {
  throwIfAborted(signal);
  // Two-phase fan-out so gold's own batched protocol fetches plus silver's
  // CG calls don't pile on top of fiat-cg simultaneously and exhaust the
  // Cloudflare 6-connection pool. Sockets opened in the first phase are
  // reclaimed before fiat-cg starts.
  const [goldTokens, silverTokens] = await Promise.all([
    fetchGoldTokens(cgData, signal),
    fetchSilverTokens(cgData, signal, coingeckoApiKey),
  ]);
  const fiatCgTokens = await fetchFiatCoinGeckoTokens(cgData, signal, chainRpcs, fxFallbackRates);

  return { goldTokens, silverTokens, fiatCgTokens };
}
