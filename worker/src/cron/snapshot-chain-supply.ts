import { logWorkerEventArgs } from "../lib/structured-log";
import { executeAtomicBatch, prepareMultiRowInsertStatements } from "../lib/db";
import { prepareCacheUpsert } from "../lib/db-cache";
import { CHAIN_META } from "@shared/types/chain-identity";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { canonicalizeChainCirculating } from "@shared/lib/chains/circulating";
import { formatIsoDate } from "@shared/lib/format";
import { CACHE_FRESHNESS_LANES } from "@shared/lib/api-freshness";
import { CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-registry";
import {
  STABLECOIN_PUBLICATION_WAIVERS,
  type StablecoinPublicationWaiver,
} from "../lib/stablecoin-publication-coverage";
import {
  buildSupplySnapshotCompletionMarker,
  preflightSupplySnapshot,
  SNAPSHOT_CHAIN_SUPPLY_LAST_WRITE_KEY,
} from "../lib/supply-snapshot-completion";

// Skip once the stablecoins cache has missed two producer intervals
// (`sync-stablecoins` cadence via the shared lane descriptor), matching the
// snapshot-supply admission gate.
const CACHE_MAX_AGE_SEC = 2 * CACHE_FRESHNESS_LANES.stablecoins.producerIntervalSec;

interface SnapshotChainSupplyOptions {
  nowSec?: number;
  publicationWaivers?: readonly StablecoinPublicationWaiver[];
  requiredActiveIds?: readonly string[];
}

function abortedCronResult(): CronResult {
  return createCronResult({ status: "degraded", itemCount: 0, metadata: { reason: "aborted" } });
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "AbortError"
  );
}

