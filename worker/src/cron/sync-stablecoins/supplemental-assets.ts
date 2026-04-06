import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { StablecoinMeta } from "@shared/types/core";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import { CIRCUIT_SOURCE, DEFILLAMA_API, DEFILLAMA_COINS, USER_AGENT } from "../../lib/constants";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { resolveMarketCap } from "../../lib/resolve-market-cap";
import { throwIfAborted } from "../../lib/abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import { fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { DefiLlamaCoinPrice, PeggedAsset } from "./enrich-prices";

const COMMODITY_TOKENS = ACTIVE_STABLECOINS.filter(
  (stablecoin) => stablecoin.flags.pegCurrency === "GOLD" || stablecoin.flags.pegCurrency === "SILVER",
);

const GOLD_METAS = ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.flags.pegCurrency === "GOLD");
const SILVER_METAS = ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.flags.pegCurrency === "SILVER");
const FIAT_CG_METAS = ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.detailProvider === "coingecko");

function pegTypeKey(meta: StablecoinMeta): string {
  return `pegged${meta.flags.pegCurrency}`;
}

export type CoinGeckoMcapData = Record<string, { usd?: number; usd_market_cap?: number }>;

function toPositiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveSupplementalPrice(
  priceData: { coins: Record<string, DefiLlamaCoinPrice> },
  cgData: CoinGeckoMcapData,
  geckoId?: string,
): { price: number; source: "coingecko-mirror" | "coingecko" } | null {
  if (!geckoId) return null;

  const dlPrice = toPositiveFiniteNumber(priceData.coins[`coingecko:${geckoId}`]?.price);
  if (dlPrice != null) {
    return { price: dlPrice, source: "coingecko-mirror" };
  }

  const cgPrice = toPositiveFiniteNumber(cgData[geckoId]?.usd);
  if (cgPrice != null) {
    return { price: cgPrice, source: "coingecko" };
  }

  return null;
}

function buildSupplementalAsset(input: {
  meta: StablecoinMeta;
  priceResolution: { price: number; source: "coingecko-mirror" | "coingecko" };
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
    priceUpdatedAt: nowSec,
    priceObservedAt: nowSec,
    priceObservedAtMode: "local_fetch",
    priceSyncedAt: nowSec,
    supplySource: input.supplySource,
    circulating: { [pKey]: input.mcap },
    circulatingPrevDay: input.circulatingPrevDay != null ? { [pKey]: input.circulatingPrevDay } : null,
    circulatingPrevWeek: input.circulatingPrevWeek != null ? { [pKey]: input.circulatingPrevWeek } : null,
    circulatingPrevMonth: input.circulatingPrevMonth != null ? { [pKey]: input.circulatingPrevMonth } : null,
    chainCirculating: {},
    chains: ["Ethereum"],
    commodityOunces: input.meta.commodityOunces,
  } as PeggedAsset;
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
    console.warn(
      `[${logPrefix}] CG markets fetch failed (${cgMarketsRes?.status ?? "no response"}), falling back to cgData mcap`,
    );
    return new Map();
  }

  const cgMarketsRaw = await cgMarketsRes.json();
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

/** Fetch ERC-20 totalSupply for a coin's first EVM contract and return mcap = supply × price. */
async function fetchOnChainMcap(
  meta: StablecoinMeta,
  priceUsd: number,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<number | null> {
  const evmContract = meta.contracts?.find(
    (c) => c.chain !== "solana" && c.chain !== "stellar" && c.chain !== "tron",
  );
  if (!evmContract) return null;

  try {
    const raw = await fetchEvmUint256AtBlock(
      evmContract.chain,
      evmContract.address,
      TOTAL_SUPPLY_SELECTOR,
      "latest",
      { chainRpcs, signal, timeoutMs: 10_000 },
    );
    if (raw == null || raw <= 0n) return null;
    const supply = Number(raw) / 10 ** (evmContract.decimals ?? 18);
    const mcap = supply * priceUsd;
    if (!Number.isFinite(mcap) || mcap <= 0) return null;
    console.log(`[fiat-cg] On-chain supply fallback for ${meta.symbol}: ${supply.toFixed(2)} units → $${mcap.toFixed(2)} mcap`);
    return mcap;
  } catch (err) {
    console.warn(`[fiat-cg] On-chain supply probe failed for ${meta.symbol}: ${String(err).slice(0, 200)}`);
    return null;
  }
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
    const priceData = await fetchSupplementalPriceData(FIAT_CG_METAS, "fiat-cg", signal);

    const mcapMap: Record<string, number> = {};
    for (const token of FIAT_CG_METAS) {
      const mcap = token.geckoId ? toPositiveFiniteNumber(cgData[token.geckoId]?.usd_market_cap) : undefined;
      if (mcap && mcap > 0) mcapMap[token.id] = mcap;
    }

    const results = await Promise.all(
      FIAT_CG_METAS.map(async (meta) => {
        const nowSec = Math.floor(Date.now() / 1000);
        const pKey = pegTypeKey(meta);
        const priceResolution = resolveSupplementalPrice(priceData, cgData, meta.geckoId);
        const pegReferencePrice = toPositiveFiniteNumber(fxFallbackRates?.[pKey]);
        const priceForSupply = priceResolution?.price ?? pegReferencePrice;

        let mcap = mcapMap[meta.id];
        let supplySource: string = "coingecko-fallback";

        // Fallback: on-chain totalSupply × market/peg-reference price when CG has no market cap.
        // This keeps preview-only fiat assets in supply coverage without inventing a live market quote.
        if (!mcap && priceForSupply != null) {
          const onChainMcap = await fetchOnChainMcap(meta, priceForSupply, chainRpcs, signal);
          if (onChainMcap) {
            mcap = onChainMcap;
            supplySource = "onchain-total-supply";
          }
        }

        if (!mcap) {
          console.log(`[fiat-cg] No mcap for ${meta.symbol}, skipping`);
          return null;
        }

        return {
          id: meta.id,
          name: meta.name,
          symbol: meta.symbol,
          geckoId: meta.geckoId,
          pegType: pKey,
          pegMechanism: meta.flags.backing,
          price: priceResolution?.price ?? null,
          priceSource: priceResolution?.source,
          priceConfidence: priceResolution ? "single-source" : null,
          priceUpdatedAt: priceResolution ? nowSec : null,
          priceObservedAt: priceResolution ? nowSec : null,
          priceObservedAtMode: priceResolution ? "local_fetch" : null,
          priceSyncedAt: priceResolution ? nowSec : null,
          supplySource,
          circulating: { [pKey]: mcap },
          circulatingPrevDay: null,
          circulatingPrevWeek: null,
          circulatingPrevMonth: null,
          chainCirculating: {},
          chains: ["Ethereum"],
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
    cgUrl(`/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true`, coingeckoApiKey ?? null),
    {
      headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
      signal,
    },
  );

  if (!res || !res.ok) {
    console.error(`[sync-stablecoins] CoinGecko batch mcap fetch failed: ${res?.status ?? "no response"}`);
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.CG_MCAP, false);
    return {};
  }

  try {
    const data = (await res.json()) as CoinGeckoMcapData;
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.CG_MCAP, true);
    return data;
  } catch (err) {
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
  const [goldTokens, silverTokens, fiatCgTokens] = await Promise.all([
    fetchGoldTokens(cgData, signal),
    fetchSilverTokens(cgData, signal, coingeckoApiKey),
    fetchFiatCoinGeckoTokens(cgData, signal, chainRpcs, fxFallbackRates),
  ]);

  return { goldTokens, silverTokens, fiatCgTokens };
}
