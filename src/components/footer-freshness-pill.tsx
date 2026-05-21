"use client";

import { useEffect, useState } from "react";
import { useIsFetching, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

// WHY: a persistent, calm reminder that the dashboard is observably live.
// Mirrors the "always know the source state" affordance from the Power-user
// status bar but global to every route via the footer.

const CRITICAL_QUERY_KEYS = [
  ["stablecoins"],
  ["peg-summary"],
  ["stress-signals"],
] as const;

function isCriticalQueryKey(key: readonly unknown[]): boolean {
  return CRITICAL_QUERY_KEYS.some((critical) => critical[0] === key[0]);
}

function readMostRecentUpdate(qc: QueryClient): number {
  let mostRecent = 0;
  for (const key of CRITICAL_QUERY_KEYS) {
    const state = qc.getQueryState(key);
    if (state?.dataUpdatedAt && state.dataUpdatedAt > mostRecent) {
      mostRecent = state.dataUpdatedAt;
    }
  }
  return mostRecent;
}

function readHasError(qc: QueryClient): boolean {
  for (const key of CRITICAL_QUERY_KEYS) {
    const state = qc.getQueryState(key);
    if (state?.status === "error") return true;
  }
  return false;
}

function formatAge(updatedAt: number, now: number): string {
  if (!updatedAt) return "—";
  const secs = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86_400)}d`;
}

export function FooterFreshnessPill() {
  const qc = useQueryClient();
  const isFetching =
    useIsFetching({
      predicate: (q) => isCriticalQueryKey(q.queryKey),
    }) > 0;

  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const mostRecent = readMostRecentUpdate(qc);
  const hasError = readHasError(qc);
  const ageDisplay = formatAge(mostRecent, now);
  const showPlaceholder = mostRecent === 0;

  if (hasError) {
    return (
      <div
        role="status"
        aria-label="Live data error"
        className="inline-flex items-center gap-1.5 text-3xs font-mono tabular-nums text-amber-700 dark:text-amber-400"
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full bg-amber-500"
        />
        <span>Markets · error</span>
        <button
          type="button"
          onClick={() => {
            for (const key of CRITICAL_QUERY_KEYS) {
              qc.invalidateQueries({ queryKey: key });
            }
          }}
          className="pharos-focus-ring rounded-sm underline underline-offset-2 hover:text-amber-800 dark:hover:text-amber-300"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-label="Live data freshness"
      className="inline-flex items-center gap-1.5 text-3xs font-mono tabular-nums text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 rounded-full bg-emerald-500",
          isFetching ? "animate-pulse motion-reduce:animate-none" : "",
        )}
      />
      <span>Markets · {showPlaceholder ? "—" : `${ageDisplay} ago`}</span>
    </div>
  );
}
