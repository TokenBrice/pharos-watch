import type { ChainRpcConfig } from "../lib/chain-registry";
import { setCacheIfNewer } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { normalizeTokenAddress } from "./dex-liquidity/token-resolution";
import { buildYieldSupplementalSourcesCache } from "./yield-sync/cache";
import { loadSupplementalSourceFamilies } from "./yield-sync/supplemental-source-families";
import type { ResolvedYieldCandidate } from "./yield-sync/types";

const YIELD_SUPPLEMENTAL_CACHE_KEY = "yield:supplemental-sources:v1";

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
    sourceFamilyCounts,
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
  );

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
        optionalRpcTelemetry,
      },
      fallbackMode: null,
      cacheWriteSkipped: cacheResult.skippedBecauseNewer,
      cacheWriteMode: cacheResult.written ? "published" : "skipped-newer",
      casSkipped: cacheResult.skippedBecauseNewer,
      cacheKey: YIELD_SUPPLEMENTAL_CACHE_KEY,
      syncStartSec: startSec,
    }),
  };
}
