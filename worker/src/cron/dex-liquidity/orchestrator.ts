import type { CronResult } from "../../lib/cron-logger";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { LlamaPool } from "./types";
import { CRAWL_BUDGETS } from "../../lib/rate-limit";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { loadPriceValidationReferences } from "../../lib/price-validation";
import type { DexPriceObs } from "./types";
import { buildPoolFingerprint, buildSymbolLookups } from "./pool-helpers";
import {
  fetchDataSources, buildCurveLookups, fetchUniV3Data,
  fetchAerodromeData, buildKnownPoolAddresses,
} from "./fetch-primary";
import { processPoolMetrics } from "./process-pools";
import { mergeStagedPools } from "./staging-merge";
import { mergeGtPools } from "./fetch-crawlers";
import { fetchDsFallbackPools, fetchCgTickersFallback } from "./fetch-fallbacks";
import { computeStablecoinScores, computeDepthStability, computeDexPrices } from "./scoring";
import { persistScores, writeHistoricalSnapshots } from "./persistence";
import { fetchFluidPools } from "./fetch-fluid";
import { fetchBalancerPools } from "./fetch-balancer";
import { fetchRaydiumPools } from "./fetch-raydium";
import { fetchOrcaPools } from "./fetch-orca";
import {
  convertToGtNewPools,
  extractPriceObservations,
  isEligibleDirectApiPool,
  makeDexApiFetchResult,
  type DexApiFetchResult,
  type DexApiPool,
} from "../../lib/dex-api-common";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcomeSafe } from "../../lib/circuit-breaker";

export function filterPrimaryPoolsPreferDirectApi(
  pools: LlamaPool[],
  directApiPools: DexApiPool[],
): {
  filteredPools: LlamaPool[];
  skippedByAddress: number;
  skippedByFingerprint: number;
} {
  const eligibleDirectApiPools = directApiPools.filter((pool) => isEligibleDirectApiPool(pool));
  const directApiAddresses = new Set(
    eligibleDirectApiPools.map((pool) => `${pool.chain.toLowerCase()}:${pool.poolAddress.toLowerCase()}`),
  );
  const directApiFingerprints = new Set(
    eligibleDirectApiPools
      .map((pool) => buildPoolFingerprint(pool.chain, pool.source, pool.tokens.map((token) => token.address)))
      .filter((fingerprint): fingerprint is string => fingerprint != null),
  );

  const filteredPools: LlamaPool[] = [];
  let skippedByAddress = 0;
  let skippedByFingerprint = 0;

  for (const pool of pools) {
    const poolKey = `${pool.chain.toLowerCase()}:${pool.pool.toLowerCase()}`;
    if (directApiAddresses.has(poolKey)) {
      skippedByAddress++;
      continue;
    }

    const fingerprint = buildPoolFingerprint(pool.chain, pool.project, pool.underlyingTokens ?? []);
    if (fingerprint != null && directApiFingerprints.has(fingerprint)) {
      skippedByFingerprint++;
      continue;
    }

    filteredPools.push(pool);
  }

  return { filteredPools, skippedByAddress, skippedByFingerprint };
}

