import type { CronResult } from "../../lib/db";
import { CRAWL_BUDGETS } from "../../lib/rate-limit";
import { throwIfAborted } from "../../lib/abort";
import type { DexPriceObs } from "./types";
import { buildSymbolLookups } from "./pool-helpers";
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

function rethrowIfAborted(err: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (typeof err === "object" && err !== null && "name" in err && (err as { name?: string }).name === "AbortError") {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function syncDexLiquidity(
  db: D1Database,
  graphApiKey: string | null,
  signal?: AbortSignal,
): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);
  const failedSources: string[] = [];
  const criticalSourceFailures: string[] = [];
  const fallbackSignals: string[] = [];
  console.log(`[dex-liquidity] Starting sync`);
  throwIfAborted(signal);

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

  // 2. Build symbol/address lookup maps
  const { symbolToIds, addressToId } = buildSymbolLookups();

  // 3. Parse Curve data into pool lookups and price observations
  const { curvePoolMap, priceObservations } = await buildCurveLookups(
    dataSources.curveResponses, symbolToIds, addressToId,
  );

  // 4. Fetch Uniswap V3 subgraph data for fee tier enrichment + price observations
  const { uniV3PoolFees, uniV3SymbolFees, uniV3PriceObs } = await fetchUniV3Data(
    graphApiKey, symbolToIds, addressToId, signal,
  );
  if (addressToId.size > 0) {
    console.log(`[dex-liquidity] Learned ${addressToId.size} token addresses for disambiguation`);
  }

  // 4b. Fetch Aerodrome subgraph data for price observations + pool stability flags
  let aerodromePriceObs = new Map<string, DexPriceObs[]>();
  let aerodromeIsStable = new Map<string, boolean>();
  try {
    const aeroData = await fetchAerodromeData(graphApiKey, symbolToIds, addressToId, signal);
    aerodromePriceObs = aeroData.aerodromePriceObs;
    aerodromeIsStable = aeroData.aerodromeIsStable;
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.warn("[dex-liquidity] Aerodrome fetch failed (non-fatal):", err);
    failedSources.push("aerodrome-subgraph");
  }

  // 4c. Build known pool address set from existing sources (for GT dedup)
  const knownPoolAddrs = buildKnownPoolAddresses(
    dataSources.pools, dataSources.dexProjects,
    curvePoolMap, uniV3PoolFees, aerodromeIsStable,
  );

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

  // 5. Match pools to stablecoins and compute per-pool metrics
  const metrics = processPoolMetrics(
    dataSources.pools, dataSources.dexProjects, symbolToIds, addressToId,
    curvePoolMap, uniV3PoolFees, uniV3SymbolFees, aerodromeIsStable,
  );

  const {
    mergedCount: stagedMergedCount,
    skippedCount: stagedSkippedCount,
    skippedByAddressCount: stagedSkippedByAddressCount,
    skippedByFingerprintCount: stagedSkippedByFingerprintCount,
    priceObservations: stagedPriceObs,
  } =
    await mergeStagedPools(db, metrics, knownPoolAddrs, syncStartSec);
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
      metrics, priceObservations, knownPoolAddrs, signal, fallbackDeadlineMs,
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
      metrics, priceObservations, signal, fallbackDeadlineMs,
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
  const previousCoverageRow = await db
    .prepare("SELECT COUNT(*) as cnt FROM dex_liquidity WHERE stablecoin_id != '__global__' AND liquidity_score IS NOT NULL")
    .first<{ cnt: number }>()
    .catch(() => null);
  const previousCoverage = previousCoverageRow?.cnt ?? 0;
  const minExpectedCoverage = Math.max(1, Math.floor(previousCoverage * 0.6));
  const nearCoverageGuard = previousCoverage >= 10 && currentCoverage < Math.floor(previousCoverage * 0.8);
  if (previousCoverage >= 10 && currentCoverage < minExpectedCoverage) {
    throw new Error(
      `[dex-liquidity] coverage guard tripped: current=${currentCoverage}, previous=${previousCoverage}, minExpected=${minExpectedCoverage}`,
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
    nearCoverageGuard;

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
        priceObservationCoins: priceObservations.size,
        dsFallbackCoins,
        cgTickerFallbackCoins,
      },
      failedSources,
      fallbackMode: fallbackSignals,
      validationFailures: 0,
    }),
  };
}
