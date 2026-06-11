import type { ChainRpcConfig } from "../lib/chain-registry";
import { setCacheIfNewer } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { normalizeTokenAddress } from "./dex-liquidity/token-resolution";
import {
  buildYieldSupplementalSourcesCache,
  getYieldSupplementalFamilyCacheKey,
  YIELD_SUPPLEMENTAL_CACHE_KEY,
} from "./yield-sync/cache";
import {
  loadSupplementalSourceFamilies,
  SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
  type SupplementalSourceFamilyKey,
} from "./yield-sync/supplemental-source-families";
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

function dedupeCandidates(
  candidates: ResolvedYieldCandidate[],
): { candidates: ResolvedYieldCandidate[]; droppedCount: number } {
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
): Promise<CronResult> {
  const startSec = Math.floor(Date.now() / 1000);
  const {
    candidates,
    familyResults,
    sourceFamilyCounts,
    supplementalSourceAccounting,
    optionalRpcTelemetry,
  } = await loadSupplementalSourceFamilies({
    startSec,
    signal,
    chainRpcs,
  });

  const rawCandidateCount = candidates.length;
  const { candidates: dedupedCandidates, droppedCount } = dedupeCandidates(candidates);
  if (dedupedCandidates.length === 0) {
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
        supplementalSourceAccounting,
        optionalRpcTelemetry,
      },
      fallbackMode: "empty-snapshot",
      cacheWriteSkipped: true,
      }),
    };
  }

  const cacheResult = await setCacheIfNewer(
    db,
    YIELD_SUPPLEMENTAL_CACHE_KEY,
    buildYieldSupplementalSourcesCache(dedupedCandidates, startSec),
    startSec,
    signal,
  );
  const familyCacheResults: Record<SupplementalSourceFamilyKey, "published" | "skipped-newer" | "empty"> =
    Object.fromEntries(SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((key) => [key, "empty"])) as Record<
      SupplementalSourceFamilyKey,
      "published" | "skipped-newer" | "empty"
    >;

  for (const family of familyResults) {
    if (family.status !== "ok") continue;
    const { candidates: dedupedFamilyCandidates } = dedupeCandidates(family.candidates);
    const familyCacheResult = await setCacheIfNewer(
      db,
      getYieldSupplementalFamilyCacheKey(family.key),
      buildYieldSupplementalSourcesCache(dedupedFamilyCandidates, startSec),
      startSec,
      signal,
    );
    familyCacheResults[family.key] = familyCacheResult.written ? "published" : "skipped-newer";
  }

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
        supplementalSourceAccounting,
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
