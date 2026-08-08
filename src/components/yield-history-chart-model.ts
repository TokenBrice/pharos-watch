"use client";

import { useMemo, useState } from "react";
import { useYieldHistory } from "@/hooks/api-hooks";
import { DAY_MS } from "@/lib/constants";
import { toTimestampMs } from "@/lib/time";
import { getYieldBenchmarkDisplayLabel } from "@/lib/yield-benchmark";
import { formatChartDate, formatDecimal } from "@shared/lib/format";
import { YIELD_HISTORY_MAX_DAYS } from "@shared/lib/yield-history-policy";
import type { YieldHistoryPoint } from "@shared/types";

export const BRAND_ACCENT = "oklch(0.72 0.14 248)";
export const DEFAULT_DAYS = 90;
export const PRESET_DAYS = [7, 30, 90, YIELD_HISTORY_MAX_DAYS] as const;
const MAX_OVERLAY_SOURCES = 4;
const SOURCE_KEY_SUFFIX_LENGTH = 12;

/* Spike-detection parameters (mirrors the `yield-spike` warning signal in docs/yield-intelligence.md):
 *   SPIKE_WINDOW_MS     — 30-day trailing window chosen to smooth seasonal variation while
 *                         staying sensitive to multi-week anomalies.
 *   SPIKE_MIN_APY       — absolute floor of 2 % APY; below this the ratio is noisy and a
 *                         "2×" jump carries no actionable information.
 *   SPIKE_RATIO_THRESHOLD — a point is flagged when its APY is ≥2× the trailing mean,
 *                           matching the same 2× threshold used by the server-side
 *                           `detectWarningSignals` function.
 * When fewer than 3 trailing data-points fall inside the window (e.g. at the start of the
 * series), the algorithm falls back to the series-wide positive-APY mean so that early
 * outliers are still catchable. */
const SPIKE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SPIKE_MIN_APY = 2;
const SPIKE_RATIO_THRESHOLD = 2.0;

interface SpikeAnnotation {
  date: number;
  apy: number;
  trailingAvg: number;
  ratio: number;
}

function computeSpikeAnnotations(
  chartData: Array<{ date: number; apy: number }>,
): SpikeAnnotation[] {
  const result: SpikeAnnotation[] = [];
  /* Compute a single reference average from the full series to catch outliers
     near the start of the window where trailing context is thin. */
  const seriesPositiveApys = chartData.filter((p) => p.apy > 0).map((p) => p.apy);
  const seriesMean =
    seriesPositiveApys.length > 0
      ? seriesPositiveApys.reduce((sum, v) => sum + v, 0) / seriesPositiveApys.length
      : 0;
  for (let i = 0; i < chartData.length; i++) {
    const point = chartData[i];
    if (point.apy <= SPIKE_MIN_APY) continue;

    const windowStart = point.date - SPIKE_WINDOW_MS;
    const trailingPoints = chartData
      .slice(0, i)
      .filter((p) => p.date >= windowStart && p.apy > 0);

    let avg: number;
    if (trailingPoints.length >= 3) {
      avg = trailingPoints.reduce((sum, p) => sum + p.apy, 0) / trailingPoints.length;
    } else if (seriesMean > 0) {
      avg = seriesMean;
    } else {
      continue;
    }
    if (avg <= 0) continue;

    const ratio = point.apy / avg;
    if (ratio >= SPIKE_RATIO_THRESHOLD) {
      result.push({ date: point.date, apy: point.apy, trailingAvg: avg, ratio });
    }
  }
  return result;
}

export interface YieldHistorySourceOption {
  sourceKey: string;
  yieldSource: string;
}

export interface YieldHistoryChartProps {
  stablecoinId: string;
  benchmarkRate: number;
  benchmarkLabel?: string;
  benchmarkIsFallback?: boolean;
  medianApy: number;
  defaultDays?: number;
  compact?: boolean;
  availableSources?: YieldHistorySourceOption[];
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

export interface YieldHistorySourceDisplay {
  sourceKey: string;
  label: string;
}

/* Deterministic palette for source-strip lanes. The first up-to-5 sources by
   first-appearance get assigned colors in order. Sources beyond the cap collapse
   into a single muted "other" lane. */
const SOURCE_STRIP_PALETTE = [
  "bg-emerald-500/40",
  "bg-sky-500/40",
  "bg-amber-500/40",
  "bg-violet-500/40",
  "bg-rose-500/40",
] as const;
const SOURCE_STRIP_OTHER_COLOR = "bg-muted-foreground/30";
const SOURCE_STRIP_DEFAULT_MAX_DISTINCT = 5;

export interface YieldSourceSegment {
  startTs: number;
  endTs: number;
  sourceKey: string;
  sourceLabel: string;
  color: string;
  isOther: boolean;
}

interface YieldSourceSegmentInput {
  ts: number;
  sourceKey: string;
  sourceLabel?: string;
}

/* Walk history points in time order; collapse adjacent points sharing a sourceKey
   into one segment. Sources beyond `maxDistinctSources` (by first-appearance) are
   recolored/relabeled as "other" — their original boundaries are preserved but
   they share a single muted lane in the rendered strip. */
export function deriveYieldSourceSegments(
  history: ReadonlyArray<YieldSourceSegmentInput>,
  options?: { maxDistinctSources?: number },
): YieldSourceSegment[] {
  if (history.length === 0) return [];

  const maxDistinct = Math.max(1, options?.maxDistinctSources ?? SOURCE_STRIP_DEFAULT_MAX_DISTINCT);
  const sorted = [...history]
    .filter((point) => Number.isFinite(point.ts) && point.sourceKey)
    .sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) return [];

