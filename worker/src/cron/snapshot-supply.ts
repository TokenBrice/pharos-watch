import { logWorkerEventArgs } from "../lib/structured-log";
import {
  D1_MAX_BOUND_PARAMETERS,
  batchExecute,
  chunkArray,
  executeAtomicBatch,
  prepareMultiRowInsertStatements,
} from "../lib/db";
import { SUPPLY_HISTORY_UPSERT_PREFIX } from "../lib/supply-history-db";
import { PSI_ELIGIBLE_STABLECOINS } from "@shared/lib/psi-eligible";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { getCirculatingRaw } from "@shared/lib/supply";
import { formatIsoDate } from "@shared/lib/format";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import {
  buildSupplySnapshotCoverageExpectation,
  buildSupplySnapshotCompletionMarker,
  getCompletedSupplySnapshot,
  SNAPSHOT_SUPPLY_LAST_WRITE_KEY,
} from "../lib/supply-snapshot-completion";
import { startOfUtcDaySec } from "@shared/lib/time-buckets";
import {
  STABLECOIN_PUBLICATION_WAIVERS,
  evaluateStablecoinPublicationCoverage,
  resolveStablecoinPublicationWaivers,
  selectAppliedStablecoinPublicationWaivers,
  type StablecoinPublicationWaiver,
} from "../lib/stablecoin-publication-coverage";

const CACHE_MAX_AGE_SEC = 1200;
const CACHE_DEGRADED_AGE_SEC = 600;

