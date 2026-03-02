// DEWS cron job — runs every 15 minutes, chained after syncStablecoins
// (same pattern as stability-index).
// Reads existing D1 tables, computes DEWS per eligible coin,
// writes to stress_signals + stress_signal_history.
import type { StablecoinData } from "../../../src/lib/types";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "../../../src/lib/supply";
import { PSI_ELIGIBLE_STABLECOINS, PSI_ELIGIBLE_META_BY_ID } from "../../../src/lib/psi-eligible";
import { derivePegRates, getPegReference } from "../../../src/lib/peg-rates";
import { getCache, batchExecute } from "../lib/db";
import type { CronResult } from "../lib/db";
import { computeDEWS } from "../lib/dews";
import type { DEWSInput, PoolEntry } from "../lib/dews";

// Map blacklist symbol → stablecoin IDs
const BLACKLIST_SYMBOL_TO_IDS: Record<string, string[]> = {
  USDC: ["5"],
  USDT: ["1"],
  PAXG: ["49"],
  XAUT: ["87"],
};

const BLACKLIST_ID_TO_SYMBOL = new Map<string, string>();
for (const [sym, ids] of Object.entries(BLACKLIST_SYMBOL_TO_IDS)) {
  for (const id of ids) BLACKLIST_ID_TO_SYMBOL.set(id, sym);
}

