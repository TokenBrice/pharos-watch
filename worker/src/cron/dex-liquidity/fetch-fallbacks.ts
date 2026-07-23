import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { canonicalExitRouteScopedId } from "@shared/lib/exit-route-identity";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { USER_AGENT, DEX_PRICE_OBSERVATION_MIN_TVL_USD, CIRCUIT_SOURCE } from "../../lib/constants";
import { cgUrl, cgHeaders } from "../../lib/coingecko";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { fetchDsTokenPoolsWithStatus, dsRateLimit, DS_CHAIN_MAP } from "../../lib/dexscreener";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { logCronEvent } from "../../lib/cron-logger";
import { QUALITY_MULTIPLIERS, GT_DEX_QUALITY } from "../../lib/dex-cron-constants";
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import type { LiquidityMetrics, DexPriceObs, GtNewPool, CgTicker } from "./types";
import { getTrackedContracts } from "./pool-helpers";
import { getChainAwareDsTrackedTokenPriceUsd } from "./crawl-helpers";
import { CG_TICKERS_RATE_MS } from "./constants";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import {
  aggregateCgTickersByExchange,
  buildCgTickerExchangeSummaries,
  buildCgTickerOrderbookMetadata,
  buildCgTickerPriceObservations,
  filterValidCgTickers,
} from "./coingecko-tickers-shared";
import {
  buildPoolIdentity,
  getIdentityDedupReason,
  registerKnownPoolIdentity,
  type KnownPoolIdentityIndex,
  type PoolIdentity,
} from "./pool-identity";
import { toErrorMessage } from "../../lib/error-utils";
import { logWorkerEvent } from "../../lib/structured-log";

const WEAK_COVERAGE_MIN_POOL_COUNT = 3;
const WEAK_COVERAGE_MIN_PROTOCOL_COUNT = 2;
const WEAK_COVERAGE_MIN_TVL_USD = 250_000;
const WEAK_COVERAGE_MIN_MEASURED_BALANCE_SHARE = 0.25;
const DEXSCREENER_LIQUIDITY_CIRCUIT = CIRCUIT_SOURCE.DEXSCREENER_LIQUIDITY;

function needsCoverageEnrichment(metric: LiquidityMetrics | undefined, observations: DexPriceObs[]): boolean {
  if (!metric) return true;
  if (needsDexScreenerEnrichment(metric, observations)) return true;
  const measuredBalanceShare = metric.totalTvlUsd > 0 ? metric.totalTvlForBalance / metric.totalTvlUsd : 0;
  return measuredBalanceShare < WEAK_COVERAGE_MIN_MEASURED_BALANCE_SHARE;
}

function needsDexScreenerEnrichment(metric: LiquidityMetrics | undefined, observations: DexPriceObs[]): boolean {
  if (!metric) return true;
  if ((metric.poolCount ?? 0) === 0) return true;
  if (observations.length === 0) return true;

  const protocolCount = new Set(observations.map((observation) => observation.protocol)).size;

  if (metric.poolCount < WEAK_COVERAGE_MIN_POOL_COUNT) return true;
  if (protocolCount < WEAK_COVERAGE_MIN_PROTOCOL_COUNT) return true;
  if (metric.totalTvlUsd < WEAK_COVERAGE_MIN_TVL_USD) return true;

  return false;
}

