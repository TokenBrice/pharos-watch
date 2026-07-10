"use client";

import { Star } from "lucide-react";
import { useWatchlist } from "@/hooks/use-watchlist";
import { trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";

interface YieldWatchlistStarProps {
  stablecoinId: string;
  symbol: string;
  className?: string;
}

export function YieldWatchlistStar({ stablecoinId, symbol, className }: YieldWatchlistStarProps) {
  const { has, toggle } = useWatchlist();
  const active = has(stablecoinId);

  return (
    <button
      type="button"
      data-active={active}
      aria-pressed={active}
      aria-label={active ? `Remove ${symbol} from watchlist` : `Add ${symbol} to watchlist`}
      onClick={(event) => {
        event.stopPropagation();
        toggle(stablecoinId);
        trackEvent("yield_watchlist_changed", {
          action: active ? "removed" : "added",
          coin_id: stablecoinId,
        });
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
      className={cn(
        "pharos-focus-ring inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-amber-500",
        active && "text-amber-500",
        className,
      )}
    >
      <Star className={cn("h-4 w-4", active && "fill-amber-500")} />
    </button>
  );
}

YieldWatchlistStar.displayName = "YieldWatchlistStar";
