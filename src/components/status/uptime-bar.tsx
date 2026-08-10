"use client";

import { useMemo } from "react";
import type { PublicStatusTransition } from "@shared/types";
import { cn } from "@/lib/utils";

interface UptimeBarProps {
  transitions: PublicStatusTransition[];
  currentStatus: "healthy" | "degraded" | "stale";
  lastChangedAt: number | null;
  days?: number;
}

interface DaySegment {
  date: string; // YYYY-MM-DD
  status: "healthy" | "degraded" | "stale" | "unknown";
}

const STATUS_COLORS: Record<DaySegment["status"], string> = {
  healthy: "bg-emerald-500",
  degraded: "bg-amber-500",
  stale: "bg-red-500",
  unknown: "bg-slate-300 dark:bg-slate-600",
};

const STATUS_LABELS: Record<DaySegment["status"], string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  stale: "Stale",
  unknown: "No probe.",
};

function buildDaySegments(
  transitions: PublicStatusTransition[],
  currentStatus: "healthy" | "degraded" | "stale",
  days: number,
): DaySegment[] {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const segments: DaySegment[] = [];

  // Build daily slots (oldest first).
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayUtc - i * 86400_000);
    segments.push({
      date: d.toISOString().slice(0, 10),
      status: "unknown",
    });
  }

  if (transitions.length === 0) {
    const today = segments.at(-1);
    if (today) today.status = currentStatus;
    return segments;
  }

  // Sort transitions chronologically (oldest first)
  const sorted = [...transitions].sort((a, b) => a.at - b.at);

  // Determine initial status: the state before the oldest transition
  // That's the `from` of the first transition, or "unknown" if init
  let runningStatus: DaySegment["status"] =
    sorted[0].transitionType === "init"
      ? (sorted[0].to as DaySegment["status"])
      : ((sorted[0].from as DaySegment["status"]) ?? "unknown");

  let transitionIndex = 0;
  for (const day of segments) {
    const dayStart = new Date(day.date).getTime() / 1000;
    const dayEnd = dayStart + 86400;

    // Apply any transitions that happened before or during this day
    while (transitionIndex < sorted.length && sorted[transitionIndex].at < dayEnd) {
      runningStatus = sorted[transitionIndex].to as DaySegment["status"];
      transitionIndex += 1;
    }

    day.status = runningStatus;
  }

  // History can omit a current degradation that comes from a public-health
  // signal rather than a persisted status transition. The live assessment is
  // authoritative for today's segment.
  const today = segments.at(-1);
  if (today) today.status = currentStatus;

  return segments;
}

export function UptimeBar({ transitions, currentStatus, lastChangedAt, days = 30 }: UptimeBarProps) {
  const segments = useMemo(
    () => buildDaySegments(transitions, currentStatus, days),
    [currentStatus, days, transitions],
  );

  // Compute holding days from the last segment's date as a pure proxy for "now"
  const holdingDays = useMemo(() => {
    if (lastChangedAt == null || segments.length === 0) return null;
    const todayEpoch = new Date(segments[segments.length - 1].date).getTime() / 1000;
    return Math.max(0, Math.floor((todayEpoch + 86400 - lastChangedAt) / 86400));
  }, [lastChangedAt, segments]);

  const summaryParts = useMemo(() => {
    const c = { healthy: 0, degraded: 0, stale: 0, unknown: 0 };
    for (const s of segments) c[s.status]++;

    const parts: string[] = [];
    if (c.healthy === days) {
      parts.push(`100% healthy over the last ${days} days`);
    } else {
      if (c.healthy > 0) parts.push(`${c.healthy}d healthy`);
      if (c.degraded > 0) parts.push(`${c.degraded}d degraded`);
      if (c.stale > 0) parts.push(`${c.stale}d stale`);
      if (c.unknown > 0) parts.push(`${c.unknown}d no data`);
    }

    return parts;
  }, [days, segments]);

  return (
    <div className="pharos-card-shell space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="pharos-kicker">Status runway</div>
          <div className="mt-1 text-sm text-muted-foreground">Daily posture over the last {days} days.</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-border/70 px-3 py-1 text-xs font-medium text-foreground">
            Last {days}d
          </span>
          {holdingDays != null && holdingDays > 0 && (
            <span className="pharos-numeric rounded-full border border-border/70 px-3 py-1 text-xs text-muted-foreground">
              {currentStatus} for {holdingDays}d
            </span>
          )}
        </div>
      </div>
      <div
        className="flex items-center gap-1.5"
        role="img"
        aria-label={`${days}-day status runway: ${summaryParts.join(", ")}`}
      >
        {segments.map((segment) => (
          <div
            key={segment.date}
            className={cn("h-2 flex-1 rounded-full transition-colors", STATUS_COLORS[segment.status])}
            title={`${segment.date}: ${STATUS_LABELS[segment.status]}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{summaryParts.join(" · ")}</span>
      </div>
    </div>
  );
}
