"use client";

import { MethodologyLabel } from "@/components/methodology-hint";
import { cn } from "@/lib/utils";
import { formatScore } from "@shared/lib/format";
import { type PsiBeamDimmerLane } from "./view-model";

const METHODOLOGY_TOPICS = {
  severity: "psiSeverity",
  breadth: "psiBreadth",
  stressBreadth: "psiStressBreadth",
  trend: "psiTrend",
} as const;

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
  columns = 4,
  density = "default",
}: {
  lanes: PsiBeamDimmerLane[];
  columns?: 2 | 4;
  density?: "default" | "compact";
}) {
  if (lanes.length === 0) return null;

  const isCompact = density === "compact";
  const gridClass =
    columns === 2
      ? cn("grid sm:grid-cols-2", isCompact ? "gap-2.5" : "gap-3")
      : cn("grid md:grid-cols-2 xl:grid-cols-4", isCompact ? "gap-2.5" : "gap-3");

  return (
    <section aria-labelledby="psi-beam-dimmers-heading">
      <div className={cn("flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1", isCompact ? "mb-2.5" : "mb-3")}>
        <p id="psi-beam-dimmers-heading" className="pharos-kicker">
          Beam Dimmers · Current PSI component pressure
        </p>
        <p className="max-w-md text-[11px] text-muted-foreground">
          Values from the current PSI sample — not a causal timeline.
        </p>
      </div>

      <div className={gridClass}>
        {lanes.map((lane) => (
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
              <div className={cn("overflow-hidden rounded-full bg-background/80", isCompact ? "h-1.5" : "h-2")}>
                <div
                  className={cn("h-full rounded-full", laneToneClass(lane))}
                  style={{ width: `${lane.pressurePct}%` }}
                />
              </div>
              <div className={cn("mt-1 flex items-center justify-between gap-3 text-muted-foreground", isCompact ? "text-[11px]" : "text-xs")}>
                <span>{deltaLabel(lane.delta)}</span>
                <span className="font-mono tabular-nums">
                  {lane.pressurePct.toFixed(0)}%
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
