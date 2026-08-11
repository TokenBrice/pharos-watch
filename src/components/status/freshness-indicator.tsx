"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";

interface FreshnessIndicatorProps {
  updatedAtMs: number;
  staleAfterMs: number;
  labelPrefix?: string;
  className?: string;
  compact?: boolean;
}

/**
 * Content-surface headroom on the staleness threshold.
 *
 * The compact chip in a module header is handed its endpoint's revalidation
 * budget (`API_FRESHNESS_MAX_AGE_SEC`), which is the producer's own cadence — so
 * with no headroom the chip turned amber the instant one normal cycle elapsed,
 * and a routine refresh read as a warning (amber at 15m, neutral at 14m). The
 * compact chips get the same 2x producer headroom the cron-backed hooks already
 * use for `refetchInterval`, so amber now means a producer run was missed.
 *
 * The operations surfaces (status dashboard, public status hero) render the
 * non-compact variant and pass their own deliberate UI thresholds; those stay
 * exact.
 */
const CONTENT_STALE_GRACE_FACTOR = 2;

function formatAge(ageMs: number): string {
  if (ageMs < 5000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  return `${Math.floor(ageMs / 3_600_000)}h ago`;
}

function nextFreshnessUpdateDelay(ageMs: number, staleAfterMs: number): number {
  const labelStepMs = ageMs < 60_000 ? 1_000 : ageMs < 3_600_000 ? 60_000 : 3_600_000;
  const nextLabelBoundaryMs = labelStepMs - (ageMs % labelStepMs);
  const nextStaleBoundaryMs = ageMs <= staleAfterMs ? staleAfterMs - ageMs + 1 : Number.POSITIVE_INFINITY;
  return Math.max(1_000, Math.min(nextLabelBoundaryMs, nextStaleBoundaryMs, 3_600_000));
}

export function FreshnessIndicator({
  updatedAtMs,
  staleAfterMs: staleAfterMsProp,
  labelPrefix,
  className,
  compact = false,
}: FreshnessIndicatorProps) {
  const staleAfterMs = compact ? staleAfterMsProp * CONTENT_STALE_GRACE_FACTOR : staleAfterMsProp;
  const isUnavailable = updatedAtMs <= 0;
  const [label, setLabel] = useState(() =>
    isUnavailable ? "not loaded" : formatAge(Math.max(0, Date.now() - updatedAtMs)),
  );
  const [isStale, setIsStale] = useState(() => !isUnavailable && Math.max(0, Date.now() - updatedAtMs) > staleAfterMs);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const recompute = () => {
      if (updatedAtMs <= 0) {
        setLabel("not loaded");
        setIsStale(false);
        return 0;
      }
      const ageMs = Math.max(0, Date.now() - updatedAtMs);
      setLabel((prev) => {
        const next = formatAge(ageMs);
        return next === prev ? prev : next;
      });
      setIsStale(ageMs > staleAfterMs);
      return ageMs;
    };

    const schedule = () => {
      if (document.visibilityState === "hidden") return;
      const ageMs = recompute();
      if (updatedAtMs <= 0) return;
      timeoutId = setTimeout(schedule, nextFreshnessUpdateDelay(ageMs, staleAfterMs));
    };

    schedule();
    const onVisibility = () => {
      if (timeoutId != null) clearTimeout(timeoutId);
      timeoutId = null;
      if (document.visibilityState === "visible") schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timeoutId != null) clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [updatedAtMs, staleAfterMs]);

  const absolute = updatedAtMs > 0 ? new Date(updatedAtMs).toLocaleString(undefined, { timeZoneName: "long" }) : null;
  const fullLabel = absolute
    ? `${labelPrefix ?? "Refreshed"} at ${absolute}`
    : `${labelPrefix ?? "Refresh"} has not loaded`;
  const visibleLabel = compact ? label.replace(/\s+ago$/, "") : labelPrefix ? `${labelPrefix}: ${label}` : label;
  return (
    <TooltipProvider delayDuration={220}>
      <Tooltip>
        <TooltipTrigger asChild>
          <time
            tabIndex={0}
            dateTime={absolute ? new Date(updatedAtMs).toISOString() : undefined}
            data-state={isUnavailable ? "unavailable" : isStale ? "stale" : "current"}
            data-stale={isStale ? "true" : "false"}
            className={cn(
              "inline-flex cursor-help items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
              compact && "min-h-6 rounded-md px-2 py-0 leading-none",
              isStale || isUnavailable
                ? SEVERITY_TONE_CLASS.watch.pill
                : "border-border/60 bg-background/60 text-muted-foreground",
              className,
            )}
          >
            {compact ? (
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
            ) : (
              <span
                className={cn("h-1.5 w-1.5 rounded-full", isStale || isUnavailable ? "bg-amber-500" : "bg-emerald-500")}
                aria-hidden="true"
              />
            )}
            {/* The relative age ticks frequently; screen readers get the stable
                absolute label instead, and state transitions are announced
                separately below. `aria-label` is prohibited on the `time` role. */}
            <span aria-hidden="true">{visibleLabel}</span>
            <span className="sr-only">{fullLabel}</span>
          </time>
        </TooltipTrigger>
        <TooltipContent className="text-[11px]">{fullLabel}</TooltipContent>
      </Tooltip>
      <FreshnessTransitionAnnouncer
        labelPrefix={labelPrefix}
        state={isUnavailable ? "unavailable" : isStale ? "stale" : "current"}
      />
    </TooltipProvider>
  );
}

/**
 * Announces freshness-state transitions only (current <-> stale), never the
 * ticking relative age. The initial state is not announced.
 */
function FreshnessTransitionAnnouncer({
  labelPrefix,
  state,
}: {
  labelPrefix?: string;
  state: "current" | "stale" | "unavailable";
}) {
  const regionRef = useRef<HTMLSpanElement>(null);
  const previousStateRef = useRef(state);

  // The live region is an external system: writing its text imperatively
  // announces the transition without rerendering (or cascading renders).
  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = state;
    if (previous === state || state === "unavailable") return;
    if (regionRef.current) {
      regionRef.current.textContent = `${labelPrefix ?? "Data"} is ${state === "stale" ? "stale" : "current again"}.`;
    }
  }, [labelPrefix, state]);

  return <span ref={regionRef} role="status" aria-live="polite" className="sr-only" />;
}
