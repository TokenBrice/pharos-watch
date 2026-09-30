"use client";

import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { CAUSE_META, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { ChartDataTable, type ChartDataTableColumn } from "@/components/chart-primitives/data-table";
import { PharosChartTooltip, TooltipLabel } from "@/components/pharos-chart-tooltip";
import { useCemeterySelection } from "@/components/cemetery/cemetery-selection-context";
import { CAUSE_BG_CLASS, CAUSE_TEXT_FILL_CLASS, causeColorVars } from "@/lib/cemetery-cause-style";
import { cn } from "@/lib/utils";
import styles from "./cemetery-below-fold.module.css";

export interface PeakDotDatum {
  id: string;
  name: string;
  symbol: string;
  peak: number;
  peakLabel: string;
  dateLabel: string;
  /** Global top five by peak. */
  labelled: boolean;
}

/** One cause lane: recorded peaks only, peak descending. */
export interface PeakLaneDatum {
  cause: CauseOfDeath;
  medianPeak: number | null;
  medianLabel: string | null;
  n: number;
  unrecordedCount: number;
  dots: PeakDotDatum[];
}

/** Fixed log domain; widened only if a recorded peak falls outside it (never clamped). */
const DOMAIN_MIN = 300_000;
const DOMAIN_MAX = 40_000_000_000;
/** Inset so edge dots are not clipped by the plot edge. */
const X_INSET = 2;
const LANE_HEIGHT = 64;
/** Top band of each lane that carries the in-plot lane label below `lg`. */
const LANE_LABEL_BAND = 18;
const LANE_CENTER = LANE_LABEL_BAND + 22;
const JITTER = 14;
const LABELLED_JITTER = 5;
const DOT_RADIUS = 5;
const LABELLED_RADIUS = 7.5;
const HIT_RADIUS = 11;
const AXIS_HEIGHT = 28;
/** Labels right of this x% flip inward so they stay inside the plot. */
const LABEL_FLIP_PCT = 86;
/** Narrow widths: labels above dots right of this x% end-align so they stay inside the plot. */
const LABEL_ABOVE_END_PCT = 90;

/** FNV-1a 32-bit hash of the record id, mapped to [-1, 1]: deterministic jitter without `Math.random`. */
function jitterUnit(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) / 0xffffffff) * 2 - 1;
}

function tickLabel(value: number): string {
  if (value >= 1e12) return `$${value / 1e12}T`;
  if (value >= 1e9) return `$${value / 1e9}B`;
  if (value >= 1e6) return `$${value / 1e6}M`;
  if (value >= 1e3) return `$${value / 1e3}K`;
  return `$${value}`;
}

function gutterLabel(lane: PeakLaneDatum): string {
  return `med ${lane.medianLabel ?? "n/r"} · n=${lane.n}${unrecordedLabel(lane)}`;
}

function unrecordedLabel(lane: PeakLaneDatum): string {
  return lane.unrecordedCount > 0 ? ` (+${lane.unrecordedCount} n/r)` : "";
}

interface PlacedDot {
  dot: PeakDotDatum;
  cause: CauseOfDeath;
  laneIndex: number;
  indexInLane: number;
  x: number;
  y: number;
  r: number;
}

