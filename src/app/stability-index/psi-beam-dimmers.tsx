"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { DateTooltip, TimeXAxis } from "@/components/chart-primitives/axes";
import { MethodologyLabel } from "@/components/methodology-hint";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { trackEvent } from "@/lib/analytics";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CHART_DRAW_IN, CHART_NO_ANIM } from "@/lib/chart-animation";
import { CHART_AMBER, CHART_GREEN, CHART_ORANGE, CHART_RED, CHART_SLATE } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";
import { formatScore } from "@shared/lib/format";
import { type PsiBeamDimmerKey, type PsiBeamDimmerLane, type PsiComponentPoint } from "./view-model";
import { PSI_LANE_TONE_CLASSES } from "@shared/lib/classification";

const METHODOLOGY_TOPICS = {
  severity: "psiSeverity",
  breadth: "psiBreadth",
  stressBreadth: "psiStressBreadth",
  trend: "psiTrend",
} as const;

const LANE_DRILLDOWN_HREF: Record<PsiBeamDimmerKey, string> = {
  severity: "/depeg/",
  breadth: "/depeg/",
  stressBreadth: "/depeg/#dews-radar",
  trend: "/flows/",
};

// Beam-dimmer tone language, shared by the pressure-bar fallback and the
// sparkline stroke: severity=red, breadth=orange, stressBreadth=amber,
// trend=green (red when 7-day momentum is dragging the score down).
const LANE_STROKE: Record<PsiBeamDimmerKey, string> = {
  severity: CHART_RED,
  breadth: CHART_ORANGE,
  stressBreadth: CHART_AMBER,
  trend: CHART_GREEN,
};

function laneStrokeHex(lane: PsiBeamDimmerLane): string {
  // A component exerting no pressure now (the panel's "0%") draws its history
  // in neutral ink: the lane hue is a warning, reserved for live pressure.
  if (lane.role !== "support" && lane.pressurePct !== null && Math.round(lane.pressurePct) === 0) return CHART_SLATE;
  if (lane.key === "trend" && lane.value !== null && lane.value < 0) return CHART_RED;
  return LANE_STROKE[lane.key];
}

/** Sparklines share the component's published range, so zero sits on the floor and height means pressure. */
function laneDomain(lane: PsiBeamDimmerLane): [number, number] {
  return lane.key === "trend" ? [-lane.max, lane.max] : [0, lane.max];
}

function laneToneClass(lane: PsiBeamDimmerLane): string {
  if (lane.role === "support") return PSI_LANE_TONE_CLASSES.support.bar;
  if (lane.key === "stressBreadth") return PSI_LANE_TONE_CLASSES.stressBreadth.bar;
  if (lane.key === "breadth") return PSI_LANE_TONE_CLASSES.breadth.bar;
  return PSI_LANE_TONE_CLASSES.pressure.bar;
}

function valueLabel(lane: PsiBeamDimmerLane): string {
  if (lane.value === null) return "Unavailable";
  if (lane.key === "trend" && lane.value > 0) return `+${formatScore(lane.value)}`;
  return formatScore(lane.value);
}

function deltaLabel(delta: number | null): string {
  if (delta === null) return "no prior sample";
  if (delta === 0) return "flat";
  return `${delta > 0 ? "+" : ""}${formatScore(delta)} vs prior sample`;
}

