"use client";

import { useCallback, useMemo } from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { asMetaQueryOptions, createRegisteredApiPollingQueryOptions, useYieldHistory } from "@/hooks/api-hooks";
import { unwrapApiQueryWithMetaResult } from "@/hooks/use-api-query";
import type { ApiMeta } from "@/lib/api";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { CHART_PALETTE } from "@/lib/chart-colors";
import { toTimestampMs } from "@/lib/time";
import type { YieldHistoryResponse } from "@shared/types";

const OVERLAY_CAPACITY = 7;

export function useYieldHistoryChartQueries(
  stablecoinId: string,
  days: number,
  selectedSourceKey: string,
  externalSourceKeys?: string[],
) {
  const primarySourceKey = externalSourceKeys?.[0] ?? selectedSourceKey;
  const additionalOverlayKeys = useMemo(() => externalSourceKeys?.slice(1) ?? [], [externalSourceKeys]);

  const historyQuery = useYieldHistory(stablecoinId, {
    days,
    mode: primarySourceKey === "best" ? "best" : "source",
    sourceKey: primarySourceKey === "best" ? null : primarySourceKey,
  });

  // Keep every query slot mounted, including disabled slots; their count owns capacity.
  const overlaySlots = useQueries({
    queries: Array.from({ length: OVERLAY_CAPACITY }, (_, index) => asMetaQueryOptions(
      createRegisteredApiPollingQueryOptions(
        FRONTEND_API_QUERY_DESCRIPTORS.yieldHistory(stablecoinId, days, "source", additionalOverlayKeys[index] ?? null),
        { enabled: additionalOverlayKeys.length > index },
      ),
    )),
    combine: useCallback((queries: UseQueryResult<{ data: YieldHistoryResponse; meta: ApiMeta | null }>[]) => queries.map((result, index) => {
      const query = unwrapApiQueryWithMetaResult(result);
      const series = new Map<number, number>();
      for (const point of query.data?.history ?? []) {
        const date = toTimestampMs(point.date);
        if (Number.isFinite(date)) series.set(date, point.apy);
      }
      return {
        sourceKey: additionalOverlayKeys[index] ?? null,
        query,
        series,
        dataKey: `apy_overlay_${index}`,
        color: CHART_PALETTE[index + 3],
      };
    }), [additionalOverlayKeys]),
  });
  const overlaySources = useMemo(
    () => overlaySlots.slice(0, additionalOverlayKeys.length),
    [overlaySlots, additionalOverlayKeys.length],
  );
  const overlayQueries = overlaySources.map((source) => source.query);
  const omittedOverlayKeys = externalSourceKeys?.slice(overlaySlots.length + 1) ?? [];

  return { primarySourceKey, historyQuery, overlaySources, overlayQueries, omittedOverlayKeys };
}
