import type { ChainRpcConfig } from "../lib/chain-registry";
import { getCaches, setCache, setCacheIfNewer } from "../lib/db-cache";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { reportCronProgress } from "../lib/cron-progress";
import type { VaultsFyiRuntimeConfig } from "../lib/env";
import { normalizeTokenAddress } from "./dex-liquidity/token-resolution";
import {
  buildYieldSupplementalFamilyCache,
  buildYieldSupplementalRunOutcome,
  getYieldSupplementalFamilyCacheKey,
  getYieldSupplementalRunOutcomeCacheKey,
  type SupplementalFamilyCacheResult,
} from "./yield-sync/cache/supplemental-cache-keys";
import {
  loadSupplementalSourceFamilies,
  SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
  type SupplementalDedupeDiscardedValue,
} from "./yield-sync/supplemental-source-families";
import type { SupplementalSourceFamilyKey } from "./yield-sync/supplemental-source-family-keys";
import type { ResolvedYieldCandidate } from "./yield-sync/types";

/** B27: bounded audit trail for values collapsed by the intra-family dedupe. */
const SUPPLEMENTAL_DEDUPE_DISCARDED_VALUE_LIMIT = 5;

export interface SyncYieldSupplementalOptions {
  /**
   * C16 hourly catch-up gate: when set, the run is skipped unless the newest
   * family cache marker is at least this old, so the hourly slot only refetches
   * families after a missed 4h slot instead of taking over its cadence.
   */
  catchUpMinMarkerAgeSec?: number;
}

function buildSupplementalCandidateDedupKey(candidate: ResolvedYieldCandidate): string | null {
  const sourceKey = candidate.yield?.sourceKey?.trim();
  if (!sourceKey) return null;

  const chain = (candidate.chain ?? "").trim().toLowerCase();
  const address = normalizeTokenAddress(candidate.address ?? "");
  const symbol = candidate.symbol.trim().toUpperCase();
  const identity = address || symbol;
  return `${sourceKey}|${chain}|${identity}`;
}

function compareObservationRecency(
  a: number | null | undefined,
  b: number | null | undefined,
): number {
  const aObservedAt = typeof a === "number" && Number.isFinite(a) ? a : null;
  const bObservedAt = typeof b === "number" && Number.isFinite(b) ? b : null;
  if (aObservedAt != null && bObservedAt != null) return aObservedAt - bObservedAt;
  if (aObservedAt != null) return 1;
  if (bObservedAt != null) return -1;
  return 0;
}

function dedupeCandidates(candidates: ResolvedYieldCandidate[]): {
  candidates: ResolvedYieldCandidate[];
  droppedCount: number;
  discardedValues: SupplementalDedupeDiscardedValue[];
} {
  const byDedupKey = new Map<string, ResolvedYieldCandidate>();
  const discardedValues: SupplementalDedupeDiscardedValue[] = [];
  let droppedCount = 0;

  for (const candidate of candidates) {
    const dedupKey = buildSupplementalCandidateDedupKey(candidate);
    if (!dedupKey) continue;

    const existing = byDedupKey.get(dedupKey);
    if (!existing) {
      byDedupKey.set(dedupKey, candidate);
      continue;
    }

    droppedCount += 1;
    // B27: the freshest observation wins and TVL only breaks an exact tie, so a
    // transient APY spike no longer displaces the current value.
    const recency = compareObservationRecency(
      candidate.yield.sourceObservedAt,
      existing.yield.sourceObservedAt,
    );
    const keepCandidate = recency > 0
      || (recency === 0 && (candidate.yield.sourceTvlUsd ?? 0) > (existing.yield.sourceTvlUsd ?? 0));
    const kept = keepCandidate ? candidate : existing;
    const discarded = keepCandidate ? existing : candidate;
    if (keepCandidate) byDedupKey.set(dedupKey, candidate);

    if (discardedValues.length < SUPPLEMENTAL_DEDUPE_DISCARDED_VALUE_LIMIT) {
      discardedValues.push({
        sourceKey: discarded.yield.sourceKey.trim(),
        discardedApy: discarded.yield.currentApy,
        discardedObservedAt: discarded.yield.sourceObservedAt ?? null,
        keptApy: kept.yield.currentApy,
        keptObservedAt: kept.yield.sourceObservedAt ?? null,
      });
    }
  }

  return {
    candidates: [...byDedupKey.values()],
    droppedCount,
    discardedValues,
  };
}

