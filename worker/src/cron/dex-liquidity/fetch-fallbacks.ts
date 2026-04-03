import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { USER_AGENT, DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { cgUrl, cgHeaders } from "../../lib/coingecko";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { fetchDsTokenPools, dsRateLimit, DS_CHAIN_MAP, getDsTrackedTokenPriceUsd } from "../../lib/dexscreener";
import { QUALITY_MULTIPLIERS, GT_DEX_QUALITY } from "../../lib/dex-constants";
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import type { LiquidityMetrics, DexPriceObs, GtNewPool, CgTicker } from "./types";
import { getTrackedContracts } from "./pool-helpers";
import { CG_TICKERS_RATE_MS } from "./constants";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import {
  aggregateCgTickersByExchange,
  buildCgTickerExchangeSummaries,
  buildCgTickerPriceObservations,
  filterValidCgTickers,
} from "./coingecko-tickers-shared";
import {
  buildPoolIdentity,
  countPoolIdentityKeys,
  getIdentityDedupReason,
  registerKnownPoolIdentity,
  type KnownPoolIdentityIndex,
  type PoolIdentity,
} from "./pool-identity";

const WEAK_COVERAGE_MIN_POOL_COUNT = 3;
const WEAK_COVERAGE_MIN_PROTOCOL_COUNT = 2;
const WEAK_COVERAGE_MIN_TVL_USD = 250_000;
const WEAK_COVERAGE_MIN_MEASURED_BALANCE_SHARE = 0.25;

function needsCoverageEnrichment(
  metric: LiquidityMetrics | undefined,
  observations: DexPriceObs[],
): boolean {
  if (!metric) return true;
  if ((metric.poolCount ?? 0) === 0) return true;
  if (observations.length === 0) return true;

  const protocolCount = new Set(observations.map((observation) => observation.protocol)).size;
  const measuredBalanceShare = metric.totalTvlUsd > 0
    ? metric.totalTvlForBalance / metric.totalTvlUsd
    : 0;

  if (metric.poolCount < WEAK_COVERAGE_MIN_POOL_COUNT) return true;
  if (protocolCount < WEAK_COVERAGE_MIN_PROTOCOL_COUNT) return true;
  if (metric.totalTvlUsd < WEAK_COVERAGE_MIN_TVL_USD) return true;
  if (measuredBalanceShare < WEAK_COVERAGE_MIN_MEASURED_BALANCE_SHARE) return true;

  return false;
}

export function getFallbackTargets(
  metrics: Map<string, LiquidityMetrics>,
  priceObservations: Map<string, DexPriceObs[]>,
  options: {
    requireGeckoId?: boolean;
    requireTrackedContracts?: boolean;
  } = {},
): typeof ACTIVE_STABLECOINS {
  return ACTIVE_STABLECOINS.filter((meta) => {
    if (options.requireGeckoId && !meta.geckoId) return false;
    if (options.requireTrackedContracts && getTrackedContracts(meta).length === 0) return false;
    const metric = metrics.get(meta.id);
    const observations = priceObservations.get(meta.id) ?? [];
    return needsCoverageEnrichment(metric, observations);
  });
}

/** DexScreener fallback: fetch pools for tracked stablecoins with missing pool or price coverage. */
export async function fetchDsFallbackPools(
  metrics: Map<string, LiquidityMetrics>,
  priceObservations: Map<string, DexPriceObs[]>,
  knownPoolIndex: KnownPoolIdentityIndex,
  signal?: AbortSignal,
  deadlineMs?: number,
  references?: PriceValidationReferences,
): Promise<{ newPools: Map<string, GtNewPool[]>; priceObs: Map<string, DexPriceObs[]> }> {
  const newPools = new Map<string, GtNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();
  const nowSec = Date.now() / 1000;
  const candidates: Array<{
    stablecoinId: string;
    pool: GtNewPool;
    identity: PoolIdentity;
  }> = [];

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

      let pairs: Awaited<ReturnType<typeof fetchDsTokenPools>>;
      try {
        pairs = await fetchDsTokenPools(contract.chain, contract.address, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn(`[dex-liquidity] DexScreener fallback error for ${meta.symbol} on ${contract.chain}:`, err);
        continue;
      }
      if (pairs.length === 0) continue;

      for (const pair of pairs) {
        // Guard against malformed DexScreener responses (missing token fields)
        if (!pair?.baseToken?.address || !pair?.quoteToken?.address || !pair?.pairAddress) continue;
        if (!pair.dexId) continue;

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
        // carry priceUsd. These observations still feed diagnostics and later
        // retained-pool price eligibility, but dex_prices is now rebuilt only
        // from the final retained pool set after dedupe and filtering.
        if (
          priceUsd != null &&
          isPlausibleDexObservationPrice(meta.id, priceUsd, references) &&
          tvl >= DEX_PRICE_OBSERVATION_MIN_TVL_USD
        ) {
          const identity = buildPoolIdentity({
            chain: contract.chain,
            protocol: pair.dexId,
            poolAddressOrId: pair.pairAddress,
            tokenAddresses: [baseAddr, quoteAddr],
          });
          const obs = priceObs.get(meta.id) ?? [];
          obs.push({
            price: priceUsd,
            tvl,
            chain: contract.chain,
            protocol: pair.dexId,
            poolKey: identity.exactPoolKey ?? undefined,
            derivedMatchKey: identity.derivedMatchKey ?? undefined,
            identityConfidence: identity.exactPoolKey ? "exact" : identity.derivedMatchKey ? "derived_ambiguous" : "none",
            sourceFamily: "dexscreener",
          });
          priceObs.set(meta.id, obs);
        }

        // Compute maturity
        let maturityDays = 0;
        if (pair.pairCreatedAt) {
          maturityDays = Math.max(0, Math.floor((nowSec - pair.pairCreatedAt / 1000) / DAY_SECONDS));
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

        const symbolStr = `${pair.baseToken.symbol ?? "?"} / ${pair.quoteToken.symbol ?? "?"}`;

        candidates.push({
          stablecoinId: meta.id,
          identity: buildPoolIdentity({
            chain: contract.chain,
            protocol: pair.dexId,
            poolAddressOrId: pair.pairAddress,
            tokenAddresses: [baseAddr, quoteAddr],
          }),
          pool: {
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
          measurement: {
            tvlMeasured: true,
            volumeMeasured: true,
            balanceMeasured: false,
            maturityMeasured: pair.pairCreatedAt != null,
            priceMeasured: priceUsd != null && priceUsd > 0,
            synthetic: false,
          },
          },
        });
      }
    }
  }

  const identityCounts = countPoolIdentityKeys(candidates.map((candidate) => candidate.identity));
  for (const candidate of candidates) {
    const dedupReason = getIdentityDedupReason(candidate.identity, knownPoolIndex, {
      derived: candidate.identity.derivedMatchKey
        ? (identityCounts.derived.get(candidate.identity.derivedMatchKey) ?? 0)
        : 0,
      wildcard: candidate.identity.optionalWildcardKey
        ? (identityCounts.wildcard.get(candidate.identity.optionalWildcardKey) ?? 0)
        : 0,
    });
    if (dedupReason) continue;

    registerKnownPoolIdentity(knownPoolIndex, candidate.identity);
    const poolList = newPools.get(candidate.stablecoinId) ?? [];
    poolList.push(candidate.pool);
    newPools.set(candidate.stablecoinId, poolList);
    poolsFound++;
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
  coingeckoApiKey?: string | null,
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
      const url = cgUrl(`/coins/${meta.geckoId}/tickers?include_exchange_logo=false&order=trust_score_desc&depth=false`, coingeckoApiKey ?? null);
      const timeout = AbortSignal.timeout(10_000);
      const res = await fetchWithRetry(url, {
        headers: cgHeaders({ "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res?.ok) {
        await sleepWithSignal(CG_TICKERS_RATE_MS, signal);
        continue;
      }

      const data = (await res.json()) as { tickers?: CgTicker[] };
      const valid = filterValidCgTickers(data?.tickers ?? []);

      if (valid.length === 0) {
        await sleepWithSignal(CG_TICKERS_RATE_MS, signal);
        continue;
      }

      const exchangeSummaries = buildCgTickerExchangeSummaries(
        aggregateCgTickersByExchange(valid),
      );

      const pools: GtNewPool[] = [];
      for (const summary of exchangeSummaries) {
        pools.push({
          address: `orderbook-${summary.exchangeId}`,
          chain: "orderbook",
          dexId: summary.exchangeId,
          name: summary.exchangeName,
          tvlUsd: summary.syntheticTvlUsd,
          volume24hUsd: summary.volumeUsd,
          qualityMultiplier: QUALITY_MULTIPLIERS["orderbook"],
          maturityDays: 30,
          poolType: "orderbook",
          price: summary.priceUsd,
          symbol: `${meta.symbol} / ORDERBOOK-USD`,
          sourceFamily: "cg_tickers",
          pairQualityOverride: 0.85,
          measurement: {
            tvlMeasured: false,
            volumeMeasured: true,
            balanceMeasured: false,
            maturityMeasured: false,
            priceMeasured: true,
            synthetic: true,
          },
        });
      }

      const observations = buildCgTickerPriceObservations(meta.id, exchangeSummaries, references);
      if (observations.length > 0) {
        priceObs.set(meta.id, observations);
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