export async function computeAndStoreDEWS(db: D1Database, _signal?: AbortSignal): Promise<CronResult> {
  const nowSec = Math.floor(Date.now() / 1000);

  // 1. Read stablecoins cache
  const stablecoinsCache = await getCache(db, "stablecoins");
  if (!stablecoinsCache) {
    return { metadata: "skipped: no stablecoins cache" };
  }

  const parsed = JSON.parse(stablecoinsCache.value) as { peggedAssets: StablecoinData[] };
  const assets = parsed.peggedAssets;
  const assetById = new Map(assets.map((a) => [a.id, a]));

  // Derive peg rates for non-USD reference prices
  const { rates: pegRates } = derivePegRates(assets, PSI_ELIGIBLE_META_BY_ID);

  // 2. Read dex_liquidity
  const dexLiqRows = await db
    .prepare(
      "SELECT stablecoin_id, weighted_balance_ratio, avg_pool_stress, top_pools_json, liquidity_score, total_tvl_usd FROM dex_liquidity",
    )
    .all<{
      stablecoin_id: string;
      weighted_balance_ratio: number | null;
      avg_pool_stress: number | null;
      top_pools_json: string | null;
      liquidity_score: number | null;
      total_tvl_usd: number | null;
    }>();
  const dexLiqMap = new Map(dexLiqRows.results.map((r) => [r.stablecoin_id, r]));

  // 3. Read dex_prices
  let dexPriceMap = new Map<string, number>();
  try {
    const dexPriceRows = await db
      .prepare("SELECT stablecoin_id, dex_price_usd FROM dex_prices")
      .all<{ stablecoin_id: string; dex_price_usd: number }>();
    dexPriceMap = new Map(dexPriceRows.results.map((r) => [r.stablecoin_id, r.dex_price_usd]));
  } catch {
    /* table may not exist */
  }

  // 4. Read dex_liquidity_history (7d lookback)
  const liqHistCutoff = nowSec - 8 * 86400;
  const target7d = nowSec - 7 * 86400;
  const liqHist7dMap = new Map<string, { score: number; tvl: number; date: number }>();
  try {
    const liqHistRows = await db
      .prepare(
        "SELECT stablecoin_id, date, score, tvl FROM dex_liquidity_history WHERE date >= ? ORDER BY date ASC",
      )
      .bind(liqHistCutoff)
      .all<{ stablecoin_id: string; date: number; score: number; tvl: number }>();

    for (const row of liqHistRows.results) {
      const existing = liqHist7dMap.get(row.stablecoin_id);
      if (!existing || Math.abs(row.date - target7d) < Math.abs(existing.date - target7d)) {
        liqHist7dMap.set(row.stablecoin_id, { score: row.score, tvl: row.tvl, date: row.date });
      }
    }
  } catch {
    /* table may not exist */
  }

  // 5. Read blacklist_events counts (24h + 7d)
  const blacklistCounts = new Map<string, { count24h: number; count7d: number }>();
  try {
    const bl7d = await db
      .prepare(
        "SELECT stablecoin, COUNT(*) as cnt FROM blacklist_events WHERE timestamp >= ? GROUP BY stablecoin",
      )
      .bind(nowSec - 7 * 86400)
      .all<{ stablecoin: string; cnt: number }>();
    const bl24h = await db
      .prepare(
        "SELECT stablecoin, COUNT(*) as cnt FROM blacklist_events WHERE timestamp >= ? GROUP BY stablecoin",
      )
      .bind(nowSec - 86400)
      .all<{ stablecoin: string; cnt: number }>();

    const map7d = new Map(bl7d.results.map((r) => [r.stablecoin, r.cnt]));
    const map24h = new Map(bl24h.results.map((r) => [r.stablecoin, r.cnt]));

    for (const [symbol, count7d] of map7d) {
      blacklistCounts.set(symbol, {
        count24h: map24h.get(symbol) ?? 0,
        count7d,
      });
    }
  } catch {
    /* blacklist_events may not exist */
  }

  // 6. Read previous stress_signals (for smoothing S_pool, S_diverg)
  const prevSignals = new Map<string, Record<string, { value: number }>>();
  try {
    const prevRows = await db
      .prepare(
        `SELECT s.stablecoin_id, s.signals_json
         FROM stress_signals s
         INNER JOIN (
           SELECT stablecoin_id, MAX(computed_at) as max_at
           FROM stress_signals GROUP BY stablecoin_id
         ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`,
      )
      .all<{ stablecoin_id: string; signals_json: string }>();
    for (const row of prevRows.results) {
      try {
        prevSignals.set(row.stablecoin_id, JSON.parse(row.signals_json));
      } catch {
        /* ignore malformed JSON */
      }
    }
  } catch {
    /* table may not exist on first run */
  }

  // 7. Read mint/burn hourly aggregates (24h + 30d baselines)
  const mintBurnMap = new Map<
    string,
    {
      burn24h: number;
      mint24h: number;
      burnBaseline: number;
      mintBaseline: number;
      dataAgeDays: number;
    }
  >();
  try {
    const mb24h = await db
      .prepare(
        `SELECT stablecoin_id,
                SUM(CASE WHEN burn_volume_usd IS NOT NULL THEN burn_volume_usd ELSE 0 END) as total_burn,
                SUM(CASE WHEN mint_volume_usd IS NOT NULL THEN mint_volume_usd ELSE 0 END) as total_mint
         FROM mint_burn_hourly WHERE hour_ts >= ? GROUP BY stablecoin_id`,
      )
      .bind(nowSec - 86400)
      .all<{ stablecoin_id: string; total_burn: number; total_mint: number }>();

    const mb30d = await db
      .prepare(
        `SELECT stablecoin_id,
                SUM(CASE WHEN burn_volume_usd IS NOT NULL THEN burn_volume_usd ELSE 0 END) / 30.0 as avg_burn,
                SUM(CASE WHEN mint_volume_usd IS NOT NULL THEN mint_volume_usd ELSE 0 END) / 30.0 as avg_mint,
                COUNT(DISTINCT date(hour_ts, 'unixepoch')) as days_with_data
         FROM mint_burn_hourly WHERE hour_ts >= ? GROUP BY stablecoin_id`,
      )
      .bind(nowSec - 30 * 86400)
      .all<{
        stablecoin_id: string;
        avg_burn: number;
        avg_mint: number;
        days_with_data: number;
      }>();

    const mb24hMap = new Map(mb24h.results.map((r) => [r.stablecoin_id, r]));
    const mb30dMap = new Map(mb30d.results.map((r) => [r.stablecoin_id, r]));

    for (const [id, d24] of mb24hMap) {
      const d30 = mb30dMap.get(id);
      mintBurnMap.set(id, {
        burn24h: d24.total_burn,
        mint24h: d24.total_mint,
        burnBaseline: d30?.avg_burn ?? 0,
        mintBaseline: d30?.avg_mint ?? 0,
        dataAgeDays: d30?.days_with_data ?? 0,
      });
    }
  } catch {
    /* mint_burn_hourly may not exist */
  }

  // 7b. Read yield warnings
  const yieldWarnings = new Map<string, string[]>();
  try {
    const yieldRows = await db
      .prepare("SELECT stablecoin_id, warning_signals FROM yield_data WHERE warning_signals IS NOT NULL")
      .all<{ stablecoin_id: string; warning_signals: string }>();
    for (const row of yieldRows.results) {
      try {
        const parsed = JSON.parse(row.warning_signals);
        if (Array.isArray(parsed)) yieldWarnings.set(row.stablecoin_id, parsed);
      } catch { /* ignore */ }
    }
  } catch { /* yield_data may not have column yet */ }

  // 7c. Read latest PSI score (from previous cycle)
  let latestPsiScore: number | null = null;
  try {
    const psiRow = await db
      .prepare("SELECT score FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
      .first<{ score: number }>();
    if (psiRow) latestPsiScore = psiRow.score;
  } catch { /* table may not exist */ }

  // 8. Compute DEWS for each eligible coin
  const results: {
    stablecoinId: string;
    score: number;
    band: string;
    signals: Record<string, unknown>;
  }[] = [];

  for (const meta of PSI_ELIGIBLE_STABLECOINS) {
    // Skip NAV tokens (price appreciates, not pegged to $1)
    if (meta.flags?.navToken) continue;

    const asset = assetById.get(meta.id);
    if (!asset) continue;

    const current = getCirculatingRaw(asset);
    if (current <= 0) continue;

    const prevDay = getPrevDayRaw(asset);
    const prevWeek = getPrevWeekRaw(asset);

    const dexLiq = dexLiqMap.get(meta.id);
    const dexPrice = dexPriceMap.get(meta.id);
    const liqHist = liqHist7dMap.get(meta.id);
    const prev = prevSignals.get(meta.id);
    const mb = mintBurnMap.get(meta.id);

    // Blacklist tracking
    const blSymbol = BLACKLIST_ID_TO_SYMBOL.get(meta.id);
    const blCounts = blSymbol ? blacklistCounts.get(blSymbol) : undefined;

    // Parse top pools
    let topPools: PoolEntry[] | null = null;
    if (dexLiq?.top_pools_json) {
      try {
        const parsed = JSON.parse(dexLiq.top_pools_json);
        topPools = (Array.isArray(parsed) ? parsed : []).map((p: Record<string, unknown>) => ({
          tvlUsd: (p.tvlUsd as number) ?? 0,
          balanceRatio: ((p.extra as Record<string, unknown>)?.balanceRatio as number) ?? 1.0,
        }));
      } catch {
        /* ignore malformed JSON */
      }
    }

    const pegRef = getPegReference(
      asset.pegType,
      pegRates,
      meta.commodityOunces,
    );

    const input: DEWSInput = {
      stablecoinId: meta.id,
      mcapUsd: current,
      pegType: asset.pegType ?? "peggedUSD",
      circulatingCurrent: current,
      circulatingPrevDay: prevDay || current,
      circulatingPrevWeek: prevWeek || current,
      weightedBalanceRatio: dexLiq?.weighted_balance_ratio ?? null,
      avgPoolStress: dexLiq?.avg_pool_stress ?? null,
      topPools,
      liquidityScore: dexLiq?.liquidity_score ?? null,
      liquidityScore7dAgo: liqHist?.score ?? null,
      tvlCurrent: dexLiq?.total_tvl_usd ?? null,
      tvl7dAgo: liqHist?.tvl ?? null,
      priceConfidence: asset.priceConfidence ?? null,
      prevPriceConfidence: (prev?.price as { confidence?: string })?.confidence ?? null,
      price: asset.price ?? null,
      pegRef: pegRef ?? 1.0,
      dexPriceUsd: dexPrice ?? null,
      blacklistEvents24h: blCounts?.count24h ?? 0,
      blacklistEvents7d: blCounts?.count7d ?? 0,
      hasBlacklistTracking: !!blSymbol,
      burnVolume24hUsd: mb?.burn24h ?? null,
      mintVolume24hUsd: mb?.mint24h ?? null,
      burnBaseline30dUsd: mb?.burnBaseline ?? null,
      flowDataAgeDays: mb?.dataAgeDays ?? 0,
      yieldWarnings: yieldWarnings.get(meta.id) ?? [],
      psiScore: latestPsiScore,
      prevPoolValue: (prev?.pool as { value?: number })?.value,
      prevDivergValue: (prev?.diverg as { value?: number })?.value,
    };

    const result = computeDEWS(input);
    results.push({
      stablecoinId: meta.id,
      score: result.score,
      band: result.band,
      signals: result.signals,
    });
  }

  // 9. Batch INSERT OR REPLACE
  if (results.length > 0) {
    const stmts = results.map((r) =>
      db
        .prepare(
          "INSERT OR REPLACE INTO stress_signals (stablecoin_id, computed_at, score, band, signals_json) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(r.stablecoinId, nowSec, r.score, r.band, JSON.stringify(r.signals)),
    );
    await batchExecute(db, stmts);
  }

  // 10. Daily snapshot (first run of UTC day)
  const nowUtc = new Date();
  const todayMidnight = Math.floor(
    Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()) / 1000,
  );
  const existing = await db
    .prepare("SELECT 1 FROM stress_signal_history WHERE snapshot_date = ? LIMIT 1")
    .bind(todayMidnight)
    .first();

  if (!existing && results.length > 0) {
    const histStmts = results.map((r) =>
      db
        .prepare(
          "INSERT OR REPLACE INTO stress_signal_history (stablecoin_id, snapshot_date, score, band, signals_json) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(r.stablecoinId, todayMidnight, r.score, r.band, JSON.stringify(r.signals)),
    );
    await batchExecute(db, histStmts);
  }

  // 11. Prune old data (7 days for signals, 365 for history)
  await db
    .prepare("DELETE FROM stress_signals WHERE computed_at < ?")
    .bind(nowSec - 7 * 86400)
    .run();
  await db
    .prepare("DELETE FROM stress_signal_history WHERE snapshot_date < ?")
    .bind(nowSec - 365 * 86400)
    .run();

  console.log(`[dews] Computed DEWS for ${results.length} coins`);
  return { itemCount: results.length, metadata: `${results.length} coins` };
}
