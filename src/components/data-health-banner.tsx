"use client";

import Link from "next/link";
import {
  formatDataHealthTimestamp,
  isPublicWarning,
  mergeHealthStates,
  type DataHealthInfo,
} from "@/lib/data-health";
import { formatElapsedSeconds } from "@shared/lib/format";
import { DATA_HEALTH_COLORS } from "@shared/lib/classification";
import { useHydrated } from "@/hooks/use-hydrated";

interface DataHealthBannerProps {
  entries: DataHealthInfo[];
  showFreshTimestamp?: boolean;
  onRetry?: () => void;
}

function formatAffectedLabels(labels: string[]): string {
  if (labels.length === 0) return "datasets";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  const more = labels.length - 2;
  return `${labels[0]}, ${labels[1]}, and ${more} more ${more === 1 ? "dataset" : "datasets"}`;
}

/** Public notice for material data problems only; see `isPublicWarning`. */
export function DataHealthBanner({
  entries,
  showFreshTimestamp = false,
  onRetry,
}: DataHealthBannerProps) {
  const hydrated = useHydrated();
  const formatTimestamp = (timestamp: number) =>
    formatDataHealthTimestamp(timestamp, hydrated ? undefined : "en-US", hydrated ? undefined : "UTC");
  const publicEntries = entries.filter(isPublicWarning);
  if (publicEntries.length === 0) {
    const latestUpdatedAt = mergeHealthStates(entries).latestUpdatedAt;
    if (!showFreshTimestamp || !latestUpdatedAt) return null;
    return <p className="text-xs text-muted-foreground text-center">Last updated: {formatTimestamp(latestUpdatedAt)}</p>;
  }

  const merged = mergeHealthStates(publicEntries);
  // Narrows the type; `isPublicWarning` already excludes both.
  if (merged.state === "fresh" || merged.state === "degraded") return null;
  const affected = formatAffectedLabels(merged.affectedLabels);
  const plural = merged.affectedLabels.length !== 1;
  const worstAge = publicEntries.reduce<number | null>((max, item) => {
    if (item.ageMs == null) return max;
    if (max == null) return item.ageMs;
    return Math.max(max, item.ageMs);
  }, null);

  let title = "";
  let message = "";
  if (merged.state === "stale") {
    const age = worstAge != null ? formatElapsedSeconds(worstAge / 1000) : "unknown";
    title = "Showing an older snapshot";
    message = `${affected} last refreshed over ${age} ago.`;
  } else if (merged.state === "unavailable") {
    title = "Waiting for initial data";
    message = `${affected} ${plural ? "have" : "has"} not populated yet.`;
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
      data-health-state={merged.state}
      className={`rounded-xl border px-4 py-3 text-sm leading-relaxed ${DATA_HEALTH_COLORS[merged.state]}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">{title}</p>
        {onRetry ? (
          <button type="button" onClick={onRetry} className="pharos-focus-ring shrink-0 rounded-md border border-current/20 px-2.5 py-1 text-xs font-medium">
            Retry
          </button>
        ) : null}
      </div>
      <p className="mt-1">{message}</p>
      <p className="mt-1.5 text-xs opacity-85">
        {lastSuccessfulText ? `${lastSuccessfulText}. ` : null}
        <Link href="/status/" className="underline underline-offset-2">Full breakdown on the status page</Link>
      </p>
    </div>
  );
}
