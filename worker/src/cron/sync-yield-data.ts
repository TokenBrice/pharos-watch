// worker/src/cron/sync-yield-data.ts
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { fetchWithRetry } from "../lib/fetch-retry";
import { getCache, setCache, batchExecute, buildInClause } from "../lib/db";
import {
  USER_AGENT, CIRCUIT_SOURCE, RISK_FREE_RATE_FALLBACK,
  PYS_SCALING_FACTOR, DEFAULT_SAFETY_SCORE, MIN_SAFETY_SCORE_FOR_YIELD,
  MIN_LENDING_POOL_APY, MIN_LENDING_POOL_TVL_USD,
} from "../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { getChainRpc } from "../lib/chain-rpcs";
import {
  computeApyFromRate, computeApyFromPrice, computePYS,
  computeYieldStability, computeApyVarianceScore,
  detectWarningSignals, findBestLendingPool, matchAllDlPools,
} from "./yield-helpers";
import {
  YIELD_VARIANT_MAP, YIELD_POOL_MAP, ON_CHAIN_RATE_CONFIGS,
  LENDING_PROTOCOL_ALLOWLIST, PRICE_DERIVED_FALLBACK_IDS,
  AUTO_LENDING_POOL_MAP, AUTO_LENDING_SAFETY_BYPASS_IDS,
} from "./yield-config";
import { YieldRankingsResponseSchema, type AltYieldSource } from "@shared/types";
import type { CronResult } from "../lib/db";
import { validatePayloadWithSchema } from "../lib/api-utils";
import { computeSafetyScoresSnapshot } from "../lib/safety-scores";

const DL_YIELDS_URL = "https://yields.llama.fi/pools";
const MIN_SAFETY_SCORE_COVERAGE_RATIO = 0.5;

interface DlPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number;
  stablecoin: boolean;
  exposure: string;
  underlyingTokens: string[] | null;
}

interface ResolvedYield {
  currentApy: number;
  apyBase: number | null;
  apyReward: number | null;
  sourcePool: string | null;
  sourceTvlUsd: number | null;
  dataSource: "onchain" | "defillama" | "defillama-auto" | "price-derived";
  exchangeRate: number | null;
  sourceKey: string;           // DL pool UUID or "price-derived"
  yieldSource?: string;        // label override for variant wrapper rows
  yieldType?: string;          // type override for variant wrapper rows
}

// -- Tier 1: On-chain exchange rates -----------------------------------------

async function fetchOnChainRates(signal?: AbortSignal): Promise<Map<string, { rate: number }>> {
  const results = new Map<string, { rate: number }>();

  for (const config of ON_CHAIN_RATE_CONFIGS) {
    try {
      const rpc = getChainRpc(config.chain);
      if (!rpc) {
        console.warn(`[yield] No RPC for chain ${config.chain}`);
        continue;
      }

      const callData = config.selector + config.inputAmount.replace("0x", "").padStart(64, "0");
      const res = await fetchWithRetry(rpc.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_call",
          params: [{ to: config.contract, data: callData }, "latest"],
          id: 1,
        }),
      });

      if (!res?.ok) continue;
      const body = await res.json() as { result?: string };
      if (!body.result || body.result === "0x") continue;

      const raw = BigInt(body.result);
      const rate = Number(raw) / 10 ** config.decimals;
      results.set(config.stablecoinId, { rate });
    } catch (err) {
      console.warn(`[yield] On-chain rate failed for ${config.stablecoinId}:`, err);
    }
  }

  return results;
}

// -- Tier 3: Price-derived APY -----------------------------------------------

async function getPriceDerivedApy(
  db: D1Database,
  stablecoinId: string,
): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 86400;

  // Get most recent and ~30d-ago prices from supply_history
  const [recentRow, oldRow] = await Promise.all([
    db.prepare(
      "SELECT price FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1"
    ).bind(stablecoinId).first<{ price: number }>(),
    db.prepare(
      "SELECT price FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL AND snapshot_date <= ? ORDER BY snapshot_date DESC LIMIT 1"
    ).bind(stablecoinId, thirtyDaysAgo).first<{ price: number }>(),
  ]);

  if (!recentRow?.price || !oldRow?.price || oldRow.price <= 0) return null;
  return computeApyFromPrice(recentRow.price, oldRow.price, 30);
}

// -- Main sync function ------------------------------------------------------

