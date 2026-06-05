"use client";

import { useMemo } from "react";
import { LineChart, Line, ReferenceArea, ReferenceDot, ReferenceLine } from "recharts";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter, type TimeRangeOption } from "@/hooks/use-time-range-filter";
import { CHART_BLUE } from "@/lib/chart-colors";
import { ChartSkeleton } from "@/components/chart-skeleton";
import {
  AnnotationDensityStrip,
  ChartAnnotationLegend,
  ChartAnnotationLines,
} from "@/components/chart-primitives/annotations";
import { MarketDataXTick } from "@/components/chart-primitives/market-data-x-tick";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis, usePlotInsets } from "@/components/chart-primitives/axes";
import {
  ChartCrosshairOverlay,
  useChartSyncHandlers,
  useMarketDataChartSync,
} from "@/components/chart-primitives/sync";
import { ChartCardShell } from "@/components/chart-primitives/shell";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";
import { useChartAnnotations } from "@/hooks/use-chart-annotations";
import { buildAdaptiveMonthlyTicks } from "@/lib/chart-utils";
import { cn } from "@/lib/utils";

function formatTooltip(value: number): [string, string] {
  const deviationBps = Math.round((value - 1) * 10000);
  const sign = deviationBps > 0 ? "+" : "";
  return [`$${value.toFixed(6)} (${sign}${deviationBps} bps)`, "Price"];
}

/**
 * Canonical peg deviation bands (absolute bps from $1).
 * Calibrated to match the wider Pharos depeg threshold (100 bps for USD pegs)
 * and to give a calm gradient of severity inside that envelope.
 */
const PEG_BAND_BPS = {
  tight: 25,
  drift: 50,
  stress: 100,
} as const;

const PEG_BAND_HEX = {
  drift: "#eab308", // yellow-500 — drift outside tight
  stress: "#f97316", // orange-500 — approaching depeg
  depeg: "#ef4444", // red-500 — confirmed depeg
} as const;

function bpsToPrice(bps: number): number {
  return 1 + bps / 10_000;
}

/**
 * `cssColor` is for HTML / `style.color` (uses semantic tokens); `svgColor` is
 * a hex for SVG `fill`/`stroke` (Recharts can't resolve CSS variables).
 */
function classifyDeviation(bps: number): {
  label: string;
  cssColor: string;
  svgColor: string;
} {
  const abs = Math.abs(bps);
  if (abs <= PEG_BAND_BPS.tight) {
    return { label: "in-band", cssColor: "var(--color-muted-foreground)", svgColor: "#94a3b8" };
  }
  if (abs <= PEG_BAND_BPS.drift) {
    return { label: "drift", cssColor: PEG_BAND_HEX.drift, svgColor: PEG_BAND_HEX.drift };
  }
  if (abs <= PEG_BAND_BPS.stress) {
    return { label: "stressed", cssColor: PEG_BAND_HEX.stress, svgColor: PEG_BAND_HEX.stress };
  }
  return { label: "depeg", cssColor: PEG_BAND_HEX.depeg, svgColor: PEG_BAND_HEX.depeg };
}

/**
 * Snap the Y-axis domain symmetrically around the $1 peg target so upside and
 * downside deviation are visually equivalent. Step is chosen so ~4-6 ticks
 * cover the range.
 */
const TICK_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2];

function computePegYAxis(prices: number[]): {
  domain: [number, number];
  ticks: number[];
  step: number;
} {
  if (prices.length === 0) {
    return { domain: [0.98, 1.02], ticks: [0.98, 0.99, 1, 1.01, 1.02], step: 0.01 };
  }
  let half = 0;
  for (const p of prices) {
    const d = Math.abs(p - 1);
    if (d > half) half = d;
  }
  // Floor at 50 bps so quiet pegs still show the in-band breathing room.
  if (half < 0.005) half = 0.005;

  let step = TICK_STEPS[TICK_STEPS.length - 1];
  for (const candidate of TICK_STEPS) {
    if (candidate >= (2 * half) / 5) {
      step = candidate;
      break;
    }
  }

  const padded = Math.ceil(half / step + 1e-9) * step;
  const domainMin = 1 - padded;
  const domainMax = 1 + padded;

  const ticks: number[] = [];
  for (let t = domainMin; t <= domainMax + 1e-9; t += step) {
    ticks.push(Number(t.toFixed(6)));
  }
  return { domain: [domainMin, domainMax], ticks, step };
}

