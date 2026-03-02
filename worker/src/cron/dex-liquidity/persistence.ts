import { TRACKED_STABLECOINS } from "../../../../src/lib/stablecoins";
import { batchExecute } from "../../lib/db";
import type { LiquidityMetrics, ScoreResult, FullScoreResult, GlobalAgg } from "./types";

/** Persist liquidity scores to D1 (both data rows and zero-score rows). */
export async function persistScores(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  scoreResults: Map<string, FullScoreResult>,
  globalAgg: GlobalAgg,
  nowSec: number,
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];

  for (const [id, m] of metrics) {
    const sr = scoreResults.get(id);
    if (!sr) continue;

    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO dex_liquidity
            (stablecoin_id, symbol, total_tvl_usd, total_volume_24h_usd, total_volume_7d_usd,
             pool_count, pair_count, chain_count, protocol_tvl_json, chain_tvl_json,
             top_pools_json, liquidity_score, concentration_hhi,
             avg_pool_stress, weighted_balance_ratio, organic_fraction,
             effective_tvl_usd, durability_score, score_components_json,
             locked_liquidity_pct, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
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
          nowSec,
        ),
    );
  }

  // Write placeholder rows for tracked stablecoins with no DEX presence
  // liquidity_score = NULL so report cards treat them as NR (not rated)
  for (const meta of TRACKED_STABLECOINS) {
    if (!metrics.has(meta.id)) {
      stmts.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO dex_liquidity
              (stablecoin_id, symbol, total_tvl_usd, total_volume_24h_usd, total_volume_7d_usd,
               pool_count, pair_count, chain_count, protocol_tvl_json, chain_tvl_json,
               top_pools_json, liquidity_score, effective_tvl_usd, updated_at)
            VALUES (?, ?, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, 0, ?)`
          )
          .bind(meta.id, meta.symbol, nowSec),
      );
    }
  }

  // Write __global__ sentinel row with deduped cross-stablecoin aggregates
  stmts.push(
    db
      .prepare(
        `INSERT OR REPLACE INTO dex_liquidity
          (stablecoin_id, symbol, total_tvl_usd, total_volume_24h_usd, total_volume_7d_usd,
           pool_count, pair_count, chain_count, protocol_tvl_json, chain_tvl_json,
           top_pools_json, liquidity_score, effective_tvl_usd, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, 0, ?)`
      )
      .bind(
        "__global__",
        "__global__",
        globalAgg.totalTvl,
        globalAgg.totalVol24h,
        globalAgg.totalVol7d,
        globalAgg.poolCount,
        globalAgg.chainCount,
        JSON.stringify(globalAgg.protocolTvl),
        JSON.stringify(globalAgg.chainTvl),
        nowSec,
      ),
  );

  // D1 batch limit — chunk
  await batchExecute(db, stmts);

  console.log(`[dex-liquidity] Wrote ${stmts.length} rows (${metrics.size} with data, ${stmts.length - metrics.size} zero, 1 global)`);
}

/** Write daily snapshot rows (first sync invocation after UTC midnight). */
export async function writeHistoricalSnapshots(
  db: D1Database,
  scoreMap: Map<string, ScoreResult>,
): Promise<void> {
  const todayMidnight = Math.floor(Date.now() / 86_400_000) * 86_400; // epoch seconds at UTC midnight
  try {
    const lastSnap = await db
      .prepare("SELECT MAX(snapshot_date) as last_date FROM dex_liquidity_history")
      .first<{ last_date: number | null }>();

    if (!lastSnap?.last_date || lastSnap.last_date < todayMidnight) {
      const snapStmts: D1PreparedStatement[] = [];
      for (const [id, data] of scoreMap) {
        snapStmts.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO dex_liquidity_history
                (stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date)
              VALUES (?, ?, ?, ?, ?)`
            )
            .bind(id, data.tvl, data.vol24h, data.score, todayMidnight)
        );
      }
      // Also insert placeholder rows for coins without DEX presence (NULL score = NR)
      for (const meta of TRACKED_STABLECOINS) {
        if (!scoreMap.has(meta.id)) {
          snapStmts.push(
            db
              .prepare(
                `INSERT OR IGNORE INTO dex_liquidity_history
                  (stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date)
                VALUES (?, 0, 0, NULL, ?)`
              )
              .bind(meta.id, todayMidnight)
          );
        }
      }
      await batchExecute(db, snapStmts);
      console.log(`[dex-liquidity] Wrote daily snapshot (${snapStmts.length} rows) for ${new Date(todayMidnight * 1000).toISOString().slice(0, 10)}`);
    }
  } catch (err) {
    console.warn("[dex-liquidity] Daily snapshot failed:", err);
  }
}
