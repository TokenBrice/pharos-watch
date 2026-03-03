import { getCache } from "../lib/db";
import { withErrorHandler, buildCacheStatuses, type CacheStatus, jsonResponse } from "../lib/api-utils";
import { requireAdmin } from "../lib/auth";

// --- Types ---

interface CronRun {
  startedAt: number;
  durationMs: number;
  status: string;
  error?: string;
  itemCount?: number;
  metadata?: Record<string, unknown>;
}

interface CronStatus {
  lastRun: CronRun | null;
  recentRuns: CronRun[];
  expectedIntervalSec: number;
  healthy: boolean;
}

interface DataQuality {
  totalStablecoins: number;
  missingPrices: number;
  blacklistMissingAmounts: number;
  blacklistTotal: number;
  onchainSupplyDivergences: number;
  onchainSupplyMonitoring: "active" | "unavailable";
  onchainSupplyLatestAt: number | null;
  onchainSupplyTrackedCoins: number;
  activeDepegs: number;
  staleOnchainSupply: number;
}

interface StatusResponse {
  timestamp: number;
  availabilityStatus: "healthy" | "degraded" | "stale";
  dataQualityStatus: "healthy" | "degraded" | "stale";
  overallStatus: "healthy" | "degraded" | "stale";
  caches: Record<string, CacheStatus>;
  crons: Record<string, CronStatus>;
  dataQuality: DataQuality;
  summary: {
    unhealthyCrons: number;
    cronErrors: number;
    worstCacheRatio: number;
  };
}

// --- Config ---

const CRON_INTERVALS: Record<string, number> = {
  "sync-stablecoins": 900,
  "sync-stablecoin-charts": 900,
  "sync-blacklist": 1200,
  "sync-mint-burn": 1200,
  "sync-dex-liquidity": 1800,
  "sync-usds-status": 86400,
  "sync-bluechip": 86400,
  "sync-fx-rates": 900,
  "daily-digest": 86400,
  "snapshot-supply": 86400,
  "stability-index": 900,
  "snapshot-psi": 86400,
  "sync-yield-data": 1800,
  "fetch-tbill-rate": 86400,
  "compute-dews": 900,
};

// --- Handler ---