export async function syncYieldData(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  const startSec = Math.floor(Date.now() / 1000);
  const sevenDaysAgoSec = startSec - 7 * 86400;
  const yieldCoins = TRACKED_STABLECOINS.filter((m) => m.flags.yieldBearing);

  if (yieldCoins.length === 0) {
    return { itemCount: 0, metadata: "no yield-bearing coins" };
  }

  // 1. Load DL pools — prefer cached data from DEX sync (avoids redundant 13MB fetch)
  let dlPools: DlPool[] = [];
  const cachedPools = await getCache(db, "dl-stablecoin-pools");
  if (cachedPools) {
    try {
      dlPools = JSON.parse(cachedPools.value) as DlPool[];
      console.log(`[sync-yield-data] Using ${dlPools.length} cached stablecoin pools from DEX sync`);
    } catch {
      console.warn("[sync-yield-data] Failed to parse cached DL pools, falling back to direct fetch");
    }
  }

  // Fall back to direct fetch if no cache available
  if (dlPools.length === 0 && await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_YIELDS)) {
    try {
      const res = await fetchWithRetry(DL_YIELDS_URL, {
        headers: { "User-Agent": USER_AGENT },
        signal,
      });
      if (res?.ok) {
        const body = await res.json() as { data: DlPool[] };
        dlPools = (body.data ?? []).filter((p) => p.stablecoin);
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, true);
      } else {
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
      }
    } catch (e) {
      console.warn("[sync-yield-data] DL yields direct fetch failed:", e);
      await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
    }
  }

  // 2. Fetch on-chain rates (Tier 1 source)
  const onChainRates = await fetchOnChainRates(signal);

  // 3. Read cached risk-free rate
  const rfCache = await getCache(db, "risk_free_rate");
  const riskFreeRate = rfCache ? parseFloat(rfCache.value) : RISK_FREE_RATE_FALLBACK;

  // 4. Compute safety scores inline (report-cards API does NOT cache results)
  //    Follows the same two-phase approach as daily-digest.ts
  const safetySnapshot = await computeSafetyScoresSnapshot(db, {
    includeNavTokens: true,
    outputMode: "map",
  });
  const safetyScores = safetySnapshot.scores;
  const safetyCoverageRatio =
    TRACKED_STABLECOINS.length > 0 ? safetyScores.size / TRACKED_STABLECOINS.length : 1;
  const safetySnapshotDegraded =
    safetyScores.size === 0 || safetyCoverageRatio < MIN_SAFETY_SCORE_COVERAGE_RATIO;

  if (safetySnapshotDegraded) {
    console.warn(
      `[sync-yield-data] Safety snapshot coverage degraded: ${safetyScores.size}/${TRACKED_STABLECOINS.length} (${(safetyCoverageRatio * 100).toFixed(1)}%)`,
    );
  }

  // Cache safety scores for other consumers (flow API, digest, etc.)
  const scoresObj: Record<string, { score: number; grade: string }> = {};
  for (const [id, val] of safetyScores) {
    scoresObj[id] = val;
  }
  if (!safetySnapshotDegraded) {
    await setCache(db, "report_card_cache", JSON.stringify({
      scores: scoresObj,
      updatedAt: startSec,
    }));
  } else {
    console.warn("[sync-yield-data] Skipped report_card_cache write due to degraded safety snapshot");
  }

  // 5. Resolve yield for each coin
  const resolved: { id: string; symbol: string; yield: ResolvedYield | null }[] = [];
  const tier1PrevRates = new Map<string, number | null>();
  const tier1CandidateIds = yieldCoins
    .map((meta) => meta.id)
    .filter((id) =>
      ON_CHAIN_RATE_CONFIGS.some((config) => config.stablecoinId === id) &&
      onChainRates.has(id),
    );
  const tier1PrevRateRows = new Map<string, { exchangeRate: number | null; recordedAt: number }>();
  if (tier1CandidateIds.length > 0) {
    const tier1InClause = buildInClause(tier1CandidateIds);
    const rows = await db.prepare(
      `SELECT stablecoin_id, exchange_rate, recorded_at
       FROM yield_history
       WHERE stablecoin_id IN (${tier1InClause.sql}) AND recorded_at <= ?
       ORDER BY stablecoin_id ASC, recorded_at DESC`,
    ).bind(...tier1InClause.binds, sevenDaysAgoSec).all<{
      stablecoin_id: string;
      exchange_rate: number | null;
      recorded_at: number;
    }>();
    for (const row of rows.results ?? []) {
      if (!tier1PrevRateRows.has(row.stablecoin_id)) {
        tier1PrevRateRows.set(row.stablecoin_id, {
          exchangeRate: row.exchange_rate,
          recordedAt: row.recorded_at,
        });
      }
    }
  }

  for (const meta of yieldCoins) {
    const id = meta.id;
    const symbol = meta.symbol;

    // Tier 1: On-chain rate
    let hasAnySource = false;
    const rateConfig = ON_CHAIN_RATE_CONFIGS.find((c) => c.stablecoinId === id);
    if (rateConfig && onChainRates.has(id)) {
      const { rate } = onChainRates.get(id)!;
      const prevRow = tier1PrevRateRows.get(id);
      tier1PrevRates.set(id, prevRow?.exchangeRate ?? null);

      if (prevRow?.exchangeRate && prevRow.exchangeRate > 0) {
        const actualDays = (startSec - prevRow.recordedAt) / 86400;
        const apy = computeApyFromRate(rate, prevRow.exchangeRate, actualDays);
        // Populate sourcePool from YIELD_POOL_MAP so source_key is a stable UUID.
        const nativePoolId = YIELD_POOL_MAP[id] ?? null;
        resolved.push({
          id, symbol,
          yield: {
            currentApy: apy, apyBase: apy, apyReward: null,
            sourcePool: nativePoolId, sourceTvlUsd: null,
            dataSource: "onchain", exchangeRate: rate,
            sourceKey: nativePoolId ?? "price-derived",
          },
        });
        hasAnySource = true;
        // Do NOT continue — fall through to Tier 2 to check for additional wrapper sources
      }
      // Fall through if no previous rate yet (first run)
    }

    // Tier 2: DeFiLlama pool matching — collect ALL sources for this coin
    {
      const alreadyResolvedKeys = new Set(
        resolved.filter(r => r.id === id && r.yield != null).map(r => r.yield!.sourceKey)
      );
      const dlSources = matchAllDlPools(id, symbol, dlPools, YIELD_POOL_MAP, YIELD_VARIANT_MAP);
      for (const dlPool of dlSources) {
        if (alreadyResolvedKeys.has(dlPool.pool)) continue; // Tier 1 already handled this source
        if (dlPool.apy == null || dlPool.apy < 0) continue;

        const fullPool = dlPools.find(p => p.pool === dlPool.pool)!;
        const variant = YIELD_VARIANT_MAP[id];
        // Use variant label/type if this pool was found via YIELD_VARIANT_MAP and not the primary pool map
        const isVariantPool = variant != null && dlPool.pool !== YIELD_POOL_MAP[id];
        const yieldSourceOverride = isVariantPool ? variant.yieldSource : undefined;
        const yieldTypeOverride = isVariantPool ? variant.yieldType : undefined;

        resolved.push({
          id, symbol,
          yield: {
            currentApy: fullPool.apy, apyBase: fullPool.apyBase, apyReward: fullPool.apyReward,
            sourcePool: fullPool.pool, sourceTvlUsd: fullPool.tvlUsd,
            dataSource: "defillama", exchangeRate: null,
            sourceKey: fullPool.pool,
            yieldSource: yieldSourceOverride,
            yieldType: yieldTypeOverride,
          },
        });
        alreadyResolvedKeys.add(dlPool.pool);
        hasAnySource = true;
      }
    }

    if (hasAnySource) continue; // Skip Tier 3 if any source was found

    // Tier 3: Price-derived fallback for NAV tokens and explicit fallback IDs.
    if (meta.flags.navToken || PRICE_DERIVED_FALLBACK_IDS.has(id)) {
      const apy = await getPriceDerivedApy(db, id);
      if (apy != null) {
        resolved.push({
          id, symbol,
          yield: {
            currentApy: apy,
            apyBase: apy,
            apyReward: null,
            sourcePool: null,
            sourceTvlUsd: null,
            dataSource: "price-derived",
            exchangeRate: null,
            sourceKey: "price-derived",
          },
        });
        continue;
      }
    }

    // No data available
    resolved.push({ id, symbol, yield: null });
  }

  // 5b. Auto-discovery: find lending pools for C+ coins (now runs for ALL coins, including yield-bearing)
  if (dlPools.length > 0) {
    // Track coins that received an auto-discovered source this run (one per coin)
    const autoDiscoveredIds = new Set<string>();
    let autoCount = 0;
    let deterministicCount = 0;

    // Deterministic overrides for edge symbols that can miss dynamic matching.
    for (const [stablecoinId, poolId] of Object.entries(AUTO_LENDING_POOL_MAP)) {
      if (autoDiscoveredIds.has(stablecoinId)) continue;

      const pool = dlPools.find((p) => p.pool === poolId);
      if (!pool) continue;

      const safetyScore = safetyScores.get(stablecoinId)?.score ?? 0;
      const bypassSafety = AUTO_LENDING_SAFETY_BYPASS_IDS.has(stablecoinId);
      if (!bypassSafety && safetyScore < MIN_SAFETY_SCORE_FOR_YIELD) continue;

      const eligible = (
        pool.exposure === "single" &&
        pool.stablecoin &&
        LENDING_PROTOCOL_ALLOWLIST.has(pool.project) &&
        pool.apy >= MIN_LENDING_POOL_APY &&
        pool.tvlUsd >= MIN_LENDING_POOL_TVL_USD
      );
      if (!eligible) continue;

      // Skip if this exact pool UUID is already resolved for this coin
      if (resolved.some(r => r.id === stablecoinId && r.yield?.sourceKey === poolId)) continue;

      const meta = TRACKED_STABLECOINS.find((m) => m.id === stablecoinId);
      if (!meta) continue;

      resolved.push({
        id: meta.id,
        symbol: meta.symbol,
        yield: {
          currentApy: pool.apy, apyBase: pool.apyBase, apyReward: pool.apyReward,
          sourcePool: pool.pool, sourceTvlUsd: pool.tvlUsd,
          dataSource: "defillama-auto", exchangeRate: null,
          sourceKey: pool.pool,
        },
      });
      autoDiscoveredIds.add(meta.id);
      autoCount++;
      deterministicCount++;
    }

    // Dynamic discovery: all coins with safety >= threshold, no auto-discovered pool yet
    const lendingCandidates = TRACKED_STABLECOINS.filter((m) =>
      !autoDiscoveredIds.has(m.id) &&
      m.flags.pegCurrency !== "GOLD" &&
      m.flags.pegCurrency !== "SILVER" &&
      (safetyScores.get(m.id)?.score ?? 0) >= MIN_SAFETY_SCORE_FOR_YIELD
    );

    for (const meta of lendingCandidates) {
      const pool = findBestLendingPool(meta.symbol, dlPools, LENDING_PROTOCOL_ALLOWLIST, {
        minApy: MIN_LENDING_POOL_APY,
        minTvlUsd: MIN_LENDING_POOL_TVL_USD,
        contractAddresses: (meta.contracts ?? []).map((c) => c.address),
      });
      if (!pool) continue;

      // Skip if this pool UUID is already in resolved for this coin
      if (resolved.some(r => r.id === meta.id && r.yield?.sourceKey === pool.pool)) continue;

      resolved.push({
        id: meta.id,
        symbol: meta.symbol,
        yield: {
          currentApy: pool.apy, apyBase: pool.apyBase, apyReward: pool.apyReward,
          sourcePool: pool.pool, sourceTvlUsd: pool.tvlUsd,
          dataSource: "defillama-auto", exchangeRate: null,
          sourceKey: pool.pool,
        },
      });
      autoDiscoveredIds.add(meta.id);
      autoCount++;
    }
    console.log(
      `[sync-yield-data] Auto-discovery: ${autoCount} lending pools (${deterministicCount} deterministic, ${autoCount - deterministicCount} dynamic)`
    );
  }

  // 5c. Determine is_best per coin: source with highest currentApy wins
  const bestSourceKeyByCoin = new Map<string, string>();
  {
    const coinBestApy = new Map<string, number>();
    for (const { id, yield: y } of resolved) {
      if (!y) continue;
      const prev = coinBestApy.get(id) ?? -Infinity;
      if (y.currentApy > prev) {
        coinBestApy.set(id, y.currentApy);
        bestSourceKeyByCoin.set(id, y.sourceKey);
      }
    }
  }

  // 6. Compute trailing averages, PYS, and store
  const yieldDataStmts: D1PreparedStatement[] = [];
  const historyStmts: D1PreparedStatement[] = [];
  const historyWrittenForCoin = new Set<string>(); // only write history for the best source
  let updatedCount = 0;

  // Compute median APY across all resolved yield-bearing coins (for warning signals)
  const resolvedApys = resolved
    .filter((r) => r.yield != null)
    .map((r) => r.yield!.currentApy)
    .sort((a, b) => a - b);
  const medianApy = resolvedApys.length > 0
    ? resolvedApys.length % 2 === 1
      ? resolvedApys[Math.floor(resolvedApys.length / 2)]
      : (resolvedApys[resolvedApys.length / 2 - 1] + resolvedApys[resolvedApys.length / 2]) / 2
    : 0;

  const resolvedIds = [...new Set(
    resolved
      .filter((entry) => entry.yield != null)
      .map((entry) => entry.id),
  )];
  const historyById = new Map<string, Array<{ apy: number; recorded_at: number; source_tvl_usd: number | null }>>();
  const prevTvlMap = new Map<string, number | null>();
  if (resolvedIds.length > 0) {
    const resolvedIdInClause = buildInClause(resolvedIds);
    const [historyRows, prevTvlRows] = await Promise.all([
      db.prepare(
        `SELECT stablecoin_id, apy, recorded_at, source_tvl_usd
         FROM yield_history
         WHERE stablecoin_id IN (${resolvedIdInClause.sql}) AND recorded_at >= ?
         ORDER BY stablecoin_id ASC, recorded_at ASC`,
      ).bind(...resolvedIdInClause.binds, startSec - 30 * 86400).all<{
        stablecoin_id: string;
        apy: number;
        recorded_at: number;
        source_tvl_usd: number | null;
      }>(),
      db.prepare(
        `SELECT stablecoin_id, source_tvl_usd, recorded_at
         FROM yield_history
         WHERE stablecoin_id IN (${resolvedIdInClause.sql}) AND recorded_at <= ? AND source_tvl_usd IS NOT NULL
         ORDER BY stablecoin_id ASC, recorded_at DESC`,
      ).bind(...resolvedIdInClause.binds, sevenDaysAgoSec).all<{
        stablecoin_id: string;
        source_tvl_usd: number | null;
        recorded_at: number;
      }>(),
    ]);
    for (const row of historyRows.results ?? []) {
      const list = historyById.get(row.stablecoin_id) ?? [];
      list.push({ apy: row.apy, recorded_at: row.recorded_at, source_tvl_usd: row.source_tvl_usd });
      historyById.set(row.stablecoin_id, list);
    }
    for (const row of prevTvlRows.results ?? []) {
      if (!prevTvlMap.has(row.stablecoin_id)) {
        prevTvlMap.set(row.stablecoin_id, row.source_tvl_usd ?? null);
      }
    }
  }

  for (const { id, symbol, yield: y } of resolved) {
    if (!y) continue;

    const meta = TRACKED_STABLECOINS.find((m) => m.id === id)!;
    const yieldConfig = meta.yieldConfig;
    // Variant wrapper rows carry their own yieldSource/yieldType overrides
    const yieldSource = y.yieldSource
      ?? yieldConfig?.yieldSource
      ?? (y.dataSource === "defillama-auto" ? "Best lending rate" : "Unknown");
    const yieldType = y.yieldType
      ?? yieldConfig?.yieldType
      ?? (y.dataSource === "defillama-auto" ? "lending-opportunity" : "nav-appreciation");

    // is_best: 1 for the source with highest currentApy per coin, 0 for alternatives
    const isBest = bestSourceKeyByCoin.get(id) === y.sourceKey ? 1 : 0;

    // Load historical APY samples for trailing averages
    const histRows = historyById.get(id) ?? [];
    const samples = histRows.map((row) => row.apy);
    samples.push(y.currentApy);

    const apy7dSamples = histRows
      .filter((row) => row.recorded_at >= sevenDaysAgoSec)
      .map((row) => row.apy);
    apy7dSamples.push(y.currentApy);
    const apy7d = apy7dSamples.reduce((s, v) => s + v, 0) / apy7dSamples.length;
    const apy30d = samples.reduce((s, v) => s + v, 0) / samples.length;

    const apyVarianceScore = computeApyVarianceScore(samples);
    const yieldStability = computeYieldStability(samples);
    const stdDev30d = samples.length >= 2
      ? Math.sqrt(samples.reduce((s, v) => s + (v - apy30d) ** 2, 0) / samples.length)
      : null;
    const apyMin30d = samples.length > 0 ? samples.reduce((m, v) => Math.min(m, v), Infinity) : null;
    const apyMax30d = samples.length > 0 ? samples.reduce((m, v) => Math.max(m, v), -Infinity) : null;

    // Safety score
    const safety = safetyScores.get(id);
    const safetyScore = safety?.score ?? DEFAULT_SAFETY_SCORE;
    const safetyGrade = safety?.grade ?? "NR";

    // PYS
    const pys = computePYS({ apy30d, safetyScore, apyVarianceScore, scalingFactor: PYS_SCALING_FACTOR });
    const yieldToRisk = (101 - safetyScore) > 0 ? apy30d / (101 - safetyScore) : null;
    const excessYield = apy30d - riskFreeRate;

    // Belt-and-suspenders: guard against NaN/Infinity reaching D1
    const safePys = Number.isFinite(pys) ? pys : 0;
    const safeVariance30d = stdDev30d != null && Number.isFinite(stdDev30d) ? stdDev30d : null;
    const safeStability = yieldStability != null && Number.isFinite(yieldStability) ? yieldStability : null;

    // Previous exchange rate (for Tier 1 coins — cached from resolution phase)
    const prevExchangeRate = tier1PrevRates.get(id) ?? null;

    // Warning signals
    const prevTvlUsd = prevTvlMap.get(id) ?? null;
    const warnings = detectWarningSignals({
      currentApy: y.currentApy,
      apy30d,
      apyReward: y.apyReward,
      medianApy,
      sourceTvlUsd: y.sourceTvlUsd,
      prevTvlUsd,
    });
    const warningSignalsJson = warnings.length > 0 ? JSON.stringify(warnings) : null;

    // Upsert yield_data
    yieldDataStmts.push(
      db.prepare(
        `INSERT OR REPLACE INTO yield_data (
          stablecoin_id, source_key, symbol, current_apy, apy_base, apy_reward, apy_7d, apy_30d,
          yield_source, yield_type, source_pool, source_tvl_usd, data_source,
          safety_score, safety_grade, pharos_yield_score, yield_to_risk, excess_yield, yield_stability,
          apy_variance_30d, /* note: column stores standard deviation, not variance */
          apy_min_30d, apy_max_30d, exchange_rate, exchange_rate_prev, warning_signals, is_best, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, y.sourceKey, symbol, y.currentApy, y.apyBase, y.apyReward, apy7d, apy30d,
        yieldSource, yieldType,
        y.sourcePool, y.sourceTvlUsd, y.dataSource,
        safetyScore, safetyGrade, safePys, yieldToRisk, excessYield, safeStability,
        safeVariance30d, apyMin30d, apyMax30d, y.exchangeRate, prevExchangeRate, warningSignalsJson, isBest, startSec,
      )
    );

    // Insert yield_history point (only for the best source per coin)
    if (isBest === 1 && !historyWrittenForCoin.has(id)) {
      historyStmts.push(
        db.prepare(
          `INSERT OR IGNORE INTO yield_history (stablecoin_id, recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd, data_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, startSec, y.currentApy, y.apyBase, y.apyReward, y.exchangeRate, y.sourceTvlUsd, y.dataSource)
      );
      historyWrittenForCoin.add(id);
    }

    updatedCount++;
  }

  // 7. Batch write
  const writeStmts = [...yieldDataStmts, ...historyStmts];
  if (writeStmts.length > 0) await batchExecute(db, writeStmts);

  // 7b. Purge stale alt-source rows: non-best rows not written in this run
  // (e.g., a wrapper pool disappeared from DL). Primary rows are always re-written.
  await db.prepare("DELETE FROM yield_data WHERE is_best = 0 AND updated_at < ?").bind(startSec).run();

  // 8. Prune old history (>365 days)
  const pruneCutoff = startSec - 365 * 86400;
  await db.prepare("DELETE FROM yield_history WHERE recorded_at < ?").bind(pruneCutoff).run();

  // 9. Cache the rankings response for fast API reads
  const rankingsData = await db.prepare("SELECT * FROM yield_data WHERE is_best = 1 ORDER BY pharos_yield_score DESC").all();

  // Fetch alt sources for coins with multiple yield sources
  const altSourcesData = await db.prepare(
    "SELECT stablecoin_id, source_key, current_apy, apy_30d, yield_source, yield_type, source_tvl_usd, data_source FROM yield_data WHERE is_best = 0"
  ).all<{ stablecoin_id: string; source_key: string; current_apy: number; apy_30d: number; yield_source: string; yield_type: string; source_tvl_usd: number | null; data_source: string }>();
  const altSourcesByCoin = new Map<string, AltYieldSource[]>();
  for (const row of altSourcesData.results ?? []) {
    const alts = altSourcesByCoin.get(row.stablecoin_id) ?? [];
    alts.push({
      sourceKey: row.source_key,
      yieldSource: row.yield_source,
      yieldType: row.yield_type as AltYieldSource["yieldType"],
      currentApy: row.current_apy,
      apy30d: row.apy_30d,
      sourceTvlUsd: row.source_tvl_usd,
      dataSource: row.data_source,
    });
    altSourcesByCoin.set(row.stablecoin_id, alts);
  }

  const rankingsPayload = {
    rankings: (rankingsData.results ?? []).map((row) => ({
      ...rowToRanking(row),
      altSources: altSourcesByCoin.get(row.stablecoin_id as string) ?? [],
    })),
    riskFreeRate,
    scalingFactor: PYS_SCALING_FACTOR,
    updatedAt: startSec,
  };
  const validation = validatePayloadWithSchema(
    YieldRankingsResponseSchema,
    rankingsPayload,
    "sync-yield-data:yield-rankings",
  );
  const degradationReasons: string[] = [];
  if (safetySnapshotDegraded) {
    degradationReasons.push("safety-snapshot-coverage");
  }

  let validationFailures = 0;
  if (validation.ok && !safetySnapshotDegraded) {
    await setCache(db, "yield-rankings", JSON.stringify(validation.data));
  } else if (!validation.ok) {
    validationFailures++;
    degradationReasons.push("schema-validation-failed");
    console.warn("[sync-yield-data] Skipped yield-rankings cache write due to schema validation failure");
  } else {
    console.warn("[sync-yield-data] Skipped yield-rankings cache write due to degraded safety snapshot");
  }

  console.log(`[sync-yield-data] Updated ${updatedCount} coins (${yieldCoins.length} yield-bearing + auto-discovered)`);
  const status = degradationReasons.length > 0 ? "degraded" : "ok";
  return {
    itemCount: updatedCount,
    ...(status === "degraded" ? { status: "degraded" as const } : {}),
    metadata: JSON.stringify({
      rowsRead: yieldCoins.length,
      rowsWritten: updatedCount,
      rowsDropped: 0,
      sourceCoverage: {
        safetyScoresComputed: safetyScores.size,
        safetyScoresExpected: TRACKED_STABLECOINS.length,
        safetyCoverageRatio: Number(safetyCoverageRatio.toFixed(4)),
      },
      fallbackMode: degradationReasons.length > 0 ? degradationReasons.join(",") : null,
      validationFailures,
      riskFreeRate,
      cacheWriteSkipped: !validation.ok || safetySnapshotDegraded,
    }),
  };
}

// -- Helpers -----------------------------------------------------------------

function rowToRanking(row: Record<string, unknown>) {
  return {
    id: row.stablecoin_id,
    symbol: row.symbol,
    name: TRACKED_STABLECOINS.find((m) => m.id === row.stablecoin_id)?.name ?? String(row.symbol),
    currentApy: row.current_apy,
    apy7d: row.apy_7d,
    apy30d: row.apy_30d,
    apyBase: row.apy_base,
    apyReward: row.apy_reward,
    yieldSource: row.yield_source,
    yieldType: row.yield_type,
    dataSource: row.data_source,
    sourceTvlUsd: row.source_tvl_usd,
    pharosYieldScore: row.pharos_yield_score,
    safetyScore: row.safety_score,
    safetyGrade: row.safety_grade,
    yieldToRisk: row.yield_to_risk,
    excessYield: row.excess_yield,
    yieldStability: row.yield_stability,
    apyVariance30d: row.apy_variance_30d,
    apyMin30d: row.apy_min_30d,
    apyMax30d: row.apy_max_30d,
    warningSignals: parseWarningSignals(row.warning_signals),
    altSources: [] as AltYieldSource[],
  };
}

function parseWarningSignals(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}
