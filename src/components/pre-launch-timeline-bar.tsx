"use client";

import { useMemo, useSyncExternalStore } from "react";
import { clampScore } from "@shared/lib/math";
import { formatFuzzyDate, parseFuzzyDate } from "@/lib/pre-launch";

const subscribeToHydration = () => () => {};
const getClientHydrationSnapshot = () => true;
const getServerHydrationSnapshot = () => false;

/**
 * Progress is read from the browser clock, so the bar is the only hydrated island on an
 * otherwise server-rendered pre-launch page. The server pass reserves the bar's height.
 */
export function PreLaunchTimelineBar({
  announcedDate,
  expectedLaunchDate,
}: {
  announcedDate: string;
  expectedLaunchDate: string;
}) {
  const start = parseFuzzyDate(announcedDate);
  const end = parseFuzzyDate(expectedLaunchDate);
  const isHydrated = useSyncExternalStore(
    subscribeToHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot,
  );
  const now = useMemo(() => (isHydrated ? new Date() : null), [isHydrated]);

  if (!start || !end || end <= start) return null;

  if (!now) {
    return (
      <div className="min-h-[54px] space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{formatFuzzyDate(announcedDate)}</span>
          <span>Expected: {formatFuzzyDate(expectedLaunchDate)}</span>
        </div>
        <div className="h-2 w-full rounded-full bg-muted/40" aria-hidden="true" />
      </div>
    );
  }

  const totalMs = end.getTime() - start.getTime();
  const elapsedMs = now.getTime() - start.getTime();
  const pct = clampScore((elapsedMs / totalMs) * 100);

  return (
    <div className="min-h-[54px] space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{formatFuzzyDate(announcedDate)}</span>
        <span>Expected: {formatFuzzyDate(expectedLaunchDate)}</span>
      </div>
      <div
        className="relative h-2 w-full overflow-hidden rounded-full bg-muted/40"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Launch timeline progress"
      >
        <div className="absolute inset-y-0 left-0 rounded-full bg-indigo-500/60" style={{ width: `${pct}%` }} />
        {pct > 2 && pct < 98 && (
          <div
            className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-foreground"
            style={{ left: `${pct}%` }}
            title="Today"
          />
        )}
      </div>
      {pct > 2 && pct < 98 && <div className="text-center text-xs text-muted-foreground">Today</div>}
    </div>
  );
}
