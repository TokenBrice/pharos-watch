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

function formatAffectedLabels(labels: string[]): string {
  if (labels.length === 0) return "datasets";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels[0]}, ${labels[1]}, and ${labels.length - 2} more datasets`;
}

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

  const affected = formatAffectedLabels(merged.affectedLabels);
  const worstAge = entries
    .filter((e) => e.state !== "fresh" && e.ageMs != null)
    .reduce<number | null>((max, item) => {
      if (item.ageMs == null) return max;
      if (max == null) return item.ageMs;
      return Math.max(max, item.ageMs);
    }, null);

  let title = "";
  let message = "";
  if (merged.state === "degraded") {
    title = "Live refresh is running behind";
    message = `${affected} refreshed later than expected.`;
  } else if (merged.state === "stale") {
    const age = formatHealthAge(worstAge);
    title = "Showing an older snapshot";
    message = `${affected} last refreshed over ${age} ago.`;
  } else if (merged.state === "unavailable") {
    title = "Waiting for initial data";
    message = `${affected} has not populated yet.`;
  } else {
    title = "Refresh failed";
    message = `Could not refresh ${affected}.`;
  }

  const lastSuccessfulText =
    merged.latestUpdatedAt != null
      ? `Last successful update: ${formatDataHealthTimestamp(merged.latestUpdatedAt)}`
      : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-lg border px-4 py-3 text-sm leading-relaxed shadow-sm ${STATE_STYLES[merged.state]}`}
    >
      <p className="font-medium">{title}</p>
      <p className="mt-1">{message}</p>
      <div className="mt-1.5 text-xs opacity-85">
        <span>Affected: {affected}.</span>
        {lastSuccessfulText ? <span> {lastSuccessfulText}.</span> : null}
      </div>
    </div>
  );
}
