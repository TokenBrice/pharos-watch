import { ACTIVE_STABLECOINS, TRACKED_IDS } from "@shared/lib/stablecoins";
import { LIQUIDITY_METHODOLOGY_VERSION } from "@shared/lib/liquidity-score-version";

const DEX_AGGREGATE_PRESERVE_IDS = new Set(["__global__"]);

/**
 * Compute the set of stablecoin ids whose DEX rows should be deleted.
 * Preserves rows for any tracked coin (active OR frozen) plus the
 * `__global__` aggregate sentinel. Only orphaned ids that no longer
 * exist in the registry get pruned.
 */
export function computeDexPruneSet(
  allDbIds: Set<string>,
  trackedIds: Set<string> = TRACKED_IDS,
): Set<string> {
  const prune = new Set<string>();
  for (const id of allDbIds) {
    if (trackedIds.has(id)) continue;
    if (DEX_AGGREGATE_PRESERVE_IDS.has(id)) continue;
    prune.add(id);
  }
  return prune;
}
import { batchExecute } from "../../lib/db";
import { writeFreshnessSentinel } from "../../lib/db-cache";
import type { LiquidityMetrics, FullScoreResult, GlobalAgg } from "./types";

const DEX_LIQUIDITY_UPSERT_SQL = `INSERT INTO dex_liquidity
  (stablecoin_id, symbol, total_tvl_usd, total_volume_24h_usd, total_volume_7d_usd,
   pool_count, pair_count, chain_count, protocol_tvl_json, chain_tvl_json,
   top_pools_json, liquidity_score, concentration_hhi,
   avg_pool_stress, weighted_balance_ratio, organic_fraction,
   effective_tvl_usd, durability_score, score_components_json,
   locked_liquidity_pct, coverage_class, coverage_confidence, source_mix_json,
   balance_measured_tvl_usd, organic_measured_tvl_usd, methodology_version, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(stablecoin_id) DO UPDATE SET
  symbol = excluded.symbol,
  total_tvl_usd = excluded.total_tvl_usd,
  total_volume_24h_usd = excluded.total_volume_24h_usd,
  total_volume_7d_usd = excluded.total_volume_7d_usd,
  pool_count = excluded.pool_count,
  pair_count = excluded.pair_count,
  chain_count = excluded.chain_count,
  protocol_tvl_json = excluded.protocol_tvl_json,
  chain_tvl_json = excluded.chain_tvl_json,
  top_pools_json = excluded.top_pools_json,
  liquidity_score = excluded.liquidity_score,
  concentration_hhi = excluded.concentration_hhi,
  avg_pool_stress = excluded.avg_pool_stress,
  weighted_balance_ratio = excluded.weighted_balance_ratio,
  organic_fraction = excluded.organic_fraction,
  effective_tvl_usd = excluded.effective_tvl_usd,
  durability_score = excluded.durability_score,
  score_components_json = excluded.score_components_json,
  locked_liquidity_pct = excluded.locked_liquidity_pct,
  coverage_class = excluded.coverage_class,
  coverage_confidence = excluded.coverage_confidence,
  source_mix_json = excluded.source_mix_json,
  balance_measured_tvl_usd = excluded.balance_measured_tvl_usd,
  organic_measured_tvl_usd = excluded.organic_measured_tvl_usd,
  methodology_version = excluded.methodology_version,
  updated_at = excluded.updated_at
WHERE dex_liquidity.updated_at <= excluded.updated_at`;

export interface PersistScoresResult {
  placeholderCount: number;
  orphanRowsDeleted: number;
  orphanCleanupFailed: boolean;
  skipped?: boolean;
  skippedReason?: string | null;
}

export interface HistoricalSnapshotWriteResult {
  snapshotRowsWritten: number;
  skipped: boolean;
  writeFailed: boolean;
}

