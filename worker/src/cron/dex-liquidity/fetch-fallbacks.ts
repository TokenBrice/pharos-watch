import { TRACKED_STABLECOINS } from "../../../../src/lib/stablecoins";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { USER_AGENT } from "../../lib/constants";
import { cgUrl, cgHeaders } from "../../lib/coingecko";
import { fetchDsTokenPools, dsRateLimit, DS_CHAIN_MAP } from "../../lib/dexscreener";
import { QUALITY_MULTIPLIERS, GT_DEX_QUALITY } from "../../lib/dex-constants";
import type { LiquidityMetrics, DexPriceObs, GtNewPool, CgTicker } from "./types";
import { normalizeProtocol } from "./pool-helpers";
import {
  CG_TICKERS_RATE_MS,
  ORDERBOOK_TVL_FACTOR, USD_QUOTE_COIN_IDS,
} from "./constants";

/** DexScreener fallback: fetch pools for tracked stablecoins with 0 pools in the main pipeline. */
export async function fetchDsFallbackPools(
  metrics: Map<string, LiquidityMetrics>,
  knownPoolAddrs: Set<string>,
  signal?: AbortSignal,
): Promise<{ newPools: Map<string, GtNewPool[]>; priceObs: Map<string, DexPriceObs[]> }> {
  const newPools = new Map<string, GtNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();
  const nowSec = Date.now() / 1000;

  // Find tracked coins with no pools from the main pipeline
  const zeroCoinIds = new Set<string>();
  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.contracts?.length) continue;
    const m = metrics.get(meta.id);
    if (!m || m.poolCount === 0) zeroCoinIds.add(meta.id);
  }

  if (zeroCoinIds.size === 0) {
    console.log("[dex-liquidity] DexScreener fallback: no zero-pool coins, skipping");
    return { newPools, priceObs };
  }

  console.log(`[dex-liquidity] DexScreener fallback: querying ${zeroCoinIds.size} zero-pool coins`);

  let requests = 0;
  let poolsFound = 0;

  for (const meta of TRACKED_STABLECOINS) {
    if (!zeroCoinIds.has(meta.id)) continue;
    if (!meta.contracts?.length) continue;

    for (const contract of meta.contracts) {
      if (!DS_CHAIN_MAP[contract.chain]) continue;

      if (requests > 0) await dsRateLimit();
      requests++;

      const pairs = await fetchDsTokenPools(contract.chain, contract.address, signal);
      if (pairs.length === 0) continue;

      for (const pair of pairs) {
        // Quality gates
        const tvl = pair.liquidity?.usd ?? 0;
        if (tvl < 1_000) continue;
        const vol24h = pair.volume?.h24 ?? 0;
        if (vol24h === 0 && tvl < 10_000) continue;

        // Dedup against known pool addresses + token-pair fingerprints
        const poolKey = `${contract.chain}:${pair.pairAddress.toLowerCase()}`;
        const baseAddr = pair.baseToken.address.toLowerCase();
        const quoteAddr = pair.quoteToken.address.toLowerCase();
        const sortedTokens = [baseAddr, quoteAddr].sort().join(":");
        const fpKey = `fp:${contract.chain}:${normalizeProtocol(pair.dexId)}:${sortedTokens}`;
        if (knownPoolAddrs.has(poolKey) || knownPoolAddrs.has(fpKey)) continue;
        knownPoolAddrs.add(poolKey);

        // Ensure our token is the base token (not some random meme pairing)
        const isBase = baseAddr === contract.address.toLowerCase();
        if (!isBase) continue;

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

        // Parse price for the GtNewPool price field
        const price = parseFloat(pair.priceUsd ?? "") || 0;

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
          price,
          symbol: symbolStr,
        });
        newPools.set(meta.id, poolList);
        poolsFound++;

        // Price observation
        if (price >= 0.5 && price <= 2.0 && tvl >= 10_000) {
          const obs = priceObs.get(meta.id) ?? [];
          obs.push({ price, tvl, chain: contract.chain, protocol: `dexscreener-${pair.dexId}` });
          priceObs.set(meta.id, obs);
        }
      }
    }
  }

  console.log(
    `[dex-liquidity] DexScreener fallback: ${requests} requests, ${poolsFound} pools found for ${newPools.size} coins`
  );
  return { newPools, priceObs };
}

/**
 * CoinGecko tickers fallback: fetch trading data for zero-pool coins that
 * are listed on orderbook exchanges tracked by CoinGecko (e.g. Kinesis Money).
 *
 * Runs after DexScreener; only targets coins that still have 0 pools AND
 * have a geckoId configured. Creates one synthetic GtNewPool per exchange,
 * aggregating all non-stale USD-denominated pairs.
 *
 * Synthetic TVL = totalVolume × ORDERBOOK_TVL_FACTOR (order-book depth proxy).
 */
export async function fetchCgTickersFallback(
  metrics: Map<string, LiquidityMetrics>,
  signal?: AbortSignal,
): Promise<{ newPools: Map<string, GtNewPool[]>; priceObs: Map<string, DexPriceObs[]> }> {
  const newPools = new Map<string, GtNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();

  const targetCoins = TRACKED_STABLECOINS.filter((meta) => {
    if (!meta.geckoId) return false;
    const m = metrics.get(meta.id);
    return !m || m.poolCount === 0;
  });

  if (targetCoins.length === 0) {
    console.log("[dex-liquidity] CG tickers fallback: no zero-pool coins with geckoId, skipping");
    return { newPools, priceObs };
  }

  console.log(`[dex-liquidity] CG tickers fallback: querying ${targetCoins.length} coins`);

  for (const meta of targetCoins) {
    try {
      const url = cgUrl(`/coins/${meta.geckoId}/tickers?include_exchange_logo=false&order=trust_score_desc&depth=false`);
      const timeout = AbortSignal.timeout(10_000);
      const res = await fetchWithRetry(url, {
        headers: cgHeaders({ "User-Agent": USER_AGENT }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res?.ok) {
        await new Promise((r) => setTimeout(r, CG_TICKERS_RATE_MS));
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
        await new Promise((r) => setTimeout(r, CG_TICKERS_RATE_MS));
        continue;
      }

      // Aggregate by exchange identifier
      const byExchange = new Map<string, { name: string; volume: number; price: number }>();
      for (const t of valid) {
        const id = t.market.identifier;
        const entry = byExchange.get(id);
        if (entry) {
          entry.volume += t.converted_volume.usd;
        } else {
          byExchange.set(id, {
            name: t.market.name,
            volume: t.converted_volume.usd,
            price: t.converted_last.usd,
          });
        }
      }

      const pools: GtNewPool[] = [];
      for (const [exchangeId, exch] of byExchange) {
        const syntheticTvl = exch.volume * ORDERBOOK_TVL_FACTOR;

        // Price observation (only if price is plausible — skip if near 0)
        if (exch.price > 0) {
          const obs = priceObs.get(meta.id) ?? [];
          obs.push({
            price: exch.price,
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
          price: exch.price,
          // Use "USDC" as quote symbol so computePoolPairQuality returns 1.0
          symbol: `${meta.symbol} / USDC`,
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

      await new Promise((r) => setTimeout(r, CG_TICKERS_RATE_MS));
    } catch (err) {
      console.warn(`[dex-liquidity] CG tickers fallback error for ${meta.symbol}:`, err);
    }
  }

  console.log(`[dex-liquidity] CG tickers fallback: done, ${newPools.size} coins with orderbook data`);
  return { newPools, priceObs };
}