function needsOrderbookFallback(metric: LiquidityMetrics | undefined, observations: DexPriceObs[]): boolean {
  if (!metric) return true;
  if ((metric.poolCount ?? 0) === 0) return true;
  if (observations.length === 0) return true;
  if ((metric.poolCount ?? 0) < WEAK_COVERAGE_MIN_POOL_COUNT && metric.totalTvlUsd < WEAK_COVERAGE_MIN_TVL_USD) {
    return true;
  }
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

export function getCgTickersFallbackTargets(
  metrics: Map<string, LiquidityMetrics>,
  priceObservations: Map<string, DexPriceObs[]>,
): typeof ACTIVE_STABLECOINS {
  return ACTIVE_STABLECOINS.filter((meta) => {
    if (!meta.geckoId) return false;
    const metric = metrics.get(meta.id);
    const observations = priceObservations.get(meta.id) ?? [];
    return needsOrderbookFallback(metric, observations);
  });
}

export function getDsFallbackTargets(
  metrics: Map<string, LiquidityMetrics>,
  priceObservations: Map<string, DexPriceObs[]>,
): typeof ACTIVE_STABLECOINS {
  return ACTIVE_STABLECOINS.filter((meta) => {
    if (getTrackedContracts(meta).length === 0) return false;
    return needsDexScreenerEnrichment(metrics.get(meta.id), priceObservations.get(meta.id) ?? []);
  });
}

/** DexScreener fallback: fetch pools for tracked stablecoins with missing pool or price coverage. */
export async function fetchDsFallbackPools(
  db: D1Database,
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
  const candidateExactKeys = new Set<string>();
  const candidateIdentityCounts = {
    derived: new Map<string, number>(),
    wildcard: new Map<string, number>(),
  };
  const priceObservationExactKeys = new Map<string, Set<string>>();

  const targetCoins = getDsFallbackTargets(metrics, priceObservations);

  if (targetCoins.length === 0) {
    await logCronEvent(db, {
      job: "sync-dex-liquidity",
      eventType: "dexscreener-fallback-skipped-no-targets",
      severity: "info",
      message: "DexScreener fallback skipped because no missing-coverage coins were targeted.",
    });
    return { newPools, priceObs };
  }

  if (!(await shouldAttemptFetch(db, DEXSCREENER_LIQUIDITY_CIRCUIT))) {
    await logCronEvent(db, {
      job: "sync-dex-liquidity",
      eventType: "dexscreener-fallback-circuit-open",
      severity: "warning",
      message: "DexScreener fallback skipped because its circuit breaker is open.",
    });
    return { newPools, priceObs };
  }

  await logCronEvent(db, {
    job: "sync-dex-liquidity",
    eventType: "dexscreener-fallback-started",
    severity: "info",
    message: "DexScreener fallback started.",
    metadata: { targetCoins: targetCoins.length },
  });

  let requests = 0;
  let successfulRequests = 0;
  let poolsFound = 0;

  const finalizeCandidates = () => {
    for (const candidate of candidates) {
      const dedupReason = getIdentityDedupReason(candidate.identity, knownPoolIndex, {
        derived: candidate.identity.derivedMatchKey
          ? (candidateIdentityCounts.derived.get(candidate.identity.derivedMatchKey) ?? 0)
          : 0,
        wildcard: candidate.identity.optionalWildcardKey
          ? (candidateIdentityCounts.wildcard.get(candidate.identity.optionalWildcardKey) ?? 0)
          : 0,
      });
      if (dedupReason) continue;

      registerKnownPoolIdentity(knownPoolIndex, candidate.identity);
      const poolList = newPools.get(candidate.stablecoinId) ?? [];
      poolList.push(candidate.pool);
      newPools.set(candidate.stablecoinId, poolList);
      poolsFound++;
    }
    candidates.length = 0;
    candidateExactKeys.clear();
    candidateIdentityCounts.derived.clear();
    candidateIdentityCounts.wildcard.clear();
    priceObservationExactKeys.clear();
  };

  const recordFallbackOutcome = async () => {
    if (requests > 0) {
      try {
        await recordOutcome(db, DEXSCREENER_LIQUIDITY_CIRCUIT, successfulRequests > 0);
      } catch (err) {
        logWorkerEvent({
          scope: "lib",
          level: "warn",
          event: "fallback_circuit_telemetry_failed",
          job: "sync-dex-liquidity",
          provider: "dexscreener",
          message: "Fallback circuit telemetry failed",
          error: err,
        });
      }
    }
  };

  for (const meta of targetCoins) {
    throwIfAborted(signal);
    if (deadlineMs && Date.now() >= deadlineMs) {
      finalizeCandidates();
      await logCronEvent(db, {
        job: "sync-dex-liquidity",
        eventType: "dexscreener-fallback-budget-exhausted",
        severity: "warning",
        message: "DexScreener fallback budget exhausted; yielding partial results.",
        metadata: { requests, phase: "between-coins" },
      });
      await recordFallbackOutcome();
      return { newPools, priceObs };
    }

    let malformedCount = 0;

    for (const contract of getTrackedContracts(meta)) {
      if (!DS_CHAIN_MAP[contract.chain]) continue;
      if (deadlineMs && Date.now() >= deadlineMs) {
        finalizeCandidates();
        await logCronEvent(db, {
          job: "sync-dex-liquidity",
          eventType: "dexscreener-fallback-budget-exhausted",
          severity: "warning",
          message: "DexScreener fallback budget exhausted; yielding partial results.",
          metadata: { requests, phase: "mid-coin" },
        });
        await recordFallbackOutcome();
        return { newPools, priceObs };
      }

      if (requests > 0) await dsRateLimit(signal);
      requests++;

      let result: Awaited<ReturnType<typeof fetchDsTokenPoolsWithStatus>>;
      try {
        result = await fetchDsTokenPoolsWithStatus(contract.chain, contract.address, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        await logCronEvent(db, {
          job: "sync-dex-liquidity",
          eventType: "dexscreener-fallback-fetch-failed",
          severity: "warning",
          message: "DexScreener fallback fetch failed for a tracked contract.",
          metadata: {
            stablecoinId: meta.id,
            symbol: meta.symbol,
            chain: contract.chain,
            error: toErrorMessage(err),
          },
        });
        continue;
      }
      if (result.ok) {
        successfulRequests++;
      }
      if (!result.ok) {
        await logCronEvent(db, {
          job: "sync-dex-liquidity",
          eventType: "dexscreener-fallback-unusable-response",
          severity: "warning",
          message: "DexScreener fallback returned an unusable response for a tracked contract.",
          metadata: {
            stablecoinId: meta.id,
            symbol: meta.symbol,
            chain: contract.chain,
            status: result.status ?? null,
            contentType: result.contentType ?? null,
            error: result.error ?? null,
          },
        });
        continue;
      }
      const pairs = result.pairs;
      if (pairs.length === 0) continue;

      for (const pair of pairs) {
        // Guard against malformed DexScreener responses (missing required token fields)
        if (!pair?.baseToken?.address || !pair?.quoteToken?.address || !pair?.pairAddress) {
          malformedCount++;
          continue;
        }
        if (!pair.dexId) continue;

        // Quality gates
        const tvl = pair.liquidity?.usd ?? 0;
        if (tvl < 1_000) continue;
        const vol24h = pair.volume?.h24 ?? 0;
        if (vol24h === 0 && tvl < 10_000) continue;

        const baseAddr = canonicalExitRouteScopedId(contract.chain, pair.baseToken.address);
        const quoteAddr = canonicalExitRouteScopedId(contract.chain, pair.quoteToken.address);
        const { side, priceUsd } = getChainAwareDsTrackedTokenPriceUsd(pair, contract.address, contract.chain);
        if (!side) continue;

        const pairIdentity = buildPoolIdentity({
          chain: contract.chain,
          protocol: pair.dexId,
          poolAddressOrId: pair.pairAddress,
          tokenAddresses: [baseAddr, quoteAddr],
        });

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
          const seenExactKeys = priceObservationExactKeys.get(meta.id) ?? new Set<string>();
          if (!pairIdentity.exactPoolKey || !seenExactKeys.has(pairIdentity.exactPoolKey)) {
            const obs = priceObs.get(meta.id) ?? [];
            obs.push({
              price: priceUsd,
              tvl,
              chain: contract.chain,
              protocol: pair.dexId,
              poolKey: pairIdentity.exactPoolKey ?? undefined,
              derivedMatchKey: pairIdentity.derivedMatchKey ?? undefined,
              identityConfidence: pairIdentity.exactPoolKey
                ? "exact"
                : pairIdentity.derivedMatchKey
                  ? "derived_ambiguous"
                  : "none",
              sourceFamily: "dexscreener",
            });
            priceObs.set(meta.id, obs);
            if (pairIdentity.exactPoolKey) {
              seenExactKeys.add(pairIdentity.exactPoolKey);
              priceObservationExactKeys.set(meta.id, seenExactKeys);
            }
          }
        }

        // Compute maturity
        let maturityDays = 0;
        if (pair.pairCreatedAt) {
          maturityDays = Math.max(0, Math.floor((nowSec - pair.pairCreatedAt / 1000) / DAY_SECONDS));
        }

        // Quality multiplier — use GT_DEX_QUALITY for known DEXes, generic fallback
        let qualMult = QUALITY_MULTIPLIERS["generic"]!;
        for (const [prefix, q] of GT_DEX_QUALITY) {
          if (pair.dexId.startsWith(prefix)) {
            qualMult = q;
            break;
          }
        }

        // Pool type inference
        let poolType = "generic";
        if (pair.labels?.includes("CLMM") || pair.labels?.includes("V3")) poolType = "concentrated";
        else if (pair.labels?.includes("StableSwap")) poolType = "stableswap";

        const symbolStr = `${pair.baseToken.symbol ?? "?"} / ${pair.quoteToken.symbol ?? "?"}`;

        if (pairIdentity.derivedMatchKey) {
          candidateIdentityCounts.derived.set(
            pairIdentity.derivedMatchKey,
            (candidateIdentityCounts.derived.get(pairIdentity.derivedMatchKey) ?? 0) + 1,
          );
        }
        if (pairIdentity.optionalWildcardKey) {
          candidateIdentityCounts.wildcard.set(
            pairIdentity.optionalWildcardKey,
            (candidateIdentityCounts.wildcard.get(pairIdentity.optionalWildcardKey) ?? 0) + 1,
          );
        }

        if (
          pairIdentity.exactPoolKey &&
          (knownPoolIndex.exactKeys.has(pairIdentity.exactPoolKey) || candidateExactKeys.has(pairIdentity.exactPoolKey))
        ) {
          continue;
        }
        if (pairIdentity.exactPoolKey) candidateExactKeys.add(pairIdentity.exactPoolKey);

        candidates.push({
          stablecoinId: meta.id,
          identity: pairIdentity,
          pool: {
            address: canonicalExitRouteScopedId(contract.chain, pair.pairAddress),
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

    if (malformedCount > 0) {
      await logCronEvent(db, {
        job: "sync-dex-liquidity",
        eventType: "dexscreener-fallback-malformed-pairs",
        severity: "warning",
        message: "DexScreener fallback returned malformed pairs for a tracked coin.",
        metadata: { stablecoinId: meta.id, malformedCount },
      });
    }
  }

  finalizeCandidates();
  await recordFallbackOutcome();

  await logCronEvent(db, {
    job: "sync-dex-liquidity",
    eventType: "dexscreener-fallback-completed",
    severity: "info",
    message: "DexScreener fallback completed.",
    metadata: { requests, poolsFound, coinsWithNewPools: newPools.size },
  });
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
 * Synthetic TVL uses CoinGecko 2% downside depth when available, capped by
 * totalVolume × ORDERBOOK_TVL_FACTOR; otherwise falls back to the volume proxy.
 */
export async function fetchCgTickersFallback(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  priceObservations: Map<string, DexPriceObs[]>,
  knownPoolIndex: KnownPoolIdentityIndex,
  signal?: AbortSignal,
  deadlineMs?: number,
  references?: PriceValidationReferences,
  coingeckoApiKey?: string | null,
): Promise<{ newPools: Map<string, GtNewPool[]>; priceObs: Map<string, DexPriceObs[]> }> {
  const newPools = new Map<string, GtNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();

  const targetCoins = getCgTickersFallbackTargets(metrics, priceObservations);

  if (targetCoins.length === 0) {
    await logCronEvent(db, {
      job: "sync-dex-liquidity",
      eventType: "cg-tickers-fallback-skipped-no-targets",
      severity: "info",
      message: "CoinGecko tickers fallback skipped because no missing-coverage geckoId coins were targeted.",
    });
    return { newPools, priceObs };
  }

  await logCronEvent(db, {
    job: "sync-dex-liquidity",
    eventType: "cg-tickers-fallback-started",
    severity: "info",
    message: "CoinGecko tickers fallback started.",
    metadata: { targetCoins: targetCoins.length },
  });

  for (const meta of targetCoins) {
    throwIfAborted(signal);
    if (deadlineMs && Date.now() >= deadlineMs) {
      await logCronEvent(db, {
        job: "sync-dex-liquidity",
        eventType: "cg-tickers-fallback-budget-exhausted",
        severity: "warning",
        message: "CoinGecko tickers fallback budget exhausted; yielding partial results.",
      });
      return { newPools, priceObs };
    }
    try {
      const url = cgUrl(
        `/coins/${meta.geckoId}/tickers?include_exchange_logo=false&depth=true`,
        coingeckoApiKey ?? null,
      );
      const timeout = AbortSignal.timeout(10_000);
      const result = await fetchJsonWithRetry<{ tickers?: CgTicker[] }>(url, {
        headers: cgHeaders({ "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!result?.response.ok) {
        await sleepWithSignal(CG_TICKERS_RATE_MS, signal);
        continue;
      }

      const data = result.body;
      const valid = filterValidCgTickers(data?.tickers ?? []);

      if (valid.length === 0) {
        await sleepWithSignal(CG_TICKERS_RATE_MS, signal);
        continue;
      }

      const exchangeSummaries = buildCgTickerExchangeSummaries(aggregateCgTickersByExchange(valid));

      const pools: GtNewPool[] = [];
      for (const summary of exchangeSummaries) {
        const orderbookAddress = `${summary.exchangeId}:${meta.id}`.toLowerCase();
        const identity = buildPoolIdentity({
          chain: "orderbook",
          protocol: "cg-tickers",
          poolAddressOrId: `orderbook:${orderbookAddress}`,
          tokenAddresses: [],
          poolType: "orderbook",
          feeTierBps: null,
          isStable: null,
        });
        const dedupReason = getIdentityDedupReason(identity, knownPoolIndex, { derived: 0, wildcard: 0 });
        if (dedupReason !== null) {
          continue;
        }
        registerKnownPoolIdentity(knownPoolIndex, identity);

        const orderbookMetadata = buildCgTickerOrderbookMetadata(summary);
        pools.push({
          address: orderbookAddress,
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
          ...(orderbookMetadata ?? {}),
          measurement: {
            tvlMeasured: summary.depthDownUsd != null,
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
        await logCronEvent(db, {
          job: "sync-dex-liquidity",
          eventType: "cg-tickers-fallback-coin-pools-found",
          severity: "info",
          message: "CoinGecko tickers fallback found orderbook liquidity for a tracked coin.",
          metadata: {
            stablecoinId: meta.id,
            symbol: meta.symbol,
            exchanges: pools.length,
            volume24hUsd: Math.round(totalVol),
          },
        });
      }

      await sleepWithSignal(CG_TICKERS_RATE_MS, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      await logCronEvent(db, {
        job: "sync-dex-liquidity",
        eventType: "cg-tickers-fallback-fetch-failed",
        severity: "warning",
        message: "CoinGecko tickers fallback failed for a tracked coin.",
        metadata: {
          stablecoinId: meta.id,
          symbol: meta.symbol,
          error: toErrorMessage(err),
        },
      });
    }
  }

  await logCronEvent(db, {
    job: "sync-dex-liquidity",
    eventType: "cg-tickers-fallback-completed",
    severity: "info",
    message: "CoinGecko tickers fallback completed.",
    metadata: { coinsWithOrderbookData: newPools.size },
  });
  return { newPools, priceObs };
}
