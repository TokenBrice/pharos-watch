"use client";

import type { ApiMeta } from "@/lib/api";
import { cn } from "@/lib/utils";

interface DataFreshnessProps {
  meta: ApiMeta | null;
  className?: string;
}

export function DataFreshness({ meta, className }: DataFreshnessProps) {
  if (!meta || meta.status === "fresh") return null;

  const ageMin = Math.round(meta.ageSeconds / 60);
  const label =
    meta.status === "degraded"
      ? `Data is ${ageMin} min old`
      : "Data may be stale";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        meta.status === "degraded"
          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
          : "bg-red-500/10 text-red-600 dark:text-red-400",
        className,
      )}
    >
      <span
        className={cn(
          "inline-block size-1.5 rounded-full",
          meta.status === "degraded" ? "bg-amber-500" : "bg-red-500",
        )}
      />
      {label}
    </span>
  );
}
