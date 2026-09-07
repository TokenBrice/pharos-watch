import { logWorkerEventArgs } from "../lib/structured-log";
import {
  D1_MAX_BOUND_PARAMETERS,
  batchExecute,
  chunkArray,
  executeAtomicBatch,
  prepareMultiRowInsertStatements,
} from "../lib/db";
import { SUPPLY_HISTORY_UPSERT_PREFIX } from "../lib/supply-history-db";
import { prepareCacheUpsert } from "../lib/db-cache";
import { SHADOW_IDS } from "@shared/lib/shadow-stablecoins";
import { WORKER_ACTIVE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { getCirculatingRaw } from "@shared/lib/supply";
import { CACHE_FRESHNESS_LANES } from "@shared/lib/api-freshness";
import { formatIsoDate } from "@shared/lib/format";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import {
  buildStablecoinsCacheFreshnessGateResult,
  buildSupplySnapshotCompletionMarker,
  preflightSupplySnapshot,
  SNAPSHOT_SUPPLY_LAST_WRITE_KEY,
} from "../lib/supply-snapshot-completion";
import {
  STABLECOIN_PUBLICATION_WAIVERS,
  evaluateStablecoinPublicationCoverage,
  type StablecoinPublicationWaiver,
} from "../lib/stablecoin-publication-coverage";

// Freshness gates follow the stablecoins producer cadence (`sync-stablecoins`
// via the shared lane descriptor): the snapshot logs a degraded-freshness
// warning after one missed interval and skips after two, so a cadence change
// moves these gates with it instead of stranding unanchored literals.
const STABLECOINS_CACHE_PRODUCER_INTERVAL_SEC = CACHE_FRESHNESS_LANES.stablecoins.producerIntervalSec;
const CACHE_DEGRADED_AGE_SEC = STABLECOINS_CACHE_PRODUCER_INTERVAL_SEC;
const CACHE_MAX_AGE_SEC = 2 * STABLECOINS_CACHE_PRODUCER_INTERVAL_SEC;

interface SnapshotSupplyOptions {
  minStablecoinsCacheUpdatedAtSec?: number | null;
  freshnessGateLabel?: string;
  nowSec?: number;
  publicationWaivers?: readonly StablecoinPublicationWaiver[];
  requiredActiveIds?: readonly string[];
  snapshotEligibleIds?: readonly string[];
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

  const publicationWaivers = options.publicationWaivers ?? STABLECOIN_PUBLICATION_WAIVERS;
  const configuredRequiredActiveIds = options.requiredActiveIds ?? [...WORKER_ACTIVE_IDS];
  const snapshotEligibleIds = new Set(
    options.snapshotEligibleIds ?? [...WORKER_ACTIVE_IDS, ...SHADOW_IDS],
  );
  const preflight = await preflightSupplySnapshot(db, {
    nowSec: options.nowSec,
    requiredActiveIds: configuredRequiredActiveIds,
    publicationWaivers,
    assertContinuation: () => throwIfAborted(signal),
    deriveCoverage: (payload, requiredActiveIds, snapshotDate) => {
      const requiredActiveIdSet = new Set(requiredActiveIds);
      const cachedIds = new Set(payload.peggedAssets.map((asset) => asset.id));
      const restoredSnapshotIds = new Set<string>();
      const nonRestoredSnapshotIds = new Set<string>();
      const validSnapshotIds = new Set<string>();
      const snapshotRows: Array<readonly [string, number, number, number | null]> = [];

      for (const asset of payload.peggedAssets) {
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

      return {
        accountedIds: new Set([...validSnapshotIds, ...restoredSnapshotIds]),
        context: {
          cachedIds,
          requiredActiveIdSet,
          restoredOnlyIds: [...restoredSnapshotIds]
            .filter((id) => requiredActiveIdSet.has(id) && !nonRestoredSnapshotIds.has(id))
            .sort(),
          snapshotRows,
          validSnapshotIds,
        },
      };
    },
  });
  throwIfAborted(signal);
  if (preflight.kind === "cache-unavailable") {
    logWorkerEventArgs("handler", "error", "[snapshot-supply] No stablecoins cache found");
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: preflight.reason },
    });
  }
  if (preflight.kind === "cache-stale") {
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "cache_stale", cacheAgeSec: preflight.cacheAgeSec },
    });
  }
  const {
    cache: stablecoinsCache,
    cacheAgeSec: cacheAge,
    context: { cachedIds, requiredActiveIdSet, restoredOnlyIds, snapshotRows, validSnapshotIds },
    coverageExpectation,
    lastWrite,
    nowSec,
    publicationCoverage,
    requiredActiveIds,
    snapshotDate,
  } = preflight;
  if (
    options.minStablecoinsCacheUpdatedAtSec != null
    && stablecoinsCache.updatedAt < options.minStablecoinsCacheUpdatedAtSec
  ) {
    if (
      publicationCoverage.complete
      && lastWrite?.snapshotDate === snapshotDate
      && lastWrite.exactCoverageVerified
    ) {
      return buildStablecoinsCacheFreshnessGateResult({
        alreadyWrittenSnapshotDate: snapshotDate,
        cacheUpdatedAt: stablecoinsCache.updatedAt,
        requiredUpdatedAt: options.minStablecoinsCacheUpdatedAtSec,
        freshnessGateLabel: options.freshnessGateLabel,
      });
    }
    return buildStablecoinsCacheFreshnessGateResult({
      cacheUpdatedAt: stablecoinsCache.updatedAt,
      requiredUpdatedAt: options.minStablecoinsCacheUpdatedAtSec,
      freshnessGateLabel: options.freshnessGateLabel,
    });
  }

  // Verify cache freshness — skip once the cache has missed two producer
  // intervals, to avoid snapshotting outdated data
  if (cacheAge > CACHE_MAX_AGE_SEC) {
    logWorkerEventArgs("handler", "warn", `[snapshot-supply] Cache is ${cacheAge}s old (>${CACHE_MAX_AGE_SEC}s), skipping snapshot`);
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "cache_stale", cacheAgeSec: cacheAge },
    });
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
      return createCronResult({
        itemCount: repairedPriceRows,
        metadata: {
          reason: repairedPriceRows > 0 ? "repaired_missing_prices_today" : "already_written_today",
          snapshotDate,
          repairedPriceRows,
        },
      });
    } catch (err) {
      rethrowIfAborted(err, signal);
      recordCronFailure("snapshot-supply", err, { metadata: { stage: "sameDayPriceRepair" } });
      return createCronResult({
        status: "degraded",
        itemCount: 0,
        metadata: { reason: "same_day_price_repair_failed", error: String(err).slice(0, 200) },
      });
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
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        reason: "partial_snapshot_blocked",
        validRows: publicationCoverage.presentActiveCount,
        expectedCount: publicationCoverage.expectedActiveCount,
        missingActiveIds: guardMissingActiveIds,
        missingCacheActiveIds: cacheCoverage.missingActiveIds,
        invalidSupplyIds,
        restoredOnlyIds,
        waivedActiveIds: publicationCoverage.waivedActiveIds,
      },
    });
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
        prepareCacheUpsert(db, { key: SNAPSHOT_SUPPLY_LAST_WRITE_KEY, value: markerValue, updatedAt: nowSec }),
      ];
      await executeAtomicBatch(db, replacementStatements, { signal });
      throwIfAborted(signal);
    } catch (err) {
      rethrowIfAborted(err, signal);
      recordCronFailure("snapshot-supply", err, { metadata: { stage: "atomicDateReplacement" } });
      return createCronResult({ status: "degraded", itemCount: 0, metadata: { reason: "db_write_failed", error: String(err).slice(0, 200) } });
    }
  }

  if (snapshotRows.length === 0) {
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "all_coins_zero_supply" },
    });
  }

  logWorkerEventArgs("handler", "info", `[snapshot-supply] Inserted ${snapshotRows.length} rows for date ${formatIsoDate(snapshotDate)}`);
  if (restoredOnlyIds.length > 0) {
    return createCronResult({
      status: "degraded",
      itemCount: snapshotRows.length,
      metadata: {
        reason: "snapshot_written_restored_skipped",
        writtenRows: snapshotRows.length,
        restoredOnlyIds,
      },
    });
  }
  return { itemCount: snapshotRows.length };
}
