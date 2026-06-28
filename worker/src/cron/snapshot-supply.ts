import { batchExecute } from "../lib/db";
import { SUPPLY_HISTORY_UPSERT_SQL } from "../lib/supply-history-db";
import { PSI_ELIGIBLE_STABLECOINS } from "@shared/lib/psi-eligible";
import { sumPegBuckets } from "@shared/lib/supply";
import { formatIsoDate } from "@shared/lib/format";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { setCache } from "../lib/db-cache";
import { getCompletedSupplySnapshot } from "../lib/supply-snapshot-completion";
import { startOfUtcDaySec } from "../lib/time-constants";

const CACHE_MAX_AGE_SEC = 1200;
const CACHE_DEGRADED_AGE_SEC = 600;
/** Minimum fraction of tracked coins that must have valid data; below this the snapshot is blocked. */
const MIN_SNAPSHOT_COVERAGE_FRACTION = 0.8;

interface SnapshotSupplyOptions {
  minStablecoinsCacheUpdatedAtSec?: number | null;
  freshnessGateLabel?: string;
}

function buildStablecoinsCacheBeforeSlotResult(
  cacheUpdatedAt: number,
  requiredUpdatedAt: number,
  freshnessGateLabel?: string,
): CronResult {
  return {
    status: "degraded",
    itemCount: 0,
    metadata: JSON.stringify({
      reason: "stablecoins_cache_before_slot",
      cacheUpdatedAt,
      requiredUpdatedAt,
      freshnessGateLabel,
    }),
  };
}

function buildAlreadyWrittenBeforeFreshnessGateResult(params: {
  snapshotDate: number;
  cacheUpdatedAt: number;
  requiredUpdatedAt: number;
  freshnessGateLabel?: string;
}): CronResult {
  return {
    itemCount: 0,
    metadata: JSON.stringify({
      reason: "already_written_today_before_freshness_gate",
      snapshotDate: params.snapshotDate,
      cacheUpdatedAt: params.cacheUpdatedAt,
      requiredUpdatedAt: params.requiredUpdatedAt,
      freshnessGateLabel: params.freshnessGateLabel,
    }),
  };
}

export async function snapshotSupply(
  db: D1Database,
  signal?: AbortSignal,
  options: SnapshotSupplyOptions = {},
): Promise<CronResult> {
  throwIfAborted(signal);

  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });
  throwIfAborted(signal);
  if (stablecoinsCache.kind !== "ok") {
    console.error("[snapshot-supply] No stablecoins cache found");
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: stablecoinsCache.reason }),
    };
  }
  // One snapshot per UTC day, keyed on the marker's stored snapshotDate. The
  // previous 20h wall-clock cooldown drifted the write time through the whole
  // UTC day (consecutive rows spanned 20-28h), skewing day-over-day deltas;
  // date-keying pins the write to the first healthy run after UTC midnight.
  const snapshotDate = startOfUtcDaySec();
  const lastWrite = await getCompletedSupplySnapshot(db);
  throwIfAborted(signal);
  if (
    options.minStablecoinsCacheUpdatedAtSec != null
    && stablecoinsCache.updatedAt < options.minStablecoinsCacheUpdatedAtSec
  ) {
    if (lastWrite?.snapshotDate === snapshotDate) {
      return buildAlreadyWrittenBeforeFreshnessGateResult({
        snapshotDate,
        cacheUpdatedAt: stablecoinsCache.updatedAt,
        requiredUpdatedAt: options.minStablecoinsCacheUpdatedAtSec,
        freshnessGateLabel: options.freshnessGateLabel,
      });
    }
    return buildStablecoinsCacheBeforeSlotResult(
      stablecoinsCache.updatedAt,
      options.minStablecoinsCacheUpdatedAtSec,
      options.freshnessGateLabel,
    );
  }

  // Verify cache freshness — skip if stale (>20 min) to avoid snapshotting outdated data
  const cacheAge = Math.floor(Date.now() / 1000) - stablecoinsCache.updatedAt;
  if (cacheAge > CACHE_MAX_AGE_SEC) {
    console.warn(`[snapshot-supply] Cache is ${cacheAge}s old (>${CACHE_MAX_AGE_SEC}s), skipping snapshot`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "cache_stale", cacheAgeSec: cacheAge }),
    };
  }
  if (cacheAge > CACHE_DEGRADED_AGE_SEC) {
    console.warn(`[snapshot-supply] Cache is ${cacheAge}s old (>${CACHE_DEGRADED_AGE_SEC}s), proceeding with degraded freshness`);
  }

  if (lastWrite?.snapshotDate === snapshotDate) {
    return { itemCount: 0, metadata: JSON.stringify({ reason: "already_written_today", snapshotDate }) };
  }

  const trackedIds = new Set(PSI_ELIGIBLE_STABLECOINS.map((s) => s.id));

  const stmts: D1PreparedStatement[] = [];

  for (const asset of stablecoinsCache.payload.peggedAssets) {
    if (!trackedIds.has(asset.id)) continue;

    const circ = asset.circulating;
    if (!circ) continue;
    const circulatingUsd = sumPegBuckets(circ);
    if (circulatingUsd <= 0) continue;

    const price = typeof asset.price === "number" && asset.price > 0 ? asset.price : null;

    stmts.push(
      db
        .prepare(SUPPLY_HISTORY_UPSERT_SQL)
        .bind(asset.id, snapshotDate, circulatingUsd, price)
    );
  }

  const expectedCount = trackedIds.size;
  if (stmts.length < expectedCount * MIN_SNAPSHOT_COVERAGE_FRACTION) {
    console.warn(`[snapshot-supply] Only ${stmts.length}/${expectedCount} coins have valid data — possible upstream issue`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "partial_snapshot_blocked",
        validRows: stmts.length,
        expectedCount,
      }),
    };
  }

  if (stmts.length > 0) {
    try {
      throwIfAborted(signal);
      await batchExecute(db, stmts, { signal });
      throwIfAborted(signal);
      await setCache(db, "snapshot-supply:last-write", JSON.stringify({ snapshotDate }));
    } catch (err) {
      rethrowIfAborted(err, signal);
      recordCronFailure("snapshot-supply", err, { metadata: { stage: "batchExecute" } });
      return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "db_write_failed", error: String(err).slice(0, 200) }) };
    }
  }

  if (stmts.length === 0) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "all_coins_zero_supply" }),
    };
  }

  console.log(`[snapshot-supply] Inserted ${stmts.length} rows for date ${formatIsoDate(snapshotDate)}`);
  return { itemCount: stmts.length };
}