export async function snapshotChainSupply(
  db: D1Database,
  signal?: AbortSignal,
  options: SnapshotChainSupplyOptions = {},
): Promise<CronResult> {
  if (signal?.aborted) return abortedCronResult();

  const preflight = await preflightSupplySnapshot(db, {
    nowSec: options.nowSec,
    requiredActiveIds: options.requiredActiveIds ?? [...CORE_AGGREGATE_ACTIVE_IDS],
    publicationWaivers: options.publicationWaivers ?? STABLECOIN_PUBLICATION_WAIVERS,
    completionCacheKey: SNAPSHOT_CHAIN_SUPPLY_LAST_WRITE_KEY,
    maxCacheAgeSec: CACHE_MAX_AGE_SEC,
    deriveCoverage: (payload, requiredActiveIds) => ({
      accountedIds: payload.peggedAssets.map((asset) => String(asset.id)),
      context: { expectedActiveIdSet: new Set(requiredActiveIds) },
    }),
  });
  if (preflight.kind === "cache-unavailable") {
    logWorkerEventArgs("handler", "error", "[snapshot-chain-supply] No stablecoins cache found");
    return createCronResult({ status: "degraded", itemCount: 0, metadata: { reason: preflight.reason } });
  }
  if (preflight.kind === "cache-stale") {
    logWorkerEventArgs("handler", "warn", `[snapshot-chain-supply] Cache is ${preflight.cacheAgeSec}s old (>${CACHE_MAX_AGE_SEC}s), skipping`);
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "cache_stale", cacheAgeSec: preflight.cacheAgeSec },
    });
  }

  const {
    cache,
    context: { expectedActiveIdSet },
    coverageExpectation,
    lastWrite,
    nowSec,
    publicationCoverage,
    snapshotDate,
  } = preflight;
  if (!publicationCoverage.complete) {
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        reason: "partial_snapshot_blocked",
        presentActiveCount: publicationCoverage.presentActiveCount,
        expectedActiveCount: publicationCoverage.expectedActiveCount,
        missingActiveIds: publicationCoverage.missingActiveIds,
        waivedActiveIds: publicationCoverage.waivedActiveIds,
        expiredWaiverIds: publicationCoverage.expiredWaiverIds,
      },
    });
  }
  const sameDayCoverageVerified = lastWrite?.snapshotDate === snapshotDate && lastWrite.exactCoverageVerified;
  if (sameDayCoverageVerified && lastWrite.chainObservationAdmissionVerified) {
    return createCronResult({ itemCount: 0, metadata: { reason: "already_written_today", snapshotDate } });
  }
  // An identity-matched partial day owns its first admitted observations.
  // Legacy or changed-coverage generations still require replacement.
  const admittedChainIds = new Set(
    sameDayCoverageVerified && lastWrite.chainObservationProgressVerified ? lastWrite.ownedRowIds ?? [] : [],
  );

  // Accumulate per-chain totals
  const chainTotals = new Map<string, { totalUsd: number; coinCount: number }>();
  const restoredOnlyIds = new Set<string>();
  const staleSupplyIds = new Set<string>();
  const missingSupplyIds = new Set<string>();
  const deferredChains = new Map<string, Set<string>>();

  for (const asset of cache.payload.peggedAssets) {
    if (!expectedActiveIdSet.has(String(asset.id))) continue;
    const canonicalChainCirculating = canonicalizeChainCirculating(asset.chainCirculating);
    const restored = asset.supplyRestored === true;
    // Legacy rows without an observation clock inherit the admitted cache
    // clock; a carried-forward row never does.
    const stale = nowSec - (asset.supplyObservedAt ?? cache.updatedAt) > CACHE_MAX_AGE_SEC;
    if (restored) restoredOnlyIds.add(String(asset.id));
    if (stale) staleSupplyIds.add(String(asset.id));

    for (const [chainId, data] of canonicalChainCirculating) {
      if (!CHAIN_META[chainId]) continue;
      if (restored || stale || data.current == null) {
        const assetIds = deferredChains.get(chainId) ?? new Set<string>();
        assetIds.add(String(asset.id));
        deferredChains.set(chainId, assetIds);
        if (data.current == null) missingSupplyIds.add(String(asset.id));
        continue;
      }
      const current = data.current;
      if (current <= 0) continue;

      const existing = chainTotals.get(chainId) ?? { totalUsd: 0, coinCount: 0 };
      existing.totalUsd += current;
      existing.coinCount += 1;
      chainTotals.set(chainId, existing);
    }
  }
  const deferredChainIds = [...deferredChains.keys()].sort();
  const observationMetadata = {
    restoredOnlyIds: [...restoredOnlyIds].sort(),
    staleSupplyIds: [...staleSupplyIds].sort(),
    missingSupplyIds: [...missingSupplyIds].sort(),
    deferredChainIds,
    deferredChains: Object.fromEntries(
      deferredChainIds.map((chainId) => [chainId, [...deferredChains.get(chainId)!].sort()]),
    ),
  };

  const chainRows: Array<readonly [string, number, number, number]> = [];
  for (const [chainId, { totalUsd, coinCount }] of chainTotals) {
    // Never publish a subtotal that subtracts an unavailable contributor.
    if (deferredChains.has(chainId) || admittedChainIds.has(chainId)) continue;
    chainRows.push([chainId, snapshotDate, totalUsd, coinCount]);
  }

  if (chainRows.length === 0 && admittedChainIds.size === 0) {
    logWorkerEventArgs("handler", "warn", "[snapshot-chain-supply] No valid chain rows produced, preserving previous snapshot");
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        reason: deferredChainIds.length > 0 ? "chain_observations_unavailable" : "no-valid-chain-rows",
        assetCount: cache.payload.peggedAssets.length,
        ...observationMetadata,
      },
    });
  }

  const ownedRowIds = [...admittedChainIds, ...chainRows.map(([chainId]) => chainId)];
  try {
    const markerValue = JSON.stringify({
      ...buildSupplySnapshotCompletionMarker({
        snapshotDate,
        coverage: coverageExpectation,
        accountedActiveCount: publicationCoverage.presentActiveCount + publicationCoverage.waivedActiveCount,
        ownedRowIds,
      }),
      writtenChains: ownedRowIds.length,
      chainObservationProgressVersion: 1,
      // Version 1 certifies complete observation admission, not partial progress.
      ...(deferredChainIds.length === 0 ? { chainObservationAdmissionVersion: 1 } : {}),
      ...observationMetadata,
    });
    const replacementStatements = [
      // Keep first observations from this coverage generation and preserve
      // deferred legacy rows until they can be replaced by an admitted value.
      db.prepare(
        "DELETE FROM chain_supply_history WHERE snapshot_date = ? AND chain_id NOT IN (SELECT value FROM json_each(?))",
      ).bind(snapshotDate, JSON.stringify([...admittedChainIds, ...deferredChainIds])),
      ...prepareMultiRowInsertStatements(
        db,
        "INSERT OR REPLACE INTO chain_supply_history (chain_id, snapshot_date, total_usd, stablecoin_count)",
        chainRows,
      ),
      prepareCacheUpsert(db, { key: SNAPSHOT_CHAIN_SUPPLY_LAST_WRITE_KEY, value: markerValue, updatedAt: nowSec }),
    ];
    await executeAtomicBatch(db, replacementStatements, { signal });
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) return abortedCronResult();
    recordCronFailure("snapshot-chain-supply", err, { metadata: { stage: "atomicDateReplacement" } });
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "db_write_failed", error: String(err).slice(0, 200) },
    });
  }

  logWorkerEventArgs("handler", "info", `[snapshot-chain-supply] Inserted ${chainRows.length} rows for ${formatIsoDate(snapshotDate)}`);
  return createCronResult({
    status: "ok",
    itemCount: chainRows.length,
    metadata: {
      quality: deferredChainIds.length > 0 ? "partial" : "complete",
      ...(deferredChainIds.length > 0 ? { reason: "chain_observations_partially_deferred" } : {}),
      ...observationMetadata,
    },
  });
}
