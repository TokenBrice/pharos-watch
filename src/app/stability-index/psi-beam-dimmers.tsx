"use client";

import { Activity } from "lucide-react";
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

export function PsiBeamDimmers({ lanes }: { lanes: PsiBeamDimmerLane[] }) {
  if (lanes.length === 0) return null;

  return (
    <section aria-labelledby="psi-beam-dimmers-heading">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="pharos-kicker">Beam Dimmers</p>
          <h2
            id="psi-beam-dimmers-heading"
            className="pharos-section-title mt-1 flex items-center gap-2"
          >
            <Activity className="h-4 w-4 text-amber-600 dark:text-amber-300" aria-hidden />
            Current PSI component pressure
          </h2>
        </div>
        <p className="max-w-xl text-xs text-muted-foreground">
          Component values come from the current PSI formula sample; this rail is not a causal event timeline.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {lanes.map((lane) => (
          <div key={lane.key} className="rounded-lg border border-border/70 bg-muted/20 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <MethodologyLabel topic={METHODOLOGY_TOPICS[lane.key]}>
                  {lane.label}
                </MethodologyLabel>
                <p className="mt-1 text-xs text-muted-foreground">{lane.detail}</p>
              </div>
              <div className="text-right">
                <p className={cn(
                  "font-mono text-lg font-bold tabular-nums",
                  lane.role === "support" ? "text-emerald-700 dark:text-emerald-300" : "text-foreground",
                )}>
                  {valueLabel(lane)}
                </p>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {lane.role}
                </p>
              </div>
            </div>
            <div className="mt-3">
              <div className="h-2 overflow-hidden rounded-full bg-background/80">
                <div
                  className={cn("h-full rounded-full", laneToneClass(lane))}
                  style={{ width: `${lane.pressurePct}%` }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
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
