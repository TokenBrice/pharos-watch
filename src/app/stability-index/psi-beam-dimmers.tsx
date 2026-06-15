"use client";

import { useCallback, useState } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { DateTooltip, TimeXAxis } from "@/components/chart-primitives/axes";
import { MethodologyLabel } from "@/components/methodology-hint";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { trackEvent } from "@/lib/analytics";
import { CHART_DRAW_IN, CHART_NO_ANIM } from "@/lib/chart-animation";
import { CHART_AMBER, CHART_GREEN, CHART_ORANGE, CHART_RED } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";
import { formatScore } from "@shared/lib/format";
import { type PsiBeamDimmerKey, type PsiBeamDimmerLane, type PsiComponentPoint } from "./view-model";

const METHODOLOGY_TOPICS = {
  severity: "psiSeverity",
  breadth: "psiBreadth",
  stressBreadth: "psiStressBreadth",
  trend: "psiTrend",
} as const;

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
  if (lane.key === "trend" && lane.value < 0) return CHART_RED;
  return LANE_STROKE[lane.key];
}

function laneToneClass(lane: PsiBeamDimmerLane): string {
  if (lane.role === "support") return "bg-emerald-500";
  if (lane.key === "stressBreadth") return "bg-amber-500";
  if (lane.key === "breadth") return "bg-orange-500";
  return "bg-red-500";
}

function valueLabel(lane: PsiBeamDimmerLane): string {
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
  const { range, setRange, filteredData, options } = useTimeRangeFilter(series ?? [], "ts");
  const [shouldAnimate, setShouldAnimate] = useState(true);
  const handleAnimationEnd = useCallback(() => setShouldAnimate(false), []);

  if (lanes.length === 0) return null;

  const isCompact = density === "compact";
  // Trend mode (sparkline + range control) needs a real series to draw against;
  // before history exists we fall back to the current-pressure bar snapshot.
  const hasTrend = (series?.length ?? 0) > 1;
  const animProps = shouldAnimate ? CHART_DRAW_IN : CHART_NO_ANIM;

  const gridClass =
    columns === 2
      ? cn("grid sm:grid-cols-2", isCompact ? "gap-2.5" : "gap-3")
      : cn("grid md:grid-cols-2 xl:grid-cols-4", isCompact ? "gap-2.5" : "gap-3");

  return (
    <section aria-labelledby="psi-beam-dimmers-heading">
      <div className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5", isCompact ? "mb-2.5" : "mb-3")}>
        <div className="min-w-0">
          <p id="psi-beam-dimmers-heading" className="pharos-kicker">
            Beam Dimmers · Component pressure &amp; trend
          </p>
          <p className="mt-0.5 max-w-md text-[11px] leading-snug text-muted-foreground">
            {hasTrend
              ? "Each panel scales independently — read the shape, not the height."
              : "Values from the current PSI sample — not a causal timeline."}
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
          return (
            <div key={lane.key} className={cn("rounded-lg border border-border/70 bg-muted/20", isCompact ? "p-2.5" : "p-3")}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <MethodologyLabel topic={METHODOLOGY_TOPICS[lane.key]}>
                    {lane.label}
                  </MethodologyLabel>
                  <p className={cn("mt-1 text-muted-foreground", isCompact ? "text-[11px] leading-snug" : "text-xs")}>{lane.detail}</p>
                </div>
                <div className="text-right">
                  <p className={cn(
                    "font-mono font-bold tabular-nums",
                    isCompact ? "text-base" : "text-lg",
                    lane.role === "support" ? "text-emerald-700 dark:text-emerald-300" : "text-foreground",
                  )}>
                    {valueLabel(lane)}
                  </p>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {lane.role}
                  </p>
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
                            <stop offset="5%" stopColor={stroke} stopOpacity={0.28} />
                            <stop offset="95%" stopColor={stroke} stopOpacity={0.04} />
                          </linearGradient>
                        </defs>
                        <TimeXAxis dataKey="ts" hide />
                        <DateTooltip formatter={(value) => [formatScore(Number(value)), lane.label]} />
                        <Area
                          type="monotone"
                          dataKey={lane.key}
                          name={lane.label}
                          stroke={stroke}
                          fill={`url(#${gradientId})`}
                          strokeWidth={1.5}
                          dot={false}
                          {...(index === 0 ? { onAnimationEnd: handleAnimationEnd } : {})}
                          {...animProps}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className={cn("overflow-hidden rounded-full bg-background/80", isCompact ? "h-1.5" : "h-2")}>
                    <div
                      className={cn("h-full rounded-full", laneToneClass(lane))}
                      style={{ width: `${lane.pressurePct}%` }}
                    />
                  </div>
                )}
                <div className={cn("mt-1 flex items-center justify-between gap-3 text-muted-foreground", isCompact ? "text-[11px]" : "text-xs")}>
                  <span>{deltaLabel(lane.delta)}</span>
                  <span className="font-mono tabular-nums">{lane.pressurePct.toFixed(0)}%</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