  /* First pass — group consecutive points with the same sourceKey into raw segments. */
  type RawSegment = { startTs: number; endTs: number; sourceKey: string; sourceLabel: string };
  const raw: RawSegment[] = [];
  for (const point of sorted) {
    const label = point.sourceLabel ?? point.sourceKey;
    const current = raw[raw.length - 1];
    if (current && current.sourceKey === point.sourceKey) {
      current.endTs = point.ts;
    } else {
      raw.push({ startTs: point.ts, endTs: point.ts, sourceKey: point.sourceKey, sourceLabel: label });
    }
  }

  /* If a segment is a single point (start === end) and there are later segments,
     extend it to the next segment's start so widths render visibly. */
  for (let i = 0; i < raw.length - 1; i++) {
    if (raw[i].endTs === raw[i].startTs) {
      raw[i].endTs = raw[i + 1].startTs;
    }
  }

  /* Determine top-N sources by first-appearance order. */
  const firstAppearance = new Map<string, number>();
  raw.forEach((segment, index) => {
    if (!firstAppearance.has(segment.sourceKey)) {
      firstAppearance.set(segment.sourceKey, index);
    }
  });
  const orderedSources = Array.from(firstAppearance.keys());
  const topSources = new Set(orderedSources.slice(0, maxDistinct));
  const colorBySource = new Map<string, string>();
  orderedSources.slice(0, maxDistinct).forEach((key, index) => {
    colorBySource.set(key, SOURCE_STRIP_PALETTE[index] ?? SOURCE_STRIP_PALETTE[SOURCE_STRIP_PALETTE.length - 1]);
  });

  return raw.map((segment) => {
    const isOther = !topSources.has(segment.sourceKey);
    return {
      startTs: segment.startTs,
      endTs: segment.endTs,
      sourceKey: isOther ? "other" : segment.sourceKey,
      sourceLabel: isOther ? "other" : segment.sourceLabel,
      color: isOther ? SOURCE_STRIP_OTHER_COLOR : colorBySource.get(segment.sourceKey) ?? SOURCE_STRIP_OTHER_COLOR,
      isOther,
    };
  });
}

function normalizeDefaultDays(value?: number) {
  return PRESET_DAYS.includes(value as (typeof PRESET_DAYS)[number]) ? value! : DEFAULT_DAYS;
}

export function formatAxisDate(timestamp: number, days: number) {
  return formatChartDate(timestamp, days > 180 ? "compact" : "short");
}

export function formatTooltipDate(timestamp: number) {
  return formatChartDate(timestamp, "full");
}

export function formatChartNumber(value: number, minimumFractionDigits = 2, maximumFractionDigits = 2) {
  return formatDecimal(value, minimumFractionDigits, maximumFractionDigits);
}

export function formatTickPercent(value: number) {
  return `${formatChartNumber(value, 0, Math.abs(value) >= 10 ? 1 : 2)}%`;
}

function formatSourceKeySuffix(sourceKey: string) {
  return sourceKey.length > SOURCE_KEY_SUFFIX_LENGTH
    ? `...${sourceKey.slice(-SOURCE_KEY_SUFFIX_LENGTH)}`
    : sourceKey;
}

export function getYieldHistorySourceDisplayLabel(
  source: YieldHistorySourceOption,
  allSources: readonly YieldHistorySourceOption[],
) {
  const duplicateLabelCount = allSources.filter((candidate) => candidate.yieldSource === source.yieldSource).length;
  if (duplicateLabelCount <= 1) {
    return source.yieldSource;
  }
  return `${source.yieldSource} (${formatSourceKeySuffix(source.sourceKey)})`;
}

