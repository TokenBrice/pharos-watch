"use client";

import { useMemo, useState } from "react";
import { useYieldHistory } from "@/hooks/api-hooks";
import { DAY_MS } from "@/lib/constants";
import { getYieldBenchmarkDisplayLabel } from "@/lib/yield-benchmark";
import type { YieldHistoryPoint } from "@shared/types";

export const BRAND_ACCENT = "oklch(0.72 0.14 248)";
export const DEFAULT_DAYS = 90;
export const PRESET_DAYS = [7, 30, 90, 365] as const;
const MAX_OVERLAY_SOURCES = 4;

export interface YieldHistoryChartProps {
  stablecoinId: string;
  benchmarkRate: number;
  benchmarkLabel?: string;
  benchmarkIsFallback?: boolean;
  medianApy: number;
  defaultDays?: number;
  compact?: boolean;
  availableSources?: Array<{
    sourceKey: string;
    yieldSource: string;
  }>;
  hideSourceSelector?: boolean;
  externalSourceKey?: string;
  externalSourceKeys?: string[];
}

export interface YieldHistoryChartPoint {
  date: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  sourceTvlUsd: number | null;
  warningSignals: string[];
  sourceKey: string | null;
  yieldSource: string | null;
  dataSource: string | null;
  isBest: boolean;
  sourceSwitch: boolean;
}

export type YieldHistoryChartSeriesPoint = YieldHistoryChartPoint & Partial<
  Record<`apy_overlay_${number}`, number | null>
>;

function normalizeDefaultDays(value?: number) {
  return PRESET_DAYS.includes(value as (typeof PRESET_DAYS)[number]) ? value! : DEFAULT_DAYS;
}

export function toTimestampMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }

    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Number.NaN;
}

const DATE_FMT_MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" });
const DATE_FMT_MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const DATE_FMT_TOOLTIP = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatAxisDate(timestamp: number, days: number) {
  return (days === 365 ? DATE_FMT_MONTH_YEAR : DATE_FMT_MONTH_DAY).format(timestamp);
}

export function formatTooltipDate(timestamp: number) {
  return DATE_FMT_TOOLTIP.format(timestamp);
}

const numberFormatterCache = new Map<string, Intl.NumberFormat>();

export function formatChartNumber(value: number, minimumFractionDigits = 2, maximumFractionDigits = 2) {
  const formatterKey = `${minimumFractionDigits}:${maximumFractionDigits}`;
  let formatter = numberFormatterCache.get(formatterKey);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", {
      minimumFractionDigits,
      maximumFractionDigits,
    });
    numberFormatterCache.set(formatterKey, formatter);
  }
  return formatter.format(value);
}

export function formatTickPercent(value: number) {
  return `${formatChartNumber(value, 0, Math.abs(value) >= 10 ? 1 : 2)}%`;
}

