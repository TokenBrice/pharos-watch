"use client";

import { useMemo } from "react";
import { Line, ReferenceArea, ReferenceDot, ReferenceLine } from "recharts";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";
import { ChartRangeToggle } from "@/components/chart-primitives/scale-toggle";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import { CHART_BLUE } from "@/lib/chart-colors";
import { computePegYAxis, ewma } from "@/lib/peg-chart-math";
import { formatChartDate, formatUsdPriceAdaptive } from "@shared/lib/format";
import { PEG_BAND_BPS, PEG_BAND_HEX, PEG_BAND_LABELS } from "@shared/lib/classification";
import { DateTooltip, MonoYAxis, useNiceValueAxis } from "@/components/chart-primitives/axes";
import type { ChartDataTableColumn } from "@/components/chart-primitives/data-table";
import { MarketDataChartFigure } from "@/components/chart-primitives/market-data-chart-frame";
import { useMarketDataChartFrame } from "@/components/chart-primitives/use-market-data-chart-window";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";

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
    return {
      label: PEG_BAND_LABELS.inBand,
      cssColor: "var(--color-muted-foreground)",
      svgColor: PEG_BAND_HEX.inBand,
    };
  }
  if (abs <= PEG_BAND_BPS.drift) {
    return { label: PEG_BAND_LABELS.drift, cssColor: PEG_BAND_HEX.drift, svgColor: PEG_BAND_HEX.drift };
  }
  if (abs <= PEG_BAND_BPS.stress) {
    return { label: PEG_BAND_LABELS.stress, cssColor: PEG_BAND_HEX.stress, svgColor: PEG_BAND_HEX.stress };
  }
  return { label: PEG_BAND_LABELS.depeg, cssColor: PEG_BAND_HEX.depeg, svgColor: PEG_BAND_HEX.depeg };
}

function makePriceTickFormatter(step: number): (value: number) => string {
  const decimals = step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4;
  return (value) => `$${value.toFixed(decimals)}`;
}

/** A non-USD peg's USD price: two decimals from $100 (gold), adaptive below. */
function formatUsdPrice(value: number): string {
  return Math.abs(value) >= 100
    ? `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${formatUsdPriceAdaptive(value)}`;
}

