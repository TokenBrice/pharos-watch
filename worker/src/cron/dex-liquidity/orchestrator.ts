import { initOnchainAvailability, isOnchainAvailable } from "../../lib/coingecko-onchain";
import type { CgNewPool, GtNewPool, DexPriceObs } from "./types";
import { buildSymbolLookups } from "./pool-helpers";
import {
  fetchDataSources, buildCurveLookups, fetchUniV3Data,
  fetchAerodromeData, buildKnownPoolAddresses,
  fetchGtTokenBatch, fetchCgTokenBatchPrices,
} from "./fetch-primary";
import { fetchCgPools, mergeCgPools, fetchGtPools, mergeGtPools } from "./fetch-crawlers";
import { fetchDsFallbackPools, fetchCgTickersFallback } from "./fetch-fallbacks";
import { processPoolMetrics } from "./process-pools";
import { computeStablecoinScores, computeDepthStability, computeDexPrices } from "./scoring";
import { persistScores, writeHistoricalSnapshots } from "./persistence";

export async function syncDexLiquidity(db: D1Database, graphApiKey: string | null, cgApiKey: string | null = null, signal?: AbortSignal): Promise<void> {
  initOnchainAvailability(cgApiKey ?? undefined);
  const useCg = isOnchainAvailable();
  console.log(`[dex-liquidity] Starting sync`);
  console.log(`[dex-liquidity] Pool discovery source: ${useCg ? "CoinGecko onchain" : "GeckoTerminal fallback"}`);

  // 1. Fetch all external data sources
  const dataSources = await fetchDataSources(graphApiKey, db);
  if (!dataSources) return;
  if (!dataSources.dlYieldsAvailable) {
    console.log("[dex-liquidity] DL yields unavailable — CG/GT pool crawl will be the only pool source");
  }

  // 2. Build symbol/address lookup maps
  const { symbolToIds, addressToId } = buildSymbolLookups();

  // 3. Parse Curve data into pool lookups and price observations
  const { curvePoolMap, priceObservations } = await buildCurveLookups(
    dataSources.curveResponses, symbolToIds, addressToId,
  );

  // 4. Fetch Uniswap V3 subgraph data for fee tier enrichment + price observations
  const { uniV3PoolFees, uniV3SymbolFees, uniV3PriceObs } = await fetchUniV3Data(
    graphApiKey, symbolToIds, addressToId,
  );
  if (addressToId.size > 0) {
    console.log(`[dex-liquidity] Learned ${addressToId.size} token addresses for disambiguation`);
  }

  // 4b. Fetch Aerodrome subgraph data for price observations + pool stability flags
  let aerodromePriceObs = new Map<string, DexPriceObs[]>();
  let aerodromeIsStable = new Map<string, boolean>();
  try {
    const aeroData = await fetchAerodromeData(graphApiKey, symbolToIds, addressToId);
    aerodromePriceObs = aeroData.aerodromePriceObs;
    aerodromeIsStable = aeroData.aerodromeIsStable;
  } catch (err) {
    console.warn("[dex-liquidity] Aerodrome fetch failed (non-fatal):", err);
  }

  // 4c. Build known pool address set from existing sources (for GT dedup)
  const knownPoolAddrs = buildKnownPoolAddresses(
    dataSources.pools, dataSources.dexProjects,
    curvePoolMap, uniV3PoolFees, aerodromeIsStable,
  );

  // 4d. Token-level batch price observations (CG or GT)
  let fallbackTokenPriceObs = new Map<string, DexPriceObs[]>();
  try {
    fallbackTokenPriceObs = useCg
      ? await fetchCgTokenBatchPrices(addressToId)
      : await fetchGtTokenBatch(addressToId);
  } catch (err) {
    console.warn(`[dex-liquidity] ${useCg ? "CG" : "GT"} token batch failed (non-fatal):`, err);
  }

  // 4e. Pool crawl for new pool discovery (CG or GT)
  let crawlNewPools: Map<string, CgNewPool[]> | Map<string, GtNewPool[]> = new Map();
  let crawlPriceObs = new Map<string, DexPriceObs[]>();
  try {
    if (useCg) {
      const cgResult = await fetchCgPools(addressToId, knownPoolAddrs, dataSources.protocolTvlCaps);
      crawlNewPools = cgResult.newPools;
      crawlPriceObs = cgResult.priceObs;
    } else {
      const gtResult = await fetchGtPools(addressToId, knownPoolAddrs, dataSources.protocolTvlCaps);
      crawlNewPools = gtResult.newPools;
      crawlPriceObs = gtResult.priceObs;
    }
  } catch (err) {
    console.warn(`[dex-liquidity] ${useCg ? "CG" : "GT"} pool crawl failed (non-fatal):`, err);
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
  for (const [id, obs] of fallbackTokenPriceObs) {
    const existing = priceObservations.get(id) ?? [];
    existing.push(...obs);
    priceObservations.set(id, existing);
  }
  for (const [id, obs] of crawlPriceObs) {
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

  // 5b. Merge discovered pools into metrics (CG or GT)
  if (useCg) {
    mergeCgPools(metrics, crawlNewPools as Map<string, CgNewPool[]>);
  } else {
    mergeGtPools(metrics, crawlNewPools as Map<string, GtNewPool[]>);
  }

  // 5c. DexScreener fallback for coins still at zero pools
  try {
    const dsFallback = await fetchDsFallbackPools(metrics, knownPoolAddrs);
    mergeGtPools(metrics, dsFallback.newPools);
    for (const [id, obs] of dsFallback.priceObs) {
      const existing = priceObservations.get(id) ?? [];
      existing.push(...obs);
      priceObservations.set(id, existing);
    }
  } catch (err) {
    console.warn("[dex-liquidity] DexScreener fallback failed (non-fatal):", err);
  }

  // 5d. CoinGecko tickers fallback for orderbook DEXes (e.g. Kinesis Exchange for KAG/KAU)
  try {
    const cgTickersFallback = await fetchCgTickersFallback(metrics);
    mergeGtPools(metrics, cgTickersFallback.newPools);
    for (const [id, obs] of cgTickersFallback.priceObs) {
      const existing = priceObservations.get(id) ?? [];
      existing.push(...obs);
      priceObservations.set(id, existing);
    }
  } catch (err) {
    console.warn("[dex-liquidity] CG tickers fallback failed (non-fatal):", err);
  }

  // 6. Compute composite scores per stablecoin
  const { scores: scoreResults, globalAgg } = await computeStablecoinScores(db, metrics, dataSources.protocolTvlCaps);

  // 7. Persist scores to D1
  const nowSec = Math.floor(Date.now() / 1000);
  await persistScores(db, metrics, scoreResults, globalAgg, nowSec);

  // 8. Write daily historical snapshots
  await writeHistoricalSnapshots(db, scoreResults);

  // 9. Compute and persist depth stability from 30-day history
  await computeDepthStability(db);

  // 10. Compute and persist DEX-implied prices from ALL observations
  await computeDexPrices(db, priceObservations, nowSec);
}