export async function syncDexLiquidity(
  db: D1Database,
  graphApiKey: string | null,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);
  const failedSources: string[] = [];
  const criticalSourceFailures: string[] = [];
  const fallbackSignals: string[] = [];
  console.log(`[dex-liquidity] Starting sync`);
  throwIfAborted(signal);
  const validationReferences = await loadPriceValidationReferences(db);

  // 1. Fetch all external data sources
  const dataSources = await fetchDataSources(graphApiKey, db, signal);
  if (!dataSources) {
    throw new Error("dex-liquidity: catastrophic source failure (DL yields + Curve unavailable)");
  }
  if (!dataSources.dlYieldsAvailable) {
    console.log("[dex-liquidity] DL yields unavailable — pool coverage may be reduced");
    failedSources.push("defillama-yields");
    criticalSourceFailures.push("defillama-yields");
    fallbackSignals.push("dl-yields-unavailable");
  }
  if (!dataSources.dlProtocolsAvailable) {
    failedSources.push("defillama-protocols");
    criticalSourceFailures.push("defillama-protocols");
    fallbackSignals.push("dl-protocols-unavailable");
  }

  // Fetch direct API sources in parallel (non-fatal, circuit-breaker gated)
  // These run alongside the existing data source processing to maximize parallelism.
  // All response bodies are consumed inline (await res.json()), so connections are released promptly.
  const directApiFetchers: Array<{ name: string; circuitKey: string; fn: (s?: AbortSignal) => Promise<DexApiFetchResult> }> = [
    { name: "Fluid", circuitKey: CIRCUIT_SOURCE.FLUID_DEX_API, fn: fetchFluidPools },
    { name: "Balancer", circuitKey: CIRCUIT_SOURCE.BALANCER_API, fn: fetchBalancerPools },
    { name: "Raydium", circuitKey: CIRCUIT_SOURCE.RAYDIUM_API, fn: fetchRaydiumPools },
    { name: "Orca", circuitKey: CIRCUIT_SOURCE.ORCA_API, fn: fetchOrcaPools },
  ];

  const directApiPromise = Promise.all(
    directApiFetchers.map(async ({ name, circuitKey, fn }) => {
      if (!(await shouldAttemptFetch(db, circuitKey))) {
        console.log(`[dex-liquidity] ${name} API circuit open, skipping`);
        failedSources.push(circuitKey);
        criticalSourceFailures.push(circuitKey);
        fallbackSignals.push(`${circuitKey}-circuit-open`);
        return {
          name,
          circuitKey,
          result: makeDexApiFetchResult([], {
            ok: false,
            degraded: true,
            errors: ["circuit open"],
          }),
        };
      }
      try {
        const result = await fn(signal);
        await recordOutcomeSafe(db, circuitKey, result.ok);
        if (!result.ok || result.degraded) {
          failedSources.push(circuitKey);
          criticalSourceFailures.push(circuitKey);
        }
        if (!result.ok) {
          fallbackSignals.push(`${circuitKey}-unavailable`);
        } else if (result.degraded) {
          fallbackSignals.push(`${circuitKey}-partial`);
        }
        return { name, circuitKey, result };
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn(`[dex-liquidity] ${name} API failed (non-fatal):`, err);
        await recordOutcomeSafe(db, circuitKey, false);
        failedSources.push(circuitKey);
        criticalSourceFailures.push(circuitKey);
        fallbackSignals.push(`${circuitKey}-exception`);
        return {
          name,
          circuitKey,
          result: makeDexApiFetchResult([], {
            ok: false,
            degraded: true,
            errors: [err instanceof Error ? err.message : String(err)],
          }),
        };
      }
    }),
  );

  // 2. Build symbol/address lookup maps
  const { symbolToIds, addressToId } = buildSymbolLookups();

  // 3. Parse Curve data into pool lookups and price observations
  const { curvePoolMap, priceObservations } = await buildCurveLookups(
    dataSources.curveResponses, symbolToIds, addressToId, validationReferences,
  );

  // 4. Fetch Uniswap V3 subgraph data for fee tier enrichment + price observations
  let uniV3PoolFees = new Map<string, number>();
  let uniV3SymbolFees = new Map<string, number>();
  let uniV3PriceObs = new Map<string, DexPriceObs[]>();
  try {
    const uniV3Data = await fetchUniV3Data(
      graphApiKey, symbolToIds, addressToId, signal, validationReferences,
    );
    uniV3PoolFees = uniV3Data.uniV3PoolFees;
    uniV3SymbolFees = uniV3Data.uniV3SymbolFees;
    uniV3PriceObs = uniV3Data.uniV3PriceObs;
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.warn("[dex-liquidity] UniV3 fetch failed (non-fatal):", err);
    failedSources.push("univ3-subgraph");
  }
  if (addressToId.size > 0) {
    console.log(`[dex-liquidity] Learned ${addressToId.size} token addresses for disambiguation`);
  }

  // 4b. Fetch Aerodrome subgraph data for price observations + pool stability flags
  let aerodromePriceObs = new Map<string, DexPriceObs[]>();
  let aerodromeIsStable = new Map<string, boolean>();
  try {
    const aeroData = await fetchAerodromeData(graphApiKey, symbolToIds, addressToId, signal, validationReferences);
    aerodromePriceObs = aeroData.aerodromePriceObs;
    aerodromeIsStable = aeroData.aerodromeIsStable;
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.warn("[dex-liquidity] Aerodrome fetch failed (non-fatal):", err);
    failedSources.push("aerodrome-subgraph");
  }

  // Merge all price observations into a single map
  for (const [id, obs] of uniV3PriceObs) {
    const existing = priceObservations.get(id) ?? [];
    existing.push(...obs);
    priceObservations.set(id, existing);
  }
  for (const [id, obs] of aerodromePriceObs) {
    const existing = priceObservations.get(id) ?? [];
    existing.push(...obs);
    priceObservations.set(id, existing);
  }
  console.log(`[dex-liquidity] Total: ${priceObservations.size} coins with price observations across all sources`);

  const directApiResults = await directApiPromise;
  const directApiPools = directApiResults.flatMap((entry) => entry.result);

  const {
    filteredPools: preferredPrimaryPools,
    skippedByAddress: primarySkippedByDirectApiAddress,
    skippedByFingerprint: primarySkippedByDirectApiFingerprint,
  } = filterPrimaryPoolsPreferDirectApi(dataSources.pools, directApiPools);
  if (primarySkippedByDirectApiAddress > 0 || primarySkippedByDirectApiFingerprint > 0) {
    console.log(
      `[dex-liquidity] Preferred direct API over DL for ${primarySkippedByDirectApiAddress} address matches and ` +
      `${primarySkippedByDirectApiFingerprint} fingerprint matches`,
    );
  }

  // 4c. Build known pool address set from preferred primary sources (for staged/fallback dedup)
  const knownPoolAddrs = buildKnownPoolAddresses(
    preferredPrimaryPools, dataSources.dexProjects,
    curvePoolMap, uniV3PoolFees, aerodromeIsStable,
  );

  // 5. Match pools to stablecoins and compute per-pool metrics
  const metrics = processPoolMetrics(
    preferredPrimaryPools, dataSources.dexProjects, symbolToIds, addressToId,
    curvePoolMap, uniV3PoolFees, uniV3SymbolFees, aerodromeIsStable,
  );

  let directApiDedupSkippedByAddress = 0;
  let directApiDedupSkippedByFingerprint = 0;
  if (directApiPools.length > 0) {
    console.log(`[dex-liquidity] Fetched ${directApiPools.length} direct API pools total`);

    const retainedDirectApiPools: DexApiPool[] = [];
    for (const pool of directApiPools) {
      const key = `${pool.chain.toLowerCase()}:${pool.poolAddress.toLowerCase()}`;
      const fingerprint = buildPoolFingerprint(pool.chain, pool.source, pool.tokens.map((token) => token.address));
      if (knownPoolAddrs.has(key)) {
        directApiDedupSkippedByAddress++;
        continue;
      }
      if (fingerprint != null && knownPoolAddrs.has(fingerprint)) {
        directApiDedupSkippedByFingerprint++;
        continue;
      }

      knownPoolAddrs.add(key);
      if (fingerprint != null) knownPoolAddrs.add(fingerprint);
      retainedDirectApiPools.push(pool);
    }

    if (retainedDirectApiPools.length > 0) {
      const directApiGtPools = convertToGtNewPools(
        retainedDirectApiPools,
        addressToId,
        symbolToIds,
        validationReferences,
      );
      if (directApiGtPools.size > 0) mergeGtPools(metrics, directApiGtPools);

      const directApiPriceObs = extractPriceObservations(
        retainedDirectApiPools, addressToId, symbolToIds, validationReferences,
      );
      for (const [id, obs] of directApiPriceObs) {
        const existing = priceObservations.get(id) ?? [];
        existing.push(...obs);
        priceObservations.set(id, existing);
      }
    }

    if (directApiDedupSkippedByAddress > 0 || directApiDedupSkippedByFingerprint > 0) {
      console.log(
        `[dex-liquidity] Skipped ${directApiDedupSkippedByAddress} direct API pools by address and ` +
        `${directApiDedupSkippedByFingerprint} by fingerprint`,
      );
    }
  }

  const {
    mergedCount: stagedMergedCount,
    skippedCount: stagedSkippedCount,
    skippedByAddressCount: stagedSkippedByAddressCount,
    skippedByFingerprintCount: stagedSkippedByFingerprintCount,
    priceObservations: stagedPriceObs,
  } =
    await mergeStagedPools(db, metrics, knownPoolAddrs, syncStartSec, validationReferences);
  for (const [id, obs] of stagedPriceObs) {
    const existing = priceObservations.get(id) ?? [];
    existing.push(...obs);
    priceObservations.set(id, existing);
  }

  // 5b. Fallback crawlers: fill price observation gaps for coins with missing coverage
  const fallbackDeadlineMs = Date.now() + CRAWL_BUDGETS.FALLBACK_MS;
  let dsFallbackCoins = 0;
  let cgTickerFallbackCoins = 0;

  try {
    const dsFallback = await fetchDsFallbackPools(
      metrics, priceObservations, knownPoolAddrs, signal, fallbackDeadlineMs, validationReferences,
    );
    dsFallbackCoins = dsFallback.newPools.size;
    if (dsFallback.newPools.size > 0) mergeGtPools(metrics, dsFallback.newPools);
    for (const [id, obs] of dsFallback.priceObs) {
      const existing = priceObservations.get(id) ?? [];
      existing.push(...obs);
      priceObservations.set(id, existing);
    }
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.warn("[dex-liquidity] DexScreener fallback failed (non-fatal):", err);
    failedSources.push("dexscreener-fallback");
  }

  try {
    const cgFallback = await fetchCgTickersFallback(
      metrics, priceObservations, signal, fallbackDeadlineMs, validationReferences, coingeckoApiKey,
    );
    cgTickerFallbackCoins = cgFallback.newPools.size;
    if (cgFallback.newPools.size > 0) mergeGtPools(metrics, cgFallback.newPools);
    for (const [id, obs] of cgFallback.priceObs) {
      const existing = priceObservations.get(id) ?? [];
      existing.push(...obs);
      priceObservations.set(id, existing);
    }
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.warn("[dex-liquidity] CG tickers fallback failed (non-fatal):", err);
    failedSources.push("cg-tickers-fallback");
  }

  console.log(
    `[dex-liquidity] After fallbacks: ${priceObservations.size} coins with price observations ` +
    `(DS fallback: ${dsFallbackCoins} coins, CG tickers: ${cgTickerFallbackCoins} coins)`,
  );

  // 6. Compute composite scores per stablecoin
  const { scores: scoreResults, globalAgg } = await computeStablecoinScores(db, metrics, dataSources.protocolTvlCaps);
  const currentCoverage = scoreResults.size;
  const [
    previousCoverageRow,
    previousGlobalRow,
    previousCoverageClassRows,
    previousTopCoverageRows,
  ] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) as cnt FROM dex_liquidity WHERE stablecoin_id != '__global__' AND liquidity_score IS NOT NULL")
      .first<{ cnt: number }>()
      .catch((e) => { console.warn("[dex-liquidity] Failed to read previous coverage count — using safe high fallback:", e instanceof Error ? e.message : e); return { cnt: 9999 }; }),
    db
      .prepare("SELECT total_tvl_usd FROM dex_liquidity WHERE stablecoin_id = '__global__'")
      .first<{ total_tvl_usd: number | null }>()
      .catch((e) => { console.warn("[dex-liquidity] Failed to read previous global TVL:", e); return null; }),
    db
      .prepare(
        `SELECT coverage_class, COUNT(*) as cnt
         FROM dex_liquidity
         WHERE stablecoin_id != '__global__'
         GROUP BY coverage_class`
      )
      .all<{ coverage_class: string | null; cnt: number }>()
      .catch((e) => { console.warn("[dex-liquidity] Failed to read previous coverage classes:", e); return { results: [] as Array<{ coverage_class: string | null; cnt: number }> }; }),
    db
      .prepare(
        `SELECT stablecoin_id, total_tvl_usd
         FROM dex_liquidity
         WHERE stablecoin_id != '__global__' AND liquidity_score IS NOT NULL
         ORDER BY total_tvl_usd DESC
         LIMIT 10`
      )
      .all<{ stablecoin_id: string; total_tvl_usd: number }>()
      .catch((e) => { console.warn("[dex-liquidity] Failed to read previous top coverage:", e); return { results: [] as Array<{ stablecoin_id: string; total_tvl_usd: number }> }; }),
  ]);
  const previousCoverage = previousCoverageRow?.cnt ?? 0;
  // M1: First-run bootstrap — when previousCoverage is 0, the minimum threshold
  // is max(1, floor(0 * 0.6)) = 1, so the guard permits any result with at
  // least 1 scored coin. This avoids false alarms on initial deployment.
  const minExpectedCoverage = Math.max(1, Math.floor(previousCoverage * 0.6));
  const nearCoverageGuard = previousCoverage >= 10 && currentCoverage < Math.floor(previousCoverage * 0.8);

  const currentGlobalTvl = globalAgg.totalTvl;
  const previousGlobalTvl = previousGlobalRow?.total_tvl_usd ?? null;
  const minExpectedGlobalTvl = previousGlobalTvl != null ? previousGlobalTvl * 0.6 : null;
  const nearValueGuard = previousGlobalTvl != null &&
    previousGlobalTvl >= 10_000_000 &&
    currentGlobalTvl < previousGlobalTvl * 0.85;
  const hardValueGuard = previousGlobalTvl != null &&
    previousGlobalTvl >= 10_000_000 &&
    currentGlobalTvl < previousGlobalTvl * 0.6;

  const previousTop10CoveredTvl = (previousTopCoverageRows.results ?? [])
    .reduce((sum, row) => sum + row.total_tvl_usd, 0);
  const currentTop10CoveredTvl = (previousTopCoverageRows.results ?? [])
    .reduce((sum, row) => sum + (scoreResults.get(row.stablecoin_id)?.tvl ?? 0), 0);
  const nearMajorCoverageGuard = previousTop10CoveredTvl >= 5_000_000 &&
    currentTop10CoveredTvl < previousTop10CoveredTvl * 0.85;
  const hardMajorCoverageGuard = previousTop10CoveredTvl >= 5_000_000 &&
    currentTop10CoveredTvl < previousTop10CoveredTvl * 0.6;

  const currentCoverageClasses = {
    primary: 0,
    mixed: 0,
    fallback: 0,
    legacy: 0,
    unobserved: ACTIVE_STABLECOINS.length - currentCoverage,
  };
  for (const row of scoreResults.values()) {
    currentCoverageClasses[row.coverageClass] += 1;
  }

  const previousCoverageClasses = {
    primary: 0,
    mixed: 0,
    fallback: 0,
    legacy: 0,
    unobserved: 0,
  };
  for (const row of previousCoverageClassRows.results ?? []) {
    const key = row.coverage_class;
    if (key && key in previousCoverageClasses) {
      previousCoverageClasses[key as keyof typeof previousCoverageClasses] = row.cnt;
    }
  }

  if (previousCoverage >= 10 && currentCoverage < minExpectedCoverage) {
    throw new Error(
      `[dex-liquidity] coverage guard tripped: current=${currentCoverage}, previous=${previousCoverage}, minExpected=${minExpectedCoverage}`,
    );
  }
  if (hardValueGuard) {
    throw new Error(
      `[dex-liquidity] value coverage guard tripped: currentGlobalTvl=${Math.round(currentGlobalTvl)}, ` +
      `previousGlobalTvl=${Math.round(previousGlobalTvl ?? 0)}, minExpectedGlobalTvl=${Math.round(minExpectedGlobalTvl ?? 0)}`,
    );
  }
  if (hardMajorCoverageGuard) {
    throw new Error(
      `[dex-liquidity] major coverage guard tripped: currentTop10CoveredTvl=${Math.round(currentTop10CoveredTvl)}, ` +
      `previousTop10CoveredTvl=${Math.round(previousTop10CoveredTvl)}`,
    );
  }
  throwIfAborted(signal);

  // 7. Persist primary tables. D1 in Workers rejects manual SQL transaction statements.
  await persistScores(db, metrics, scoreResults, globalAgg, syncStartSec);
  await computeDexPrices(db, priceObservations, syncStartSec);

  // 8. Write daily historical snapshots
  await writeHistoricalSnapshots(db, scoreResults);

  // 9. Compute and persist depth stability from 30-day history
  await computeDepthStability(db);

  const degraded =
    criticalSourceFailures.length > 0 ||
    nearCoverageGuard ||
    nearValueGuard ||
    nearMajorCoverageGuard;

  return {
    status: degraded ? "degraded" : "ok",
    itemCount: scoreResults.size,
    metadata: JSON.stringify({
      rowsRead: dataSources.pools.length,
      rowsWritten: scoreResults.size,
      rowsDropped: 0,
      stagedPoolsMerged: stagedMergedCount,
      stagedPoolsSkipped: stagedSkippedCount,
      stagedPoolsSkippedByAddress: stagedSkippedByAddressCount,
      stagedPoolsSkippedByFingerprint: stagedSkippedByFingerprintCount,
      sourceCoverage: {
        dlYieldsAvailable: dataSources.dlYieldsAvailable,
        dlProtocolsAvailable: dataSources.dlProtocolsAvailable,
        currentCoverage,
        previousCoverage,
        minExpectedCoverage,
        nearCoverageGuard,
        currentGlobalTvl,
        previousGlobalTvl,
        minExpectedGlobalTvl,
        nearValueGuard,
        currentTop10CoveredTvl,
        previousTop10CoveredTvl,
        nearMajorCoverageGuard,
        currentCoverageClasses,
        previousCoverageClasses,
        priceObservationCoins: priceObservations.size,
        dsFallbackCoins,
        cgTickerFallbackCoins,
      },
      failedSources: [...new Set(failedSources)],
      fallbackMode: [...new Set(fallbackSignals)],
      validationFailures: 0,
    }),
  };
}
