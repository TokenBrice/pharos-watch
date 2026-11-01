import type { ChainRpcConfig } from "../lib/chain-registry";
import { getCaches, setCache, setCacheIfNewer } from "../lib/db-cache";
import { logWorkerEventArgs } from "../lib/structured-log";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { reportCronProgress } from "../lib/cron-progress";
import {
  SUPPLEMENTAL_FAMILY_COUNT_DROP_ACCEPT_RUNS,
  SUPPLEMENTAL_FAMILY_COUNT_DROP_CONFIRM_RUNS,
  SUPPLEMENTAL_FAMILY_COUNT_DROP_RATIO,
} from "../lib/yield-ranking-helpers";
import { normalizeTokenAddress } from "./dex-liquidity/token-resolution";
import {
  buildYieldSupplementalCountDropState,
  buildYieldSupplementalFamilyCache,
  buildYieldSupplementalRunOutcome,
  getYieldSupplementalCountDropStateCacheKey,
  getYieldSupplementalFamilyCacheKey,
  getYieldSupplementalRunOutcomeCacheKey,
  parseYieldSupplementalCountDropState,
  parseYieldSupplementalSourcesCache,
  supplementalFamilySnapshotHash,
  type SupplementalFamilyCacheResult,
  type YieldSupplementalCountDropStateEntry,
} from "./yield-sync/cache";
import { parseYieldSupplementalRunOutcomeDetailed } from "./yield-sync/cache";
import { loadSupplementalSourceFamilies, type SupplementalDedupeDiscardedValue } from "./yield-sync/sources-supplemental";
import {
  getSupplementalFamilyStaleThresholdSec,
  SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
  type SupplementalSourceFamilyKey,
} from "./yield-sync/family-registry";
import type { ResolvedYieldCandidate } from "./yield-sync/types";

/** B27: bounded audit trail for values collapsed by the intra-family dedupe. */
const SUPPLEMENTAL_DEDUPE_DISCARDED_VALUE_LIMIT = 5;