/**
 * C16: newest family cache marker. A missing marker means no family snapshot
 * exists yet, so the catch-up must run.
 */
async function loadNewestSupplementalFamilyMarkerSec(db: D1Database): Promise<number | null> {
  const familyCacheRows = await getCaches(
    db,
    SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((family) => getYieldSupplementalFamilyCacheKey(family)),
  );
  let newestMarkerSec: number | null = null;
  for (const row of familyCacheRows.values()) {
    newestMarkerSec = newestMarkerSec == null ? row.updatedAt : Math.max(newestMarkerSec, row.updatedAt);
  }
  return newestMarkerSec;
}

export async function syncYieldSupplemental(
  db: D1Database,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  reportProgress?: CronProgressReporter,
  vaultsFyi?: VaultsFyiRuntimeConfig,
  options?: SyncYieldSupplementalOptions,
): Promise<CronResult> {
  const startSec = Math.floor(Date.now() / 1000);
  const catchUpMinMarkerAgeSec = options?.catchUpMinMarkerAgeSec;
  if (catchUpMinMarkerAgeSec != null) {
    const newestFamilyMarkerSec = await loadNewestSupplementalFamilyMarkerSec(db);
    const newestFamilyMarkerAgeSec =
      newestFamilyMarkerSec == null ? null : Math.max(0, startSec - newestFamilyMarkerSec);
    if (newestFamilyMarkerAgeSec != null && newestFamilyMarkerAgeSec < catchUpMinMarkerAgeSec) {
      return {
        status: "skipped_neutral",
        itemCount: 0,
        metadata: JSON.stringify({
          reason: "supplemental-catch-up-not-due",
          newestFamilyMarkerSec,
          newestFamilyMarkerAgeSec,
          minMarkerAgeSec: catchUpMinMarkerAgeSec,
          syncStartSec: startSec,
        }),
        productivity: { productive: false, reason: "supplemental-catch-up-not-due" },
      };
    }
  }
  const reportSupplementalProgress = async (
    stage: string,
    message: string,
    options: {
      itemsDone?: number;
      itemsTotal?: number;
      metadata?: Record<string, unknown>;
    } = {},
  ) => {
    await reportCronProgress(reportProgress, {
      stage,
      message,
      providerFamily: "yield-supplemental",
      itemsDone: options.itemsDone,
      itemsTotal: options.itemsTotal ?? SUPPLEMENTAL_SOURCE_FAMILY_KEYS.length,
      metadata: {
        providerFamilies: SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
        ...options.metadata,
      },
    });
  };

  await reportSupplementalProgress("source-family-fetch", "Fetching supplemental yield source families", {
    itemsDone: 0,
    metadata: {
      countTotals: {
        sourceFamilies: SUPPLEMENTAL_SOURCE_FAMILY_KEYS.length,
      },
    },
  });
  const {
    candidates,
    familyResults,
    sourceFamilyCounts,
    sourceFamilyInventoryCounts,
    supplementalSourceAccounting,
    sourceFamilySummaries,
    optionalRpcTelemetry,
  } =
    await loadSupplementalSourceFamilies({
      db,
      startSec,
      signal,
      chainRpcs,
      vaultsFyi,
    });
  await reportSupplementalProgress("source-family-fetch-complete", "Completed supplemental yield source fetches", {
    itemsDone: familyResults.length,
    metadata: {
      countTotals: {
        sourceFamilies: SUPPLEMENTAL_SOURCE_FAMILY_KEYS.length,
        rawSupplementalCandidates: candidates.length,
        successfulFamilies: familyResults.filter((family) => family.status === "ok").length,
      },
      sourceFamilyCounts,
      sourceFamilyInventoryCounts,
      sourceFamilySummaries,
    },
  });

  const rawCandidateCount = candidates.length;
  await reportSupplementalProgress("dedupe", "Deduplicating supplemental yield candidates", {
    itemsDone: rawCandidateCount,
    itemsTotal: rawCandidateCount,
    metadata: {
      countTotals: {
        rawSupplementalCandidates: rawCandidateCount,
      },
    },
  });
  const { candidates: dedupedCandidates, droppedCount } = dedupeCandidates(candidates);
  const emptySnapshot = dedupedCandidates.length === 0;
  if (emptySnapshot) {
    await reportSupplementalProgress("empty-snapshot", "Supplemental yield source families produced no candidates", {
      itemsDone: 0,
      itemsTotal: rawCandidateCount,
      metadata: {
        countTotals: {
          rawSupplementalCandidates: rawCandidateCount,
          rowsDropped: droppedCount,
        },
        fallbackMode: "empty-snapshot",
        sourceFamilyInventoryCounts,
        sourceFamilySummaries,
      },
    });
  }

  const familyCacheResults: Record<SupplementalSourceFamilyKey, SupplementalFamilyCacheResult> =
    Object.fromEntries(SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((key) => [key, "empty"])) as Record<
      SupplementalSourceFamilyKey,
      SupplementalFamilyCacheResult
    >;
  const degradedFamilies: SupplementalSourceFamilyKey[] = [];
  let supplementalCandidatesWritten = 0;

  for (const family of familyResults) {
    if (family.status !== "ok" || family.degraded) {
      // B1: a family whose fetch ended early keeps the snapshot the previous run
      // published instead of a fresh, incomplete one.
      familyCacheResults[family.key] = "retained-previous";
      degradedFamilies.push(family.key);
      continue;
    }
    await reportSupplementalProgress("family-cache-write", `Publishing ${family.key} supplemental yield cache`, {
      itemsDone: Object.values(familyCacheResults).filter((status) => status !== "empty").length,
      metadata: {
        providerFamily: `yield-supplemental:${family.key}`,
        cursor: {
          family: family.key,
        },
        countTotals: {
          familyCandidates: family.candidates.length,
          sourceFamilies: SUPPLEMENTAL_SOURCE_FAMILY_KEYS.length,
        },
      },
    });
    const { candidates: dedupedFamilyCandidates, discardedValues } = dedupeCandidates(family.candidates);
    if (discardedValues.length > 0) {
      sourceFamilySummaries[family.key].dedupeDiscardedValues = discardedValues;
    }
    const familyCacheResult = await setCacheIfNewer(
      db,
      getYieldSupplementalFamilyCacheKey(family.key),
      buildYieldSupplementalFamilyCache(dedupedFamilyCandidates, startSec),
      startSec,
      signal,
    );
    familyCacheResults[family.key] =
      dedupedFamilyCandidates.length === 0
        ? familyCacheResult.written
          ? "empty-published"
          : "skipped-newer"
        : familyCacheResult.written
          ? "published"
          : "skipped-newer";
    if (familyCacheResult.written) supplementalCandidatesWritten += dedupedFamilyCandidates.length;
  }
  // B1/B16: publish the per-family outcome so the next publication can name the
  // families whose snapshot was retained.
  await setCache(
    db,
    getYieldSupplementalRunOutcomeCacheKey(),
    buildYieldSupplementalRunOutcome(familyCacheResults, degradedFamilies, startSec),
    signal,
  );
  await reportSupplementalProgress("complete", "Published supplemental yield source caches", {
    itemsDone: supplementalCandidatesWritten,
    itemsTotal: dedupedCandidates.length,
    metadata: {
      countTotals: {
        rawSupplementalCandidates: rawCandidateCount,
        dedupedSupplementalCandidates: dedupedCandidates.length,
        rowsWritten: supplementalCandidatesWritten,
        rowsDropped: droppedCount,
      },
      familyCacheResults,
      degradedFamilies,
      sourceFamilyInventoryCounts,
      sourceFamilySummaries,
    },
  });

  const metadata = JSON.stringify({
    rowsRead: rawCandidateCount,
    rowsWritten: supplementalCandidatesWritten,
    rowsDropped: droppedCount,
    sourceCoverage: {
      rawSupplementalCandidates: rawCandidateCount,
      dedupedSupplementalCandidates: dedupedCandidates.length,
      supplementalCandidatesWritten,
      sourceFamilyCounts,
      sourceFamilyInventoryCounts,
      supplementalSourceAccounting,
      sourceFamilySummaries,
      optionalRpcTelemetry,
    },
    fallbackMode: emptySnapshot ? "empty-snapshot" : null,
    familyCacheResults,
    degradedFamilies,
    syncStartSec: startSec,
  });

  return emptySnapshot
    ? { status: "degraded", itemCount: 0, metadata }
    : { itemCount: supplementalCandidatesWritten, metadata };
}
