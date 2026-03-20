import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { ContractDeployment } from "@shared/types";
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { dsRateLimit, fetchDsTokenPools, getDsTrackedTokenPriceUsd } from "../../lib/dexscreener";
import { CHAIN_REGISTRY, CG_CHAIN_MAP, GT_CHAIN_MAP, DS_CHAIN_MAP } from "../../lib/chain-registry";
import { normalizeProtocol, getGtDexQuality } from "../dex-liquidity/pool-helpers";
import { crawlTokenPools, type CrawlToken } from "../dex-liquidity/crawl-helpers";
import { fetchGtTokenPools, getGtPoolType, parseGtPool } from "../dex-liquidity/geckoterminal-shared";
import { makeChainAddressKey } from "../dex-liquidity/token-resolution";
import { CG_TICKERS_RATE_MS, ORDERBOOK_TVL_FACTOR, USD_QUOTE_COIN_IDS } from "../dex-liquidity/constants";
import { QUALITY_MULTIPLIERS } from "../../lib/dex-constants";
import { fetchCgTokenPools, parseCgPoolVolume } from "../../lib/coingecko-onchain";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { USER_AGENT, DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { isPlausibleDexObservationPrice } from "../dex-liquidity/price-sanity";
import type { GtPool, DexPriceObs, GtNewPool } from "../dex-liquidity/types";
import type { StagedPool } from "./types";

export interface CrawlResult {
  pools: StagedPool[];
  priceObs: Array<{
    stablecoinId: string;
    price: number;
    tvl: number;
    chain: string;
    protocol: string;
  }>;
  unresolvedChains: string[];
}

export async function crawlCoin(
  stablecoinId: string,
  coinTargets: ContractDeployment[],
  cgApiKey: string | null,
  knownPoolIds: Set<string>,
  signal?: AbortSignal,
  deadlineMs?: number,
  references?: PriceValidationReferences,
): Promise<CrawlResult> {
  const pools: StagedPool[] = [];
  const priceObs: CrawlResult["priceObs"] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const stablecoinMeta = ACTIVE_STABLECOINS.find((s) => s.id === stablecoinId);
  const cgQueriedChains = new Set<string>();
  const unresolvedChains: string[] = [];

  const timeExceeded = (): boolean => !!deadlineMs && Date.now() >= deadlineMs;
  const addPool = (pool: StagedPool): void => {
    pools.push(pool);
    knownPoolIds.add(pool.poolId);
  };
  const addPriceObs = (obs: DexPriceObs & { stablecoinId: string }): void => {
    priceObs.push(obs);
  };

  // Stage 1: CoinGecko Onchain (requires API key)
  if (cgApiKey?.trim()) {
    let cgRequests = 0;

    for (const { chain, address } of coinTargets) {
      throwIfAborted(signal);
      if (timeExceeded()) return { pools, priceObs, unresolvedChains };

      const registry = CHAIN_REGISTRY[chain];
      const cgNetwork = CG_CHAIN_MAP[chain] ?? registry?.coingecko;
      if (!cgNetwork) {
        console.warn(`[dex-discovery] Chain "${chain}" not in CG registry for ${stablecoinId}, skipping`);
        unresolvedChains.push(chain);
        continue;
      }

      if (cgRequests > 0) {
        await sleepWithSignal(RATE_LIMITS.COINGECKO_ONCHAIN_MS, signal);
      }
      cgRequests++;
      cgQueriedChains.add(chain);

      try {
        const rawPools = await fetchCgTokenPools(cgNetwork, address.toLowerCase(), signal, cgApiKey);
        for (const pool of rawPools) {
          const attrs = pool.attributes;
          const poolAddress = attrs.address?.toLowerCase();
          if (!poolAddress) continue;

          const baseToken = pool.relationships.base_token.data.id.split("_").pop()?.toLowerCase() ?? "";
          const quoteToken = pool.relationships.quote_token.data.id.split("_").pop()?.toLowerCase() ?? "";
          const poolId = `${chain.toLowerCase()}:${poolAddress}`;
          if (knownPoolIds.has(poolId)) continue;

          const side =
            address.toLowerCase() === baseToken ? "base" : address.toLowerCase() === quoteToken ? "quote" : null;
          if (!side) continue;

          const basePrice = parseFloat(attrs.base_token_price_usd ?? "");
          const quotePrice = parseFloat(attrs.quote_token_price_usd ?? "");
          const priceRaw = side === "base" ? basePrice : quotePrice;
          const tvlUsd = parseFloat(attrs.reserve_in_usd ?? "");
          if (!Number.isFinite(tvlUsd) || tvlUsd < 1_000) continue;
          const volume24h = parseCgPoolVolume(attrs);
          if (tvlUsd > 0 && volume24h / tvlUsd > 50) continue;

          const feePct = attrs.pool_fee_percentage != null ? parseFloat(attrs.pool_fee_percentage) : null;
          const feeTier = feePct != null && !isNaN(feePct) ? Math.round(feePct * 100) : null;
          const lockedLiqPct =
            attrs.locked_liquidity_percentage != null ? parseFloat(attrs.locked_liquidity_percentage) : null;

          let balanceRatio: number | null = null;
          if (basePrice > 0 && quotePrice > 0) {
            const ratio = Math.min(basePrice, quotePrice) / Math.max(basePrice, quotePrice);
            if (ratio > 0.5) balanceRatio = ratio;
          }

          const dexId = pool.relationships.dex.data.id;
          const protocol = normalizeProtocol(dexId);
          let qualityMultiplier: number;
          let poolType: string;
          if (feePct != null && !isNaN(feePct)) {
            if (feePct <= 0.01) {
              qualityMultiplier = QUALITY_MULTIPLIERS["uniswap-v3-1bp"]!;
              poolType = "cg-cl-1bp";
            } else if (feePct <= 0.05) {
              qualityMultiplier = QUALITY_MULTIPLIERS["uniswap-v3-5bp"]!;
              poolType = "cg-cl-5bp";
            } else if (feePct <= 0.3) {
              qualityMultiplier = QUALITY_MULTIPLIERS["uniswap-v3-30bp"]!;
              poolType = "cg-cl-30bp";
            } else {
              qualityMultiplier = QUALITY_MULTIPLIERS["generic"]!;
              poolType = "cg-wide-fee";
            }
          } else {
            qualityMultiplier = getGtDexQuality(dexId);
            poolType =
              dexId.includes("v3") || dexId.includes("v4")
                ? "cg-concentrated"
                : dexId.includes("stable")
                  ? "cg-stable-amm"
                  : "cg-amm";
          }

          const stagedPool: StagedPool = {
            poolId,
            stablecoinId,
            source: "cg_onchain",
            chain,
            protocol,
            dexId,
            symbol: attrs.name,
            tvlUsd,
            volume24h,
            qualityMultiplier,
            poolType,
            feeTier,
            balanceRatio,
            isStable: null,
            baseToken,
            quoteToken,
            quoteSymbol: null,
            priceUsd: Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null,
            lockedLiqPct: lockedLiqPct != null && !isNaN(lockedLiqPct) ? lockedLiqPct : null,
            rawJson: null,
            discoveredAt: nowSec,
            refreshedAt: nowSec,
          };

          addPool(stagedPool);

          if (
            stagedPool.priceUsd != null &&
            isPlausibleDexObservationPrice(stablecoinId, stagedPool.priceUsd, references) &&
            tvlUsd >= DEX_PRICE_OBSERVATION_MIN_TVL_USD
          ) {
            addPriceObs({
              stablecoinId,
              price: stagedPool.priceUsd,
              tvl: tvlUsd,
              chain,
              protocol: dexId,
            });
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn(`[dex-discovery] cg_onchain error for ${chain}:${address}`, err);
      }
    }
  }

  // Stage 2: GeckoTerminal (chains not already covered by CG)
  const gtTokens: CrawlToken[] = [];
  const gtChainAddressToId = new Map<string, string>();
  for (const { chain, address } of coinTargets) {
    const registry = CHAIN_REGISTRY[chain];
    const gtNetwork = GT_CHAIN_MAP[chain] ?? registry?.geckoTerminal;
    if (!gtNetwork) continue;
    if (cgQueriedChains.has(chain)) continue; // already handled by CG onchain
    gtTokens.push({
      sourceChain: gtNetwork,
      ourChain: chain,
      address: address.toLowerCase(),
      stablecoinId,
    });
    gtChainAddressToId.set(makeChainAddressKey(chain, address), stablecoinId);
  }

  if (gtTokens.length > 0 && !timeExceeded()) {
    const gtNewPools = new Map<
      string,
      (GtNewPool & { baseToken: string; quoteToken: string; quoteSymbol: string | null })[]
    >();
    const gtPriceObs = new Map<string, DexPriceObs[]>();

    await crawlTokenPools<GtPool, GtNewPool & { baseToken: string; quoteToken: string; quoteSymbol: string | null }>({
      sourceLabel: "GT",
      tokens: gtTokens,
      chainAddressToId: gtChainAddressToId,
      knownPoolAddrs: knownPoolIds,
      protocolTvlCaps: new Map(),
      newPools: gtNewPools,
      priceObs: gtPriceObs,
      references,
      stats: {
        requests: 0,
        poolsSeen: 0,
        poolsNew: 0,
        poolsSkippedCurve: 0,
        poolsSkippedKnown: 0,
        poolsSkippedRatio: 0,
      },
      signal,
      minTvlUsd: 1_000,
      beforeRequest: async ({ requestCount }) => {
        if (timeExceeded()) return false;
        if (requestCount > 0) await sleepWithSignal(RATE_LIMITS.GECKO_TERMINAL_MS, signal);
        return true;
      },
      fetchPools: fetchGtTokenPools,
      parsePool: parseGtPool,
      buildNewPool: ({ parsed, chain, price, cappedTvlUsd, maturityDays }) => ({
        address: parsed.poolAddress,
        chain,
        dexId: parsed.dexId,
        name: parsed.poolName,
        tvlUsd: cappedTvlUsd,
        volume24hUsd: parsed.volume24hUsd,
        qualityMultiplier: getGtDexQuality(parsed.dexId),
        maturityDays,
        poolType: getGtPoolType(parsed.dexId),
        price,
        symbol: parsed.poolName,
        baseToken: parsed.baseTokenAddress,
        quoteToken: parsed.quoteTokenAddress,
        quoteSymbol: null,
        sourceFamily: "gecko_terminal",
      }),
    });

    const gtPools = gtNewPools.get(stablecoinId) ?? [];
    for (const pool of gtPools) {
      const poolId = `${pool.chain.toLowerCase()}:${pool.address.toLowerCase()}`;
      if (knownPoolIds.has(poolId)) continue;
      if (pool.volume24hUsd <= 0 && pool.tvlUsd < 10_000) continue;

      const stagedPool: StagedPool = {
        poolId,
        stablecoinId,
        source: "gecko_terminal",
        chain: pool.chain,
        protocol: normalizeProtocol(pool.dexId),
        dexId: pool.dexId,
        symbol: pool.name,
        tvlUsd: pool.tvlUsd,
        volume24h: pool.volume24hUsd,
        qualityMultiplier: pool.qualityMultiplier,
        poolType: pool.poolType,
        feeTier: null,
        balanceRatio: null,
        isStable: null,
        baseToken: pool.baseToken || null,
        quoteToken: pool.quoteToken || null,
        quoteSymbol: pool.quoteSymbol,
        priceUsd: pool.price > 0 ? pool.price : null,
        lockedLiqPct: null,
        rawJson: null,
        discoveredAt: nowSec,
        refreshedAt: nowSec,
      };

      addPool(stagedPool);
    }

    const gtObs = gtPriceObs.get(stablecoinId) ?? [];
    for (const obs of gtObs) {
      addPriceObs({ ...obs, stablecoinId });
    }
  }

  // Stage 3: DexScreener (gap-filler)
  const uncoveredChains: Array<[string, string]> = [];
  for (const { chain, address } of coinTargets) {
    const registry = CHAIN_REGISTRY[chain];
    const hasCg = !!(CG_CHAIN_MAP[chain] ?? registry?.coingecko);
    const hasGt = !!(GT_CHAIN_MAP[chain] ?? registry?.geckoTerminal);
    if (!hasCg && !hasGt) {
      uncoveredChains.push([chain, address]);
    }
  }

  const dsTargets =
    pools.length === 0 ? coinTargets.map(({ chain, address }) => [chain, address] as const) : uncoveredChains;

  if (dsTargets.length > 0 && !timeExceeded()) {
    let dsRequests = 0;

    for (const [chain, address] of dsTargets) {
      throwIfAborted(signal);
      if (timeExceeded()) return { pools, priceObs, unresolvedChains };

      const dsChain = DS_CHAIN_MAP[chain];
      if (!dsChain) continue;

      if (dsRequests > 0) await dsRateLimit(signal);
      dsRequests++;

      try {
        const pairs = await fetchDsTokenPools(chain, address, signal);
        if (pairs.length === 0) continue;

        for (const pair of pairs) {
          const tvl = pair.liquidity?.usd ?? 0;
          if (tvl < 1_000) continue;
          const vol24h = pair.volume?.h24 ?? 0;
          if (vol24h === 0 && tvl < 10_000) continue;
          if (tvl > 0 && vol24h / tvl > 50) continue; // Skip wash-traded pools (M-4)

          const poolAddress = pair.pairAddress?.toLowerCase();
          const dexId = pair.dexId;
          const baseAddr = pair.baseToken?.address?.toLowerCase();
          const quoteAddr = pair.quoteToken?.address?.toLowerCase();
          if (!poolAddress || !dexId || !baseAddr || !quoteAddr) {
            console.warn(`[dex-discovery] dexscreener malformed pair for ${chain}:${address}`, {
              pairAddress: pair.pairAddress ?? null,
              dexId: pair.dexId ?? null,
              baseToken: pair.baseToken?.address ?? null,
              quoteToken: pair.quoteToken?.address ?? null,
            });
            continue;
          }

          const poolId = `${chain.toLowerCase()}:${poolAddress}`;
          if (knownPoolIds.has(poolId)) continue;

          const { side, priceUsd } = getDsTrackedTokenPriceUsd(pair, address);
          if (!side) continue;

          addPool({
            poolId,
            stablecoinId,
            source: "dexscreener",
            chain,
            protocol: normalizeProtocol(dexId),
            dexId,
            symbol: `${pair.baseToken.symbol ?? stablecoinId} / ${pair.quoteToken.symbol ?? "UNKNOWN"}`,
            tvlUsd: tvl,
            volume24h: vol24h,
            qualityMultiplier: getGtDexQuality(dexId),
            poolType:
              pair.labels?.includes("CLMM") || pair.labels?.includes("V3")
                ? "ds-concentrated"
                : pair.labels?.includes("StableSwap")
                  ? "ds-stableswap"
                  : "ds-amm",
            feeTier: null,
            balanceRatio: null,
            isStable: null,
            baseToken: baseAddr,
            quoteToken: quoteAddr,
            quoteSymbol: pair.quoteToken?.symbol ?? null,
            priceUsd,
            lockedLiqPct: null,
            rawJson: null,
            discoveredAt: nowSec,
            refreshedAt: nowSec,
          });

          if (
            priceUsd != null &&
            tvl >= DEX_PRICE_OBSERVATION_MIN_TVL_USD &&
            isPlausibleDexObservationPrice(stablecoinId, priceUsd, references)
          ) {
            addPriceObs({
              stablecoinId,
              price: priceUsd,
              tvl,
              chain,
              protocol: `dexscreener-${dexId}`,
            });
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn(`[dex-discovery] dexscreener error for ${chain}:${address}`, err);
      }
    }
  }

  // Stage 4: CoinGecko Tickers (orderbook fallback)
  if ((pools.length === 0 || priceObs.length === 0) && !timeExceeded()) {
    const geckoId = stablecoinMeta?.geckoId;
    if (geckoId) {
      try {
        const url = cgUrl(`/coins/${geckoId}/tickers?include_exchange_logo=false&order=trust_score_desc&depth=false`, cgApiKey);
        const timeout = AbortSignal.timeout(10_000);
        const res = await fetchWithRetry(url, {
          headers: cgHeaders({ "User-Agent": USER_AGENT }, cgApiKey),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (res?.ok) {
          const data = (await res.json()) as {
            tickers?: Array<{
              base: string;
              target: string;
              market: { name: string; identifier: string };
              converted_last: { usd: number };
              converted_volume: { usd: number };
              target_coin_id?: string;
              is_anomaly: boolean;
              is_stale: boolean;
              trust_score: string | null;
            }>;
          };
          const valid = (data.tickers ?? []).filter((t) => {
            if (t.is_stale || t.is_anomaly || !t.trust_score) return false;
            const isUsdQuote =
              t.target === "USD" || (t.target_coin_id != null && USD_QUOTE_COIN_IDS.has(t.target_coin_id));
            return isUsdQuote && t.converted_volume.usd >= 1_000;
          });

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

          for (const [exchangeId, exch] of byExchange) {
            const syntheticTvl = exch.volume * ORDERBOOK_TVL_FACTOR;
            const poolId = `orderbook:${exchangeId}:${stablecoinId}`.toLowerCase();
            if (knownPoolIds.has(poolId)) continue;
            const price = exch.volume > 0 ? exch.priceVolumeWeightedSum / exch.volume : 0;

            addPool({
              poolId,
              stablecoinId,
              source: "cg_tickers",
              chain: "orderbook",
              protocol: exchangeId,
              dexId: exchangeId,
              symbol: `${stablecoinMeta?.symbol ?? stablecoinId} / USD`,
              tvlUsd: syntheticTvl,
              volume24h: exch.volume,
              qualityMultiplier: QUALITY_MULTIPLIERS["orderbook"],
              poolType: "orderbook",
              feeTier: null,
              balanceRatio: null,
              isStable: null,
              baseToken: null,
              quoteToken: null,
              quoteSymbol: "USD",
              priceUsd: price,
              lockedLiqPct: null,
              rawJson: null,
              discoveredAt: nowSec,
              refreshedAt: nowSec,
            });

            if (
              syntheticTvl >= DEX_PRICE_OBSERVATION_MIN_TVL_USD &&
              isPlausibleDexObservationPrice(stablecoinId, price, references)
            ) {
              addPriceObs({
                stablecoinId,
                price,
                tvl: syntheticTvl,
                chain: "orderbook",
                protocol: `cg-ticker-${exchangeId}`,
              });
            }
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn(`[dex-discovery] cg_tickers error for ${stablecoinId}`, err);
      } finally {
        await sleepWithSignal(CG_TICKERS_RATE_MS, signal);
      }
    }
  }

  return { pools, priceObs, unresolvedChains };
}