/** Persist liquidity scores to D1 (both data rows and zero-score rows). */
export async function persistScores(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  scoreResults: Map<string, FullScoreResult>,
  globalAgg: GlobalAgg,
  nowSec: number,
): Promise<PersistScoresResult> {
  const stmts: D1PreparedStatement[] = [];
  let placeholderCount = 0;
  let orphanRowsDeleted = 0;
  let orphanCleanupFailed = false;

  for (const [id, m] of metrics) {
    const sr = scoreResults.get(id);
    if (!sr) continue;

    stmts.push(
      db
        .prepare(DEX_LIQUIDITY_UPSERT_SQL)
        .bind(
          id,
          m.symbol,
          m.totalTvlUsd,
          m.totalVolume24hUsd,
          m.totalVolume7dUsd,
          m.poolCount,
          m.pairs.size,
          m.chains.size,
          JSON.stringify(m.protocolTvl),
          JSON.stringify(m.chainTvl),
          JSON.stringify(m.topPools),
          sr.score,
          sr.hhi,
          sr.avgStress,
          sr.weightedBalanceRatio,
          sr.organicFrac,
          Math.round(m.effectiveTvl),
          sr.durability,
          JSON.stringify(sr.components),
          sr.lockedLiqPct,
          sr.coverageClass,
          sr.coverageConfidence,
          JSON.stringify(sr.sourceMix),
          sr.balanceMeasuredTvlUsd,
          sr.organicMeasuredTvlUsd,
          LIQUIDITY_METHODOLOGY_VERSION,
          nowSec,
        ),
    );
  }

  // Write placeholder rows for tracked stablecoins with no DEX presence
  // liquidity_score = NULL so report cards treat them as NR (not rated)
  for (const meta of ACTIVE_STABLECOINS) {
    if (!metrics.has(meta.id)) {
      placeholderCount++;
      stmts.push(
        db
          .prepare(DEX_LIQUIDITY_UPSERT_SQL)
          .bind(
            meta.id,
            meta.symbol,
            0,
            0,
            0,
            0,
            0,
            0,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            0,
            null,
            null,
            null,
            "unobserved",
            0,
            null,
            0,
            0,
            LIQUIDITY_METHODOLOGY_VERSION,
            nowSec,
          ),
      );
    }
  }

  // Write __global__ sentinel row with deduped cross-stablecoin aggregates
  stmts.push(
    db
      .prepare(DEX_LIQUIDITY_UPSERT_SQL)
      .bind(
        "__global__",
        "__global__",
        globalAgg.totalTvl,
        globalAgg.totalVol24h,
        globalAgg.totalVol7d,
        globalAgg.poolCount,
        0,
        globalAgg.chainCount,
        JSON.stringify(globalAgg.protocolTvl),
        JSON.stringify(globalAgg.chainTvl),
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        null,
        null,
        null,
        "unobserved",
        0,
        null,
        0,
        0,
        LIQUIDITY_METHODOLOGY_VERSION,
        nowSec,
      ),
  );

  // Clean up orphaned rows from stablecoins no longer in the tracked set.
  // Preserve TRACKED (active + frozen) plus the `__global__` aggregate so
  // frozen coins keep their historical DEX rows.
  const DEX_LIQUIDITY_TABLES = new Set([
    "dex_liquidity",
    "dex_liquidity_history",
    "dex_discovery_meta",
  ] as const);
  try {
    const tables = ["dex_liquidity", "dex_liquidity_history", "dex_discovery_meta"] as const;
    for (const table of tables) {
      if (!DEX_LIQUIDITY_TABLES.has(table)) throw new Error(`Invalid DEX liquidity table: ${table}`);
      const existingRows = await db
        // SAFETY: validated against DEX_LIQUIDITY_TABLES allowlist above.
        .prepare(`SELECT DISTINCT stablecoin_id FROM ${table}`)
        .all<{ stablecoin_id: string }>();
      const tableIds = new Set((existingRows.results ?? []).map((row) => row.stablecoin_id));
      const pruneIds = computeDexPruneSet(tableIds);
      for (const id of pruneIds) {
        orphanRowsDeleted++;
        stmts.push(
          // SAFETY: validated against DEX_LIQUIDITY_TABLES allowlist above.
          db.prepare(`DELETE FROM ${table} WHERE stablecoin_id = ?`).bind(id),
        );
      }
    }
  } catch (err) {
    orphanCleanupFailed = true;
    console.warn("[dex-liquidity] Failed to check for orphaned rows:", err);
  }

  // D1 batch limit — chunk
  await batchExecute(db, stmts);
  await writeFreshnessSentinel(db, "dex-liquidity", nowSec);

  console.log(`[dex-liquidity] Wrote ${stmts.length} rows (${metrics.size} with data, ${placeholderCount} zero, 1 global)`);
  return {
    placeholderCount,
    orphanRowsDeleted,
    orphanCleanupFailed,
  };
}