export const handleStatus = withErrorHandler(
  "status",
  async (db: D1Database, adminKey?: string, request?: Request): Promise<Response> => {
    const authError = await requireAdmin(request, adminKey);
    if (authError) return authError;

    const now = Math.floor(Date.now() / 1000);

    // 1. Cache freshness
    const { caches, worstRatio: worstCacheRatio } = await buildCacheStatuses(db, now);

    // 2. Cron run history (batch query)
    const cronJobs = Object.keys(CRON_INTERVALS);
    const cronRows = await db
      .prepare(
        `SELECT job, started_at, duration_ms, status, error, item_count, metadata
         FROM cron_runs
         WHERE job IN (${cronJobs.map(() => '?').join(',')})
         ORDER BY started_at DESC`
      )
      .bind(...cronJobs)
      .all<{
        job: string;
        started_at: number;
        duration_ms: number;
        status: string;
        error: string | null;
        item_count: number | null;
        metadata: string | null;
      }>();

    // Group by job, keeping only the 10 most recent per job
    const cronByJob = new Map<string, CronRun[]>();
    for (const r of cronRows.results ?? []) {
      const runs = cronByJob.get(r.job) ?? [];
      if (runs.length < 10) {
        let parsedMeta: Record<string, unknown> | undefined;
        if (r.metadata) {
          try { parsedMeta = JSON.parse(r.metadata); } catch { /* ignore */ }
        }
        runs.push({
          startedAt: r.started_at,
          durationMs: r.duration_ms,
          status: r.status,
          ...(r.error ? { error: r.error } : {}),
          ...(r.item_count != null ? { itemCount: r.item_count } : {}),
          ...(parsedMeta ? { metadata: parsedMeta } : {}),
        });
        cronByJob.set(r.job, runs);
      }
    }

    const crons: Record<string, CronStatus> = {};
    let anyCronError = false;
    let unhealthyCrons = 0;
    let cronErrorCount = 0;
    for (const [job, interval] of Object.entries(CRON_INTERVALS)) {
      const runs = cronByJob.get(job) ?? [];
      const lastRun = runs.length > 0 ? runs[0] : null;
      const isFresh = lastRun != null && now - lastRun.startedAt <= interval * 2;
      const hasFreshOk = runs.some((run) => run.status === "ok" && now - run.startedAt <= interval * 2);
      const healthy =
        isFresh &&
        (
          lastRun!.status === "ok" ||
          (lastRun!.status === "skipped_locked" && hasFreshOk)
        );

      if (!healthy) unhealthyCrons++;
      if (lastRun?.status === "error") {
        anyCronError = true;
        cronErrorCount++;
      }

      crons[job] = {
        lastRun,
        recentRuns: runs,
        expectedIntervalSec: interval,
        healthy,
      };
    }

    // 3. Data quality
    const dataQuality = await getDataQuality(db, now);

    // 4. Overall status
    const availabilityStatus: StatusResponse["availabilityStatus"] =
      worstCacheRatio > 2 || anyCronError || unhealthyCrons >= 3
        ? "stale"
        : worstCacheRatio > 1.5 || unhealthyCrons > 0
          ? "degraded"
          : "healthy";

    const missingPriceRatio =
      dataQuality.totalStablecoins > 0 ? dataQuality.missingPrices / dataQuality.totalStablecoins : 0;
    const hasActiveOnchainMonitor = dataQuality.onchainSupplyMonitoring === "active";
    const staleOnchainSupply = hasActiveOnchainMonitor ? dataQuality.staleOnchainSupply : 0;
    const onchainSupplyDivergences = hasActiveOnchainMonitor ? dataQuality.onchainSupplyDivergences : 0;
    const dataQualityStatus: StatusResponse["dataQualityStatus"] =
      missingPriceRatio > 0.4 ||
      staleOnchainSupply >= 5 ||
      onchainSupplyDivergences >= 10
        ? "stale"
        : missingPriceRatio > 0.15 ||
            dataQuality.blacklistMissingAmounts > 0 ||
            staleOnchainSupply > 0 ||
            onchainSupplyDivergences > 0
          ? "degraded"
          : "healthy";

    const severity: Record<StatusResponse["overallStatus"], number> = {
      healthy: 0,
      degraded: 1,
      stale: 2,
    };
    const overallStatus: StatusResponse["overallStatus"] =
      severity[availabilityStatus] >= severity[dataQualityStatus]
        ? availabilityStatus
        : dataQualityStatus;

    const body: StatusResponse = {
      timestamp: now,
      availabilityStatus,
      dataQualityStatus,
      overallStatus,
      caches,
      crons,
      dataQuality,
      summary: {
        unhealthyCrons,
        cronErrors: cronErrorCount,
        worstCacheRatio,
      },
    };

    return jsonResponse(body, { "Cache-Control": "no-store" });
  }
);

// --- Data quality queries ---

