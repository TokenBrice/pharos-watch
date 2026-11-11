"use client";

import { useMemo } from "react";
import { useYieldHistory } from "@/hooks/api-hooks";
import { CHART_PALETTE } from "@/lib/chart-colors";
import { toTimestampMs } from "@/lib/time";

function useYieldHistoryOverlaySource(stablecoinId: string, days: number, sourceKeys: string[], index: number) {
  const sourceKey = sourceKeys[index] ?? null;
  const query = useYieldHistory(stablecoinId, {
    days, mode: "source", sourceKey, enabled: sourceKeys.length > index,
  });
  const series = useMemo(() => {
    const values = new Map<number, number>();
    for (const point of query.data?.history ?? []) {
      const date = toTimestampMs(point.date);
      if (Number.isFinite(date)) values.set(date, point.apy);
    }
    return values;
  }, [query.data]);
  return { sourceKey, query, series, dataKey: `apy_overlay_${index}`, color: CHART_PALETTE[index + 3] };
}

export function useYieldHistoryChartQueries(
  stablecoinId: string,
  days: number,
  selectedSourceKey: string,
  externalSourceKeys?: string[],
) {
  const primarySourceKey = externalSourceKeys?.[0] ?? selectedSourceKey;
  const additionalOverlayKeys = externalSourceKeys?.slice(1) ?? [];

  const historyQuery = useYieldHistory(stablecoinId, {
    days,
    mode: primarySourceKey === "best" ? "best" : "source",
    sourceKey: primarySourceKey === "best" ? null : primarySourceKey,
  });

  // Keep every query slot mounted, including disabled slots; their count owns capacity.
  const overlaySlots = [
    useYieldHistoryOverlaySource(stablecoinId, days, additionalOverlayKeys, 0),
    useYieldHistoryOverlaySource(stablecoinId, days, additionalOverlayKeys, 1),
    useYieldHistoryOverlaySource(stablecoinId, days, additionalOverlayKeys, 2),
    useYieldHistoryOverlaySource(stablecoinId, days, additionalOverlayKeys, 3),
    useYieldHistoryOverlaySource(stablecoinId, days, additionalOverlayKeys, 4),
    useYieldHistoryOverlaySource(stablecoinId, days, additionalOverlayKeys, 5),
    useYieldHistoryOverlaySource(stablecoinId, days, additionalOverlayKeys, 6),
  ];
  const overlaySources = overlaySlots.slice(0, additionalOverlayKeys.length);
  const overlayQueries = overlaySources.map((source) => source.query);
  const omittedOverlayKeys = externalSourceKeys?.slice(overlaySlots.length + 1) ?? [];

  return { primarySourceKey, historyQuery, overlaySources, overlayQueries, omittedOverlayKeys };
}