function getSourceDisplay(
  sourceKey: string,
  allSources: readonly YieldHistorySourceOption[],
  fallbackLabel = sourceKey,
): YieldHistorySourceDisplay {
  if (sourceKey === "best") {
    return { sourceKey, label: "Best yield" };
  }

  const source = allSources.find((candidate) => candidate.sourceKey === sourceKey);
  return {
    sourceKey,
    label: source ? getYieldHistorySourceDisplayLabel(source, allSources) : fallbackLabel,
  };
}

function buildTicks(points: YieldHistoryChartPoint[], days: number) {
  if (points.length === 0) return [];

  const first = points[0].date;
  const last = points[points.length - 1].date;
  const ticks = new Set<number>([first, last]);

  if (days === YIELD_HISTORY_MAX_DAYS) {
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
  // When the parent controls the source key, the internal selector cannot do
  // anything — expose `undefined` so the dropdown is omitted rather than
  // present-but-inert (a noop would silently discard child calls).
  const onSourceChange = externalSourceKey !== undefined ? undefined : setInternalSourceKey;

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
      return getSourceDisplay(key, availableSources);
    });
  }, [additionalOverlayKeys, availableSources]);
  const primarySourceLabel = useMemo(() => {
    return getSourceDisplay(primarySourceKey, availableSources, primarySourceKey);
  }, [availableSources, primarySourceKey]);

  const hasBreakdown = useMemo(() => {
    return chartData.some((point) => point.apyBase !== null);
  }, [chartData]);
  const effectiveShowBreakdown = hasBreakdown && showBreakdown;
  const tickValues = useMemo(() => buildTicks(chartData, days), [chartData, days]);

  const spikeAnnotations = useMemo(() => computeSpikeAnnotations(chartData), [chartData]);
  const spikeDates = useMemo(() => new Set(spikeAnnotations.map((spike) => spike.date)), [spikeAnnotations]);

  const sourceSegments = useMemo(() => {
    return deriveYieldSourceSegments(
      chartData
        .filter((point): point is YieldHistoryChartPoint & { sourceKey: string } => Boolean(point.sourceKey))
        .map((point) => ({
          ts: point.date,
          sourceKey: point.sourceKey,
          sourceLabel: getSourceDisplay(point.sourceKey, availableSources, point.yieldSource ?? point.sourceKey).label,
        })),
    );
  }, [availableSources, chartData]);

  const yDomain = useMemo(() => {
    if (chartData.length === 0) {
      const minRef = Math.min(0, benchmarkRate, medianApy > 0 ? medianApy : 0);
      const maxRef = Math.max(benchmarkRate, medianApy, 1);
      return [minRef - 1, maxRef + 1] as const;
    }

    const apyValues = chartData
      .filter((point) => !spikeDates.has(point.date))
      .map((point) => point.apy);
    const values: number[] = apyValues.length > 0 ? [...apyValues] : chartData.map((point) => point.apy);
    // Reference lines join the domain only when they sit near the data.
    // A hurdle several data-spans away otherwise empties the plot (ZCHF:
    // a flat 3.5% series stretched to show a -0.04% benchmark); far-away
    // references clamp to the domain edge at render time instead.
    const dataMin = Math.min(...values);
    const dataMax = Math.max(...values);
    const nearBand = Math.max((dataMax - dataMin) * 2, 1);
    if (benchmarkRate >= dataMin - nearBand && benchmarkRate <= dataMax + nearBand) {
      values.push(benchmarkRate);
    }
    if (medianApy > 0 && medianApy >= dataMin - nearBand && medianApy <= dataMax + nearBand) {
      values.push(medianApy);
    }

    if (effectiveShowBreakdown) {
      for (const point of chartData) {
        if (spikeDates.has(point.date)) continue;
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
  }, [benchmarkRate, chartData, effectiveShowBreakdown, medianApy, overlayData, spikeDates]);

  return {
    days,
    setDays,
    showBreakdown,
    setShowBreakdown,
    onSourceChange,
    selectedSourceKey: effectiveSelectedSourceKey,
    primarySourceKey,
    primarySourceLabel,
    bodyWarning: historyQuery.data?.warning ?? null,
    historyQuery,
    chartData,
    mergedChartData,
    overlayLabels,
    overlaySeriesKeys: additionalOverlayKeys.map((_, index) => `apy_overlay_${index}`),
    hasBreakdown,
    effectiveShowBreakdown,
    tickValues,
    yDomain,
    spikeAnnotations,
    sourceSegments,
    resolvedBenchmarkLabel: getYieldBenchmarkDisplayLabel({
      benchmarkLabel,
      benchmarkIsFallback,
    }),
  };
}
