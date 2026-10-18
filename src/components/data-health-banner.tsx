"use client";

import {
  formatDataHealthTimestamp,
  mergeHealthStates,
  type DataHealthInfo,
} from "@/lib/data-health";
import { formatElapsedSeconds } from "@shared/lib/format";
import { DATA_HEALTH_COLORS } from "@shared/lib/classification";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import { useHydrated } from "@/hooks/use-hydrated";

interface DataHealthBannerProps {
  entries: DataHealthInfo[];
  showFreshTimestamp?: boolean;
  /** Detail pages retain this provenance footprint even when every lane is fresh. */
  persistent?: boolean;
  refreshingEntries?: DataHealthInfo[];
  onRetry?: () => void;
}

function formatAffectedLabels(labels: string[]): string {
  if (labels.length === 0) return "datasets";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  const more = labels.length - 2;
  return `${labels[0]}, ${labels[1]}, and ${more} more ${more === 1 ? "dataset" : "datasets"}`;
}

export function DataHealthBanner({
  entries,
  showFreshTimestamp = false,
  persistent = false,
  refreshingEntries = [],
  onRetry,
}: DataHealthBannerProps) {
  const hydrated = useHydrated();
  const formatTimestamp = (timestamp: number) =>
    formatDataHealthTimestamp(timestamp, hydrated ? undefined : "en-US", hydrated ? undefined : "UTC");
  const merged = mergeHealthStates(entries);
  const healthColors = merged.state === "fresh"
    ? "border-border/60 bg-muted/20 text-muted-foreground"
    : DATA_HEALTH_COLORS[merged.state];
  const refreshing = refreshingEntries.length > 0 && merged.state === "fresh";
  const provenance = persistent ? [...entries, ...refreshingEntries].map((entry) => {
    const explicitBudget = entry.meta && "freshBudgetSec" in entry.meta ? entry.meta.freshBudgetSec : undefined;
    const budget = typeof explicitBudget === "number" && Number.isFinite(explicitBudget) && explicitBudget >= 0
      ? formatElapsedSeconds(explicitBudget)
      : entry.meta?.updatedAt === null ? "unknown" : formatElapsedSeconds(FRESHNESS_RATIOS.FRESH * entry.staleTime / 1000);
    const reason = entry.meta && "reason" in entry.meta ? entry.meta.reason : undefined;
    const dependencies = Object.values(entry.meta?.dependencies ?? {})
      .flatMap((dependency) => dependency.reason ? [dependency.reason] : []);
    return `${entry.label}: ${entry.dataUpdatedAt > 0 ? `saved generation ${formatTimestamp(entry.dataUpdatedAt)}` : "producer generation unknown"}; freshness budget ${budget}; reason ${reason ?? entry.degradationReason ?? entry.state}.${dependencies.length ? `\n${dependencies.join("\n")}` : ""}${entry.meta?.warning ? `\n${entry.meta.warning}` : ""}`;
  }).join("\n") : "";
  if (entries.length === 0 && !persistent) return null;

  if (merged.state === "fresh" && !persistent) {
    if (!showFreshTimestamp || !merged.latestUpdatedAt) return null;
    return <p className="text-xs text-muted-foreground text-center">Last updated: {formatTimestamp(merged.latestUpdatedAt)}</p>;
  }

  const affected = formatAffectedLabels(merged.affectedLabels);
  const plural = merged.affectedLabels.length !== 1;
  const worstAge = entries
    .filter((e) => e.state !== "fresh" && e.ageMs != null)
    .reduce<number | null>((max, item) => {
      if (item.ageMs == null) return max;
      if (max == null) return item.ageMs;
      return Math.max(max, item.ageMs);
    }, null);

  const nonFresh = entries.filter((entry) => entry.state !== "fresh");
  const warningDetails = nonFresh
    .flatMap((entry) => entry.meta?.warning ? [`${entry.label}: ${entry.meta.warning}`] : []).join("\n");
  const catchUps = nonFresh.flatMap((entry) => (entry.catchUp ? [entry.catchUp] : []));
  const allCatchingUp = merged.state === "degraded" && catchUps.length === nonFresh.length;

  let title = "";
  let message = "";
  if (merged.state === "fresh") {
    const savedAt = refreshing
      ? Math.min(...refreshingEntries.map((entry) => entry.dataUpdatedAt))
      : merged.latestUpdatedAt;
    title = refreshing ? `Refreshing… saved data from ${formatTimestamp(savedAt ?? 0)}`
      : savedAt ? `Latest monitored generation: ${formatTimestamp(savedAt)}` : "Checking current data";
    message = refreshing ? "Checking the latest producer generation."
      : savedAt ? "Freshness is assessed against each source’s own budget."
        : "Producer generation and freshness will appear when the read settles.";
  } else if (allCatchingUp) {
    const lagging = formatAffectedLabels([...new Set(catchUps.flatMap((catchUp) => catchUp.laggingLabels))]);
    const observedAtMs = Math.min(...catchUps.map((catchUp) => catchUp.observedAtMs));
    title = "Some sources are still catching up";
    message = `${affected} ${plural ? "are" : "is"} current as of ${formatTimestamp(observedAtMs)}. ${lagging} history is still being backfilled, so its latest events may be missing.`;
  } else if (merged.state === "degraded") {
    if (entries.some((entry) => entry.state === "degraded" && entry.degradationReason === "refresh")) {
      title = "Refresh failed; showing saved data";
      message = `${affected} ${plural ? "remain" : "remains"} available while refresh retries.`;
    } else if (entries.some((entry) => entry.state === "degraded" && entry.degradationReason === "source")) {
      title = "Data quality warning";
      message = `${affected} ${plural ? "are" : "is"} available, but a source or quality check needs attention.`;
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
    message = `${affected} ${plural ? "have" : "has"} not populated yet.`;
  } else {
    title = "Refresh failed";
    message = `Could not refresh ${affected}.`;
  }

  const lastSuccessfulText =
    merged.latestUpdatedAt != null
      ? `${allCatchingUp ? "Last complete scan of every source" : "Last successful update"}: ${formatTimestamp(merged.latestUpdatedAt)}`
      : null;

  if (persistent) {
    const retainedOnly = nonFresh.length > 0 && nonFresh.every((entry) =>
      entry.meta && "reason" in entry.meta && entry.meta.reason === "retained-browser-evidence"
      && !entry.meta.warning && !entry.degradationReason);
    if (retainedOnly && merged.state === "stale") title = "Retained data (stale); checking live generation";
    return (
      <div
        role="status"
        aria-live="polite"
        data-freshness-slot
        data-health-state={refreshing ? "refreshing" : entries.length === 0 ? "pending" : merged.state}
        className={`relative flex h-12 items-center gap-2 rounded-xl border px-3 text-xs ${healthColors}`}
      >
        <p className="min-w-0 flex-1 truncate font-medium" title={title}>{title}</p>
        {onRetry ? (
          <button type="button" onClick={onRetry} className="pharos-focus-ring shrink-0 rounded-md border border-current/20 px-2 py-1 font-medium">
            Retry
          </button>
        ) : null}
        <details className="shrink-0">
          <summary aria-label="Generation & freshness budgets" className="pharos-focus-ring cursor-pointer rounded-sm px-1 py-2">Details</summary>
          <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-80 overflow-y-auto rounded-xl border border-border bg-background p-4 text-foreground">
            <p className="font-medium">{title}</p>
            <p className="mt-1">{message}</p>
            {lastSuccessfulText ? <p className="mt-1">{lastSuccessfulText}.</p> : null}
            <p className="mt-2 font-medium">Generation &amp; freshness budgets</p>
            <p className="mt-1 whitespace-pre-line break-words">{provenance || "No producer generation is available yet."}</p>
          </div>
        </details>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-health-state={merged.state}
      className={`rounded-xl border px-4 py-3 text-sm leading-relaxed ${healthColors}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">{title}</p>
        {onRetry ? (
          <button type="button" onClick={onRetry} className="pharos-focus-ring shrink-0 rounded-md border border-current/20 px-2.5 py-1 text-xs font-medium">
            Retry
          </button>
        ) : null}
      </div>
      <p className="mt-1" title={warningDetails || undefined}>{message}</p>
      {lastSuccessfulText ? (
        <p className="mt-1.5 text-xs opacity-85">{lastSuccessfulText}.</p>
      ) : null}
    </div>
  );
}