/** Write daily snapshot rows (first sync invocation after UTC midnight). */
export async function writeHistoricalSnapshots(
  db: D1Database,
  scoreMap: Map<string, FullScoreResult>,
): Promise<HistoricalSnapshotWriteResult> {
  const todayMidnight = Math.floor(Date.now() / 86_400_000) * 86_400; // epoch seconds at UTC midnight
  const expectedRowCount = ACTIVE_STABLECOINS.length;
  try {
    const existing = await db
      .prepare(
        `SELECT
           COUNT(*) as cnt,
           SUM(CASE WHEN liquidity_score IS NOT NULL THEN 1 ELSE 0 END) as scored
         FROM dex_liquidity_history
         WHERE snapshot_date = ?`
      )
      .bind(todayMidnight)
      .first<{ cnt: number; scored: number | null }>();
    const existingCount = existing?.cnt ?? 0;
    const existingScored = existing?.scored ?? 0;
    const incomingScored = scoreMap.size;

    // Keep repairing today's snapshot until coverage and scored-coin count are at least
    // as good as the current run (avoids locking in a degraded first post-midnight run).
    if (existingCount >= expectedRowCount && existingScored >= incomingScored) {
      return {
        snapshotRowsWritten: 0,
        skipped: true,
        writeFailed: false,
      };
    }

    const snapStmts: D1PreparedStatement[] = [];
    for (const [id, data] of scoreMap) {
      snapStmts.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO dex_liquidity_history
              (stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date,
               coverage_class, coverage_confidence, source_mix_json, methodology_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            id,
            data.tvl,
            data.vol24h,
            data.score,
            todayMidnight,
            data.coverageClass,
            data.coverageConfidence,
            JSON.stringify(data.sourceMix),
            LIQUIDITY_METHODOLOGY_VERSION,
          )
      );
    }
    // Also insert placeholder rows for coins without DEX presence (NULL score = NR)
    for (const meta of ACTIVE_STABLECOINS) {
      if (!scoreMap.has(meta.id)) {
        snapStmts.push(
          db
            .prepare(
              `INSERT OR REPLACE INTO dex_liquidity_history
                (stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date,
                 coverage_class, coverage_confidence, source_mix_json, methodology_version)
              VALUES (?, 0, 0, NULL, ?, 'unobserved', 0, NULL, ?)`
            )
            .bind(meta.id, todayMidnight, LIQUIDITY_METHODOLOGY_VERSION)
        );
      }
    }
    await batchExecute(db, snapStmts);
    console.log(
      `[dex-liquidity] Reconciled daily snapshot (${existingCount}/${existingScored} -> ${snapStmts.length}/${incomingScored}) for ${new Date(todayMidnight * 1000).toISOString().slice(0, 10)}`,
    );
    return {
      snapshotRowsWritten: snapStmts.length,
      skipped: false,
      writeFailed: false,
    };
  } catch (err) {
    console.warn("[dex-liquidity] Daily snapshot failed:", err);
    return {
      snapshotRowsWritten: 0,
      skipped: false,
      writeFailed: true,
    };
  }
}