function buildTicks(points: YieldHistoryChartPoint[], days: number) {
  if (points.length === 0) return [];

  const first = points[0].date;
  const last = points[points.length - 1].date;
  const ticks = new Set<number>([first, last]);

  if (days === 365) {
    const cursor = new Date(first);
    cursor.setDate(1);
    cursor.setHours(0, 0, 0, 0);

    if (cursor.getTime() < first) {
      cursor.setMonth(cursor.getMonth() + 1);
    }

    while (cursor.getTime() < last) {
      ticks.add(cursor.getTime());
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    const stepMs = days === 7 ? DAY_MS : 7 * DAY_MS;
    const cursor = new Date(first);
    cursor.setHours(0, 0, 0, 0);

    if (cursor.getTime() < first) {
      cursor.setTime(cursor.getTime() + stepMs);
    }

    while (cursor.getTime() < last) {
      ticks.add(cursor.getTime());
      cursor.setTime(cursor.getTime() + stepMs);
    }
  }

  return Array.from(ticks).sort((a, b) => a - b);
}

function mapHistoryPoint(point: YieldHistoryPoint): YieldHistoryChartPoint | null {
  const date = toTimestampMs(point.date);
  if (!Number.isFinite(date)) {
    return null;
  }

  return {
    date,
    apy: point.apy,
    apyBase: point.apyBase,
    apyReward: point.apyReward,
    sourceTvlUsd: point.sourceTvlUsd,
    warningSignals: point.warningSignals,
    sourceKey: point.sourceKey ?? null,
    yieldSource: point.yieldSource ?? null,
    dataSource: point.dataSource ?? null,
    isBest: point.isBest ?? false,
    sourceSwitch: point.sourceSwitch ?? false,
  };
}

function roundHistoryTimestamp(timestamp: number) {
  return Math.round(timestamp / 3_600_000) * 3_600_000;
}

export function useYieldHistoryChartModel({
  stablecoinId,
  benchmarkRate,
  benchmarkLabel,
  benchmarkIsFallback = false,
  medianApy,
  defaultDays = DEFAULT_DAYS,
  availableSources = [],
  externalSourceKey,
  externalSourceKeys,
}: Pick<
  YieldHistoryChartProps,
  | "stablecoinId"
  | "benchmarkRate"
  | "benchmarkLabel"
  | "benchmarkIsFallback"
  | "medianApy"
  | "defaultDays"
  | "availableSources"
  | "externalSourceKey"
  | "externalSourceKeys"
>) {
  const [days, setDays] = useState(() => normalizeDefaultDays(defaultDays));
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [internalSourceKey, setInternalSourceKey] = useState<string>("best");

  const selectedSourceKey = externalSourceKey ?? internalSourceKey;
  const onSourceChange = externalSourceKey !== undefined ? () => {} : setInternalSourceKey;

  const effectiveSelectedSourceKey =
    selectedSourceKey === "best" || availableSources.some((source) => source.sourceKey === selectedSourceKey)
      ? selectedSourceKey
      : "best";

  const overlayKeys = externalSourceKeys?.slice(0, MAX_OVERLAY_SOURCES) ?? [];
  const primaryOverlayKey = overlayKeys[0] ?? null;
  const additionalOverlayKeys = overlayKeys.slice(1);
  const primarySourceKey = primaryOverlayKey ?? effectiveSelectedSourceKey;

  const historyQuery = useYieldHistory(stablecoinId, {
    days,
    mode: primarySourceKey === "best" ? "best" : "source",
    sourceKey: primarySourceKey === "best" ? null : primarySourceKey,
  });

  const overlay1 = useYieldHistory(stablecoinId, {
    days,
    mode: "source",
    sourceKey: additionalOverlayKeys[0] ?? null,
    enabled: additionalOverlayKeys.length >= 1,
  });
  const overlay2 = useYieldHistory(stablecoinId, {
    days,
    mode: "source",
    sourceKey: additionalOverlayKeys[1] ?? null,
    enabled: additionalOverlayKeys.length >= 2,
  });
  const overlay3 = useYieldHistory(stablecoinId, {
    days,
    mode: "source",
    sourceKey: additionalOverlayKeys[2] ?? null,
    enabled: additionalOverlayKeys.length >= 3,
  });
  const overlayQueries = [overlay1, overlay2, overlay3].slice(0, additionalOverlayKeys.length);

  const chartData = useMemo<YieldHistoryChartPoint[]>(() => {
    return (historyQuery.data?.history ?? [])
      .map(mapHistoryPoint)
      .flatMap((point) => (point ? [point] : []))
      .sort((a, b) => a.date - b.date);
  }, [historyQuery.data]);

  const overlayData = useMemo(() => {
    return overlayQueries.map((query) => {
      const series = new Map<number, number>();
      for (const point of query.data?.history ?? []) {
        const date = toTimestampMs(point.date);
        if (Number.isFinite(date)) {
          series.set(roundHistoryTimestamp(date), point.apy);
        }
      }
      return series;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- overlay query result refs are fixed-width
  }, [overlay1.data, overlay2.data, overlay3.data, overlayQueries.length]);

  const mergedChartData = useMemo<YieldHistoryChartSeriesPoint[]>(() => {
    if (overlayData.length === 0 || overlayData.every((series) => series.size === 0)) {
      return chartData as YieldHistoryChartSeriesPoint[];
    }

    return chartData.map((point) => {
      const merged: YieldHistoryChartSeriesPoint = { ...point };
      const rounded = roundHistoryTimestamp(point.date);
      for (let index = 0; index < overlayData.length; index++) {
        merged[`apy_overlay_${index}`] = overlayData[index].get(rounded) ?? null;
      }
      return merged;
    });
  }, [chartData, overlayData]);

  const overlayLabels = useMemo(() => {
    return additionalOverlayKeys.map((key) => {
      return availableSources.find((source) => source.sourceKey === key)?.yieldSource ?? key;
    });
  }, [additionalOverlayKeys, availableSources]);

  const hasBreakdown = useMemo(() => {
    return chartData.some((point) => point.apyBase !== null);
  }, [chartData]);
  const effectiveShowBreakdown = hasBreakdown && showBreakdown;
  const tickValues = useMemo(() => buildTicks(chartData, days), [chartData, days]);

  const yDomain = useMemo(() => {
    if (chartData.length === 0) {
      const minRef = Math.min(0, benchmarkRate, medianApy > 0 ? medianApy : 0);
      const maxRef = Math.max(benchmarkRate, medianApy, 1);
      return [minRef - 1, maxRef + 1] as const;
    }

    const values = [...chartData.map((point) => point.apy), benchmarkRate];
    if (medianApy > 0) {
      values.push(medianApy);
    }

    if (effectiveShowBreakdown) {
      for (const point of chartData) {
        if (point.apyBase !== null) values.push(point.apyBase);
        if (point.apyReward !== null) values.push(point.apyReward);
      }
    }

    for (const overlayMap of overlayData) {
      for (const apy of overlayMap.values()) {
        values.push(apy);
      }
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(max - min, 1);
    const padding = Math.max(span * 0.08, 0.5);
    return [min - padding, max + padding] as const;
  }, [benchmarkRate, chartData, effectiveShowBreakdown, medianApy, overlayData]);

  return {
    days,
    setDays,
    showBreakdown,
    setShowBreakdown,
    onSourceChange,
    selectedSourceKey: effectiveSelectedSourceKey,
    historyQuery,
    chartData,
    mergedChartData,
    overlayLabels,
    overlaySeriesKeys: additionalOverlayKeys.map((_, index) => `apy_overlay_${index}`),
    hasBreakdown,
    effectiveShowBreakdown,
    tickValues,
    yDomain,
    resolvedBenchmarkLabel: getYieldBenchmarkDisplayLabel({
      benchmarkLabel,
      benchmarkIsFallback,
    }),
  };
}
