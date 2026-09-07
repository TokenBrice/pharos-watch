"use client";

import {
  formatDataHealthTimestamp,
  mergeHealthStates,
  type DataHealthInfo,
} from "@/lib/data-health";
import { formatElapsedSeconds } from "@shared/lib/format";
import { DATA_HEALTH_COLORS } from "@shared/lib/classification";
import { useHydrated } from "@/hooks/use-hydrated";

interface DataHealthBannerProps {
  entries: DataHealthInfo[];
  showFreshTimestamp?: boolean;
}

function formatAffectedLabels(labels: string[]): string {
  if (labels.length === 0) return "datasets";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels[0]}, ${labels[1]}, and ${labels.length - 2} more datasets`;
}

export function DataHealthBanner({ entries, showFreshTimestamp = false }: DataHealthBannerProps) {
  const hydrated = useHydrated();
  const formatTimestamp = (timestamp: number) =>
    formatDataHealthTimestamp(timestamp, hydrated ? undefined : "en-US", hydrated ? undefined : "UTC");
  if (entries.length === 0) return null;

  const merged = mergeHealthStates(entries);
  if (merged.state === "fresh") {
    if (!showFreshTimestamp || !merged.latestUpdatedAt) return null;
    return (
      <p className="text-xs text-muted-foreground text-center">
        Last updated: {formatTimestamp(merged.latestUpdatedAt)}
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
    if (entries.some((entry) => entry.state === "degraded" && entry.degradationReason === "refresh")) {
      title = "Refresh failed; showing saved data";
      message = `${affected} remains available while refresh retries.`;
    } else if (entries.some((entry) => entry.state === "degraded" && entry.degradationReason === "source")) {
      title = "Data quality warning";
      message = `${affected} is available, but a source or quality check needs attention.`;
    } else {
      title = "Live refresh is running behind";
      message = `${affected} refreshed later than expected.`;
    }
  } else if (merged.state === "stale") {
    const age = worstAge != null ? formatElapsedSeconds(worstAge / 1000) : "unknown";
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
      ? `Last successful update: ${formatTimestamp(merged.latestUpdatedAt)}`
      : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-lg border px-4 py-3 text-sm leading-relaxed shadow-sm ${DATA_HEALTH_COLORS[merged.state]}`}
    >
      <p className="font-medium">{title}</p>
      <p className="mt-1">{message}</p>
      {lastSuccessfulText ? (
        <p className="mt-1.5 text-xs opacity-85">{lastSuccessfulText}.</p>
      ) : null}
    </div>
  );
}
