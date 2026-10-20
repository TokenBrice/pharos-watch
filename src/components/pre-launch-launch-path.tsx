"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { PRE_LAUNCH_ACCENT_CLASSES } from "@shared/lib/classification";
import { formatFuzzyDate, PHASE_DOT } from "@/lib/pre-launch";
import {
  DEFAULT_CLUSTER_PCT,
  buildLaunchPathModel,
  formatPhaseLabel,
  pluralize,
  type LaunchPathModel,
} from "@/lib/pre-launch-dossier";
import { usePreLaunchNowMs } from "@/components/pre-launch-readiness";
import type { StablecoinMeta } from "@shared/types";

type LaunchPathCoin = Pick<
  StablecoinMeta,
  "symbol" | "launchPhase" | "announcedDate" | "expectedLaunchDate" | "dateHistory" | "milestones"
>;

/** Keeps a label anchored at `pct` inside the plot: left-aligned near 0, right-aligned near 100. */
function anchorStyle(pct: number): CSSProperties {
  if (pct < 12) return { left: `${pct}%` };
  if (pct > 88) return { right: `${100 - pct}%` };
  return { left: `${pct}%`, transform: "translateX(-50%)" };
}

function describePath(coin: LaunchPathCoin, model: LaunchPathModel): string {
  const parts = [`${coin.symbol} launch path`];
  if (coin.announcedDate) parts.push(`announced ${formatFuzzyDate(coin.announcedDate)}`);
  parts.push(pluralize(coin.milestones?.length ?? 0, "milestone"));
  if (model.retired.length > 0) parts.push(`${pluralize(model.retired.length, "retired target")} (${model.retired.map((band) => band.label).join(", ")})`);
  parts.push(model.current ? `current target ${model.current.label}` : "no target date");
  parts.push(`today in ${formatPhaseLabel(coin).toLowerCase()} phase`);
  return `${parts.join("; ")}.`;
}

const PLOT_CLASS = "relative h-[8.5rem] w-full";

/** Markers closer than this many pixels share one glyph (and one count). */
const CLUSTER_GAP_PX = 16;

/** The plot's rendered width, so marker clustering holds a pixel gap at every width. */
function usePlotWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/**
 * Launch path: the coin's registry dates on one UTC time axis. Retired targets
 * (dashed), the current target window (solid band, as wide as its fuzzy
 * precision), milestones (dots; delays as diamonds) and today. The axis spans
 * the visitor's date, so the plot draws after mount; the server reserves its
 * height. The Activity module below lists the same milestones as text.
 */
