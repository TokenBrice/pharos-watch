import type { ChainRpcConfig } from "../lib/chain-registry";
import { setCacheIfNewer } from "../lib/db-cache";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { reportCronProgress } from "../lib/cron-progress";
import type { VaultsFyiRuntimeConfig } from "../lib/env";
import { normalizeTokenAddress } from "./dex-liquidity/token-resolution";
import {
  buildYieldSupplementalSourcesCache,
  getYieldSupplementalFamilyCacheKey,
  YIELD_SUPPLEMENTAL_CACHE_KEY,
} from "./yield-sync/cache";
import {
  loadSupplementalSourceFamilies,
  SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
} from "./yield-sync/supplemental-source-families";
import type { SupplementalSourceFamilyKey } from "./yield-sync/supplemental-source-family-keys";
import type { ResolvedYieldCandidate } from "./yield-sync/types";

function buildSupplementalCandidateDedupKey(candidate: ResolvedYieldCandidate): string | null {
  const sourceKey = candidate.yield?.sourceKey?.trim();
  if (!sourceKey) return null;

  const chain = (candidate.chain ?? "").trim().toLowerCase();
  const address = normalizeTokenAddress(candidate.address ?? "");
  const symbol = candidate.symbol.trim().toUpperCase();
  const identity = address || symbol;
  return `${sourceKey}|${chain}|${identity}`;
}

function dedupeCandidates(candidates: ResolvedYieldCandidate[]): {
  candidates: ResolvedYieldCandidate[];
  droppedCount: number;
} {
  const byDedupKey = new Map<string, ResolvedYieldCandidate>();
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
    if ((candidate.yield.currentApy ?? 0) > (existing.yield.currentApy ?? 0)) {
      byDedupKey.set(dedupKey, candidate);
    }
  }

  return {
    candidates: [...byDedupKey.values()],
    droppedCount,
  };
}

export async function syncYieldSupplemental(
  db: D1Database,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  reportProgress?: CronProgressReporter,
  vaultsFyi?: VaultsFyiRuntimeConfig,
): Promise<CronResult> {
  const startSec = Math.floor(Date.now() / 1000);
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
  if (dedupedCandidates.length === 0) {
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
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        rowsRead: rawCandidateCount,
        rowsWritten: 0,
        rowsDropped: droppedCount,
        sourceCoverage: {
          rawSupplementalCandidates: rawCandidateCount,
          dedupedSupplementalCandidates: 0,
          supplementalCandidatesWritten: 0,
          sourceFamilyCounts,
          sourceFamilyInventoryCounts,
          supplementalSourceAccounting,
          sourceFamilySummaries,
          optionalRpcTelemetry,
        },
        fallbackMode: "empty-snapshot",
        cacheWriteSkipped: true,
      }),
    };
  }

  await reportSupplementalProgress("aggregate-cache-write", "Publishing aggregate supplemental yield cache", {
    itemsDone: 0,
    itemsTotal: dedupedCandidates.length,
    metadata: {
      countTotals: {
        rawSupplementalCandidates: rawCandidateCount,
        dedupedSupplementalCandidates: dedupedCandidates.length,
        rowsDropped: droppedCount,
      },
    },
  });
  const cacheResult = await setCacheIfNewer(
    db,
    YIELD_SUPPLEMENTAL_CACHE_KEY,
    buildYieldSupplementalSourcesCache(dedupedCandidates, startSec),
    startSec,
    signal,
  );
  const familyCacheResults: Record<
    SupplementalSourceFamilyKey,
    "published" | "skipped-newer" | "empty" | "empty-published"
  > = Object.fromEntries(SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((key) => [key, "empty"])) as Record<
    SupplementalSourceFamilyKey,
    "published" | "skipped-newer" | "empty" | "empty-published"
  >;

  for (const family of familyResults) {
    if (family.status !== "ok") continue;
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
    const { candidates: dedupedFamilyCandidates } = dedupeCandidates(family.candidates);
    const familyCacheResult = await setCacheIfNewer(
      db,
      getYieldSupplementalFamilyCacheKey(family.key),
      buildYieldSupplementalSourcesCache(dedupedFamilyCandidates, startSec),
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
  }
  await reportSupplementalProgress("complete", "Published supplemental yield source caches", {
    itemsDone: cacheResult.written ? dedupedCandidates.length : 0,
    itemsTotal: dedupedCandidates.length,
    metadata: {
      countTotals: {
        rawSupplementalCandidates: rawCandidateCount,
        dedupedSupplementalCandidates: dedupedCandidates.length,
        rowsWritten: cacheResult.written ? dedupedCandidates.length : 0,
        rowsDropped: droppedCount,
      },
      cacheWriteMode: cacheResult.written ? "published" : "skipped-newer",
      familyCacheResults,
      sourceFamilyInventoryCounts,
      sourceFamilySummaries,
    },
  });

  return {
    itemCount: cacheResult.written ? dedupedCandidates.length : 0,
    metadata: JSON.stringify({
      rowsRead: rawCandidateCount,
      rowsWritten: cacheResult.written ? dedupedCandidates.length : 0,
      rowsDropped: droppedCount,
      sourceCoverage: {
        rawSupplementalCandidates: rawCandidateCount,
        dedupedSupplementalCandidates: dedupedCandidates.length,
        supplementalCandidatesWritten: cacheResult.written ? dedupedCandidates.length : 0,
        sourceFamilyCounts,
        sourceFamilyInventoryCounts,
        supplementalSourceAccounting,
        sourceFamilySummaries,
        optionalRpcTelemetry,
      },
      fallbackMode: null,
      cacheWriteSkipped: cacheResult.skippedBecauseNewer,
      cacheWriteMode: cacheResult.written ? "published" : "skipped-newer",
      casSkipped: cacheResult.skippedBecauseNewer,
      cacheKey: YIELD_SUPPLEMENTAL_CACHE_KEY,
      familyCacheResults,
      syncStartSec: startSec,
    }),
  };
}
