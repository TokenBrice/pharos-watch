import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { USER_AGENT, DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { cgUrl, cgHeaders } from "../../lib/coingecko";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { fetchDsTokenPools, dsRateLimit, DS_CHAIN_MAP, getDsTrackedTokenPriceUsd } from "../../lib/dexscreener";
import { QUALITY_MULTIPLIERS, GT_DEX_QUALITY } from "../../lib/dex-constants";
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import type { LiquidityMetrics, DexPriceObs, GtNewPool, CgTicker } from "./types";
import { buildPoolFingerprint, getTrackedContracts } from "./pool-helpers";
import {
  CG_TICKERS_RATE_MS,
  ORDERBOOK_TVL_FACTOR, USD_QUOTE_COIN_IDS,
} from "./constants";
import { isPlausibleDexObservationPrice } from "./price-sanity";

export function getFallbackTargets(
  metrics: Map<string, LiquidityMetrics>,
  priceObservations: Map<string, DexPriceObs[]>,
  options: {
    requireGeckoId?: boolean;
    requireTrackedContracts?: boolean;
  } = {},
): typeof TRACKED_STABLECOINS {
  return TRACKED_STABLECOINS.filter((meta) => {
    if (options.requireGeckoId && !meta.geckoId) return false;
    if (options.requireTrackedContracts && getTrackedContracts(meta).length === 0) return false;
    const metric = metrics.get(meta.id);
    const hasPools = (metric?.poolCount ?? 0) > 0;
    const hasDexPrice = (priceObservations.get(meta.id)?.length ?? 0) > 0;
    return !hasPools || !hasDexPrice;
  });
}

/** DexScreener fallback: fetch pools for tracked stablecoins with missing pool or price coverage. */
export async function fetchDsFallbackPools(
  metrics: Map<string, LiquidityMetrics>,
  priceObservations: Map<string, DexPriceObs[]>,
  knownPoolAddrs: Set<string>,
  signal?: AbortSignal,
  deadlineMs?: number,
  references?: PriceValidationReferences,
): Promise<{ newPools: Map<string, GtNewPool[]>; priceObs: Map<string, DexPriceObs[]> }> {
  const newPools = new Map<string, GtNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();
  const nowSec = Date.now() / 1000;

  const targetCoins = getFallbackTargets(metrics, priceObservations, { requireTrackedContracts: true });

  if (targetCoins.length === 0) {
    console.log("[dex-liquidity] DexScreener fallback: no missing-coverage coins, skipping");
    return { newPools, priceObs };
  }

  console.log(`[dex-liquidity] DexScreener fallback: querying ${targetCoins.length} missing-coverage coins`);

  let requests = 0;
  let poolsFound = 0;

  for (const meta of targetCoins) {
    throwIfAborted(signal);
    if (deadlineMs && Date.now() >= deadlineMs) {
      console.log(`[dex-liquidity] DexScreener fallback budget exhausted after ${requests} requests, yielding partial results`);
      return { newPools, priceObs };
    }

    for (const contract of getTrackedContracts(meta)) {
      if (!DS_CHAIN_MAP[contract.chain]) continue;
      if (deadlineMs && Date.now() >= deadlineMs) {
        console.log(`[dex-liquidity] DexScreener fallback budget exhausted after ${requests} requests, yielding partial results`);
        return { newPools, priceObs };
      }

      if (requests > 0) await dsRateLimit(signal);
      requests++;

      const pairs = await fetchDsTokenPools(contract.chain, contract.address, signal);
      if (pairs.length === 0) continue;

      for (const pair of pairs) {
        // Quality gates
        const tvl = pair.liquidity?.usd ?? 0;
        if (tvl < 1_000) continue;
        const vol24h = pair.volume?.h24 ?? 0;
        if (vol24h === 0 && tvl < 10_000) continue;

        const baseAddr = pair.baseToken.address.toLowerCase();
        const quoteAddr = pair.quoteToken.address.toLowerCase();
        const { side, priceUsd } = getDsTrackedTokenPriceUsd(pair, contract.address);
        if (!side) continue;

        // Extract price observation BEFORE dedup check.
        // DL yields pools provide pool metrics but never prices; DexScreener pairs
        // carry priceUsd. Dedup correctly prevents double-counting TVL in dex_liquidity,
        // but price observations feed dex_prices via TVL-weighted median.
        if (
          priceUsd != null &&
          isPlausibleDexObservationPrice(meta.id, priceUsd, references) &&
          tvl >= DEX_PRICE_OBSERVATION_MIN_TVL_USD
        ) {
          const obs = priceObs.get(meta.id) ?? [];
          obs.push({ price: priceUsd, tvl, chain: contract.chain, protocol: `dexscreener-${pair.dexId}` });
          priceObs.set(meta.id, obs);
        }

        // Dedup against known pool addresses + token-pair fingerprints
        const poolKey = `${contract.chain}:${pair.pairAddress.toLowerCase()}`;
        const fpKey = buildPoolFingerprint(contract.chain, pair.dexId, [baseAddr, quoteAddr]);
        if (knownPoolAddrs.has(poolKey) || (fpKey != null && knownPoolAddrs.has(fpKey))) continue;
        knownPoolAddrs.add(poolKey);

        // Compute maturity
        let maturityDays = 0;
        if (pair.pairCreatedAt) {
          maturityDays = Math.max(0, Math.floor((nowSec - pair.pairCreatedAt / 1000) / 86400));
        }

        // Quality multiplier — use GT_DEX_QUALITY for known DEXes, generic fallback
        let qualMult = QUALITY_MULTIPLIERS["generic"]!;
        for (const [prefix, q] of GT_DEX_QUALITY) {
          if (pair.dexId.startsWith(prefix)) { qualMult = q; break; }
        }

        // Pool type inference
        let poolType = "generic";
        if (pair.labels?.includes("CLMM") || pair.labels?.includes("V3")) poolType = "concentrated";
        else if (pair.labels?.includes("StableSwap")) poolType = "stableswap";

        const symbolStr = `${pair.baseToken.symbol} / ${pair.quoteToken.symbol}`;

        const poolList = newPools.get(meta.id) ?? [];
        poolList.push({
          address: pair.pairAddress.toLowerCase(),
          chain: contract.chain,
          dexId: pair.dexId,
          name: symbolStr,
          tvlUsd: tvl,
          volume24hUsd: vol24h,
          qualityMultiplier: qualMult,
          maturityDays,
          poolType,
          price: priceUsd ?? 0,
          symbol: symbolStr,
          sourceFamily: "dexscreener",
        });
        newPools.set(meta.id, poolList);
        poolsFound++;
      }
    }
  }

  console.log(
    `[dex-liquidity] DexScreener fallback: ${requests} requests, ${poolsFound} pools found for ${newPools.size} coins`
  );
  return { newPools, priceObs };
}

/**
 * CoinGecko tickers fallback: fetch trading data for missing-coverage coins that
 * are listed on orderbook exchanges tracked by CoinGecko (e.g. Kinesis Money).
 *
 * Runs after DexScreener; targets coins that still lack pools or a usable
 * DEX price and have a geckoId configured. Creates one synthetic GtNewPool per exchange,
 * aggregating all non-stale USD-denominated pairs.
 *
 * Synthetic TVL = totalVolume × ORDERBOOK_TVL_FACTOR (order-book depth proxy).
 */
export async function fetchCgTickersFallback(
  metrics: Map<string, LiquidityMetrics>,
  priceObservations: Map<string, DexPriceObs[]>,
  signal?: AbortSignal,
  deadlineMs?: number,
  references?: PriceValidationReferences,
): Promise<{ newPools: Map<string, GtNewPool[]>; priceObs: Map<string, DexPriceObs[]> }> {
  const newPools = new Map<string, GtNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();

  const targetCoins = getFallbackTargets(metrics, priceObservations, { requireGeckoId: true });

  if (targetCoins.length === 0) {
    console.log("[dex-liquidity] CG tickers fallback: no missing-coverage coins with geckoId, skipping");
    return { newPools, priceObs };
  }

  console.log(`[dex-liquidity] CG tickers fallback: querying ${targetCoins.length} coins`);

  for (const meta of targetCoins) {
    throwIfAborted(signal);
    if (deadlineMs && Date.now() >= deadlineMs) {
      console.log(`[dex-liquidity] CG tickers fallback budget exhausted, yielding partial results`);
      return { newPools, priceObs };
    }
    try {
      const url = cgUrl(`/coins/${meta.geckoId}/tickers?include_exchange_logo=false&order=trust_score_desc&depth=false`);
      const timeout = AbortSignal.timeout(10_000);
      const res = await fetchWithRetry(url, {
        headers: cgHeaders({ "User-Agent": USER_AGENT }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res?.ok) {
        await sleepWithSignal(CG_TICKERS_RATE_MS, signal);
        continue;
      }

      const data = (await res.json()) as { tickers?: CgTicker[] };
      const tickers = data?.tickers ?? [];

      // Keep: non-stale, non-anomaly, has trust score, USD-denominated quote, min $1k volume
      const valid = tickers.filter((t) => {
        if (t.is_stale || t.is_anomaly || !t.trust_score) return false;
        const isUsdQuote =
          t.target === "USD" ||
          (t.target_coin_id && USD_QUOTE_COIN_IDS.has(t.target_coin_id));
        return isUsdQuote && t.converted_volume.usd >= 1_000;
      });

      if (valid.length === 0) {
        await sleepWithSignal(CG_TICKERS_RATE_MS, signal);
        continue;
      }

      // Aggregate by exchange identifier
      const byExchange = new Map<string, { name: string; volume: number; priceVolumeWeightedSum: number }>();
      for (const t of valid) {
        const id = t.market.identifier;
        const entry = byExchange.get(id);
        if (entry) {
          entry.volume += t.converted_volume.usd;
          entry.priceVolumeWeightedSum += t.converted_last.usd * t.converted_volume.usd;
        } else {
          byExchange.set(id, {
            name: t.market.name,
            volume: t.converted_volume.usd,
            priceVolumeWeightedSum: t.converted_last.usd * t.converted_volume.usd,
          });
        }
      }

      const pools: GtNewPool[] = [];
      for (const [exchangeId, exch] of byExchange) {
        const syntheticTvl = exch.volume * ORDERBOOK_TVL_FACTOR;
        const price = exch.volume > 0 ? exch.priceVolumeWeightedSum / exch.volume : 0;

        // Price observation (only if price is plausible — skip if near 0)
        if (syntheticTvl >= DEX_PRICE_OBSERVATION_MIN_TVL_USD && isPlausibleDexObservationPrice(meta.id, price, references)) {
          const obs = priceObs.get(meta.id) ?? [];
          obs.push({
            price,
            tvl: syntheticTvl,
            chain: "orderbook",
            protocol: `cg-ticker-${exchangeId}`,
          });
          priceObs.set(meta.id, obs);
        }

        pools.push({
          address: `orderbook-${exchangeId}`,
          chain: "orderbook",
          dexId: exchangeId,
          name: exch.name,
          tvlUsd: syntheticTvl,
          volume24hUsd: exch.volume,
          qualityMultiplier: QUALITY_MULTIPLIERS["orderbook"],
          maturityDays: 365,
          poolType: "orderbook",
          price,
          // Use "USDC" as quote symbol so computePoolPairQuality returns 1.0
          symbol: `${meta.symbol} / USDC`,
          sourceFamily: "cg_tickers",
        });
      }

      if (pools.length > 0) {
        newPools.set(meta.id, pools);
        const totalVol = pools.reduce((s, p) => s + p.volume24hUsd, 0);
        console.log(
          `[dex-liquidity] CG tickers fallback: ${meta.symbol} → ${pools.length} exchange(s), ` +
          `$${Math.round(totalVol).toLocaleString()} vol/day`,
        );
      }

      await sleepWithSignal(CG_TICKERS_RATE_MS, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`[dex-liquidity] CG tickers fallback error for ${meta.symbol}:`, err);
    }
  }

  console.log(`[dex-liquidity] CG tickers fallback: done, ${newPools.size} coins with orderbook data`);
  return { newPools, priceObs };
}
