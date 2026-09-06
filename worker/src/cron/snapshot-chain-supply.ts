import { logWorkerEventArgs } from "../lib/structured-log";
import { executeAtomicBatch, prepareMultiRowInsertStatements } from "../lib/db";
import { prepareCacheUpsert } from "../lib/db-cache";
import { CHAIN_META } from "@shared/lib/chains";
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
  if (publicationCoverage.complete && lastWrite?.snapshotDate === snapshotDate && lastWrite.exactCoverageVerified) {
    return createCronResult({ itemCount: 0, metadata: { reason: "already_written_today", snapshotDate } });
  }
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

  // Accumulate per-chain totals
  const chainTotals = new Map<string, { totalUsd: number; coinCount: number }>();

  for (const asset of cache.payload.peggedAssets) {
    if (!expectedActiveIdSet.has(String(asset.id))) continue;
    const canonicalChainCirculating = canonicalizeChainCirculating(asset.chainCirculating);

    for (const [chainId, data] of canonicalChainCirculating) {
      const current = data.current ?? 0;
      if (current <= 0) continue;

      if (!CHAIN_META[chainId]) continue;

      const existing = chainTotals.get(chainId) ?? { totalUsd: 0, coinCount: 0 };
      existing.totalUsd += current;
      existing.coinCount += 1;
      chainTotals.set(chainId, existing);
    }
  }

  const chainRows: Array<readonly [string, number, number, number]> = [];
  for (const [chainId, { totalUsd, coinCount }] of chainTotals) {
    chainRows.push([chainId, snapshotDate, totalUsd, coinCount]);
  }

  if (chainRows.length === 0) {
    logWorkerEventArgs("handler", "warn", "[snapshot-chain-supply] No valid chain rows produced, preserving previous snapshot");
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "no-valid-chain-rows", assetCount: cache.payload.peggedAssets.length },
    });
  }

  try {
    const markerValue = JSON.stringify({
      ...buildSupplySnapshotCompletionMarker({
        snapshotDate,
        coverage: coverageExpectation,
        accountedActiveCount: publicationCoverage.presentActiveCount + publicationCoverage.waivedActiveCount,
        ownedRowIds: chainRows.map(([chainId]) => chainId),
      }),
      writtenChains: chainRows.length,
    });
    const replacementStatements = [
      db.prepare("DELETE FROM chain_supply_history WHERE snapshot_date = ?").bind(snapshotDate),
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
  return { itemCount: chainRows.length };
}
