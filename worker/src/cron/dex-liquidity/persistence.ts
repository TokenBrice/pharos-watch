import { TRACKED_STABLECOINS } from "../../../../src/lib/stablecoins";
import { LIQUIDITY_METHODOLOGY_VERSION } from "../../../../src/lib/liquidity-score-version";
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
             locked_liquidity_pct, methodology_version, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          LIQUIDITY_METHODOLOGY_VERSION,
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
               top_pools_json, liquidity_score, effective_tvl_usd, methodology_version, updated_at)
            VALUES (?, ?, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, 0, ?, ?)`
          )
          .bind(meta.id, meta.symbol, LIQUIDITY_METHODOLOGY_VERSION, nowSec),
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
           top_pools_json, liquidity_score, effective_tvl_usd, methodology_version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, 0, ?, ?)`
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
        LIQUIDITY_METHODOLOGY_VERSION,
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
  const expectedRowCount = TRACKED_STABLECOINS.length;
  try {
    const existing = await db
      .prepare("SELECT COUNT(*) as cnt FROM dex_liquidity_history WHERE snapshot_date = ?")
      .bind(todayMidnight)
      .first<{ cnt: number }>();
    const existingCount = existing?.cnt ?? 0;

    if (existingCount >= expectedRowCount) {
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
      `[dex-liquidity] Reconciled daily snapshot (${existingCount} -> ${snapStmts.length}/${expectedRowCount}) for ${new Date(todayMidnight * 1000).toISOString().slice(0, 10)}`,
    );
  } catch (err) {
    console.warn("[dex-liquidity] Daily snapshot failed:", err);
  }
}
