/**
 * Dynamic Early Warning Score (DEWS) — composite risk metric cron job.
 *
 * DEWS aggregates multiple real-time signals into a single 0-100 risk score
 * per stablecoin (higher = more risk). Runs every 15 minutes, chained after
 * syncStablecoins so fresh supply data is always available.
 *
 * Signal sources (read from D1):
 * - Peg deviation: oracle/DEX price vs. expected peg reference
 * - Pool balance ratio: DEX pool imbalance indicating directional pressure
 * - Liquidity depth: current TVL vs. 7-day ago TVL (trend signal)
 * - Price confidence: consensus quality from the pricing engine
 * - Mint/burn flows: 24h vs. 30-day baseline (anomalous outflows = stress)
 * - Blacklist events: on-chain address freezes (24h + 7d windows)
 * - Yield warnings: anomalous APY signals from yield tracking
 * - PSI score: ecosystem-level stress context for individual coin scoring
 *
 * Persistence: current scores → `stress_signals` (7-day rolling);
 * daily snapshots → `stress_signal_history` (365-day rolling).
 *
 * Bootstrap mode: On first run or after schema migration, sources flagged in
 * `BOOTSTRAP_ALLOWED_MISSING_TABLE_SOURCES` are tolerated as missing so that
 * DEWS can produce partial scores before all tables are populated.
 */