export function PreLaunchLaunchPath({ coin }: { coin: LaunchPathCoin }) {
  const nowMs = usePreLaunchNowMs();
  const { ref, width } = usePlotWidth();

  if (nowMs == null) {
    return (
      <div ref={ref} aria-hidden="true" className="space-y-3">
        <div className={PLOT_CLASS}>
          <div className="absolute inset-x-0 top-[7rem] h-px bg-border" />
        </div>
        <div className="h-4" />
      </div>
    );
  }

  const model = buildLaunchPathModel(coin, nowMs, width ? (CLUSTER_GAP_PX / width) * 100 : DEFAULT_CLUSTER_PCT);
  const latestRetired = model.retired.at(-1);
  const hasDelay = model.markers.some((marker) => marker.hasDelay);
  // Narrow screens keep only year-bearing labels once the axis carries more than four ticks.
  const thinMinorTicks = model.ticks.length > 4;
  const hasMilestone = model.markers.some((marker) => marker.items.some((item) => item.type !== "delay"));

  return (
    <div ref={ref} className="space-y-3">
      <div role="img" aria-label={describePath(coin, model)} className={PLOT_CLASS}>
        {/* Year boundaries as faint gridlines, so a band reads against the calendar. */}
        {model.ticks.map((tick) => (
          <div
            key={`grid-${tick.pct}`}
            aria-hidden="true"
            className={cn("absolute top-4 h-[6rem] w-px", tick.major ? "bg-border/70" : "bg-border/30")}
            style={{ left: `${tick.pct}%` }}
          />
        ))}

        {/* Retired targets lane. */}
        {model.retired.map((band) => (
          <div
            key={band.key}
            title={`Retired target ${band.label} (retired ${band.retiredOn})`}
            className="absolute top-[2.125rem] h-2 rounded-sm border border-dashed border-muted-foreground/60"
            style={{ left: `${band.startPct}%`, width: `max(0.375rem, ${band.endPct - band.startPct}%)` }}
          />
        ))}
        {/* Only the most recent retired target is labelled in the plot; the fold lists them all. */}
        {latestRetired ? (
          <span
            className="absolute top-[1.125rem] z-10 whitespace-nowrap rounded-sm bg-card px-1 text-2xs text-muted-foreground"
            style={latestRetired.startPct > 70 ? { right: `${100 - latestRetired.endPct}%` } : { left: `${latestRetired.startPct}%` }}
          >
            {latestRetired.label} · retired
          </span>
        ) : null}

        {/* Current target lane: label, then the window. */}
        {model.current ? (
          <>
            <span
              className="absolute top-[2.875rem] z-10 whitespace-nowrap rounded-sm bg-card px-1 text-2xs font-semibold text-foreground"
              style={anchorStyle((model.current.startPct + model.current.endPct) / 2)}
            >
              Target {model.current.label}
            </span>
            <div
              title={`Current target ${model.current.label}`}
              className={cn("absolute top-16 h-2.5 rounded-sm", PRE_LAUNCH_ACCENT_CLASSES.progressFill)}
              style={{ left: `${model.current.startPct}%`, width: `max(0.375rem, ${model.current.endPct - model.current.startPct}%)` }}
            />
          </>
        ) : (
          <>
            <span
              className="absolute top-[2.875rem] z-10 whitespace-nowrap rounded-sm bg-card px-1 text-2xs font-medium text-muted-foreground"
              // Beside today, on whichever side has room, so it never covers the today rule.
              style={model.todayPct > 85 ? { right: `${100 - model.todayPct + 1}%` } : { left: `${model.todayPct + 1}%` }}
            >
              No target date
            </span>
            <div
              className="absolute top-16 h-2.5 rounded-sm border border-dashed border-border"
              style={{ left: `${model.todayPct}%`, right: 0 }}
            />
          </>
        )}

        {/* Activity lane. */}
        {model.markers.map((marker) => (
          <div
            key={marker.key}
            title={marker.items.map((item) => `${formatFuzzyDate(item.date)} · ${item.title}`).join("\n")}
            className="absolute top-[5.5rem] flex h-3 w-3 -translate-x-1/2 items-center justify-center"
            style={{ left: `${marker.pct}%` }}
          >
            <span
              className={cn(
                "ring-2 ring-card",
                marker.hasDelay ? "h-2 w-2 rotate-45 bg-state-warn-solid" : "h-2.5 w-2.5 rounded-full bg-foreground/75",
              )}
            />
            {marker.items.length > 1 ? (
              <span className="pharos-numeric absolute -top-3.5 text-3xs font-semibold text-muted-foreground">
                {marker.items.length}
              </span>
            ) : null}
          </div>
        ))}

        {/* Axis, announcement mark and ticks. */}
        <div className="absolute inset-x-0 top-[7rem] h-px bg-border" />
        {model.announcedPct != null ? (
          <span
            title={`Announced ${coin.announcedDate ? formatFuzzyDate(coin.announcedDate) : ""}`}
            className="absolute top-[6.5rem] h-0 w-0 -translate-x-1/2 border-x-[5px] border-b-[7px] border-x-transparent border-b-foreground/70"
            style={{ left: `${model.announcedPct}%` }}
          />
        ) : null}
        {model.ticks.map((tick) => (
          <span
            key={`label-${tick.pct}`}
            className={cn(
              "pharos-numeric absolute top-[7.625rem] whitespace-nowrap text-2xs",
              tick.major ? "text-foreground/80" : "text-muted-foreground",
              !tick.withYear && thinMinorTicks && "hidden sm:block",
            )}
            style={anchorStyle(tick.pct)}
          >
            {tick.label}
          </span>
        ))}

        {/* Today spans every lane (labels above mask it); its label carries the current phase. */}
        <div
          className="absolute top-3.5 h-[6.25rem] border-l border-dashed border-foreground/70"
          style={{ left: `${model.todayPct}%` }}
        />
        <span
          className="absolute top-0 z-10 inline-flex items-center gap-1 whitespace-nowrap rounded-sm bg-card px-1 text-2xs font-medium text-foreground"
          style={anchorStyle(model.todayPct)}
        >
          {coin.launchPhase ? (
            <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", PHASE_DOT[coin.launchPhase])} />
          ) : null}
          Today · {formatPhaseLabel(coin)}
        </span>
      </div>

      <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        {model.current ? (
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("h-2 w-4 rounded-sm", PRE_LAUNCH_ACCENT_CLASSES.progressFill)} />
            Target window
          </li>
        ) : null}
        {model.retired.length > 0 ? (
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-4 rounded-sm border border-dashed border-muted-foreground/60" />
            Retired target
          </li>
        ) : null}
        {hasMilestone ? (
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-foreground/75" />
            Milestone
          </li>
        ) : null}
        {hasDelay ? (
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-1.5 w-1.5 rotate-45 bg-state-warn-solid" />
            Delay
          </li>
        ) : null}
        {model.announcedPct != null ? (
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-0 w-0 border-x-[4px] border-b-[6px] border-x-transparent border-b-foreground/70" />
            Announced
          </li>
        ) : null}
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-3 border-l border-dashed border-foreground/70" />
          Today
        </li>
      </ul>
    </div>
  );
}
