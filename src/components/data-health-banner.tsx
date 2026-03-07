"use client";

import {
  formatDataHealthTimestamp,
  formatHealthAge,
  mergeHealthStates,
  type DataHealthInfo,
} from "@/lib/data-health";

interface DataHealthBannerProps {
  entries: DataHealthInfo[];
  showFreshTimestamp?: boolean;
}

const STATE_STYLES = {
  degraded: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  stale: "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  unavailable: "border-border/60 bg-muted/40 text-muted-foreground",
  error: "border-destructive/50 bg-destructive/10 text-destructive",
} as const;

export function DataHealthBanner({ entries, showFreshTimestamp = false }: DataHealthBannerProps) {
  if (entries.length === 0) return null;

  const merged = mergeHealthStates(entries);
  if (merged.state === "fresh") {
    if (!showFreshTimestamp || !merged.latestUpdatedAt) return null;
    return (
      <p className="text-xs text-muted-foreground text-center">
        Last updated: {formatDataHealthTimestamp(merged.latestUpdatedAt)}
      </p>
    );
  }

  const affected =
    merged.affectedLabels.length > 0 ? merged.affectedLabels.join(", ") : "data";
  const worstAge = entries
    .filter((e) => e.state !== "fresh" && e.ageMs != null)
    .reduce<number | null>((max, item) => {
      if (item.ageMs == null) return max;
      if (max == null) return item.ageMs;
      return Math.max(max, item.ageMs);
    }, null);

  let message = "";
  if (merged.state === "degraded") {
    message = `Data may be delayed (${affected}).`;
  } else if (merged.state === "stale") {
    const age = formatHealthAge(worstAge);
    message = `Data may be stale (${affected}). Last successful update was over ${age} ago.`;
  } else if (merged.state === "unavailable") {
    message = `Some data is not yet available (${affected}).`;
  } else {
    message = `Failed to refresh ${affected}.`;
  }

  return (
    <div role="status" aria-live="polite" className={`rounded-lg border px-4 py-2.5 text-sm leading-relaxed shadow-sm ${STATE_STYLES[merged.state]}`}>
      {message}
    </div>
  );
}