async function getDataQuality(db: D1Database, now: number): Promise<DataQuality> {
  // Missing prices: parse stablecoins cache
  let totalStablecoins = 0;
  let missingPrices = 0;
  try {
    const cached = await getCache(db, "stablecoins");
    if (cached) {
      const data = JSON.parse(cached.value);
      const assets = Array.isArray(data) ? data : data?.peggedAssets ?? [];
      totalStablecoins = assets.length;
      missingPrices = assets.filter(
        (a: { price?: number | null }) => a.price == null || a.price === 0
      ).length;
    }
  } catch (e) {
    console.error("[status] Failed to parse stablecoins cache:", e);
  }

  // Blacklist gaps
  let blacklistTotal = 0;
  let blacklistMissingAmounts = 0;
  try {
    const bl = await db
      .prepare(
        "SELECT COUNT(*) as total, SUM(CASE WHEN amount IS NULL THEN 1 ELSE 0 END) as missing FROM blacklist_events"
      )
      .first<{ total: number; missing: number }>();
    if (bl) {
      blacklistTotal = bl.total;
      blacklistMissingAmounts = bl.missing;
    }
  } catch (e) {
    console.error("[status] Failed to query blacklist gaps:", e);
  }

  // Active depegs
  let activeDepegs = 0;
  try {
    const dp = await db
      .prepare("SELECT COUNT(*) as cnt FROM depeg_events WHERE ended_at IS NULL")
      .first<{ cnt: number }>();
    if (dp) activeDepegs = dp.cnt;
  } catch (e) {
    console.error("[status] Failed to query active depegs:", e);
  }

  // Stale on-chain supply (rows older than 2h)
  let staleOnchainSupply = 0;
  let onchainSupplyDivergences = 0;
  let onchainSupplyMonitoring: DataQuality["onchainSupplyMonitoring"] = "unavailable";
  let onchainSupplyLatestAt: number | null = null;
  let onchainSupplyTrackedCoins = 0;
  try {
    const monitor = await db
      .prepare(
        "SELECT MAX(updated_at) as latest, COUNT(DISTINCT stablecoin_id) as tracked FROM onchain_supply"
      )
      .first<{ latest: number | null; tracked: number }>();
    onchainSupplyLatestAt = monitor?.latest ?? null;
    onchainSupplyTrackedCoins = monitor?.tracked ?? 0;

    // The on-chain supply monitor is considered active only when rows are recent.
    if (onchainSupplyLatestAt != null && (now - onchainSupplyLatestAt) <= 3 * 86400) {
      onchainSupplyMonitoring = "active";
    }
  } catch (e) {
    console.error("[status] Failed to query stale on-chain supply:", e);
  }

  if (onchainSupplyMonitoring === "active") {
    try {
      const stale = await db
        .prepare(
          `SELECT COUNT(*) as cnt
           FROM (
             SELECT stablecoin_id, MAX(updated_at) as latest_update
             FROM onchain_supply
             GROUP BY stablecoin_id
             HAVING latest_update < ?
           )`
        )
        .bind(now - 7200)
        .first<{ cnt: number }>();
      if (stale) staleOnchainSupply = stale.cnt;
    } catch (e) {
      console.error("[status] Failed to query stale on-chain supply:", e);
    }

    // On-chain supply divergences (compare on-chain vs DefiLlama)
    try {
      const onchainRows = await db
        .prepare(
          "SELECT stablecoin_id, SUM(supply) as total_supply FROM onchain_supply WHERE updated_at > ? GROUP BY stablecoin_id"
        )
        .bind(now - 7200)
        .all<{ stablecoin_id: string; total_supply: number }>();

      if (onchainRows.results && onchainRows.results.length > 0) {
        const cached = await getCache(db, "stablecoins");
        if (cached) {
          const data = JSON.parse(cached.value);
          const assets: Array<{ id: string; price?: number; circulating?: Record<string, number> }> =
            Array.isArray(data) ? data : data?.peggedAssets ?? [];
          const assetMap = new Map(assets.map((a) => [a.id, a]));

          for (const row of onchainRows.results) {
            const asset = assetMap.get(row.stablecoin_id);
            if (!asset?.price || asset.price <= 0 || !asset.circulating) continue;
            // DefiLlama circulating values are in USD
            const llamaValues = Object.values(asset.circulating);
            const llamaTotal = llamaValues.reduce((s, v) => s + (v ?? 0), 0);
            const llamaSupply = llamaTotal / asset.price;
            if (llamaSupply > 0) {
              const divergence = Math.abs(row.total_supply - llamaSupply) / llamaSupply;
              if (divergence > 0.05) onchainSupplyDivergences++;
            }
          }
        }
      }
    } catch (e) {
      console.error("[status] Failed to check on-chain supply divergences:", e);
    }
  }

  return {
    totalStablecoins,
    missingPrices,
    blacklistMissingAmounts,
    blacklistTotal,
    onchainSupplyDivergences,
    onchainSupplyMonitoring,
    onchainSupplyLatestAt,
    onchainSupplyTrackedCoins,
    activeDepegs,
    staleOnchainSupply,
  };
}
