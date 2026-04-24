import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { ContractDeployment } from "@shared/types/core";
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { dsRateLimit, fetchDsTokenPoolsWithStatus, getDsTrackedTokenPriceUsd } from "../../lib/dexscreener";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { CHAIN_REGISTRY, CG_CHAIN_MAP, GT_CHAIN_MAP, DS_CHAIN_MAP } from "../../lib/chain-registry";
import { normalizeProtocol, getGtDexQuality } from "../dex-liquidity/pool-helpers";
import { crawlTokenPools, type CrawlToken } from "../dex-liquidity/crawl-helpers";
import { fetchGtTokenPools, getGtPoolType, parseGtPool } from "../dex-liquidity/geckoterminal-shared";
import { makeChainAddressKey } from "../dex-liquidity/token-resolution";
import { CG_TICKERS_RATE_MS } from "../dex-liquidity/constants";
import { QUALITY_MULTIPLIERS } from "../../lib/dex-cron-constants";
import { fetchCgTokenPoolsWithStatus } from "../../lib/coingecko-onchain";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { USER_AGENT, DEX_PRICE_OBSERVATION_MIN_TVL_USD, CIRCUIT_SOURCE } from "../../lib/constants";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { isPlausibleDexObservationPrice } from "../dex-liquidity/price-sanity";
import type { GtPool, DexPriceObs, GtNewPool, CgTicker } from "../dex-liquidity/types";
import { classifyCgPool, parseCgPool } from "../dex-liquidity/coingecko-onchain-shared";
import {
  aggregateCgTickersByExchange,
  buildCgTickerExchangeSummaries,
  buildCgTickerOrderbookMetadata,
  buildCgTickerPriceObservations,
  filterValidCgTickers,
} from "../dex-liquidity/coingecko-tickers-shared";
import type { StagedPool } from "./types";

const DISCOVERY_STAGE_TIMEOUT_MS = {
  cgOnchain: 8_000,
  geckoTerminal: 8_000,
  dexscreener: 6_000,
  cgTickers: 6_000,
} as const;