export function PsiBeamDimmers({
  lanes,
  series,
  columns = 4,
  density = "default",
}: {
  lanes: PsiBeamDimmerLane[];
  series?: PsiComponentPoint[];
  columns?: 2 | 4;
  density?: "default" | "compact";
}) {
  const { range, setRange, filteredData, options } = useTimeRangeFilter(
    series ?? [],
    "ts",
    undefined,
    { initialRange: "30d" },
  );
  const reducedMotion = usePrefersReducedMotion({ ssrDefault: true });
  const [shouldAnimate, setShouldAnimate] = useState(true);
  const handleAnimationEnd = useCallback(() => setShouldAnimate(false), []);

  if (lanes.length === 0) return null;

  const isCompact = density === "compact";
  // Trend mode (sparkline + range control) needs a real series to draw against;
  // before history exists we fall back to the current-pressure bar snapshot.
  const hasTrend = (series?.length ?? 0) > 1;
  const animProps = shouldAnimate && !reducedMotion ? CHART_DRAW_IN : CHART_NO_ANIM;

  const gridClass =
    columns === 2
      ? "grid grid-cols-1 divide-y divide-border/50 sm:grid-cols-2 sm:divide-y-0"
      : "grid grid-cols-1 divide-y divide-border/50 sm:grid-cols-2 sm:divide-y-0 xl:grid-cols-4";

  return (
    <section
      aria-labelledby="psi-beam-dimmers-heading"
      className="pharos-card-shell overflow-hidden"
    >
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/50",
          isCompact ? "px-4 py-3" : "px-5 py-4 sm:px-6",
        )}
      >
        <div className="min-w-0">
          <h2 id="psi-beam-dimmers-heading" className="pharos-label">
            Beam dimmers · component pressure &amp; trend
          </h2>
          <p className="mt-0.5 max-w-xl text-2xs leading-snug text-muted-foreground">
            {hasTrend
              ? "Each panel spans its component's full published range; height is pressure. Click a component to inspect its source monitor."
              : "Values from the current PSI sample, not a causal timeline."}
          </p>
        </div>
        {hasTrend ? (
          <TimeRangeButtons
            options={options}
            value={range}
            onChange={(nextRange) => {
              trackEvent("time_range_changed", { page: "stability-index-dimmers", range: nextRange });
              setRange(nextRange);
            }}
          />
        ) : null}
      </div>

      <div className={gridClass}>
        {lanes.map((lane, index) => {
          const stroke = laneStrokeHex(lane);
          const gradientId = `psi-dimmer-grad-${lane.key}`;
          const cellDividerClass =
            columns === 2
              ? cn(
                  index % 2 === 1 && "sm:border-l sm:border-border/50",
                  index >= 2 && "sm:border-t sm:border-border/50",
                )
              : cn(
                  index % 2 === 1 && "sm:border-l sm:border-border/50",
                  index >= 2 && "sm:border-t sm:border-border/50 xl:border-t-0",
                  index > 0 && "xl:border-l xl:border-border/50",
                );

          return (
            <div
              key={lane.key}
              className={cn(
                "min-w-0",
                isCompact ? "p-3.5" : "p-4 sm:p-5",
                cellDividerClass,
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <MethodologyLabel topic={METHODOLOGY_TOPICS[lane.key]} compact>
                    <Link
                      href={LANE_DRILLDOWN_HREF[lane.key]}
                      className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-sm font-medium text-foreground transition-colors hover:text-brand-accent-text hover:underline"
                    >
                      <span>{lane.label}</span>
                      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </Link>
                  </MethodologyLabel>
                  <p className={cn("mt-1 text-muted-foreground", isCompact ? "text-2xs leading-snug" : "text-xs")}>
                    {lane.detail}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className={cn(
                      "font-mono font-bold tabular-nums",
                      isCompact ? "text-base" : "text-lg",
                      lane.role === "support" ? PSI_LANE_TONE_CLASSES.support.text : "text-foreground",
                    )}
                  >
                    {valueLabel(lane)}
                  </p>
                  <p className="pharos-label">{lane.role}</p>
                </div>
              </div>

              <div className={isCompact ? "mt-2.5" : "mt-3"}>
                {hasTrend ? (
                  <div
                    className={isCompact ? "h-14" : "h-16"}
                    role="figure"
                    aria-label={`${lane.label} across ${filteredData.length} samples`}
                  >
                    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                      <AreaChart data={filteredData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                        <defs>
                          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={stroke} stopOpacity={0.16} />
                            <stop offset="95%" stopColor={stroke} stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <TimeXAxis dataKey="ts" hide />
                        <YAxis hide domain={laneDomain(lane)} allowDataOverflow />
                        <DateTooltip
                          formatter={(value) => [value == null ? "Unavailable" : formatScore(Number(value)), lane.label]}
                        />
                        <Area
                          type="monotone"
                          dataKey={lane.key}
                          name={lane.label}
                          stroke={stroke}
                          fill={`url(#${gradientId})`}
                          strokeWidth={1.5}
                          dot={false}
                          connectNulls={false}
                          {...(index === 0 ? { onAnimationEnd: handleAnimationEnd } : {})}
                          {...animProps}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ) : lane.pressurePct !== null ? (
                  <div className={cn("overflow-hidden rounded-full bg-muted", isCompact ? "h-1.5" : "h-2")}>
                    <div
                      className={cn("h-full rounded-full", laneToneClass(lane))}
                      style={{ width: `${lane.pressurePct}%` }}
                    />
                  </div>
                ) : null}
                <div
                  className={cn(
                    "mt-1.5 flex items-center justify-between gap-3 text-muted-foreground",
                    isCompact ? "text-2xs" : "text-xs",
                  )}
                >
                  <span>{lane.value === null ? "component not reported" : deltaLabel(lane.delta)}</span>
                  <span className="font-mono tabular-nums">
                    {lane.pressurePct === null ? "—" : `${lane.pressurePct.toFixed(0)}%`}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
