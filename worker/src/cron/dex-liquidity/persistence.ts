import { TRACKED_STABLECOINS } from "../../../../src/lib/stablecoins";
import { LIQUIDITY_METHODOLOGY_VERSION } from "../../../../src/lib/liquidity-score-version";
import { batchExecute } from "../../lib/db";
import type { LiquidityMetrics, ScoreResult, FullScoreResult, GlobalAgg } from "./types";

const DEX_LIQUIDITY_UPSERT_SQL = `INSERT INTO dex_liquidity
  (stablecoin_id, symbol, total_tvl_usd, total_volume_24h_usd, total_volume_7d_usd,
   pool_count, pair_count, chain_count, protocol_tvl_json, chain_tvl_json,
   top_pools_json, liquidity_score, concentration_hhi,
   avg_pool_stress, weighted_balance_ratio, organic_fraction,
   effective_tvl_usd, durability_score, score_components_json,
   locked_liquidity_pct, methodology_version, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  methodology_version = excluded.methodology_version,
  updated_at = excluded.updated_at
WHERE dex_liquidity.updated_at <= excluded.updated_at`;

/** Persist liquidity scores to D1 (both data rows and zero-score rows). */
export async function persistScores(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  scoreResults: Map<string, FullScoreResult>,
  globalAgg: GlobalAgg,
  nowSec: number,
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  let placeholderCount = 0;

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
          LIQUIDITY_METHODOLOGY_VERSION,
          nowSec,
        ),
    );
  }

  // Write placeholder rows for tracked stablecoins with no DEX presence
  // liquidity_score = NULL so report cards treat them as NR (not rated)
  for (const meta of TRACKED_STABLECOINS) {
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
        LIQUIDITY_METHODOLOGY_VERSION,
        nowSec,
      ),
  );

  // D1 batch limit — chunk
  await batchExecute(db, stmts);

  console.log(`[dex-liquidity] Wrote ${stmts.length} rows (${metrics.size} with data, ${placeholderCount} zero, 1 global)`);
}

/** Write daily snapshot rows (first sync invocation after UTC midnight). */
export async function writeHistoricalSnapshots(
  db: D1Database,
  scoreMap: Map<string, ScoreResult>,
): Promise<void> {
  const todayMidnight = Math.floor(Date.now() / 86_400_000) * 86_400; // epoch seconds at UTC midnight
  const expectedRowCount = TRACKED_STABLECOINS.length;
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
      return;
    }

    const snapStmts: D1PreparedStatement[] = [];
    for (const [id, data] of scoreMap) {
      snapStmts.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO dex_liquidity_history
              (stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date, methodology_version)
            VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(id, data.tvl, data.vol24h, data.score, todayMidnight, LIQUIDITY_METHODOLOGY_VERSION)
      );
    }
    // Also insert placeholder rows for coins without DEX presence (NULL score = NR)
    for (const meta of TRACKED_STABLECOINS) {
      if (!scoreMap.has(meta.id)) {
        snapStmts.push(
          db
            .prepare(
              `INSERT OR REPLACE INTO dex_liquidity_history
                (stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date, methodology_version)
              VALUES (?, 0, 0, NULL, ?, ?)`
            )
            .bind(meta.id, todayMidnight, LIQUIDITY_METHODOLOGY_VERSION)
        );
      }
    }
    await batchExecute(db, snapStmts);
    console.log(
      `[dex-liquidity] Reconciled daily snapshot (${existingCount}/${existingScored} -> ${snapStmts.length}/${incomingScored}) for ${new Date(todayMidnight * 1000).toISOString().slice(0, 10)}`,
    );
  } catch (err) {
    console.warn("[dex-liquidity] Daily snapshot failed:", err);
  }
}