function buildStageSignal(
  signal: AbortSignal | undefined,
  deadlineMs: number | undefined,
  timeoutMs: number,
): AbortSignal {
  const remainingMs = deadlineMs == null ? timeoutMs : Math.max(1, Math.min(timeoutMs, deadlineMs - Date.now()));
  const timeout = AbortSignal.timeout(remainingMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

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
  db: D1Database,
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
  const stablecoinMeta = TRACKED_META_BY_ID.get(stablecoinId);
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
  if (!cgApiKey?.trim()) {
    console.warn(`[dex-discovery] CG API key not configured — Stage 1 (CG onchain) skipped for ${stablecoinId}`);
  }
  const cgOnchainAllowed = cgApiKey?.trim()
    ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_ONCHAIN)
    : false;
  if (cgApiKey?.trim() && !cgOnchainAllowed) {
    console.warn(`[dex-discovery] CG onchain circuit open — Stage 1 skipped for ${stablecoinId}`);
  }
  if (cgApiKey?.trim() && cgOnchainAllowed) {
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
        const result = await fetchCgTokenPoolsWithStatus(
          cgNetwork,
          address.toLowerCase(),
          buildStageSignal(signal, deadlineMs, DISCOVERY_STAGE_TIMEOUT_MS.cgOnchain),
          cgApiKey,
          { maxRetries: 0, timeoutMs: DISCOVERY_STAGE_TIMEOUT_MS.cgOnchain },
        );
        await recordOutcome(db, CIRCUIT_SOURCE.CG_ONCHAIN, result.ok);
        const rawPools = result.pools;
        for (const pool of rawPools) {
          const parsed = parseCgPool(pool);
          if (!parsed) continue;

          const poolId = `${chain.toLowerCase()}:${parsed.poolAddress}`;
          if (knownPoolIds.has(poolId)) continue;

          const side =
            address.toLowerCase() === parsed.baseTokenAddress
              ? "base"
              : address.toLowerCase() === parsed.quoteTokenAddress
                ? "quote"
                : null;
          if (!side) continue;

          const priceRaw = side === "base" ? parsed.baseTokenPriceUsd : parsed.quoteTokenPriceUsd;
          const tvlUsd = parsed.tvlUsd;
          if (!Number.isFinite(tvlUsd) || tvlUsd < 1_000) continue;
          const volume24h = parsed.volume24hUsd;
          if (tvlUsd > 0 && volume24h / tvlUsd > 50) continue;

          const {
            qualityMultiplier,
            poolType,
            feePercentage,
            lockedLiquidityPct,
            balanceRatio,
          } = classifyCgPool(parsed, pool.attributes);
          const dexId = parsed.dexId;
          const protocol = normalizeProtocol(dexId);

          const stagedPool: StagedPool = {
            poolId,
            stablecoinId,
            source: "cg_onchain",
            chain,
            protocol,
            dexId,
            symbol: parsed.poolName,
            tvlUsd,
            volume24h,
            qualityMultiplier,
            poolType,
            feeTier: feePercentage != null ? Math.round(feePercentage * 100) : null,
            balanceRatio,
            isStable: null,
            baseToken: parsed.baseTokenAddress,
            quoteToken: parsed.quoteTokenAddress,
            quoteSymbol: null,
            priceUsd: Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null,
            lockedLiqPct: lockedLiquidityPct,
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
        await recordOutcome(db, CIRCUIT_SOURCE.CG_ONCHAIN, false);
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
      fetchPools: (tokenAddress, sourceChain, requestSignal) =>
        fetchGtTokenPools(
          tokenAddress,
          sourceChain,
          buildStageSignal(requestSignal, deadlineMs, DISCOVERY_STAGE_TIMEOUT_MS.geckoTerminal),
          0,
          DISCOVERY_STAGE_TIMEOUT_MS.geckoTerminal,
        ),
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

  if (dsTargets.length > 0 && !timeExceeded() && await shouldAttemptFetch(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES)) {
    let dsRequests = 0;

    for (const [chain, address] of dsTargets) {
      throwIfAborted(signal);
      if (timeExceeded()) return { pools, priceObs, unresolvedChains };

      const dsChain = DS_CHAIN_MAP[chain];
      if (!dsChain) continue;

      if (dsRequests > 0) await dsRateLimit(signal);
      dsRequests++;

      try {
        const result = await fetchDsTokenPoolsWithStatus(
          chain,
          address,
          buildStageSignal(signal, deadlineMs, DISCOVERY_STAGE_TIMEOUT_MS.dexscreener),
          DISCOVERY_STAGE_TIMEOUT_MS.dexscreener,
          0,
        );
        await recordOutcome(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES, result.ok);
        if (!result.ok) continue;
        const pairs = result.pairs;
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
        await recordOutcome(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES, false);
      }
    }
  }

  // Stage 4: CoinGecko Tickers (orderbook fallback)
  if ((pools.length === 0 || priceObs.length === 0) && !timeExceeded()) {
    const geckoId = stablecoinMeta?.geckoId;
    if (geckoId) {
      try {
        const url = cgUrl(`/coins/${geckoId}/tickers?include_exchange_logo=false&depth=true`, cgApiKey);
        const res = await fetchWithRetry(url, {
          headers: cgHeaders({ "User-Agent": USER_AGENT }, cgApiKey),
          signal: buildStageSignal(signal, deadlineMs, DISCOVERY_STAGE_TIMEOUT_MS.cgTickers),
        }, 0, { timeoutMs: DISCOVERY_STAGE_TIMEOUT_MS.cgTickers });
        if (res?.ok) {
          const data = (await res.json()) as { tickers?: CgTicker[] };
          const exchangeSummaries = buildCgTickerExchangeSummaries(
            aggregateCgTickersByExchange(filterValidCgTickers(data.tickers ?? [])),
          );

          for (const summary of exchangeSummaries) {
            // Canonical orderbook pool id — no stablecoin suffix. Multiple tracked stablecoins
            // sharing the same exchange map to the same poolId and dedup correctly downstream.
            const poolId = `orderbook:${summary.exchangeId}`.toLowerCase();
            if (knownPoolIds.has(poolId)) continue;
            const orderbookMetadata = buildCgTickerOrderbookMetadata(summary);

            addPool({
              poolId,
              stablecoinId,
              source: "cg_tickers",
              chain: "orderbook",
              protocol: summary.exchangeId,
              dexId: summary.exchangeId,
              symbol: `${stablecoinMeta?.symbol ?? stablecoinId} / USD`,
              tvlUsd: summary.syntheticTvlUsd,
              volume24h: summary.volumeUsd,
              qualityMultiplier: QUALITY_MULTIPLIERS["orderbook"],
              poolType: "orderbook",
              feeTier: null,
              balanceRatio: null,
              isStable: null,
              baseToken: null,
              quoteToken: null,
              quoteSymbol: "USD",
              priceUsd: summary.priceUsd,
              lockedLiqPct: null,
              rawJson: orderbookMetadata ? JSON.stringify(orderbookMetadata) : null,
              discoveredAt: nowSec,
              refreshedAt: nowSec,
            });
          }

          for (const observation of buildCgTickerPriceObservations(stablecoinId, exchangeSummaries, references)) {
            addPriceObs({ ...observation, stablecoinId });
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
