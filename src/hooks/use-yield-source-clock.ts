"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { ApiQueryWithMetaResult } from "@/hooks/use-api-query";
import { useFreshnessBoundary } from "@/hooks/use-freshness-boundary";
import type { YieldWorkbenchRanking } from "@/lib/yield-row-types";
import { getYieldRankingSourceClockInputs } from "@/lib/yield-source-explorer-model";
import {
  getYieldSourceDisplayHealthInput,
  resolveYieldSourceAssessedAt,
  type YieldSourceClockInput,
  type YieldSourceDisplayClock,
} from "@/lib/yield-source-presentation";
import { isYieldRankingSummary } from "@/lib/yield-workbench-row";
import { isFiniteNumber } from "@shared/lib/type-guards";
import { compareYieldRankRows } from "@shared/lib/yield-rank-order";
import type { YieldRankingsCoinResponse, YieldRankingsResponse, YieldSourceInputMeta } from "@shared/types/yield";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";

const subscribeToNothing = () => () => {};

/**
 * Parent-owned source-age clock: one boundary render at the next public-gate
 * crossing of any listed source, never a poll or per-row timer. Callers pass a
 * memoized source list; a changed list or assessment re-anchors the schedule.
 */
export function useYieldSourceClock(
  sources: readonly YieldSourceClockInput[],
  assessedAt: number | null,
  expiresAtMs?: readonly number[],
): YieldSourceDisplayClock {
  const inputs = useMemo(
    () => sources.map((source) => getYieldSourceDisplayHealthInput(source, { assessedAt })),
    [assessedAt, sources],
  );
  const nowMs = useFreshnessBoundary(inputs, true, expiresAtMs);
  return useMemo(() => ({ assessedAt, nowMs }), [assessedAt, nowMs]);
}

/** Age delivery-based scores on the source clock while the response is cached. */
export function useYieldDeliveryScores<Row extends YieldWorkbenchRanking>(
  rows: Row[] | undefined,
  pools: YieldSourceInputMeta | undefined,
  sources: readonly YieldSourceClockInput[],
  assessedAt: number | null,
  dataUpdatedAt: number,
  fullCohort = true,
  cohortValidUntil?: number,
) {
  const deadlines = useMemo(() => {
    const batchAt = pools?.updatedAt;
    const validBatch = pools?.mode !== "unavailable" && isFiniteNumber(batchAt)
      && batchAt > 0 && (assessedAt == null || batchAt <= assessedAt);
    return (rows ?? []).map((row) => {
      if (row.pharosYieldScore == null || row.provenance?.sourceFreshness !== "unknown"
        || (row.dataSource !== "defillama" && row.dataSource !== "defillama-auto")) return undefined;
      const budget = row.provenance.sourceMaxAgeSeconds;
      return validBatch && isFiniteNumber(budget) && budget > 0 ? (batchAt + budget) * 1000 : null;
    });
  }, [assessedAt, pools, rows]);
  const cohortDeadline = cohortValidUntil === undefined ? undefined : cohortValidUntil * 1000;
  const expiresAtMs = useMemo(() => [...deadlines, cohortDeadline].filter(isFiniteNumber), [deadlines, cohortDeadline]);
  const sourceClock = useYieldSourceClock(sources, assessedAt, expiresAtMs);
  // Sample once when the browser first sees these deadlines, including a cached response on navigation.
  const getBrowserSnapshot = useMemo(() => {
    let sampledAtMs: number | undefined;
    return () => expiresAtMs.length > 0 ? (sampledAtMs ??= Date.now()) : undefined;
  }, [expiresAtMs]);
  const browserNowMs = useSyncExternalStore(subscribeToNothing, getBrowserSnapshot, () => undefined);
  const nowMs = Math.max(browserNowMs ?? 0, sourceClock.nowMs ?? 0, dataUpdatedAt ?? 0, (assessedAt ?? 0) * 1000);
  const rankings = useMemo(() => {
    if (!rows) return [];
    let changed = false;
    const projected = rows.map((row, index): Row => {
      const deadline = deadlines[index];
      if (deadline === undefined || (deadline !== null && nowMs < deadline)) return row;
      changed = true;
      return {
        ...row,
        pharosYieldScore: null,
        pysNullReason: deadline === null ? "source-freshness-unknown" : "source-stale",
        warningSignals: deadline === null ? row.warningSignals : [...row.warningSignals, "data-stale"],
        provenance: row.provenance && {
          ...row.provenance,
          scoreQualification: "NR",
          ...("scoreQualified" in row.provenance ? { scoreQualified: false } : {}),
          sourceFreshness: deadline === null ? "unknown" : "stale",
        },
      };
    });
    if (!changed && (cohortDeadline === undefined || nowMs < cohortDeadline)) return rows;
    if (fullCohort) projected.sort(compareYieldRankRows);
    // Movement requires the server's baseline assessment of the whole cohort.
    return projected.map((row, index): Row => isYieldRankingSummary(row)
      ? { ...row, rankDelta: undefined, rankChangeDriver: undefined, rankPysDelta: undefined }
      : { ...row, ...(fullCohort ? { liveRank: index + 1 } : { liveRank: undefined }), rankChangeAttribution: undefined });
  }, [rows, deadlines, nowMs, fullCohort, cohortDeadline]);
  return { rankings, sourceClock };
}

/** Apply delivery deadlines on routes that consume yield rankings. */
export function useLiveYieldRankings<Response extends YieldRankingsResponse | YieldRankingsSummaryResponse>(
  query: ApiQueryWithMetaResult<Response>,
): ApiQueryWithMetaResult<Response> {
  const { data, meta, dataUpdatedAt } = query;
  const assessedAt = resolveYieldSourceAssessedAt(data?._meta ?? meta, dataUpdatedAt);
  const { rankings } = useYieldDeliveryScores<Response["rankings"][number]>(
    data?.rankings, data?.provenance?.dlPools, [], assessedAt, dataUpdatedAt,
  );
  return data && rankings !== data.rankings ? { ...query, data: { ...data, rankings } } : query;
}

/** The selected coin's source labels share a timer with the detailed response's delivery deadlines. */
export function useYieldCoinRankings(
  data: (YieldRankingsResponse & { projection?: never }) | YieldRankingsCoinResponse | undefined,
  stablecoinId: string | null,
  responseMeta: object | null | undefined,
  dataUpdatedAt: number,
) {
  const response = stablecoinId === null ? undefined : data;
  const selected = response?.rankings.find((row) => row.id === stablecoinId);
  const sources = useMemo(() => (selected ? getYieldRankingSourceClockInputs(selected) : []), [selected]);
  const assessedAt = resolveYieldSourceAssessedAt(response?._meta ?? responseMeta, dataUpdatedAt);
  const scoped = response?.projection !== undefined ? response : undefined;
  const { rankings, sourceClock } = useYieldDeliveryScores(
    response?.rankings, response?.provenance?.dlPools, sources, assessedAt, dataUpdatedAt,
    !scoped, scoped?.cohortValidUntil,
  );
  const agedData = useMemo(
    () => response && (rankings === response.rankings ? response : { ...response, rankings }),
    [response, rankings],
  );
  return { data: agedData, sourceClock };
}
