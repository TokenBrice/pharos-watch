"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface FreshnessIndicatorProps {
  updatedAtMs: number;
  staleAfterMs: number;
  className?: string;
}

function formatAge(ageMs: number): string {
  if (ageMs < 5000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  return `${Math.floor(ageMs / 3_600_000)}h ago`;
}

export function FreshnessIndicator({ updatedAtMs, staleAfterMs, className }: FreshnessIndicatorProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ageMs = Math.max(0, now - updatedAtMs);
  const isStale = ageMs > staleAfterMs;
  const absolute = updatedAtMs > 0
    ? new Date(updatedAtMs).toLocaleString(undefined, { timeZoneName: "long" })
    : "never";
  return (
    <span
      role="status"
      data-stale={isStale ? "true" : "false"}
      title={`Refreshed at ${absolute}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        isStale
          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "border-border/60 bg-background/60 text-muted-foreground",
        className,
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 rounded-full", isStale ? "bg-amber-400" : "bg-emerald-400")}
        aria-hidden="true"
      />
      {formatAge(ageMs)}
    </span>
  );
}
