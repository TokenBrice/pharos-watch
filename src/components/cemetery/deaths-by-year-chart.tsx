"use client";

import { useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { CAUSE_META, CAUSE_ORDER } from "@shared/lib/cause-of-death";
import { ChartDataTable, type ChartDataTableColumn } from "@/components/chart-primitives/data-table";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { PharosChartTooltip, TooltipLabel } from "@/components/pharos-chart-tooltip";
import { CAUSE_BG_CLASS, CAUSE_TEXT_FILL_CLASS, causeColorVars } from "@/lib/cemetery-cause-style";
import { cn } from "@/lib/utils";
import styles from "./cemetery-below-fold.module.css";

/** One year of chart B. Arrays follow `CAUSE_ORDER`. */
export interface DeathsByYearDatum {
  year: number;
  total: number;
  counts: number[];
  /** Tracked-archive records per cause; each at most `counts[i]`. */
  tracked: number[];
  /** Formatted median recorded peak; null when the year has no recorded peak (or no records). */
  medianPeakLabel: string | null;
  partial: boolean;
}

type BarMode = "count" | "share";

const MODE_OPTIONS = [
  { value: "count", label: "Count" },
  { value: "share", label: "Share" },
] as const satisfies readonly { value: BarMode; label: string }[];

const PLOT_HEIGHT = 224;
/** Headroom above the tallest bar for its total and the partial-year outline. */
const TOP_PAD = 30;
const BASELINE = PLOT_HEIGHT;
const PLOT_SPAN = BASELINE - TOP_PAD;
const BAR_WIDTH_RATIO = 0.6;
const STEP_CANDIDATES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
const SHARE_TICKS = [0, 0.25, 0.5, 0.75, 1];

function pct(value: number): string {
  return `${Math.round(value * 1000) / 1000}%`;
}

function countTicks(max: number): number[] {
  const safeMax = Math.max(1, max);
  const step = STEP_CANDIDATES.find((candidate) => Math.ceil(safeMax / candidate) <= 4) ?? Math.ceil(safeMax / 4);
  const top = step * Math.ceil(safeMax / step);
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  return ticks;
}

interface Segment {
  causeIndex: number;
  y: number;
  height: number;
  hatchHeight: number;
}

interface YearGeometry {
  datum: DeathsByYearDatum;
  center: number;
  barX: number;
  barWidth: number;
  columnX: number;
  columnWidth: number;
  top: number;
  segments: Segment[];
}

function buildGeometry(years: readonly DeathsByYearDatum[], mode: BarMode) {
  const maxTotal = years.reduce((max, year) => Math.max(max, year.total), 0);
  const ticks = mode === "share" ? SHARE_TICKS : countTicks(maxTotal);
  const domainMax = ticks[ticks.length - 1] || 1;
  const columnWidth = 100 / Math.max(1, years.length);
  const barWidth = columnWidth * BAR_WIDTH_RATIO;
  const scale = (value: number) => (value / domainMax) * PLOT_SPAN;

  const bars: YearGeometry[] = years.map((datum, index) => {
    const center = (index + 0.5) * columnWidth;
    let cursor = BASELINE;
    const segments: Segment[] = [];
    if (datum.total > 0) {
      datum.counts.forEach((count, causeIndex) => {
        if (count <= 0) return;
        const height = scale(mode === "share" ? count / datum.total : count);
        cursor -= height;
        const trackedCount = Math.min(count, Math.max(0, datum.tracked[causeIndex] ?? 0));
        segments.push({ causeIndex, y: cursor, height, hatchHeight: (height * trackedCount) / count });
      });
    }
    return {
      datum,
      center,
      barX: center - barWidth / 2,
      barWidth,
      columnX: index * columnWidth,
      columnWidth,
      top: cursor,
      segments,
    };
  });

  return {
    bars,
    ticks: ticks.map((value) => ({
      value,
      y: BASELINE - scale(value),
      label: mode === "share" ? `${Math.round(value * 100)}%` : String(value),
    })),
  };
}

function yearSummary(datum: DeathsByYearDatum, asOfLabel: string): string {
  if (datum.total === 0) return `${datum.year}: none recorded`;
  return `${datum.year}: ${datum.total}${datum.partial ? ` through ${asOfLabel}` : ""}`;
}

function buildColumns(asOfLabel: string): ChartDataTableColumn<DeathsByYearDatum>[] {
  return [
    {
      id: "year",
      label: "Year",
      format: (row) => (row.partial ? `${row.year} (through ${asOfLabel})` : String(row.year)),
    },
    { id: "total", label: "Total", format: (row) => String(row.total) },
    ...CAUSE_ORDER.map((cause, causeIndex) => ({
      id: cause,
      label: CAUSE_META[cause].label,
      format: (row: DeathsByYearDatum) => String(row.counts[causeIndex] ?? 0),
    })),
    {
      id: "tracked",
      label: "Tracked archive",
      format: (row) => String(row.tracked.reduce((sum, value) => sum + value, 0)),
    },
    {
      id: "median",
      label: "Median peak",
      format: (row) => (row.total === 0 ? "no records" : (row.medianPeakLabel ?? "not recorded")),
    },
  ];
}

function tooltipAlignClass(center: number): string {
  if (center < 18) return "translate-x-[-12%]";
  if (center > 82) return "-translate-x-[88%]";
  return "-translate-x-1/2";
}

export function DeathsByYearChart({
  years,
  asOfLabel,
  titleId,
  header,
  footnote,
}: {
  years: readonly DeathsByYearDatum[];
  /** "Aug 27, 2026": where the partial year stops. */
  asOfLabel: string;
  /** Id of the card's `<h3>` (inside `header`). */
  titleId: string;
  header: ReactNode;
  footnote: ReactNode;
}) {
  const [mode, setMode] = useState<BarMode>("count");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const hatchId = `cemetery-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const geometry = useMemo(() => buildGeometry(years, mode), [years, mode]);
  const columns = useMemo(() => buildColumns(asOfLabel), [asOfLabel]);
  const first = years[0]?.year;
  const last = years[years.length - 1]?.year;
  const ariaLabel = `Documented deaths per year by cause, ${first} to ${last}, ${mode === "share" ? "as a share of each year" : "as counts"}. ${years
    .map((datum) => yearSummary(datum, asOfLabel))
    .join(", ")}.`;
  const gridStyle = { "--year-count": years.length } as CSSProperties;
  const hovered = hoverIndex === null ? null : geometry.bars[hoverIndex];

  return (
    <article aria-labelledby={titleId} className="pharos-card-shell p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 max-w-3xl">{header}</div>
        <ControlPillToggle
          options={MODE_OPTIONS}
          value={mode}
          onChange={setMode}
          ariaLabel="Bar values"
          className="flex shrink-0 gap-1 self-start"
          buttonClassName="min-h-8 px-3 py-1"
        />
      </div>

      <div className="mt-5">
        <div className="flex">
          <svg aria-hidden="true" className="w-9 shrink-0 overflow-visible sm:w-14" height={PLOT_HEIGHT + 1}>
            {geometry.ticks.map((tick) => (
              <text
                key={tick.value}
                x="100%"
                dx={-8}
                y={tick.y}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground font-mono text-[11px]"
              >
                {tick.label}
              </text>
            ))}
          </svg>
          <div className="relative min-w-0 flex-1" onPointerLeave={() => setHoverIndex(null)}>
            <svg role="img" aria-label={ariaLabel} width="100%" height={PLOT_HEIGHT + 1} className="block overflow-visible">
              <defs>
                <pattern id={hatchId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="1.6" height="4" className="fill-card" opacity={0.75} />
                </pattern>
              </defs>
              <g aria-hidden="true">
                {geometry.ticks.map((tick) =>
                  tick.value === 0 ? null : (
                    <line
                      key={tick.value}
                      x1="0"
                      x2="100%"
                      y1={tick.y}
                      y2={tick.y}
                      className="stroke-border"
                      strokeDasharray="2 6"
                    />
                  ),
                )}
                <line x1="0" x2="100%" y1={BASELINE + 0.5} y2={BASELINE + 0.5} className="stroke-border" />
              </g>
              {geometry.bars.map((bar, index) => {
                const { datum } = bar;
                const dimmed = hoverIndex !== null && hoverIndex !== index;
                return (
                  <g key={datum.year} className={cn("transition-opacity", dimmed && "opacity-55")}>
                    {bar.segments.map((segment) => {
                      const cause = CAUSE_ORDER[segment.causeIndex];
                      return (
                        <g key={cause} style={causeColorVars(cause)}>
                          <rect
                            x={pct(bar.barX)}
                            y={segment.y}
                            width={pct(bar.barWidth)}
                            height={Math.max(0, segment.height)}
                            rx={2}
                            className={cn(CAUSE_TEXT_FILL_CLASS, "stroke-card")}
                            strokeWidth={1}
                          />
                          {segment.hatchHeight > 0 ? (
                            <rect
                              data-hatch="tracked"
                              x={pct(bar.barX)}
                              y={segment.y}
                              width={pct(bar.barWidth)}
                              height={segment.hatchHeight}
                              rx={2}
                              fill={`url(#${hatchId})`}
                            />
                          ) : null}
                        </g>
                      );
                    })}
                    {datum.partial && datum.total > 0 ? (
                      <rect
                        data-partial-outline=""
                        x={pct(bar.barX - bar.columnWidth * 0.07)}
                        y={bar.top - 24}
                        width={pct(bar.barWidth + bar.columnWidth * 0.14)}
                        height={BASELINE - bar.top + 24}
                        rx={4}
                        fill="none"
                        className="stroke-muted-foreground"
                        strokeDasharray="3 3"
                      />
                    ) : null}
                    {datum.total > 0 ? (
                      <text
                        x={pct(bar.center)}
                        y={bar.top - 7}
                        textAnchor="middle"
                        className="fill-foreground font-mono text-[11px] font-semibold"
                      >
                        {datum.total}
                      </text>
                    ) : (
                      <g data-empty-year={datum.year} className="fill-muted-foreground font-mono text-[10px]">
                        {/* Phones: a dash, since "none" would touch its neighbour in the narrow columns; the footnote names the years. */}
                        <text x={pct(bar.center)} y={BASELINE - 7} textAnchor="middle" className="sm:hidden">
                          –
                        </text>
                        <text x={pct(bar.center)} y={BASELINE - 22} textAnchor="middle" className="hidden sm:inline">
                          <tspan x={pct(bar.center)}>none</tspan>{" "}
                          <tspan x={pct(bar.center)} dy="1.2em">
                            recorded
                          </tspan>
                        </text>
                      </g>
                    )}
                    <rect
                      x={pct(bar.columnX)}
                      y={0}
                      width={pct(bar.columnWidth)}
                      height={PLOT_HEIGHT}
                      fill="transparent"
                      onPointerEnter={() => setHoverIndex(index)}
                    />
                  </g>
                );
              })}
            </svg>
            {hovered ? (
              <div
                aria-hidden="true"
                style={{ "--tip-x": pct(hovered.center), "--tip-y": `${Math.min(hovered.top, BASELINE - 24)}px` } as CSSProperties}
                className={cn(
                  "pointer-events-none absolute left-[var(--tip-x)] top-[var(--tip-y)] z-10 w-max max-w-64 -translate-y-full pb-3",
                  tooltipAlignClass(hovered.center),
                )}
              >
                <PharosChartTooltip active>
                  <TooltipLabel>
                    {hovered.datum.year}
                    {hovered.datum.partial ? ` · through ${asOfLabel}` : ""}
                  </TooltipLabel>
                  {hovered.datum.total === 0 ? (
                    <p className="text-xs text-muted-foreground">No records exist for this year.</p>
                  ) : (
                    <div className="space-y-1">
                      {CAUSE_ORDER.map((cause, causeIndex) => {
                        const count = hovered.datum.counts[causeIndex] ?? 0;
                        if (count === 0) return null;
                        const trackedCount = hovered.datum.tracked[causeIndex] ?? 0;
                        return (
                          <div key={cause} className="flex items-center justify-between gap-4 text-xs">
                            <span className="flex items-center gap-1.5 text-muted-foreground">
                              <span
                                className={cn("inline-block size-2 shrink-0 rounded-full", CAUSE_BG_CLASS)}
                                style={causeColorVars(cause)}
                              />
                              {CAUSE_META[cause].label}
                            </span>
                            <span className="font-mono tabular-nums text-foreground">
                              {count}
                              {trackedCount > 0 ? <span className="text-muted-foreground"> ({trackedCount} tracked)</span> : null}
                            </span>
                          </div>
                        );
                      })}
                      <div className="mt-1.5 flex justify-between gap-4 border-t border-border/60 pt-1.5 text-xs">
                        <span className="text-muted-foreground">Total</span>
                        <span className="font-mono font-semibold tabular-nums text-foreground">{hovered.datum.total}</span>
                      </div>
                      <div className="flex justify-between gap-4 text-xs">
                        <span className="text-muted-foreground">Median peak</span>
                        <span className="font-mono tabular-nums text-foreground">{hovered.datum.medianPeakLabel ?? "n/r"}</span>
                      </div>
                    </div>
                  )}
                </PharosChartTooltip>
              </div>
            ) : null}
          </div>
        </div>

        <div aria-hidden="true" className="mt-2 flex font-mono text-[11px]">
          <span className="w-9 shrink-0 sm:w-14" />
          <div style={gridStyle} className="grid min-w-0 flex-1 grid-cols-[repeat(var(--year-count),minmax(0,1fr))]">
            {years.map((datum) => (
              <span
                key={datum.year}
                data-year-label={datum.year}
                className={cn("text-center", datum.partial ? "font-semibold text-foreground" : "text-foreground/80")}
              >
                <span className="hidden sm:inline">{datum.year}</span>
                <span className="sm:hidden">&apos;{String(datum.year).slice(-2)}</span>
                {datum.partial ? "*" : null}
              </span>
            ))}
          </div>
        </div>
        <div aria-hidden="true" className="mt-1.5 hidden font-mono text-[11px] text-muted-foreground sm:flex">
          <span className="w-14 shrink-0">median</span>
          <div style={gridStyle} className="grid min-w-0 flex-1 grid-cols-[repeat(var(--year-count),minmax(0,1fr))]">
            {years.map((datum) => (
              <span key={datum.year} className="text-center tabular-nums">
                {datum.total === 0 ? "" : (datum.medianPeakLabel ?? "n/r")}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 space-y-3">
        <div>{footnote}</div>
        <details className="group">
          <summary className="pharos-focus-ring w-fit cursor-pointer rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground">
            Data table
          </summary>
          <ChartDataTable
            srOnly={false}
            className={cn(styles.dataTable, "mt-2 overflow-x-auto")}
            caption={`Documented deaths per year by cause, ${first} to ${last}, with tracked-archive records and the median recorded peak market cap.`}
            data={years}
            columns={columns}
          />
        </details>
      </div>
    </article>
  );
}
