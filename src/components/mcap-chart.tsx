"use client";

import { useMemo } from "react";
import { Area, ReferenceDot } from "recharts";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import { usePreference } from "@/hooks/use-preferences";
import { formatChartDate, formatCurrency } from "@shared/lib/format";
import { CHART_BLUE } from "@/lib/chart-colors";
import { ChartScaleToggle } from "@/components/chart-primitives/scale-toggle";
import { ChartAreaGradient, DateTooltip, MonoYAxis, useSvgId } from "@/components/chart-primitives/axes";
import type { ChartDataTableColumn } from "@/components/chart-primitives/data-table";
import { MarketDataChartFigure } from "@/components/chart-primitives/market-data-chart-frame";
import { computeChartYDomain } from "@/lib/chart-utils";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";
import { useMarketDataChartFrame } from "@/components/chart-primitives/use-market-data-chart-window";

const MCAP_TABLE_COLUMNS: ChartDataTableColumn<{ ts: number; mcap: number }>[] = [
  { id: "date", label: "Date", format: (row) => formatChartDate(row.ts, "short-year") },
  { id: "mcap", label: "Market cap (USD)", format: (row) => formatCurrency(row.mcap) },
];

interface McapChartProps {
  data: SupplyHistoryPoint[];
  stablecoinId: string;
  /**
   * Suppress the inline annotation legend (`<ChartAnnotationLegend>`) below
   * the card. Reference-line markers are still drawn. Used when the chart is
   * paired with `PegDeviationChart` in a side-by-side grid and a single
   * shared legend is rendered by the parent.
   */
  hideAnnotationLegend?: boolean;
  /**
   * When provided, the chart uses this range and hides its internal
   * time-range buttons. Used by `MarketDataSection` to drive both charts
   * from a single header-level selector.
   */
  controlledRange?: TimeRangeOption;
  /** Optional className for the outer `<Card>` (e.g. remove the accent border in grouped layouts). */
  cardClassName?: string;
  /** When true, drop the outer Card chrome so the chart can be embedded in a grouped panel. */
  embedded?: boolean;
}

export function McapChart({
  data,
  stablecoinId,
  hideAnnotationLegend = false,
  controlledRange,
  cardClassName,
  embedded = false,
}: McapChartProps) {
  const mcapGradientId = useSvgId("mcap");
  // Log toggle persisted across visits; gated to `range === "all"` + no active brush.
  const [logScale, setLogScale] = usePreference<boolean>("pharos-chart-log-scale", false);

  const chartData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];

    return data
      .filter((d) => d.circulatingUsd > 0)
      .map((d) => ({
        ts: d.date * 1000,
        mcap: d.circulatingUsd,
      }));
  }, [data]);

  const frame = useMarketDataChartFrame({ chartData, controlledRange, stablecoinId });
  const {
    brushedRange,
    options,
    range,
    setRange,
    visibleData,
  } = frame;

  // Log scale is allowed only on the unbrushed `all` view (multi-year, multi-OOM).
  // Linear stays the default for short ranges where log compresses the signal.
  const logEnabled = range === "all" && !brushedRange;
  const useLog = logEnabled && logScale;

  const yDomain = useMemo<[number, number | "auto"] | [number, number]>(() => {
    if (useLog) {
      let min = Infinity;
      let max = -Infinity;
      for (const d of visibleData) {
        if (d.mcap > 0) {
          if (d.mcap < min) min = d.mcap;
          if (d.mcap > max) max = d.mcap;
        }
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) return [1, 10];
      // Pad by ~10% in log space (one third of a decade roughly = factor 2.15).
      return [min / 1.6, max * 1.4];
    }
    return computeChartYDomain(
      visibleData.map((d) => d.mcap),
      range === "all",
    );
  }, [range, visibleData, useLog]);

  // Header readout: current mcap + 24h delta (anchor on the previous point — daily data).
  const readout = useMemo(() => {
    if (visibleData.length === 0) return null;
    const last = visibleData[visibleData.length - 1];
    const prev = visibleData.length >= 2 ? visibleData[visibleData.length - 2] : null;
    const delta = prev && prev.mcap > 0 ? (last.mcap - prev.mcap) / prev.mcap : null;
    return {
      mcap: last.mcap,
      ts: last.ts,
      deltaPct: delta == null ? null : delta * 100,
    };
  }, [visibleData]);

  const deltaColor =
    readout?.deltaPct == null
      ? "var(--color-muted-foreground)"
      : readout.deltaPct > 0
        ? "#22c55e"
        : readout.deltaPct < 0
          ? "#ef4444"
          : "var(--color-muted-foreground)";

  const header = (
    <div className="flex flex-row items-center justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>Market Cap</StablecoinModuleTitle>
        {readout ? (
          <div className="flex items-baseline gap-2 font-mono text-xs tabular-nums">
            <span className="text-foreground/85">{formatCurrency(readout.mcap)}</span>
            {readout.deltaPct != null ? (
              <>
                <span aria-hidden="true" className="text-muted-foreground/60">
                  ·
                </span>
                <span style={{ color: deltaColor }}>
                  {readout.deltaPct > 0 ? "+" : ""}
                  {readout.deltaPct.toFixed(2)}% 24h
                </span>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <ChartScaleToggle
          value={useLog ? "log" : "lin"}
          onChange={(v) => setLogScale(v === "log")}
          disabled={!logEnabled}
          disabledTitle={
            brushedRange
              ? "Log scale is only available on the full range — clear the brush to enable."
              : "Log scale is only meaningful on the full range — switch to All."
          }
        />
        {controlledRange ? null : <TimeRangeButtons options={options} value={range} onChange={setRange} />}
      </div>
    </div>
  );

  return (
    <MarketDataChartFigure
      cardClassName={cardClassName}
      columns={MCAP_TABLE_COLUMNS}
      embedded={embedded}
      emptyMessage="No market cap data available"
      frame={frame}
      header={header}
      hideAnnotationLegend={hideAnnotationLegend}
      label="Market cap"
      beforeAxes={
        <defs>
          <ChartAreaGradient id={mcapGradientId} color={CHART_BLUE} />
        </defs>
      }
      variant="area"
    >
          <MonoYAxis
            tickFormatter={(val: number) => formatCurrency(val)}
            domain={yDomain}
            scale={useLog ? "log" : "auto"}
            allowDataOverflow={useLog}
          />
          <DateTooltip formatter={(value) => [formatCurrency(Number(value)), "Market Cap"]} />
          <Area
            type="monotone"
            dataKey="mcap"
            stroke={CHART_BLUE}
            fill={`url(#${mcapGradientId})`}
            strokeWidth={2}
            isAnimationActive={false}
          />
          {readout ? (
            <ReferenceDot
              x={readout.ts}
              y={readout.mcap}
              r={3.5}
              fill={CHART_BLUE}
              stroke="var(--color-background)"
              strokeWidth={1.5}
              ifOverflow="extendDomain"
            />
          ) : null}
    </MarketDataChartFigure>
  );
}