export interface SyncYieldSupplementalOptions {
  /** Selected families share the existing global supplemental lease and outcome row. */
  families?: readonly SupplementalSourceFamilyKey[];
  /**
   * Group catch-up keeps the newest selected marker gate. A single-family
   * producer tail skips only with a validated recent snapshot and no failed
   * outcome, so a sibling's publication cannot defer that family's recovery.
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
 * A timestamp gates cadence, but only validated, current family artifacts prove
 * the supplemental output satisfied. A lone recent marker is not that proof.
 */
async function loadSupplementalCatchUpEvidence(
  db: D1Database,
  nowSec: number,
  maxAgeSec: number,
  families: readonly SupplementalSourceFamilyKey[],
) {
  const familyCacheRows = await getCaches(
    db,
    families.map((family) => getYieldSupplementalFamilyCacheKey(family)),
  );
  let newestMarkerSec: number | null = null;
  const provenFamilies: Array<{ family: SupplementalSourceFamilyKey; updatedAt: number; snapshotHash: string }> = [];
  for (const family of families) {
    const row = familyCacheRows.get(getYieldSupplementalFamilyCacheKey(family));
    if (!row || !Number.isSafeInteger(row.updatedAt) || row.updatedAt <= 0 || row.updatedAt > nowSec) continue;
    newestMarkerSec = newestMarkerSec == null ? row.updatedAt : Math.max(newestMarkerSec, row.updatedAt);
    const parsed = parseYieldSupplementalSourcesCache(row.value, row.updatedAt, nowSec);
    if (!parsed || parsed.updatedAt !== row.updatedAt || parsed.ageSeconds >= maxAgeSec
      || parsed.sourceCount !== parsed.candidates.length) continue;
    const payload = JSON.parse(row.value) as { source?: unknown; updatedAt?: unknown; sourceCount?: unknown; data?: unknown };
    if (payload.source !== "sync-yield-supplemental" || payload.updatedAt !== row.updatedAt
      || payload.sourceCount !== parsed.candidates.length || !Array.isArray(payload.data)
      || payload.data.length !== parsed.candidates.length) continue;
    provenFamilies.push({ family, updatedAt: parsed.updatedAt, snapshotHash: supplementalFamilySnapshotHash(row) });
  }
  return { newestMarkerSec, provenFamilies };
}

export async function syncYieldSupplemental(
  db: D1Database,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  reportProgress?: CronProgressReporter,
  options?: SyncYieldSupplementalOptions,
): Promise<CronResult> {
  signal?.throwIfAborted();
  const startSec = Math.floor(Date.now() / 1000);
  const families = options?.families ?? SUPPLEMENTAL_SOURCE_FAMILY_KEYS;
  // Read failures must not erase sibling diagnostics. Scheduled callers hold
  // the same supplemental lease across this read, family writes and merge.
  const previousOutcomeRow = options?.families
    ? (await getCaches(db, [getYieldSupplementalRunOutcomeCacheKey()])).get(getYieldSupplementalRunOutcomeCacheKey())
    : null;
  signal?.throwIfAborted();
  const previousOutcome = previousOutcomeRow
    ? parseYieldSupplementalRunOutcomeDetailed(previousOutcomeRow.value)
    : null;
  const catchUpMinMarkerAgeSec = options?.catchUpMinMarkerAgeSec;
  if (catchUpMinMarkerAgeSec != null) {
    const { newestMarkerSec: newestFamilyMarkerSec, provenFamilies } =
      await loadSupplementalCatchUpEvidence(db, startSec, catchUpMinMarkerAgeSec, families);
    signal?.throwIfAborted();
    const newestFamilyMarkerAgeSec =
      newestFamilyMarkerSec == null ? null : Math.max(0, startSec - newestFamilyMarkerSec);
    const artifactProven = provenFamilies.length === families.length;
    const selectedFamilyFailed = previousOutcome?.degradedFamilies.some((family) => families.includes(family)) ?? false;
    if (newestFamilyMarkerAgeSec != null && newestFamilyMarkerAgeSec < catchUpMinMarkerAgeSec
      && (families.length !== 1 || (artifactProven && !selectedFamilyFailed))) {
      const reason = artifactProven ? "supplemental-catch-up-not-due" : "supplemental-catch-up-marker-not-due";
      return {
        status: "skipped_neutral",
        itemCount: 0,
        metadata: JSON.stringify({
          reason,
          newestFamilyMarkerSec,
          newestFamilyMarkerAgeSec,
          minMarkerAgeSec: catchUpMinMarkerAgeSec,
          syncStartSec: startSec,
          artifactProven,
          provenFamilies,
        }),
        productivity: { productive: false, reason },
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
      itemsTotal: options.itemsTotal ?? families.length,
      metadata: {
        providerFamilies: families,
        ...options.metadata,
      },
    });
  };

  const retainedFamilyRows = await getCaches(db, [
    ...families.map((family) => getYieldSupplementalFamilyCacheKey(family)),
    getYieldSupplementalCountDropStateCacheKey(),
  ]).catch((error) => {
    if (signal?.aborted) throw error;
    logWorkerEventArgs("handler", "warn", "[yield-supplemental] Snapshot identity unavailable; retained outcomes remain unknown", error);
    return null;
  });
  signal?.throwIfAborted();
  const familySnapshotHashes: Partial<Record<SupplementalSourceFamilyKey, string>> = retainedFamilyRows
    ? Object.fromEntries(families.map((family) => [
      family, supplementalFamilySnapshotHash(retainedFamilyRows.get(getYieldSupplementalFamilyCacheKey(family)) ?? null),
    ])) : {};
  const previousCountDropState = parseYieldSupplementalCountDropState(
    retainedFamilyRows?.get(getYieldSupplementalCountDropStateCacheKey())?.value,
  );
  const previousFamilyCounts = new Map<SupplementalSourceFamilyKey, number>();
  if (retainedFamilyRows) {
    for (const family of families) {
      const row = retainedFamilyRows.get(getYieldSupplementalFamilyCacheKey(family));
      const parsed = row ? parseYieldSupplementalSourcesCache(row.value, row.updatedAt, startSec) : null;
      if (parsed) previousFamilyCounts.set(family, parsed.candidates.length);
    }
  }

  await reportSupplementalProgress("source-family-fetch", "Fetching supplemental yield source families", {
    itemsDone: 0,
    metadata: {
      countTotals: {
        sourceFamilies: families.length,
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
      families,
    });
  await reportSupplementalProgress("source-family-fetch-complete", "Completed supplemental yield source fetches", {
    itemsDone: familyResults.length,
    metadata: {
      countTotals: {
        sourceFamilies: families.length,
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
  const degradedFamilyReasons: Record<string, string> = {};
  const nextCountDropState: Partial<Record<SupplementalSourceFamilyKey, YieldSupplementalCountDropStateEntry>> = {
    ...previousCountDropState.families,
  };
  const familyCountDrops: Record<string, {
    baseline: number;
    previousCount: number;
    candidateCount: number;
    strikes: number;
    consistentRuns: number;
    retained: boolean;
    accepted: boolean;
  }> = {};
  let supplementalCandidatesWritten = 0;

  for (const family of familyResults) {
    if (family.skipReason) {
      // PENDLE-RL: a neutral skip keeps the retained family row authoritative —
      // no cache write, no degraded-family entry. The staleness budget the
      // publication applies per family is what turns a long skip into a real
      // degradation; it is never masked here.
      familyCacheResults[family.key] =
        family.skipReason === "pendle-rate-limited-backoff" ? "skipped-backoff" : "skipped-not-due";
      continue;
    }
    if (family.status !== "ok" || family.degraded) {
      // B1: a family whose fetch ended early keeps the snapshot the previous run
      // published instead of a fresh, incomplete one.
      familyCacheResults[family.key] = "retained-previous";
      degradedFamilies.push(family.key);
      if (family.degradedReason) {
        degradedFamilyReasons[family.key] = family.degradedReason;
      }
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
          sourceFamilies: families.length,
        },
      },
    });
    const { candidates: dedupedFamilyCandidates, discardedValues } = dedupeCandidates(family.candidates);
    if (discardedValues.length > 0) {
      const summary = sourceFamilySummaries[family.key];
      if (summary) summary.dedupeDiscardedValues = discardedValues;
    }
    const previousFamilyCount = previousFamilyCounts.get(family.key);
    const previousDropState = previousCountDropState.families[family.key];
    const countDropBaseline = previousDropState?.baseline ?? previousFamilyCount;
    const countDrop = countDropBaseline != null && countDropBaseline > 0
      && dedupedFamilyCandidates.length < Math.ceil(countDropBaseline * SUPPLEMENTAL_FAMILY_COUNT_DROP_RATIO);
    if (countDrop && countDropBaseline != null) {
      // A 200 response with fewer rows than the family last published is a
      // collapsed read, not a new level. Retain through the confirmation
      // window only: a retained row is never re-stamped, and it is never served
      // past the family's own freshness budget. After that the smaller
      // snapshot publishes with its real clock while the run stays degraded.
      const strikes = (previousDropState?.strikes ?? 0) + 1;
      const consistentAtNewLevel = previousFamilyCount != null
        && dedupedFamilyCandidates.length >= Math.ceil(previousFamilyCount * SUPPLEMENTAL_FAMILY_COUNT_DROP_RATIO);
      const consistentRuns = consistentAtNewLevel ? (previousDropState?.consistentRuns ?? 0) + 1 : 0;
      const retainedUpdatedAt = retainedFamilyRows?.get(getYieldSupplementalFamilyCacheKey(family.key))?.updatedAt ?? null;
      const retainedWithinBudget = retainedUpdatedAt == null
        || startSec - retainedUpdatedAt < getSupplementalFamilyStaleThresholdSec(family.key);
      const accepted = consistentRuns >= SUPPLEMENTAL_FAMILY_COUNT_DROP_ACCEPT_RUNS;
      const retained = !accepted
        && strikes <= SUPPLEMENTAL_FAMILY_COUNT_DROP_CONFIRM_RUNS
        && retainedWithinBudget
        && previousFamilyCount != null;
      familyCountDrops[family.key] = {
        baseline: countDropBaseline,
        previousCount: previousFamilyCount ?? 0,
        candidateCount: dedupedFamilyCandidates.length,
        strikes,
        consistentRuns,
        retained,
        accepted,
      };
      if (accepted) {
        delete nextCountDropState[family.key];
      } else {
        nextCountDropState[family.key] = {
          baseline: countDropBaseline,
          strikes,
          consistentRuns,
        };
        if (!retained || strikes >= SUPPLEMENTAL_FAMILY_COUNT_DROP_CONFIRM_RUNS) {
          degradedFamilies.push(family.key);
          degradedFamilyReasons[family.key] = "family-count-drop";
        }
        if (retained) {
          familyCacheResults[family.key] = "retained-previous";
          continue;
        }
      }
    } else if (previousDropState) {
      // Back at (or above) the accepted level: the drop is over.
      delete nextCountDropState[family.key];
    }
    const familyCacheValue = buildYieldSupplementalFamilyCache(dedupedFamilyCandidates, startSec);
    const familyCacheResult = await setCacheIfNewer(
      db,
      getYieldSupplementalFamilyCacheKey(family.key),
      familyCacheValue,
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
    if (familyCacheResult.written) {
      supplementalCandidatesWritten += dedupedFamilyCandidates.length;
      familySnapshotHashes[family.key] = supplementalFamilySnapshotHash({ value: familyCacheValue, updatedAt: startSec });
    }
  }
  // The previous outcome row is only read for partial runs (their merge must
  // not erase sibling diagnostics), so count-drop strikes live in their own row.
  const previousCountDropStateValue =
    retainedFamilyRows?.get(getYieldSupplementalCountDropStateCacheKey())?.value ?? null;
  const nextCountDropStateValue = buildYieldSupplementalCountDropState(nextCountDropState, startSec);
  if (nextCountDropStateValue !== previousCountDropStateValue
    && (Object.keys(nextCountDropState).length > 0 || previousCountDropStateValue != null)) {
    await setCache(db, getYieldSupplementalCountDropStateCacheKey(), nextCountDropStateValue, signal);
  }
  // B1/B16: publish the per-family outcome so the next publication can name the
  // families whose snapshot was retained.
  const mergedResults = { ...previousOutcome?.familyCacheResults, ...Object.fromEntries(
    families.map((family) => [family, familyCacheResults[family]]),
  ) };
  const mergedDegradedFamilies = [
    ...(previousOutcome?.degradedFamilies.filter((family) => !families.includes(family)) ?? []),
    ...degradedFamilies,
  ];
  const mergedReasons = Object.fromEntries(Object.entries(previousOutcome?.degradedFamilyReasons ?? {})
    .filter(([family]) => !families.includes(family as SupplementalSourceFamilyKey)));
  await setCache(
    db,
    getYieldSupplementalRunOutcomeCacheKey(),
    buildYieldSupplementalRunOutcome(
      { ...familyCacheResults, ...mergedResults },
      mergedDegradedFamilies,
      startSec,
      { ...mergedReasons, ...degradedFamilyReasons },
      { ...previousOutcome?.familySnapshotHashes, ...familySnapshotHashes },
    ),
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
      degradedFamilyReasons,
      sourceFamilyInventoryCounts,
      sourceFamilySummaries,
    },
  });

  const familyPublished = Object.values(familyCacheResults).some(
    (status) => status === "published" || status === "empty-published",
  );
  const metadata = JSON.stringify({
    ...(familyPublished ? { outputPublishedAt: startSec } : {}),
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
    degradedFamilyReasons,
    ...(Object.keys(familyCountDrops).length > 0 ? { familyCountDrops } : {}),
    reason: degradedFamilies.length > 0
      ? degradedFamilies.map((family) => {
          const familyReason = degradedFamilyReasons[family];
          return familyReason === "family-count-drop"
            ? `family-count-drop:${family}`
            : familyReason ?? `family-degraded:${family}`;
        }).join(",")
      : emptySnapshot ? "empty-snapshot" : null,
    syncStartSec: startSec,
  });

  return {
    ...(emptySnapshot || degradedFamilies.length > 0 ? { status: "degraded" as const } : {}),
    itemCount: supplementalCandidatesWritten,
    productivity: { productive: familyPublished },
    metadata,
  };
}
