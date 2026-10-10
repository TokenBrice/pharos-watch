import { logWorkerEventArgs } from "../lib/structured-log";
import {
  D1_MAX_BOUND_PARAMETERS,
  batchExecute,
  chunkArray,
  executeAtomicBatch,
  prepareMultiRowInsertStatements,
} from "../lib/db";
import { SUPPLY_SNAPSHOT_UPSERT_PREFIX } from "../lib/supply-history-db";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { prepareCacheUpsert } from "../lib/db-cache";
import { PSI_HISTORICAL_IDS } from "@shared/lib/psi-historical-assets";
import { WORKER_ACTIVE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { CACHE_FRESHNESS_LANES } from "@shared/lib/api-freshness";
import { formatIsoDate } from "@shared/lib/format";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import { createCronResult, type CronMetadataRecord } from "../lib/cron-result";
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
  classifyStablecoinPublicationGap,
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

/** `[stablecoinId, snapshotDate, circulatingUsd, price, priceObservedAt]` */
type SupplySnapshotRow = readonly [string, number, number, number | null, number | null];

async function repairSameDayMissingPrices(
  db: D1Database,
  snapshotDate: number,
  snapshotRows: readonly SupplySnapshotRow[],
  signal?: AbortSignal,
): Promise<number> {
  const missing = await db.prepare(
    "SELECT stablecoin_id FROM supply_history WHERE snapshot_date = ? AND price IS NULL",
  ).bind(snapshotDate).all<{ stablecoin_id: string }>();
  throwIfAborted(signal);

  const missingIds = new Set((missing.results ?? []).map((row) => row.stablecoin_id));
  // Rows carry a price only when it is an actual observation (see deriveCoverage).
  const repairs = snapshotRows
    .filter(([stablecoinId, , , price]) => missingIds.has(stablecoinId) && price != null)
    .map(([stablecoinId, , , price, priceObservedAt]) => db.prepare(
      "UPDATE supply_history SET price = ?, price_observed_at = ? WHERE stablecoin_id = ? AND snapshot_date = ? AND price IS NULL",
    ).bind(price, priceObservedAt, stablecoinId, snapshotDate));

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
    options.snapshotEligibleIds ?? [...WORKER_ACTIVE_IDS, ...PSI_HISTORICAL_IDS],
  );
  const preflight = await preflightSupplySnapshot(db, {
    nowSec: options.nowSec,
    requiredActiveIds: configuredRequiredActiveIds,
    publicationWaivers,
    maxCacheAgeSec: CACHE_MAX_AGE_SEC,
    assertContinuation: () => throwIfAborted(signal),
    deriveCoverage: (payload, requiredActiveIds, snapshotDate) => {
      const requiredActiveIdSet = new Set(requiredActiveIds);
      const cachedIds = new Set(payload.peggedAssets.map((asset) => asset.id));
      const restoredSnapshotIds = new Set<string>();
      const nonRestoredSnapshotIds = new Set<string>();
      const validSnapshotIds = new Set<string>();
      const snapshotRows: SupplySnapshotRow[] = [];

      for (const asset of payload.peggedAssets) {
        if (!snapshotEligibleIds.has(asset.id)) continue;
        if (asset.supplyRestored === true) {
          restoredSnapshotIds.add(asset.id);
          continue;
        }
        nonRestoredSnapshotIds.add(asset.id);

        const circ = asset.circulating;
        if (!circ) continue;
        const circulatingUsd = getCirculatingRawOrNull(asset);
        if (circulatingUsd === null) continue;
        validSnapshotIds.add(asset.id);

        // A nominal par reference (or other non-observed provenance) is not a
        // price observation: it never enters the daily price history. The
        // observation clock travels with the price; unknown stays NULL.
        const price = typeof asset.price === "number" && asset.price > 0 && isObservedPrice(asset)
          ? asset.price
          : null;
        const observedAt = asset.priceObservedAt;
        const priceObservedAt = price != null && typeof observedAt === "number"
          && Number.isSafeInteger(observedAt) && observedAt > 0
          ? observedAt
          : null;
        snapshotRows.push([asset.id, snapshotDate, circulatingUsd, price, priceObservedAt]);
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
  const publicationGapBand = classifyStablecoinPublicationGap(publicationCoverage);
  const publicationGap: CronMetadataRecord = publicationGapBand === "none" ? {} : {
    publicationGap: {
      band: publicationGapBand,
      missingActiveCount: publicationCoverage.missingActiveIds.length,
      missingActiveIds: publicationCoverage.missingActiveIds.slice(0, 20),
    },
  };
  const recoveredSinceLastWrite = lastWrite?.snapshotDate === snapshotDate
    ? [...validSnapshotIds].filter(
      (id) => requiredActiveIdSet.has(id) && !(lastWrite.ownedRowIds ?? []).includes(id),
    )
    : [];
  const alreadyWritten = publicationGapBand !== "systemic"
    && lastWrite?.snapshotDate === snapshotDate
    && lastWrite.coverageIdentityVerified
    && recoveredSinceLastWrite.length === 0;
  if (
    options.minStablecoinsCacheUpdatedAtSec != null
    && stablecoinsCache.updatedAt < options.minStablecoinsCacheUpdatedAtSec
  ) {
    if (alreadyWritten) {
      const result = buildStablecoinsCacheFreshnessGateResult({
        alreadyWrittenSnapshotDate: snapshotDate,
        cacheUpdatedAt: stablecoinsCache.updatedAt,
        requiredUpdatedAt: options.minStablecoinsCacheUpdatedAtSec,
        freshnessGateLabel: options.freshnessGateLabel,
      });
      return createCronResult({
        ...result,
        ...(publicationGapBand !== "none" ? {
          status: publicationGapBand === "elevated" ? "degraded" as const : "ok" as const,
        } : {}),
        metadata: {
          ...JSON.parse(result.metadata ?? "{}"),
          ...(publicationGapBand === "elevated" ? { reason: "publication_gap_elevated" } : {}),
          ...publicationGap,
        },
      });
    }
    return buildStablecoinsCacheFreshnessGateResult({
      cacheUpdatedAt: stablecoinsCache.updatedAt,
      requiredUpdatedAt: options.minStablecoinsCacheUpdatedAtSec,
      freshnessGateLabel: options.freshnessGateLabel,
    });
  }

  if (cacheAge > CACHE_DEGRADED_AGE_SEC) {
    logWorkerEventArgs("handler", "warn", `[snapshot-supply] Cache is ${cacheAge}s old (>${CACHE_DEGRADED_AGE_SEC}s), proceeding with degraded freshness`);
  }

  // Missing or restored required IDs recovering later trigger an atomic
  // date replacement; an unchanged partial day retains its first observations.
  if (alreadyWritten) {
    try {
      const repairedPriceRows = await repairSameDayMissingPrices(db, snapshotDate, snapshotRows, signal);
      return createCronResult({
        ...(publicationGapBand !== "none" ? {
          status: publicationGapBand === "elevated" ? "degraded" as const : "ok" as const,
        } : {}),
        itemCount: repairedPriceRows,
        metadata: {
          reason: repairedPriceRows > 0 ? "repaired_missing_prices_today" : "already_written_today",
          ...(publicationGapBand === "elevated" ? { reason: "publication_gap_elevated" } : {}),
          ...publicationGap,
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
  if (publicationGapBand === "systemic") {
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
      `[snapshot-supply] Systemic active coverage gap: ` +
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
          missingActiveIds: publicationCoverage.missingActiveIds,
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
        ...prepareMultiRowInsertStatements(db, SUPPLY_SNAPSHOT_UPSERT_PREFIX, snapshotRows),
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
  if (restoredOnlyIds.length > 0 || publicationGapBand !== "none") {
    const metadata: CronMetadataRecord = {
      writtenRows: snapshotRows.length,
      ...publicationGap,
      ...(restoredOnlyIds.length > 0 ? {
        quality: {
          reason: "snapshot_written_restored_skipped",
          restoredOnlyIds,
        },
      } : {}),
    };
    return createCronResult(publicationGapBand === "elevated" ? {
      status: "degraded",
      itemCount: snapshotRows.length,
      metadata: { ...metadata, reason: "publication_gap_elevated" },
    } : {
      ...(publicationGapBand === "routine" ? { status: "ok" as const } : {}),
      itemCount: snapshotRows.length,
      metadata,
    });
  }
  return { itemCount: snapshotRows.length };
}
