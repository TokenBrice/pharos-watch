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
  const worstAge = (group: DataHealthInfo[]) => group.reduce<number | null>((max, item) => {
    if (item.ageMs == null) return max;
    if (max == null) return item.ageMs;
    return Math.max(max, item.ageMs);
  }, null);

  // One claim per state group: a lane that retains an old snapshot and a lane
  // with nothing retained are different findings, and the worst state must not
  // re-label the others.
  const errorEntries = publicEntries.filter((entry) => entry.state === "error");
  const unavailableEntries = publicEntries.filter((entry) => entry.state === "unavailable");
  const staleEntries = publicEntries.filter((entry) => entry.state === "stale");
  const messages: string[] = [];
  if (errorEntries.length > 0) {
    const affected = formatAffectedLabels(errorEntries.map((entry) => entry.label));
    messages.push(`Could not refresh ${affected}.`);
  }
  if (unavailableEntries.length > 0) {
    const labels = unavailableEntries.map((entry) => entry.label);
    const affected = formatAffectedLabels(labels);
    messages.push(`${affected} ${labels.length === 1 ? "has" : "have"} not populated yet.`);
  }
  if (staleEntries.length > 0) {
    const age = worstAge(staleEntries);
    messages.push(
      `${formatAffectedLabels(staleEntries.map((entry) => entry.label))} last refreshed over ${age != null ? formatElapsedSeconds(age / 1000) : "unknown"} ago.`,
    );
  }
  // The banner keeps one title and one tone: those of the worst state.
  const title =
    merged.state === "error"
      ? "Refresh failed"
      : merged.state === "unavailable"
        ? "Waiting for initial data"
        : "Showing an older snapshot";
  const message = messages.join(" ");

  // A stamp belongs to its own group; with mixed findings it would read as the
  // unpopulated lane's last success.
  const stateGroups = [errorEntries, unavailableEntries, staleEntries].filter((group) => group.length > 0);
  const lastSuccessfulText =
    stateGroups.length === 1 && merged.latestUpdatedAt != null
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
