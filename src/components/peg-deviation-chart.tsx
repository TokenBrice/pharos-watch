"use client";

import { useMemo } from "react";
import { Line, ReferenceArea, ReferenceDot, ReferenceLine } from "recharts";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import { CHART_BLUE } from "@/lib/chart-colors";
import { computePegYAxis, ewma } from "@/lib/peg-chart-math";
import { formatChartDate } from "@shared/lib/format";
import { AnnotationDensityStrip } from "@/components/chart-primitives/annotations";
import { DateTooltip, MonoYAxis } from "@/components/chart-primitives/axes";
import type { ChartDataTableColumn } from "@/components/chart-primitives/data-table";
import { MarketDataChartFigure } from "@/components/chart-primitives/market-data-chart-frame";
import { useMarketDataChartFrame } from "@/components/chart-primitives/use-market-data-chart-window";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";
import { useChartAnnotations } from "@/hooks/use-chart-annotations";

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
const PEG_TABLE_COLUMNS: ChartDataTableColumn<{ ts: number; price: number }>[] = [
  { id: "date", label: "Date", format: (row) => formatChartDate(row.ts, "short-year") },
  { id: "price", label: "Price (USD)", format: (row) => `$${row.price.toFixed(6)}` },
  {
    id: "deviation",
    label: "Deviation (bps)",
    format: (row) => {
      const bps = Math.round((row.price - 1) * 10000);
      return `${bps > 0 ? "+" : ""}${bps}`;
    },
  },
];

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

function makePriceTickFormatter(step: number): (value: number) => string {
  const decimals = step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4;
  return (value) => `$${value.toFixed(decimals)}`;
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

  const frame = useMarketDataChartFrame({ chartData, controlledRange, stablecoinId });
  const {
    filteredData,
    options,
    plotInsetLeft,
    plotInsetRight,
    range,
    setRange,
    visibleData,
    width,
    xDomain,
  } = frame;

  // Apply EWMA smoothing at long ranges where daily ticks compress into static.
  // `priceSmoothed` is plotted on top of the raw `price` line (which is dimmed).
  const smoothedData = useMemo(() => {
    if (range !== "all" && range !== "1y") {
      return visibleData.map((d) => ({ ...d, priceSmoothed: null as number | null }));
    }
    const alpha = range === "all" ? 0.04 : 0.12;
    const smoothed = ewma(
      visibleData.map((d) => d.price),
      alpha,
    );
    return visibleData.map((d, i) => ({ ...d, priceSmoothed: smoothed[i] }));
  }, [visibleData, range]);

  const showSmoothed = range === "all" || range === "1y";

  // D14 — wider annotation set (the full controlled range, not brushed) for
  // the density strip. The strip reflects *available* events for the active
  // range, so brushing into a sub-window still surfaces the parent's cadence.
  const fullRangeFromMs = filteredData[0]?.ts ?? null;
  const fullRangeToMs = filteredData[filteredData.length - 1]?.ts ?? null;
  const { data: fullRangeAnnotations } = useChartAnnotations(stablecoinId, fullRangeFromMs, fullRangeToMs);

  const yAxis = useMemo(() => computePegYAxis(visibleData.map((d) => d.price)), [visibleData]);
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

  if (pegCurrency !== "USD") {
    return null;
  }

  // Available plot-area width inside the chart's left axis + right margin.
  // Used by the density strip so its bars share the x-pixel domain.
  const plotAreaWidth = Math.max(0, width - plotInsetLeft - plotInsetRight);
  const pegSeverityBands = [
    {
      id: "drift-above",
      y1: bpsToPrice(PEG_BAND_BPS.tight),
      y2: bpsToPrice(PEG_BAND_BPS.drift),
      fill: PEG_BAND_HEX.drift,
      fillOpacity: 0.06,
    },
    {
      id: "drift-below",
      y1: bpsToPrice(-PEG_BAND_BPS.drift),
      y2: bpsToPrice(-PEG_BAND_BPS.tight),
      fill: PEG_BAND_HEX.drift,
      fillOpacity: 0.06,
    },
    {
      id: "stress-above",
      y1: bpsToPrice(PEG_BAND_BPS.drift),
      y2: bpsToPrice(PEG_BAND_BPS.stress),
      fill: PEG_BAND_HEX.stress,
      fillOpacity: 0.07,
    },
    {
      id: "stress-below",
      y1: bpsToPrice(-PEG_BAND_BPS.stress),
      y2: bpsToPrice(-PEG_BAND_BPS.drift),
      fill: PEG_BAND_HEX.stress,
      fillOpacity: 0.07,
    },
    {
      id: "depeg-above",
      y1: bpsToPrice(PEG_BAND_BPS.stress),
      y2: yAxis.domain[1],
      fill: PEG_BAND_HEX.depeg,
      fillOpacity: 0.08,
    },
    {
      id: "depeg-below",
      y1: yAxis.domain[0],
      y2: bpsToPrice(-PEG_BAND_BPS.stress),
      fill: PEG_BAND_HEX.depeg,
      fillOpacity: 0.08,
    },
  ] as const;

  const densityStrip =
    showDensityStrip && xDomain ? (
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
    ) : null;

  const renderChart = () => (
    <MarketDataChartFigure
      cardClassName={cardClassName}
      chartData={smoothedData}
      columns={PEG_TABLE_COLUMNS}
      embedded={embedded}
      emptyMessage="No price history available"
      frame={frame}
      header={header}
      hideAnnotationLegend={hideAnnotationLegend}
      label="Peg deviation"
      overlay={densityStrip}
      variant="line"
    >
          <MonoYAxis tickFormatter={formatPriceTick} domain={yAxis.domain} ticks={yAxis.ticks} />

          {/* Peg severity bands clip at the visible domain so they do not push the axis. */}
          {pegSeverityBands.map((band) => (
            <ReferenceArea
              key={band.id}
              y1={band.y1}
              y2={band.y2}
              fill={band.fill}
              fillOpacity={band.fillOpacity}
              ifOverflow="hidden"
              strokeOpacity={0}
            />
          ))}

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
              stroke="var(--color-background)"
              strokeWidth={1.5}
              ifOverflow="extendDomain"
            />
          ) : null}
    </MarketDataChartFigure>
  );

  const header = (
    <div className="flex flex-row items-center justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>Peg Deviation</DetailSectionTitle>
        {readout ? (
          <div className="flex items-baseline gap-2 font-mono text-xs tabular-nums">
            <span className="text-foreground/85">${readout.price.toFixed(4)}</span>
            <span aria-hidden="true" className="text-muted-foreground/60">
              ·
            </span>
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
      {controlledRange ? null : <TimeRangeButtons options={options} value={range} onChange={setRange} />}
    </div>
  );

  return renderChart();
}