function makePriceTickFormatter(step: number): (value: number) => string {
  const decimals = step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4;
  return (value) => `$${value.toFixed(decimals)}`;
}

/**
 * Single-pole exponential moving average over a price series. `alpha` is
 * chosen by caller based on range so longer windows get heavier smoothing.
 */
function ewma(values: number[], alpha: number): number[] {
  if (values.length === 0) return [];
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    out.push(alpha * values[i] + (1 - alpha) * out[i - 1]);
  }
  return out;
}

interface PegDeviationChartProps {
  data: SupplyHistoryPoint[];
  pegCurrency?: string | null;
  stablecoinId: string;
  hideAnnotationLegend?: boolean;
  controlledRange?: TimeRangeOption;
  cardClassName?: string;
  /** When true, drop the outer Card chrome so the chart can be embedded in a grouped panel. */
  embedded?: boolean;
}

export function PegDeviationChart({
  data,
  pegCurrency,
  stablecoinId,
  hideAnnotationLegend = false,
  controlledRange,
  cardClassName,
  embedded = false,
}: PegDeviationChartProps) {
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();
  const sync = useMarketDataChartSync();

  const chartData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];
    const raw = data
      .filter((d) => d.price != null && d.price > 0)
      .map((d) => ({
        ts: d.date * 1000,
        price: d.price as number,
      }));
    return raw;
  }, [data]);

  const { range, setRange, filteredData, options } = useTimeRangeFilter(
    chartData,
    "ts",
    undefined,
    { externalRange: controlledRange },
  );

  const brushedRange = sync?.brushedRange ?? null;
  // Brushed sub-window further narrows the visible data (D4).
  const visibleData = useMemo(() => {
    if (!brushedRange) return filteredData;
    const [lo, hi] = brushedRange;
    return filteredData.filter((d) => d.ts >= lo && d.ts <= hi);
  }, [filteredData, brushedRange]);

  // Apply EWMA smoothing at long ranges where daily ticks compress into static.
  // `priceSmoothed` is plotted on top of the raw `price` line (which is dimmed).
  const smoothedData = useMemo(() => {
    if (range !== "all" && range !== "1y") {
      return visibleData.map((d) => ({ ...d, priceSmoothed: null as number | null }));
    }
    const alpha = range === "all" ? 0.04 : 0.12;
    const smoothed = ewma(visibleData.map((d) => d.price), alpha);
    return visibleData.map((d, i) => ({ ...d, priceSmoothed: smoothed[i] }));
  }, [visibleData, range]);

  const showSmoothed = range === "all" || range === "1y";

  const fromMs = visibleData[0]?.ts ?? null;
  const toMs = visibleData[visibleData.length - 1]?.ts ?? null;
  const { data: annotations } = useChartAnnotations(stablecoinId, fromMs, toMs);

  // D14 — wider annotation set (the full controlled range, not brushed) for
  // the density strip. The strip reflects *available* events for the active
  // range, so brushing into a sub-window still surfaces the parent's cadence.
  const fullRangeFromMs = filteredData[0]?.ts ?? null;
  const fullRangeToMs = filteredData[filteredData.length - 1]?.ts ?? null;
  const { data: fullRangeAnnotations } = useChartAnnotations(
    stablecoinId,
    fullRangeFromMs,
    fullRangeToMs,
  );

  const xTicks = useMemo(() => {
    if (range !== "all" || visibleData.length === 0) return undefined;
    const first = visibleData[0].ts;
    const last = visibleData[visibleData.length - 1].ts;
    return buildAdaptiveMonthlyTicks(first, last);
  }, [range, visibleData]);

  const yAxis = useMemo(
    () => computePegYAxis(visibleData.map((d) => d.price)),
    [visibleData],
  );
  const formatPriceTick = useMemo(() => makePriceTickFormatter(yAxis.step), [yAxis.step]);

  // Header readout: current price + signed bps + named band.
  const readout = useMemo(() => {
    if (visibleData.length === 0) return null;
    const last = visibleData[visibleData.length - 1];
    const bps = Math.round((last.price - 1) * 10_000);
    const band = classifyDeviation(bps);
    const sign = bps > 0 ? "+" : "";
    return {
      price: last.price,
      bps,
      sign,
      bandLabel: band.label,
      bandCssColor: band.cssColor,
      bandSvgColor: band.svgColor,
      isInBand: band.label === "in-band",
      ts: last.ts,
    };
  }, [visibleData]);

  // D14 gate: density strip only on full-range view. Reserve ~12px of bottom
  // padding so the strip sits below the axis without colliding.
  const showDensityStrip = range === "all" && fullRangeAnnotations.length > 0;
  const densityStripHeight = 6;
  const densityStripBottomPad = 6;

  // Stable chart margins (used by both Recharts and the crosshair overlay).
  const margin = useMemo(() => ({
    top: 5,
    right: 12,
    bottom: range === "all" ? 32 : 20,
    left: 5,
  }), [range]);
  const { plotInsetLeft, plotInsetRight, plotInsetTop, plotInsetBottom } = usePlotInsets(margin);
  const { handleMouseMove, handleMouseLeave } = useChartSyncHandlers(sync);

  if (pegCurrency !== "USD") {
    return null;
  }

  const chartHeightClass = "h-[250px] sm:h-[350px]";
  const xDomain = visibleData.length > 0
    ? ([visibleData[0].ts, visibleData[visibleData.length - 1].ts] as const)
    : null;

  // Available plot-area width inside the chart's left axis + right margin.
  // Used by the density strip so its bars share the x-pixel domain.
  const plotAreaWidth = Math.max(0, width - plotInsetLeft - plotInsetRight);

  const chartBody = visibleData.length > 0 ? (
    <div className={cn("relative", chartHeightClass)}>
      <div
        ref={chartContainerRef}
        className="h-full"
        role="figure"
        aria-label={`Peg deviation chart showing ${visibleData.length} data points`}
      >
      {isChartReady ? (
        <LineChart
          width={width}
          height={height}
          data={smoothedData}
          margin={margin}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <TimeGrid />
          <TimeXAxis
            dataKey="ts"
            ticks={xTicks}
            interval={range === "all" ? 0 : "preserveStartEnd"}
            tick={<MarketDataXTick range={range} />}
            height={range === "all" ? 44 : 30}
          />
          <MonoYAxis tickFormatter={formatPriceTick} domain={yAxis.domain} ticks={yAxis.ticks} />

          {/* Peg severity bands — calm in-band core, warning outside. ifOverflow="hidden" clips
              bands that extend past the visible domain so they don't push the axis. */}
          <ReferenceArea
            y1={bpsToPrice(PEG_BAND_BPS.tight)}
            y2={bpsToPrice(PEG_BAND_BPS.drift)}
            fill={PEG_BAND_HEX.drift}
            fillOpacity={0.06}
            ifOverflow="hidden"
            strokeOpacity={0}
          />
          <ReferenceArea
            y1={bpsToPrice(-PEG_BAND_BPS.drift)}
            y2={bpsToPrice(-PEG_BAND_BPS.tight)}
            fill={PEG_BAND_HEX.drift}
            fillOpacity={0.06}
            ifOverflow="hidden"
            strokeOpacity={0}
          />
          <ReferenceArea
            y1={bpsToPrice(PEG_BAND_BPS.drift)}
            y2={bpsToPrice(PEG_BAND_BPS.stress)}
            fill={PEG_BAND_HEX.stress}
            fillOpacity={0.07}
            ifOverflow="hidden"
            strokeOpacity={0}
          />
          <ReferenceArea
            y1={bpsToPrice(-PEG_BAND_BPS.stress)}
            y2={bpsToPrice(-PEG_BAND_BPS.drift)}
            fill={PEG_BAND_HEX.stress}
            fillOpacity={0.07}
            ifOverflow="hidden"
            strokeOpacity={0}
          />
          <ReferenceArea
            y1={bpsToPrice(PEG_BAND_BPS.stress)}
            y2={yAxis.domain[1]}
            fill={PEG_BAND_HEX.depeg}
            fillOpacity={0.08}
            ifOverflow="hidden"
            strokeOpacity={0}
          />
          <ReferenceArea
            y1={yAxis.domain[0]}
            y2={bpsToPrice(-PEG_BAND_BPS.stress)}
            fill={PEG_BAND_HEX.depeg}
            fillOpacity={0.08}
            ifOverflow="hidden"
            strokeOpacity={0}
          />

          {/* $1 peg reference line — solid, mono-weight, with inline label */}
          <ReferenceLine
            y={1}
            stroke="var(--color-foreground)"
            strokeOpacity={0.45}
            strokeWidth={1}
            label={{
              value: "$1.000",
              position: "insideLeft",
              fill: "var(--color-muted-foreground)",
              fontSize: 10,
              fontFamily: "var(--font-mono, monospace)",
              offset: 6,
            }}
          />

          <DateTooltip formatter={(value) => formatTooltip(Number(value))} />

          {/* Raw line: full opacity when not smoothing, dimmed when smoothed overlay is drawn */}
          <Line
            type="monotone"
            dataKey="price"
            stroke={CHART_BLUE}
            strokeWidth={showSmoothed ? 1 : 1.75}
            strokeOpacity={showSmoothed ? 0.35 : 1}
            dot={false}
            isAnimationActive={false}
          />
          {showSmoothed ? (
            <Line
              type="monotone"
              dataKey="priceSmoothed"
              stroke={CHART_BLUE}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ) : null}

          {readout ? (
            <ReferenceDot
              x={readout.ts}
              y={readout.price}
              r={3.5}
              fill={readout.bandSvgColor}
              stroke="#0b1220"
              strokeWidth={1.5}
              ifOverflow="extendDomain"
            />
          ) : null}

          <ChartAnnotationLines annotations={annotations} numbered />
        </LineChart>
      ) : (
        <ChartSkeleton className="h-full w-full" />
      )}
      </div>
      {sync ? (
        <ChartCrosshairOverlay
          hoveredTs={sync.hoveredTs}
          domain={xDomain}
          plotInsetLeft={plotInsetLeft}
          plotInsetRight={plotInsetRight}
          plotInsetTop={plotInsetTop}
          plotInsetBottom={plotInsetBottom}
        />
      ) : null}
      {showDensityStrip && xDomain ? (
        <div
          aria-label="Annotation event density by quarter"
          className="absolute"
          style={{
            left: plotInsetLeft,
            bottom: densityStripBottomPad,
            width: plotAreaWidth,
            height: densityStripHeight,
          }}
        >
          <AnnotationDensityStrip
            annotations={fullRangeAnnotations}
            domain={xDomain}
            width={plotAreaWidth}
            height={densityStripHeight}
          />
        </div>
      ) : null}
    </div>
  ) : (
    <div className={`flex ${chartHeightClass} items-center justify-center text-muted-foreground`}>
      No price history available
    </div>
  );

  const header = (
    <div className="flex flex-row items-center justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <DetailSectionTitle>Peg Deviation</DetailSectionTitle>
        {readout ? (
          <div className="flex items-baseline gap-2 font-mono text-xs tabular-nums">
            <span className="text-foreground/85">${readout.price.toFixed(4)}</span>
            <span className="text-muted-foreground/60">·</span>
            <span style={{ color: readout.bandCssColor }}>
              {readout.sign}
              {readout.bps} bps
            </span>
            <span
              className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
              style={{
                color: readout.bandCssColor,
                backgroundColor: readout.isInBand ? "transparent" : `${readout.bandSvgColor}1a`,
                border: `1px solid ${readout.isInBand ? "var(--color-border)" : readout.bandSvgColor + "55"}`,
              }}
            >
              {readout.bandLabel}
            </span>
          </div>
        ) : null}
      </div>
      {controlledRange ? null : (
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      )}
    </div>
  );

  const legend =
    !hideAnnotationLegend && annotations.length > 0 ? (
      <ChartAnnotationLegend annotations={annotations} numbered />
    ) : null;

  return (
    <ChartCardShell
      embedded={embedded}
      className={cardClassName}
      header={header}
      body={chartBody}
      legend={legend}
    />
  );
}
