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
import { PSI_ELIGIBLE_STABLECOINS, PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { derivePegRates } from "@shared/lib/peg-rates";
import type { CronResult } from "../lib/cron-logger";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { getCache, setCache } from "../lib/db-cache";
import { logMalformedJsonPath } from "../lib/json-decode-observability";
import { loadDewsSourceState } from "./dews/source-state";
import { buildDewsScoringResult } from "./dews/scoring";
import { persistDewsResults } from "./dews/persistence";
import type {
  MalformedPersistedInput,
  PersistedJsonDecodeReason,
  SourceFailure,
} from "./dews/contracts";

const DEWS_BOOTSTRAP_SENTINEL_CACHE_KEY = "dews:bootstrap-complete";

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
  const malformedPersistedInputs: MalformedPersistedInput[] = [];
  let validationFailures = 0;
  let malformedCoreInputRows = 0;

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

  const { peggedAssets: assets, fxFallbackRates } = stablecoinsCache.payload;
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
  const registerMalformedPersistedInput = (options: {
    source: string;
    context: string;
    stablecoinId: string;
    updatedAt?: number | null;
    reason: PersistedJsonDecodeReason;
    degradesRun: boolean;
  }): void => {
    validationFailures++;
    if (options.degradesRun) {
      malformedCoreInputRows++;
    }
    malformedPersistedInputs.push({
      source: options.source,
      context: options.context,
      stablecoinId: options.stablecoinId,
      updatedAt: options.updatedAt ?? null,
      degradesRun: options.degradesRun,
    });
    logMalformedJsonPath({
      scope: "cron",
      owner: "compute-dews",
      context: options.context,
      reason: options.reason,
      source: options.source,
      updatedAt: options.updatedAt ?? null,
      extra: {
        stablecoinId: options.stablecoinId,
        degradesRun: options.degradesRun,
      },
    });
  };

  // Derive peg rates for non-USD reference prices
  const { rates: pegRates } = derivePegRates(assets, PSI_ELIGIBLE_META_BY_ID, fxFallbackRates);

  const sourceState = await loadDewsSourceState({
    db,
    nowSec,
    bootstrapPending,
    registerSourceFailure,
    registerMalformedPersistedInput,
  });
  Object.assign(sourceCoverage, sourceState.sourceCoverage);

  const { results, liqHistCoverageCount, insufficientDataCount } = buildDewsScoringResult({
    assetById,
    pegRates,
    sourceState,
    registerMalformedPersistedInput,
  });
  const { rowsDropped } = await persistDewsResults({
    db,
    results,
    eligibleIds,
    nowSec,
  });

  const liqHistCoverage = results.length > 0 ? liqHistCoverageCount / results.length : 0;
  if (results.length > 0 && liqHistCoverage < 0.5) {
    console.warn(
      `[dews] Low 7d liquidity history coverage: ${liqHistCoverageCount}/${results.length} (${(liqHistCoverage * 100).toFixed(1)}%)`,
    );
  }

  const hardFailures = sourceFailures.filter((failure) => !failure.bootstrapAllowed);
  const degradedByMalformedInputs = malformedCoreInputRows > 0;
  const degraded = hardFailures.length > 0 || degradedByMalformedInputs;
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
    ...(degraded ? { status: "degraded" as const } : {}),
    metadata: JSON.stringify({
      rowsRead: assets.length + sourceState.dexLiqRows.results.length + sourceState.liqHistRowsRead,
      rowsWritten: results.length,
      rowsSkippedInsufficientData: insufficientDataCount,
      rowsDropped,
      sourceCoverage,
      sourceFailures,
      fallbackMode:
        hardFailures.length > 0
          ? "degraded-inputs"
          : degradedByMalformedInputs
            ? "malformed-persisted-inputs"
            : null,
      validationFailures,
      malformedCoreInputRows,
      malformedPersistedInputs,
      bootstrapPending,
    }),
  };
}
