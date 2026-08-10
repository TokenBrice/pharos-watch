import { executeAtomicBatch, prepareMultiRowInsertStatements } from "../lib/db";
import { CHAIN_META } from "@shared/lib/chains";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { canonicalizeChainCirculating } from "@shared/lib/chain-circulating";
import { formatIsoDate } from "@shared/lib/format";
import { CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-registry";
import { startOfUtcDaySec } from "../lib/time-constants";
import {
  STABLECOIN_PUBLICATION_WAIVERS,
  evaluateStablecoinPublicationCoverage,
  resolveStablecoinPublicationWaivers,
  selectAppliedStablecoinPublicationWaivers,
  type StablecoinPublicationWaiver,
} from "../lib/stablecoin-publication-coverage";
import {
  buildSupplySnapshotCoverageExpectation,
  buildSupplySnapshotCompletionMarker,
  getCompletedSupplySnapshot,
  SNAPSHOT_CHAIN_SUPPLY_LAST_WRITE_KEY,
} from "../lib/supply-snapshot-completion";

const CACHE_MAX_AGE_SEC = 1200;

interface SnapshotChainSupplyOptions {
  nowSec?: number;
  publicationWaivers?: readonly StablecoinPublicationWaiver[];
  requiredActiveIds?: readonly string[];
}

function abortedCronResult(): CronResult {
  return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "aborted" }) };
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

  const cache = await loadStablecoinsCache(db, { mode: "strict" });
  if (cache.kind !== "ok") {
    console.error("[snapshot-chain-supply] No stablecoins cache found");
    return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: cache.reason }) };
  }

  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const cacheAge = nowSec - cache.updatedAt;
  if (cacheAge > CACHE_MAX_AGE_SEC) {
    console.warn(`[snapshot-chain-supply] Cache is ${cacheAge}s old (>${CACHE_MAX_AGE_SEC}s), skipping`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "cache_stale", cacheAgeSec: cacheAge }),
    };
  }

  // One snapshot per UTC day, keyed on the marker's stored snapshotDate.
  // See snapshot-supply.ts for the drift rationale.
  const snapshotDate = startOfUtcDaySec();
  const expectedActiveIds = [...new Set(options.requiredActiveIds ?? CORE_AGGREGATE_ACTIVE_IDS)].sort();
  const expectedActiveIdSet = new Set(expectedActiveIds);
  const publicationWaivers = options.publicationWaivers ?? STABLECOIN_PUBLICATION_WAIVERS;
  const cachedIds = new Set(cache.payload.peggedAssets.map((asset) => String(asset.id)));
  const publicationCoverage = evaluateStablecoinPublicationCoverage(
    cachedIds,
    nowSec,
    publicationWaivers,
    expectedActiveIds,
  );
  const resolvedWaivers = resolveStablecoinPublicationWaivers(expectedActiveIds, nowSec, publicationWaivers);
  const appliedWaivers = selectAppliedStablecoinPublicationWaivers(
    publicationCoverage.waivedActiveIds,
    resolvedWaivers,
  );
  const coverageExpectation = buildSupplySnapshotCoverageExpectation(expectedActiveIds, appliedWaivers);
  const lastWrite = await getCompletedSupplySnapshot(db, {
    cacheKey: SNAPSHOT_CHAIN_SUPPLY_LAST_WRITE_KEY,
    expectedCoverage: coverageExpectation,
  });
  if (publicationCoverage.complete && lastWrite?.snapshotDate === snapshotDate && lastWrite.exactCoverageVerified) {
    return { itemCount: 0, metadata: JSON.stringify({ reason: "already_written_today", snapshotDate }) };
  }
  if (!publicationCoverage.complete) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "partial_snapshot_blocked",
        presentActiveCount: publicationCoverage.presentActiveCount,
        expectedActiveCount: publicationCoverage.expectedActiveCount,
        missingActiveIds: publicationCoverage.missingActiveIds,
        waivedActiveIds: publicationCoverage.waivedActiveIds,
        expiredWaiverIds: publicationCoverage.expiredWaiverIds,
      }),
    };
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
    console.warn("[snapshot-chain-supply] No valid chain rows produced, preserving previous snapshot");
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "no-valid-chain-rows", assetCount: cache.payload.peggedAssets.length }),
    };
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
      db
        .prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .bind(SNAPSHOT_CHAIN_SUPPLY_LAST_WRITE_KEY, markerValue, nowSec),
    ];
    await executeAtomicBatch(db, replacementStatements, { signal });
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) return abortedCronResult();
    recordCronFailure("snapshot-chain-supply", err, { metadata: { stage: "atomicDateReplacement" } });
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "db_write_failed", error: String(err).slice(0, 200) }),
    };
  }

  console.log(`[snapshot-chain-supply] Inserted ${chainRows.length} rows for ${formatIsoDate(snapshotDate)}`);
  return { itemCount: chainRows.length };
}