interface SnapshotSupplyOptions {
  minStablecoinsCacheUpdatedAtSec?: number | null;
  freshnessGateLabel?: string;
  nowSec?: number;
  publicationWaivers?: readonly StablecoinPublicationWaiver[];
  requiredActiveIds?: readonly string[];
  snapshotEligibleIds?: readonly string[];
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

async function repairSameDayMissingPrices(
  db: D1Database,
  snapshotDate: number,
  snapshotRows: readonly (readonly [string, number, number, number | null])[],
  signal?: AbortSignal,
): Promise<number> {
  const missing = await db.prepare(
    "SELECT stablecoin_id FROM supply_history WHERE snapshot_date = ? AND price IS NULL",
  ).bind(snapshotDate).all<{ stablecoin_id: string }>();
  throwIfAborted(signal);

  const missingIds = new Set((missing.results ?? []).map((row) => row.stablecoin_id));
  const repairs = snapshotRows
    .filter(([stablecoinId, , , price]) => missingIds.has(stablecoinId) && price != null)
    .map(([stablecoinId, , , price]) => db.prepare(
      "UPDATE supply_history SET price = ? WHERE stablecoin_id = ? AND snapshot_date = ? AND price IS NULL",
    ).bind(price, stablecoinId, snapshotDate));

  return batchExecute(db, repairs, { signal });
}

export async function snapshotSupply(
  db: D1Database,
  signal?: AbortSignal,
  options: SnapshotSupplyOptions = {},
): Promise<CronResult> {
  throwIfAborted(signal);

  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict" });
  throwIfAborted(signal);
  if (stablecoinsCache.kind !== "ok") {
    logWorkerEventArgs("handler", "error", "[snapshot-supply] No stablecoins cache found");
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: stablecoinsCache.reason }),
    };
  }
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const publicationWaivers = options.publicationWaivers ?? STABLECOIN_PUBLICATION_WAIVERS;
  const requiredActiveIds = [...new Set(options.requiredActiveIds ?? PSI_ELIGIBLE_STABLECOINS
    .map((stablecoin) => stablecoin.id)
    .filter((id) => ACTIVE_IDS.has(id)))].sort();
  const snapshotEligibleIds = new Set(
    options.snapshotEligibleIds ?? PSI_ELIGIBLE_STABLECOINS.map((stablecoin) => stablecoin.id),
  );
  const requiredActiveIdSet = new Set(requiredActiveIds);
  const cachedIds = new Set(stablecoinsCache.payload.peggedAssets.map((asset) => asset.id));
  const restoredSnapshotIds = new Set<string>();
  const nonRestoredSnapshotIds = new Set<string>();
  const validSnapshotIds = new Set<string>();
  const snapshotRows: Array<readonly [string, number, number, number | null]> = [];

  // One snapshot per UTC day, keyed on the marker's stored snapshotDate. The
  // previous 20h wall-clock cooldown drifted the write time through the whole
  // UTC day (consecutive rows spanned 20-28h), skewing day-over-day deltas;
  // date-keying pins the write to the first healthy run after UTC midnight.
  const snapshotDate = startOfUtcDaySec(new Date());

  for (const asset of stablecoinsCache.payload.peggedAssets) {
    if (!snapshotEligibleIds.has(asset.id)) continue;
    if (asset.supplyRestored === true) {
      restoredSnapshotIds.add(asset.id);
      continue;
    }
    nonRestoredSnapshotIds.add(asset.id);

    const circ = asset.circulating;
    if (!circ) continue;
    const circulatingUsd = getCirculatingRaw(asset);
    if (circulatingUsd <= 0) continue;
    validSnapshotIds.add(asset.id);

    const price = typeof asset.price === "number" && asset.price > 0 ? asset.price : null;
    snapshotRows.push([asset.id, snapshotDate, circulatingUsd, price]);
  }

  const restoredOnlyIds = [...restoredSnapshotIds]
    .filter((id) => requiredActiveIdSet.has(id) && !nonRestoredSnapshotIds.has(id))
    .sort();

  // Restored rows are never written (a carried-forward value is not that
  // day's observation), but they are deliberate exclusions, not coverage
  // gaps: counting them as missing would let a handful of restored coins
  // veto every genuinely observed row for the whole UTC day.
  const coverageAccountedIds = new Set([...validSnapshotIds, ...restoredSnapshotIds]);
  const publicationCoverage = evaluateStablecoinPublicationCoverage(
    coverageAccountedIds,
    nowSec,
    publicationWaivers,
    requiredActiveIds,
  );
  const resolvedWaivers = resolveStablecoinPublicationWaivers(
    requiredActiveIds,
    nowSec,
    publicationWaivers,
  );
  const appliedWaivers = selectAppliedStablecoinPublicationWaivers(
    publicationCoverage.waivedActiveIds,
    resolvedWaivers,
  );
  const coverageExpectation = buildSupplySnapshotCoverageExpectation(requiredActiveIds, appliedWaivers);
  const lastWrite = await getCompletedSupplySnapshot(db, { expectedCoverage: coverageExpectation });
  throwIfAborted(signal);
  if (
    options.minStablecoinsCacheUpdatedAtSec != null
    && stablecoinsCache.updatedAt < options.minStablecoinsCacheUpdatedAtSec
  ) {
    if (
      publicationCoverage.complete
      && lastWrite?.snapshotDate === snapshotDate
      && lastWrite.exactCoverageVerified
    ) {
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
  const cacheAge = nowSec - stablecoinsCache.updatedAt;
  if (cacheAge > CACHE_MAX_AGE_SEC) {
    logWorkerEventArgs("handler", "warn", `[snapshot-supply] Cache is ${cacheAge}s old (>${CACHE_MAX_AGE_SEC}s), skipping snapshot`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "cache_stale", cacheAgeSec: cacheAge }),
    };
  }
  if (cacheAge > CACHE_DEGRADED_AGE_SEC) {
    logWorkerEventArgs("handler", "warn", `[snapshot-supply] Cache is ${cacheAge}s old (>${CACHE_DEGRADED_AGE_SEC}s), proceeding with degraded freshness`);
  }

  // A same-day rerun normally short-circuits, but a required id that was
  // restored at write time and has since produced a fresh observation must
  // re-write the day so its row stops missing (atomic date replacement).
  const recoveredSinceLastWrite = lastWrite?.snapshotDate === snapshotDate
    ? [...validSnapshotIds].filter(
      (id) => requiredActiveIdSet.has(id) && !(lastWrite.ownedRowIds ?? []).includes(id),
    )
    : [];
  if (
    publicationCoverage.complete
    && lastWrite?.snapshotDate === snapshotDate
    && lastWrite.exactCoverageVerified
    && recoveredSinceLastWrite.length === 0
  ) {
    try {
      const repairedPriceRows = await repairSameDayMissingPrices(db, snapshotDate, snapshotRows, signal);
      return {
        itemCount: repairedPriceRows,
        metadata: JSON.stringify({
          reason: repairedPriceRows > 0 ? "repaired_missing_prices_today" : "already_written_today",
          snapshotDate,
          repairedPriceRows,
        }),
      };
    } catch (err) {
      rethrowIfAborted(err, signal);
      recordCronFailure("snapshot-supply", err, { metadata: { stage: "sameDayPriceRepair" } });
      return {
        status: "degraded",
        itemCount: 0,
        metadata: JSON.stringify({ reason: "same_day_price_repair_failed", error: String(err).slice(0, 200) }),
      };
    }
  }
  if (!publicationCoverage.complete) {
    const cacheCoverage = evaluateStablecoinPublicationCoverage(
      cachedIds,
      nowSec,
      publicationWaivers,
      requiredActiveIds,
    );
    const guardMissingActiveIds = [...publicationCoverage.missingActiveIds].sort();
    const invalidSupplyIds = guardMissingActiveIds.filter(
      (id) => cachedIds.has(id),
    );
    logWorkerEventArgs("handler", "warn",
      `[snapshot-supply] Exact active coverage failed: ` +
      `${publicationCoverage.presentActiveCount}/${publicationCoverage.expectedActiveCount}; ` +
      `missing=${guardMissingActiveIds.slice(0, 20).join(",")}`,
    );
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "partial_snapshot_blocked",
        validRows: publicationCoverage.presentActiveCount,
        expectedCount: publicationCoverage.expectedActiveCount,
        missingActiveIds: guardMissingActiveIds,
        missingCacheActiveIds: cacheCoverage.missingActiveIds,
        invalidSupplyIds,
        restoredOnlyIds,
        waivedActiveIds: publicationCoverage.waivedActiveIds,
      }),
    };
  }

  if (snapshotRows.length > 0) {
    try {
      throwIfAborted(signal);
      const markerValue = JSON.stringify({
        ...buildSupplySnapshotCompletionMarker({
          snapshotDate,
          coverage: coverageExpectation,
          accountedActiveCount:
            publicationCoverage.presentActiveCount + publicationCoverage.waivedActiveCount,
          ownedRowIds: snapshotRows.map(([stablecoinId]) => stablecoinId),
        }),
        writtenRows: snapshotRows.length,
      });
      const ownedStablecoinIds = [...new Set([
        ...snapshotEligibleIds,
        ...(lastWrite?.ownedRowIds ?? []),
      ])].sort();
      const deleteStatements = chunkArray(
        ownedStablecoinIds,
        D1_MAX_BOUND_PARAMETERS - 1,
      ).map((stablecoinIds) => db.prepare(
        `DELETE FROM supply_history
         WHERE snapshot_date = ?
           AND stablecoin_id IN (${new Array(stablecoinIds.length).fill("?").join(", ")})`,
      ).bind(snapshotDate, ...stablecoinIds));
      const replacementStatements = [
        ...deleteStatements,
        ...prepareMultiRowInsertStatements(db, SUPPLY_HISTORY_UPSERT_PREFIX, snapshotRows),
        db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
          .bind(SNAPSHOT_SUPPLY_LAST_WRITE_KEY, markerValue, nowSec),
      ];
      await executeAtomicBatch(db, replacementStatements, { signal });
      throwIfAborted(signal);
    } catch (err) {
      rethrowIfAborted(err, signal);
      recordCronFailure("snapshot-supply", err, { metadata: { stage: "atomicDateReplacement" } });
      return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "db_write_failed", error: String(err).slice(0, 200) }) };
    }
  }

  if (snapshotRows.length === 0) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "all_coins_zero_supply" }),
    };
  }

  logWorkerEventArgs("handler", "info", `[snapshot-supply] Inserted ${snapshotRows.length} rows for date ${formatIsoDate(snapshotDate)}`);
  if (restoredOnlyIds.length > 0) {
    return {
      status: "degraded",
      itemCount: snapshotRows.length,
      metadata: JSON.stringify({
        reason: "snapshot_written_restored_skipped",
        writtenRows: snapshotRows.length,
        restoredOnlyIds,
      }),
    };
  }
  return { itemCount: snapshotRows.length };
}
