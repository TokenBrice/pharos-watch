"use client";

import { cn } from "@/lib/utils";

interface CronInFlightProgressProps {
  itemsDone: number;
  itemsTotal: number;
  stale: boolean;
  className?: string;
}

export function CronInFlightProgress({ itemsDone, itemsTotal, stale, className }: CronInFlightProgressProps) {
  const safeTotal = Math.max(itemsTotal, 0);
  const safeDone = Math.max(0, Math.min(itemsDone, safeTotal));
  const pct = safeTotal > 0 ? (safeDone / safeTotal) * 100 : 0;
  return (
    <div
      role="progressbar"
      aria-valuenow={safeDone}
      aria-valuemin={0}
      aria-valuemax={safeTotal}
      aria-label={`Cron progress: ${safeDone} of ${safeTotal}`}
      data-stale={stale ? "true" : "false"}
      className={cn(
        "relative h-1.5 w-full overflow-hidden rounded-full bg-muted/40",
        className,
      )}
    >
      <div
        className={cn(
          "h-full transition-[width] duration-500 ease-out",
          stale ? "bg-amber-500" : "bg-emerald-500",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
