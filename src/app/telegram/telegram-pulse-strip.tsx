"use client";

import { useTelegramPulse } from "@/hooks/use-telegram-pulse";
import { Skeleton } from "@/components/ui/skeleton";

export function TelegramPulseStrip() {
  const { data, isLoading } = useTelegramPulse();

  if (isLoading) {
    return (
      <div className="flex items-center gap-x-5 text-xs text-muted-foreground">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-32" />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs tabular-nums">
      <span className="text-muted-foreground">
        <span className="font-semibold text-foreground font-mono">{data.activeWatchers}</span> active watchers
      </span>
      <span className="hidden text-border sm:inline" aria-hidden="true">&middot;</span>
      <span className="text-muted-foreground">
        <span className="font-semibold text-foreground font-mono">{data.coinSubscriptions}</span> active coin follows
      </span>
      {data.topCoins.length > 0 && (
        <>
          <span className="hidden text-border sm:inline" aria-hidden="true">&middot;</span>
          <span className="text-muted-foreground">
            most watched:{" "}
            <span className="font-medium text-foreground">{data.topCoins.slice(0, 3).join(", ")}</span>
          </span>
        </>
      )}
    </div>
  );
}