function buildGeometry(lanes: readonly PeakLaneDatum[]) {
  let min = DOMAIN_MIN;
  let max = DOMAIN_MAX;
  for (const lane of lanes) {
    for (const dot of lane.dots) {
      if (dot.peak < min) min = dot.peak;
      if (dot.peak > max) max = dot.peak;
    }
  }
  const logMin = Math.log10(min);
  const logMax = Math.log10(max);
  const x = (value: number) => X_INSET + ((Math.log10(value) - logMin) / (logMax - logMin)) * (100 - 2 * X_INSET);

  const ticks: { value: number; x: number }[] = [];
  for (let exponent = Math.ceil(logMin); exponent <= Math.floor(logMax); exponent += 1) {
    const value = 10 ** exponent;
    ticks.push({ value, x: x(value) });
  }

  // Keyboard order: lane (CAUSE_ORDER), then peak descending.
  const dots: PlacedDot[] = [];
  const laneStart: number[] = [];
  lanes.forEach((lane, laneIndex) => {
    laneStart.push(dots.length);
    const center = laneIndex * LANE_HEIGHT + LANE_CENTER;
    lane.dots.forEach((dot, indexInLane) => {
      const unit = jitterUnit(dot.id);
      dots.push({
        dot,
        cause: lane.cause,
        laneIndex,
        indexInLane,
        x: x(dot.peak),
        // Labelled dots only drop below the lane line: their symbol above the dot stays clear of the lane label.
        y: center + (dot.labelled ? Math.abs(unit) * LABELLED_JITTER : unit * JITTER),
        r: dot.labelled ? LABELLED_RADIUS : DOT_RADIUS,
      });
    });
  });

  return {
    dots,
    laneStart,
    ticks,
    medians: lanes.map((lane) => (lane.medianPeak === null ? null : x(lane.medianPeak))),
  };
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 1000}%`;
}

const COLUMNS: ChartDataTableColumn<PeakLaneDatum>[] = [
  { id: "cause", label: "Cause", format: (lane) => CAUSE_META[lane.cause].label },
  { id: "plotted", label: "Recorded peaks", format: (lane) => String(lane.n) },
  { id: "unrecorded", label: "Not recorded", format: (lane) => String(lane.unrecordedCount) },
  { id: "median", label: "Median peak", format: (lane) => lane.medianLabel ?? "not recorded" },
  {
    id: "largest",
    label: "Largest",
    format: (lane) => (lane.dots[0] ? `${lane.dots[0].symbol} ${lane.dots[0].peakLabel}` : "not recorded"),
  },
];

export function PeakByCauseChart({
  lanes,
  titleId,
  header,
  footnote,
}: {
  lanes: readonly PeakLaneDatum[];
  /** Id of the card's `<h3>` (inside `header`). */
  titleId: string;
  header: ReactNode;
  footnote: ReactNode;
}) {
  const { revealRecord } = useCemeterySelection();
  const geometry = useMemo(() => buildGeometry(lanes), [lanes]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const dotRefs = useRef<(SVGGElement | null)[]>([]);
  const plotHeight = lanes.length * LANE_HEIGHT;
  const height = plotHeight + AXIS_HEIGHT;
  const { dots } = geometry;
  const tipIndex = hoverIndex ?? focusIndex;
  const tip = tipIndex === null ? null : dots[tipIndex];

  const moveTo = (index: number) => {
    setActiveIndex(index);
    dotRefs.current[index]?.focus();
  };

  const nearestInLane = (laneIndex: number, peak: number): number | null => {
    const lane = lanes[laneIndex];
    if (!lane || lane.dots.length === 0) return null;
    let best = 0;
    for (let index = 1; index < lane.dots.length; index += 1) {
      if (Math.abs(Math.log10(lane.dots[index].peak / peak)) < Math.abs(Math.log10(lane.dots[best].peak / peak))) best = index;
    }
    return geometry.laneStart[laneIndex] + best;
  };

  const handleKeyDown = (event: KeyboardEvent<SVGGElement>, index: number) => {
    const current = dots[index];
    let next: number | null = null;
    switch (event.key) {
      case "Enter":
      case " ":
        event.preventDefault();
        revealRecord(current.dot.id, "chart");
        return;
      case "ArrowRight":
        // Larger peak (lane dots are peak descending).
        next = current.indexInLane > 0 ? index - 1 : null;
        break;
      case "ArrowLeft":
        next = current.indexInLane < lanes[current.laneIndex].dots.length - 1 ? index + 1 : null;
        break;
      case "ArrowDown":
      case "ArrowUp": {
        const step = event.key === "ArrowDown" ? 1 : -1;
        for (let lane = current.laneIndex + step; lane >= 0 && lane < lanes.length && next === null; lane += step) {
          next = nearestInLane(lane, current.dot.peak);
        }
        break;
      }
      case "Home":
        next = 0;
        break;
      case "End":
        next = dots.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next !== null) moveTo(next);
  };

  const plotted = dots.length;
  const ariaLabel = `Peak market cap by cause on a log scale: ${plotted} deaths with a recorded peak in ${lanes.length} cause lanes. Select a dot to open its row in the register.`;

  return (
    <article aria-labelledby={titleId} className="pharos-card-shell p-4 sm:p-6">
      <div className="min-w-0 max-w-3xl">{header}</div>

      {plotted === 0 ? (
        <p className="pharos-empty-note mt-5">No record has a recorded peak market cap.</p>
      ) : (
        <div className="mt-5 flex">
          <div aria-hidden="true" className="hidden w-44 shrink-0 pr-4 lg:block">
            {lanes.map((lane) => (
              <div key={lane.cause} className="flex h-16 items-center justify-end pt-4 text-right text-sm text-foreground">
                {CAUSE_META[lane.cause].label}
              </div>
            ))}
          </div>

          <div className="relative min-w-0 flex-1" onPointerLeave={() => setHoverIndex(null)}>
            <svg role="group" aria-label={ariaLabel} width="100%" height={height} className="block overflow-visible">
              <g aria-hidden="true">
                {geometry.ticks.map((tick) => (
                  <line
                    key={tick.value}
                    x1={pct(tick.x)}
                    x2={pct(tick.x)}
                    y1={0}
                    y2={plotHeight}
                    className="stroke-border"
                    strokeDasharray="2 6"
                  />
                ))}
                {lanes.map((lane, laneIndex) => (
                  <line
                    key={lane.cause}
                    x1="0"
                    x2="100%"
                    y1={laneIndex * LANE_HEIGHT + LANE_CENTER}
                    y2={laneIndex * LANE_HEIGHT + LANE_CENTER}
                    className="stroke-border"
                    strokeOpacity={0.7}
                  />
                ))}
                {geometry.ticks.map((tick) => (
                  <text
                    key={tick.value}
                    x={pct(tick.x)}
                    y={plotHeight + 18}
                    textAnchor="middle"
                    className="fill-muted-foreground font-mono text-[11px]"
                  >
                    {tickLabel(tick.value)}
                  </text>
                ))}
                {lanes.map((lane, laneIndex) => (
                  <text key={lane.cause} x={0} y={laneIndex * LANE_HEIGHT + 12} className="lg:hidden">
                    <tspan className="fill-foreground text-xs font-medium">{CAUSE_META[lane.cause].label}</tspan>
                    <tspan dx={6} className="fill-muted-foreground font-mono text-[10.5px]">
                      {`med ${lane.medianLabel ?? "n/r"} · n=${lane.n}`}
                      {/* The unrecorded count would run past the plot on phones; the footnote and data table carry it. */}
                      {lane.unrecordedCount > 0 ? <tspan className="hidden sm:inline">{unrecordedLabel(lane)}</tspan> : null}
                    </tspan>
                  </text>
                ))}
              </g>

              {lanes.map((lane, laneIndex) => (
                <g
                  key={lane.cause}
                  role="group"
                  aria-label={`${CAUSE_META[lane.cause].label}: ${lane.n} recorded peaks, median ${lane.medianLabel ?? "not recorded"}`}
                  style={causeColorVars(lane.cause)}
                >
                  {dots.map((placed, index) => {
                    if (placed.laneIndex !== laneIndex) return null;
                    const { dot } = placed;
                    const focused = focusIndex === index;
                    const hovered = hoverIndex === index;
                    return (
                      <g
                        key={dot.id}
                        ref={(node) => {
                          dotRefs.current[index] = node;
                        }}
                        role="button"
                        tabIndex={index === activeIndex ? 0 : -1}
                        aria-label={`${dot.name} (${dot.symbol}), ${dot.peakLabel}, ${dot.dateLabel}`}
                        data-dot-id={dot.id}
                        className="cursor-pointer outline-none"
                        onClick={() => {
                          setActiveIndex(index);
                          revealRecord(dot.id, "chart");
                        }}
                        onKeyDown={(event) => handleKeyDown(event, index)}
                        onFocus={() => {
                          setActiveIndex(index);
                          setFocusIndex(index);
                        }}
                        onBlur={() => setFocusIndex((currentFocus) => (currentFocus === index ? null : currentFocus))}
                        onPointerEnter={(event) => {
                          if (event.pointerType === "mouse") setHoverIndex(index);
                        }}
                      >
                        <circle cx={pct(placed.x)} cy={placed.y} r={HIT_RADIUS} fill="transparent" />
                        {focused ? (
                          <circle
                            cx={pct(placed.x)}
                            cy={placed.y}
                            r={placed.r + 3.5}
                            fill="none"
                            className="stroke-foreground"
                            strokeWidth={2}
                          />
                        ) : null}
                        <circle
                          cx={pct(placed.x)}
                          cy={placed.y}
                          r={hovered ? placed.r + 1.5 : placed.r}
                          className={cn(CAUSE_TEXT_FILL_CLASS, "stroke-card")}
                          fillOpacity={dot.labelled ? 1 : 0.88}
                          strokeWidth={1}
                        />
                      </g>
                    );
                  })}
                </g>
              ))}

              <g aria-hidden="true" className="pointer-events-none">
                {geometry.medians.map((median, laneIndex) =>
                  median === null ? null : (
                    <line
                      key={lanes[laneIndex].cause}
                      x1={pct(median)}
                      x2={pct(median)}
                      y1={laneIndex * LANE_HEIGHT + LANE_CENTER - 18}
                      y2={laneIndex * LANE_HEIGHT + LANE_CENTER + 18}
                      className="stroke-foreground"
                      strokeWidth={2}
                    />
                  ),
                )}
                {dots.map((placed) => {
                  if (!placed.dot.labelled) return null;
                  const flip = placed.x > LABEL_FLIP_PCT;
                  const nearRightEdge = placed.x > LABEL_ABOVE_END_PCT;
                  return (
                    <g key={placed.dot.id}>
                      {/* Wide: beside the dot, flipped inward near the right edge. */}
                      <text
                        x={pct(placed.x)}
                        dx={flip ? -(placed.r + 5) : placed.r + 5}
                        y={placed.y}
                        dy="0.35em"
                        textAnchor={flip ? "end" : "start"}
                        className="hidden fill-foreground font-mono text-[11px] font-semibold lg:inline"
                      >
                        {placed.dot.symbol}
                      </text>
                      {/* Narrow: above the dot, so neighbouring labels in one lane cannot collide sideways. */}
                      <text
                        x={pct(placed.x)}
                        dx={nearRightEdge ? placed.r : 0}
                        y={placed.y - placed.r - 4}
                        textAnchor={nearRightEdge ? "end" : "middle"}
                        className="fill-foreground font-mono text-[11px] font-semibold lg:hidden"
                      >
                        {placed.dot.symbol}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>

            {tip ? (
              <div
                aria-hidden="true"
                style={{ "--tip-x": pct(tip.x), "--tip-y": `${tip.y - tip.r - 4}px` } as CSSProperties}
                className={cn(
                  "pointer-events-none absolute left-[var(--tip-x)] top-[var(--tip-y)] z-10 w-max max-w-64 -translate-y-full",
                  tip.x < 18 ? "translate-x-[-12%]" : tip.x > 82 ? "-translate-x-[88%]" : "-translate-x-1/2",
                )}
              >
                <PharosChartTooltip active>
                  <TooltipLabel>{tip.dot.symbol}</TooltipLabel>
                  <p className="mb-1.5 text-xs text-foreground">{tip.dot.name}</p>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Peak market cap</span>
                      <span className="font-mono tabular-nums text-foreground">{tip.dot.peakLabel}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Died</span>
                      <span className="font-mono tabular-nums text-foreground">{tip.dot.dateLabel}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <span
                        className={cn("inline-block size-2 shrink-0 rounded-full", CAUSE_BG_CLASS)}
                        style={causeColorVars(tip.cause)}
                      />
                      {CAUSE_META[tip.cause].label}
                    </div>
                  </div>
                </PharosChartTooltip>
              </div>
            ) : null}
          </div>

          <div aria-hidden="true" className="hidden w-56 shrink-0 pl-4 lg:block">
            {lanes.map((lane) => (
              <div key={lane.cause} className="flex h-16 items-center pt-4 font-mono text-[11px] text-muted-foreground">
                {gutterLabel(lane)}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 space-y-3">
        <div>{footnote}</div>
        <details className="group">
          <summary className="pharos-focus-ring -my-1.5 w-fit cursor-pointer rounded-sm py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            Data table
          </summary>
          <ChartDataTable
            srOnly={false}
            className={cn(styles.dataTable, "mt-2 overflow-x-auto")}
            caption="Recorded peak market cap by cause: records with and without a recorded peak, the median and the largest."
            data={lanes}
            columns={COLUMNS}
          />
        </details>
      </div>
    </article>
  );
}