// DEWS cron job — runs every 15 minutes, chained after syncStablecoins
// (same pattern as stability-index).
// Reads existing D1 tables, computes DEWS per eligible coin,
// writes to stress_signals + stress_signal_history.
import { z } from "zod";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { PSI_ELIGIBLE_STABLECOINS, PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { batchExecute, buildInClause } from "../lib/db";
import type { CronResult } from "../lib/cron-logger";
import { computeDEWS } from "../lib/dews";
import type { DEWSInput, PoolEntry } from "../lib/dews";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { DEX_PRICE_CHECK_FRESHNESS_SEC } from "../lib/constants";
import { chunkArray } from "../lib/collections";
import { getCache, setCache } from "../lib/db-cache";

const RawPoolDataSchema = z.object({
  tvlUsd: z.number().default(0),
  extra: z.object({
    balanceRatio: z.number(),
  }).optional(),
});

// Map blacklist symbol → stablecoin IDs
const BLACKLIST_SYMBOL_TO_IDS: Record<string, string[]> = {
  USDC: ["usdc-circle"],
  USDT: ["usdt-tether"],
  PAXG: ["paxg-paxos"],
  XAUT: ["xaut-tether"],
};

const BLACKLIST_ID_TO_SYMBOL = new Map<string, string>();
for (const [sym, ids] of Object.entries(BLACKLIST_SYMBOL_TO_IDS)) {
  for (const id of ids) BLACKLIST_ID_TO_SYMBOL.set(id, sym);
}

const D1_SAFE_SQL_IN_CHUNK_SIZE = 90;
const DEWS_BOOTSTRAP_SENTINEL_CACHE_KEY = "dews:bootstrap-complete";
const DEWS_STALE_DEX_LIQUIDITY_SEC = 2 * 3600;
const DEWS_TABLES = new Set([
  "stress_signals",
  "stress_signal_history",
]);
const BOOTSTRAP_ALLOWED_MISSING_TABLE_SOURCES = new Set([
  "dex-prices",
  "dex-liquidity-history",
  "blacklist-events",
  "mint-burn-hourly",
  "yield-data",
  "stability-index-samples",
]);

interface SourceFailure {
  source: string;
  reason: string;
  bootstrapAllowed: boolean;
}

function isMissingTableError(error: unknown): boolean {
  return String(error).toLowerCase().includes("no such table");
}

function isBootstrapAllowedMissingTableSource(source: string): boolean {
  return BOOTSTRAP_ALLOWED_MISSING_TABLE_SOURCES.has(source);
}

async function deleteOrphansForTable(
  db: D1Database,
  table: string,
  eligibleIds: Set<string>,
): Promise<number> {
  if (!DEWS_TABLES.has(table)) throw new Error(`Invalid DEWS table: ${table}`);

  const existingIds = await db
    // SAFETY: validated against DEWS_TABLES allowlist above.
    .prepare(`SELECT DISTINCT stablecoin_id FROM ${table}`)
    .all<{ stablecoin_id: string }>();
  const orphanIds = (existingIds.results ?? [])
    .map((row) => row.stablecoin_id)
    .filter((id) => !eligibleIds.has(id));

  if (orphanIds.length === 0) return 0;

  let deleted = 0;
  for (const idChunk of chunkArray(orphanIds, D1_SAFE_SQL_IN_CHUNK_SIZE)) {
    const inClause = buildInClause(idChunk);
    const result = await db
      // SAFETY: validated against DEWS_TABLES allowlist above.
      .prepare(`DELETE FROM ${table} WHERE stablecoin_id IN (${inClause.sql})`)
      .bind(...inClause.binds)
      .run();
    deleted += result.meta?.changes ?? 0;
  }
  return deleted;
}

/**
 * Main cron entry point: reads all signal sources from D1, computes DEWS for
 * every PSI-eligible non-NAV stablecoin, persists results, and returns a
 * structured {@link CronResult} with coverage diagnostics.
 *
 * Execution steps:
 * 1. Load stablecoins cache (hard dependency — aborts if unavailable).
 * 2. Read DEX liquidity, DEX prices, 7d liquidity history.
 * 3. Read blacklist event counts (24h + 7d per symbol).
 * 4. Read previous stress signals for EMA smoothing of pool/divergence signals.
 * 5. Read mint/burn hourly aggregates (24h totals + 30d daily baselines).
 * 6. Read yield warnings and latest PSI score.
 * 7. For each eligible coin: assemble {@link DEWSInput}, call `computeDEWS`,
 *    collect scored results.
 * 8. Batch-upsert current scores to `stress_signals`.
 * 9. Write daily snapshot to `stress_signal_history` (once per UTC day).
 * 10. Delete orphan rows for coins removed from the PSI universe.
 * 11. Prune stale rows (signals > 7d, history > 365d).
 *
 * Returns "degraded" status if any non-bootstrap-allowed source failed.
 * Partial results are always written — a failed source reduces coverage but
 * does not abort the entire run.
 *
 * @param db - D1 database handle bound to the Worker environment.
 * @param _signal - Unused AbortSignal (reserved for future graceful shutdown).
 * @returns CronResult with itemCount (coins computed) and JSON metadata
 *   containing rowsRead, rowsWritten, sourceCoverage, and sourceFailures.
 */
export async function computeAndStoreDEWS(
  db: D1Database,
  _signal?: AbortSignal,
): Promise<CronResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const eligibleIds = new Set(PSI_ELIGIBLE_STABLECOINS.map((meta) => meta.id));
  const sourceFailures: SourceFailure[] = [];
  const sourceCoverage: Record<string, number> = {};
  let validationFailures = 0;

  // 1. Read stablecoins cache
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: true });
  if (stablecoinsCache.kind !== "ok") {
    const failure: SourceFailure = {
      source: "stablecoins-cache",
      reason: stablecoinsCache.reason,
      bootstrapAllowed: false,
    };
    return {
      itemCount: 0,
      status: "degraded",
      metadata: JSON.stringify({
        rowsRead: 0,
        rowsWritten: 0,
        rowsDropped: 0,
        sourceCoverage: { stablecoins: 0 },
        sourceFailures: [failure],
        fallbackMode: "stablecoins-cache-unavailable",
        validationFailures: 1,
      }),
    };
  }

  const assets = stablecoinsCache.payload.peggedAssets;
  sourceCoverage.stablecoins = assets.length;
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const bootstrapPending = (await getCache(db, DEWS_BOOTSTRAP_SENTINEL_CACHE_KEY)) == null;

  const registerSourceFailure = (
    source: string,
    error: unknown,
    options?: { bootstrapAllowed?: boolean },
  ): void => {
    const bootstrapAllowed = options?.bootstrapAllowed ?? false;
    sourceFailures.push({
      source,
      reason: String(error),
      bootstrapAllowed,
    });
    console.warn(`[dews] ${source} unavailable${bootstrapAllowed ? " (bootstrap-allowed)" : ""}:`, error);
  };

  // Derive peg rates for non-USD reference prices
  const { rates: pegRates } = derivePegRates(assets, PSI_ELIGIBLE_META_BY_ID);

  // 2. Read dex_liquidity
  let dexLiqRows = {
    results: [] as Array<{
      stablecoin_id: string;
      weighted_balance_ratio: number | null;
      avg_pool_stress: number | null;
      top_pools_json: string | null;
      liquidity_score: number | null;
      total_tvl_usd: number | null;
      updated_at: number | null;
    }>,
  };
  try {
    dexLiqRows = await db
      .prepare(
        "SELECT stablecoin_id, weighted_balance_ratio, avg_pool_stress, top_pools_json, liquidity_score, total_tvl_usd, updated_at FROM dex_liquidity",
      )
      .all<{
        stablecoin_id: string;
        weighted_balance_ratio: number | null;
        avg_pool_stress: number | null;
        top_pools_json: string | null;
        liquidity_score: number | null;
        total_tvl_usd: number | null;
        updated_at: number | null;
      }>();
  } catch (error) {
    registerSourceFailure("dex-liquidity", error);
  }
  sourceCoverage.dexLiquidity = dexLiqRows.results.length;
  const dexLiqMap = new Map(dexLiqRows.results.map((r) => [r.stablecoin_id, r]));
  const dexLiquidityUpdatedAt = dexLiqRows.results.reduce<number | null>(
    (latest, row) => {
      if (row.updated_at == null || !Number.isFinite(row.updated_at)) return latest;
      if (latest == null || row.updated_at > latest) return row.updated_at;
      return latest;
    },
    null,
  );
  const dexLiquidityAgeSec = dexLiquidityUpdatedAt != null ? Math.max(0, nowSec - dexLiquidityUpdatedAt) : null;
  if (dexLiquidityAgeSec != null) {
    sourceCoverage.dexLiquidityAgeSec = dexLiquidityAgeSec;
    if (dexLiquidityAgeSec > DEWS_STALE_DEX_LIQUIDITY_SEC) {
      registerSourceFailure(
        "dex-liquidity-freshness",
        `dex_liquidity age ${dexLiquidityAgeSec}s exceeds ${DEWS_STALE_DEX_LIQUIDITY_SEC}s`,
      );
    }
  }

  // 3. Read dex_prices
  let dexPriceMap = new Map<string, number>();
  try {
    const dexPriceRows = await db
      .prepare("SELECT stablecoin_id, dex_price_usd, updated_at FROM dex_prices")
      .all<{ stablecoin_id: string; dex_price_usd: number; updated_at: number }>();
    dexPriceMap = new Map(
      (dexPriceRows.results ?? [])
        .filter((row) => (nowSec - row.updated_at) < DEX_PRICE_CHECK_FRESHNESS_SEC)
        .map((row) => [row.stablecoin_id, row.dex_price_usd]),
    );
    sourceCoverage.dexPrices = dexPriceMap.size;
  } catch (error) {
    registerSourceFailure("dex-prices", error, {
      bootstrapAllowed:
        bootstrapPending &&
        isMissingTableError(error) &&
        isBootstrapAllowedMissingTableSource("dex-prices"),
    });
    sourceCoverage.dexPrices = 0;
  }

  // 4. Read dex_liquidity_history (7d lookback)
  const liqHistCutoff = nowSec - 8 * DAY_SECONDS;
  const target7d = nowSec - 7 * DAY_SECONDS;
  const liqHist7dMap = new Map<string, { score: number | null; tvl: number | null; date: number }>();
  let liqHistRowsRead = 0;
  try {
    const liqHistRows = await db
      .prepare(
        "SELECT stablecoin_id, snapshot_date, liquidity_score, total_tvl_usd FROM dex_liquidity_history WHERE snapshot_date >= ? ORDER BY snapshot_date ASC",
      )
      .bind(liqHistCutoff)
      .all<{
        stablecoin_id: string;
        snapshot_date: number;
        liquidity_score: number | null;
        total_tvl_usd: number | null;
      }>();
    liqHistRowsRead = liqHistRows.results.length;

    for (const row of liqHistRows.results) {
      const existing = liqHist7dMap.get(row.stablecoin_id);
      if (!existing || Math.abs(row.snapshot_date - target7d) < Math.abs(existing.date - target7d)) {
        liqHist7dMap.set(row.stablecoin_id, {
          score: row.liquidity_score ?? null,
          tvl: row.total_tvl_usd ?? null,
          date: row.snapshot_date,
        });
      }
    }
  } catch (error) {
    registerSourceFailure("dex-liquidity-history", error, {
      bootstrapAllowed:
        bootstrapPending &&
        isMissingTableError(error) &&
        isBootstrapAllowedMissingTableSource("dex-liquidity-history"),
    });
  }
  sourceCoverage.dexLiquidityHistory = liqHistRowsRead;

  // 5. Read blacklist_events counts (24h + 7d)
  const blacklistCounts = new Map<string, { count24h: number; count7d: number }>();
  let blacklistRowsRead = 0;
  try {
    const bl7d = await db
      .prepare(
        "SELECT stablecoin, COUNT(*) as cnt FROM blacklist_events WHERE timestamp >= ? GROUP BY stablecoin",
      )
      .bind(nowSec - 7 * DAY_SECONDS)
      .all<{ stablecoin: string; cnt: number }>();
    const bl24h = await db
      .prepare(
        "SELECT stablecoin, COUNT(*) as cnt FROM blacklist_events WHERE timestamp >= ? GROUP BY stablecoin",
      )
      .bind(nowSec - DAY_SECONDS)
      .all<{ stablecoin: string; cnt: number }>();
    blacklistRowsRead = (bl7d.results?.length ?? 0) + (bl24h.results?.length ?? 0);

    const map7d = new Map(bl7d.results.map((r) => [r.stablecoin, r.cnt]));
    const map24h = new Map(bl24h.results.map((r) => [r.stablecoin, r.cnt]));

    for (const [symbol, count7d] of map7d) {
      blacklistCounts.set(symbol, {
        count24h: map24h.get(symbol) ?? 0,
        count7d,
      });
    }
  } catch (error) {
    registerSourceFailure("blacklist-events", error, {
      bootstrapAllowed:
        bootstrapPending &&
        isMissingTableError(error) &&
        isBootstrapAllowedMissingTableSource("blacklist-events"),
    });
  }
  sourceCoverage.blacklistEvents = blacklistRowsRead;

  // 6. Read previous stress_signals (for smoothing S_pool, S_diverg)
  const prevSignals = new Map<string, Record<string, { value: number }>>();
  let prevSignalRowsRead = 0;
  try {
    const prevRows = await db
      .prepare(
        `SELECT s.stablecoin_id, s.signals_json, s.band
         FROM stress_signals s
         INNER JOIN (
           SELECT stablecoin_id, MAX(computed_at) as max_at
           FROM stress_signals GROUP BY stablecoin_id
         ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`,
      )
      .all<{ stablecoin_id: string; signals_json: string; band: string }>();
    prevSignalRowsRead = prevRows.results.length;
    for (const row of prevRows.results) {
      try {
        prevSignals.set(row.stablecoin_id, JSON.parse(row.signals_json));
      } catch { /* expected: malformed signals_json from previous cycle */
        validationFailures++;
      }
    }
  } catch (error) {
    registerSourceFailure("stress-signals", error);
  }
  sourceCoverage.previousStressSignals = prevSignalRowsRead;

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
  let mintBurnRowsRead = 0;
  try {
    const mb24h = await db
      .prepare(
        `SELECT stablecoin_id,
                SUM(CASE WHEN burn_volume_usd IS NOT NULL THEN burn_volume_usd ELSE 0 END) as total_burn,
                SUM(CASE WHEN mint_volume_usd IS NOT NULL THEN mint_volume_usd ELSE 0 END) as total_mint
         FROM mint_burn_hourly WHERE hour_ts >= ? GROUP BY stablecoin_id`,
      )
      .bind(nowSec - DAY_SECONDS)
      .all<{ stablecoin_id: string; total_burn: number; total_mint: number }>();

    const mb30d = await db
      .prepare(
        `SELECT stablecoin_id,
                SUM(CASE WHEN burn_volume_usd IS NOT NULL THEN burn_volume_usd ELSE 0 END) / 30.0 as avg_burn,
                SUM(CASE WHEN mint_volume_usd IS NOT NULL THEN mint_volume_usd ELSE 0 END) / 30.0 as avg_mint,
                COUNT(DISTINCT date(hour_ts, 'unixepoch')) as days_with_data
         FROM mint_burn_hourly WHERE hour_ts >= ? GROUP BY stablecoin_id`,
      )
      .bind(nowSec - 30 * DAY_SECONDS)
      .all<{
        stablecoin_id: string;
        avg_burn: number;
        avg_mint: number;
        days_with_data: number;
      }>();
    mintBurnRowsRead = (mb24h.results?.length ?? 0) + (mb30d.results?.length ?? 0);

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
  } catch (error) {
    registerSourceFailure("mint-burn-hourly", error, {
      bootstrapAllowed:
        bootstrapPending &&
        isMissingTableError(error) &&
        isBootstrapAllowedMissingTableSource("mint-burn-hourly"),
    });
  }
  sourceCoverage.mintBurnHourly = mintBurnRowsRead;

  // 7b. Read yield warnings
  const yieldWarnings = new Map<string, string[]>();
  let yieldWarningRowsRead = 0;
  try {
    const yieldRows = await db
      .prepare("SELECT stablecoin_id, warning_signals FROM yield_data WHERE warning_signals IS NOT NULL")
      .all<{ stablecoin_id: string; warning_signals: string }>();
    yieldWarningRowsRead = yieldRows.results.length;
    for (const row of yieldRows.results) {
      try {
        const parsed = JSON.parse(row.warning_signals);
        if (Array.isArray(parsed)) yieldWarnings.set(row.stablecoin_id, parsed);
      } catch { /* expected: malformed warning_signals JSON */
        validationFailures++;
      }
    }
  } catch (error) {
    registerSourceFailure("yield-data", error, {
      bootstrapAllowed:
        bootstrapPending &&
        isMissingTableError(error) &&
        isBootstrapAllowedMissingTableSource("yield-data"),
    });
  }
  sourceCoverage.yieldWarnings = yieldWarningRowsRead;

  // 7c. Read latest PSI score (from previous cycle)
  let latestPsiScore: number | null = null;
  try {
    const psiRow = await db
      .prepare("SELECT score FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
      .first<{ score: number }>();
    if (psiRow) latestPsiScore = psiRow.score;
  } catch (error) {
    registerSourceFailure("stability-index-samples", error, {
      bootstrapAllowed:
        bootstrapPending &&
        isMissingTableError(error) &&
        isBootstrapAllowedMissingTableSource("stability-index-samples"),
    });
  }

  // 8. Compute DEWS for each eligible coin
  const results: {
    stablecoinId: string;
    score: number;
    band: string;
    signals: Record<string, unknown>;
  }[] = [];
  let liqHistCoverageCount = 0;
  let insufficientDataCount = 0;

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
    if (liqHist) liqHistCoverageCount++;
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
        topPools = (Array.isArray(parsed) ? parsed : []).map((raw) => {
          const p = RawPoolDataSchema.safeParse(raw);
          return {
            tvlUsd: p.success ? p.data.tvlUsd : 0,
            balanceRatio: p.success ? (p.data.extra?.balanceRatio ?? 1.0) : 1.0,
          };
        });
      } catch { /* expected: malformed top_pools_json */
        validationFailures++;
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
    if (!result) {
      insufficientDataCount++;
      continue;
    }
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
    .prepare("SELECT COUNT(*) as cnt FROM stress_signal_history WHERE snapshot_date = ?")
    .bind(todayMidnight)
    .first<{ cnt: number }>();
  const existingCount = existing?.cnt ?? 0;

  if (results.length > 0 && existingCount < results.length) {
    const histStmts = results.map((r) =>
      db
        .prepare(
          "INSERT OR REPLACE INTO stress_signal_history (stablecoin_id, snapshot_date, score, band, signals_json) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(r.stablecoinId, todayMidnight, r.score, r.band, JSON.stringify(r.signals)),
    );
    await batchExecute(db, histStmts);
    console.log(
      `[dews] Reconciled daily snapshot (${existingCount} -> ${histStmts.length}) for ${new Date(todayMidnight * 1000).toISOString().slice(0, 10)}`,
    );
  }

  let rowsDropped = 0;

  // 11. Remove orphan rows for coins no longer in the PSI universe.
  // Keep deletes chunked because D1 has a low bind-variable ceiling.
  if (eligibleIds.size > 0) {
    rowsDropped += await deleteOrphansForTable(db, "stress_signals", eligibleIds);
    rowsDropped += await deleteOrphansForTable(db, "stress_signal_history", eligibleIds);
  }

  // 12. Prune old data (7 days for signals, 365 for history)
  const oldSignals = await db
    .prepare("DELETE FROM stress_signals WHERE computed_at < ?")
    .bind(nowSec - 7 * DAY_SECONDS)
    .run();
  rowsDropped += oldSignals.meta?.changes ?? 0;
  const oldHistory = await db
    .prepare("DELETE FROM stress_signal_history WHERE snapshot_date < ?")
    .bind(nowSec - 365 * DAY_SECONDS)
    .run();
  rowsDropped += oldHistory.meta?.changes ?? 0;

  const liqHistCoverage = results.length > 0 ? liqHistCoverageCount / results.length : 0;
  if (results.length > 0 && liqHistCoverage < 0.5) {
    console.warn(
      `[dews] Low 7d liquidity history coverage: ${liqHistCoverageCount}/${results.length} (${(liqHistCoverage * 100).toFixed(1)}%)`,
    );
  }

  const hardFailures = sourceFailures.filter((failure) => !failure.bootstrapAllowed);
  sourceCoverage.liquidityHistoryCoveragePct = Number((liqHistCoverage * 100).toFixed(2));
  sourceCoverage.coinsComputed = results.length;
  sourceCoverage.coinsSkippedInsufficientData = insufficientDataCount;

  console.log(`[dews] Computed DEWS for ${results.length} coins`);
  if (bootstrapPending) {
    await setCache(
      db,
      DEWS_BOOTSTRAP_SENTINEL_CACHE_KEY,
      JSON.stringify({ completedAt: nowSec }),
    );
  }
  return {
    itemCount: results.length,
    ...(hardFailures.length > 0 ? { status: "degraded" as const } : {}),
    metadata: JSON.stringify({
      rowsRead: assets.length + dexLiqRows.results.length + liqHistRowsRead,
      rowsWritten: results.length,
      rowsSkippedInsufficientData: insufficientDataCount,
      rowsDropped,
      sourceCoverage,
      sourceFailures,
      fallbackMode: hardFailures.length > 0 ? "degraded-inputs" : null,
      validationFailures,
      bootstrapPending,
    }),
  };
}