/** Just enough decimals to print every tick of a fitted step exactly. */
function makeUsdTickFormatter(step: number): (value: number) => string {
  let decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  while (decimals < 8 && Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) > 1e-6) decimals += 1;
  return (value) => `$${value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

const USD_PRICE_TABLE_COLUMNS: ChartDataTableColumn<{ ts: number; price: number }>[] = [
  PEG_TABLE_COLUMNS[0],
  { id: "price", label: "Price (USD)", format: (row) => formatUsdPrice(row.price) },
];

interface PegDeviationChartProps {
  data: SupplyHistoryPoint[];
  pegCurrency?: string | null;
  controlledRange?: TimeRangeOption;
  cardClassName?: string;
  /** When true, drop the outer Card chrome so the chart can be embedded in a grouped panel. */
  embedded?: boolean;
  /**
   * The live quote and its deviation from the peg reference (what the hero shows).
   * When given, the header reads these; the line stays on daily snapshots.
   */
  current?: { price: number | null; deviationBps: number | null };
}

export function PegDeviationChart({
  data,
  pegCurrency,
  controlledRange,
  cardClassName,
  embedded = false,
  current,
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

  const frame = useMarketDataChartFrame({ chartData, controlledRange });
  const {
    options,
    range,
    setRange,
    visibleData,
    filteredData,
  } = frame;
  // A USD peg's reference is $1 on every day. Other pegs have no dated FX or
  // commodity reference series, so their line is the plain USD price: no par
  // line or peg bands, and an axis fitted to the data.
  const parCharted = pegCurrency === "USD";

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

  const yAxis = useMemo(() => computePegYAxis(visibleData.map((d) => d.price)), [visibleData]);
  const usdPrices = useMemo(() => (parCharted ? [] : visibleData.map((d) => d.price)), [parCharted, visibleData]);
  const usdAxis = useNiceValueAxis(usdPrices, { includeZero: false });
  const usdStep = usdAxis.ticks && usdAxis.ticks.length > 1 ? usdAxis.ticks[1] - usdAxis.ticks[0] : null;
  const formatPriceTick = useMemo(
    () => (parCharted ? makePriceTickFormatter(yAxis.step) : makeUsdTickFormatter(usdStep ?? 0.01)),
    [parCharted, yAxis.step, usdStep],
  );
  const headlinePrice = current ? current.price : filteredData[filteredData.length - 1]?.price ?? null;

  // Header readout: current price + signed bps + named band. The header describes
  // the controlled range's latest observation, not the brushed window, so a brush
  // drag cannot turn an old print into the "current" one.
  const readout = useMemo(() => {
    const last = filteredData[filteredData.length - 1];
    const price = current ? current.price : last?.price;
    const bps = current ? current.deviationBps : last ? Math.round((last.price - 1) * 10_000) : null;
    if (price == null || bps == null) return null;
    const band = classifyDeviation(bps);
    const sign = bps > 0 ? "+" : "";
    return {
      price,
      bps,
      sign,
      bandLabel: band.label,
      bandCssColor: band.cssColor,
      bandSvgColor: band.svgColor,
      isInBand: band.label === "in-band",
    };
  }, [current, filteredData]);

  const dot = useMemo(() => {
    if (visibleData.length === 0) return null;
    const last = visibleData[visibleData.length - 1];
    const bps = Math.round((last.price - 1) * 10_000);
    return { ts: last.ts, price: last.price, svgColor: parCharted ? classifyDeviation(bps).svgColor : CHART_BLUE };
  }, [parCharted, visibleData]);

  if (!pegCurrency) {
    return null;
  }

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


  const renderChart = () => (
    <MarketDataChartFigure
      cardClassName={cardClassName}
      chartData={smoothedData}
      columns={parCharted ? PEG_TABLE_COLUMNS : USD_PRICE_TABLE_COLUMNS}
      embedded={embedded}
      emptyMessage="No price history available"
      frame={frame}
      header={header}
      label={parCharted ? "Peg deviation" : "Price (USD)"}
      variant="line"
    >
          <MonoYAxis
            tickFormatter={formatPriceTick}
            domain={parCharted ? yAxis.domain : usdAxis.domain}
            ticks={parCharted ? yAxis.ticks : usdAxis.ticks}
          />

          {/* Peg severity bands clip at the visible domain so they do not push the axis. */}
          {parCharted ? pegSeverityBands.map((band) => (
            <ReferenceArea
              key={band.id}
              y1={band.y1}
              y2={band.y2}
              fill={band.fill}
              fillOpacity={band.fillOpacity}
              ifOverflow="hidden"
              strokeOpacity={0}
            />
          )) : null}

          {parCharted ? (
            <ReferenceLine
              y={1}
              stroke="var(--color-foreground)"
              strokeOpacity={0.45}
              strokeWidth={1}
            />
          ) : null}

          <DateTooltip
            formatter={(value) => (parCharted ? formatTooltip(Number(value)) : [formatUsdPrice(Number(value)), "Price"])}
          />

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
              tooltipType="none"
            />
          ) : null}

          {dot ? (
            <ReferenceDot
              x={dot.ts}
              y={dot.price}
              r={3.5}
              fill={dot.svgColor}
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
        <DetailSectionTitle as={embedded ? "h3" : "h2"} className={DETAIL_MODULE_TITLE_CLASS}>
          {parCharted ? "Peg deviation" : "Price (USD)"}
        </DetailSectionTitle>
        {!parCharted ? (
          headlinePrice != null ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="pharos-numeric text-lg font-semibold text-foreground">{formatUsdPrice(headlinePrice)}</span>
              <span className="text-2xs text-muted-foreground">Line: daily UTC snapshots</span>
            </div>
          ) : null
        ) : readout ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="pharos-numeric text-lg font-semibold text-foreground">${readout.price.toFixed(4)}</span>
            <span className="pharos-numeric text-xs" style={{ color: readout.bandCssColor }}>
              {readout.sign}
              {readout.bps} bps
            </span>
            <span
              className="rounded-sm px-1.5 py-0.5 text-2xs"
              style={{
                color: readout.bandCssColor,
                backgroundColor: readout.isInBand ? "transparent" : `${readout.bandSvgColor}1a`,
                border: `1px solid ${readout.isInBand ? "var(--color-border)" : readout.bandSvgColor + "55"}`,
              }}
            >
              {readout.bandLabel.charAt(0).toUpperCase() + readout.bandLabel.slice(1).replace("-", " ")}
            </span>
            <span className="text-2xs text-muted-foreground">Line: daily UTC snapshots</span>
          </div>
        ) : null}
      </div>
      {controlledRange ? null : <ChartRangeToggle options={options} value={range} onChange={setRange} />}
    </div>
  );

  return renderChart();
}
