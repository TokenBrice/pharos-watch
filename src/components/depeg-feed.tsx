"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMediaQuery } from "@/hooks/use-is-mobile";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { DepegProvenanceBadges } from "@/components/depeg-provenance-badges";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { formatDuration, formatEventDate, formatBps } from "@shared/lib/format";
import { deviationColorClass, deviationBorderClass } from "@/lib/severity-colors";
import type { DepegEvent } from "@shared/types";

interface DepegFeedProps {
  events: DepegEvent[];
  logos?: Record<string, string>;
  title?: string;
  emptyMessage?: string;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
}

const MOBILE_PAGE_SIZE = 3;
const DESKTOP_PAGE_SIZE = 6;

export function DepegFeed({
  events,
  logos,
  title = "Recent Depeg Events",
  emptyMessage = "No confirmed depeg events in this view.",
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
}: DepegFeedProps) {
  const prefetch = usePrefetchStablecoin();
  // Desktop/mobile page size from the live breakpoint; `false` keeps SSR and
  // first-paint markup on the mobile default until hydration confirms the
  // viewport, matching the previous post-mount matchMedia sync.
  const pageSize = useMediaQuery("(min-width: 1024px)", false)
    ? DESKTOP_PAGE_SIZE
    : MOBILE_PAGE_SIZE;
  const [visibleCount, setVisibleCount] = useState(MOBILE_PAGE_SIZE);

  // Track seen event IDs so only genuinely new arrivals animate.
  // Seed with initial events to prevent animation on first render.
  const [seenIds, setSeenIds] = useState<Set<number>>(() => new Set(events.map((e) => e.id)));

  // Raise the floor before commit; a passive effect would briefly leave the desktop view at three rows.
  if (visibleCount < pageSize) {
    setVisibleCount(pageSize);
  }

  const sorted = useMemo(
    () => [...events].sort((a, b) => {
      const activeDelta = Number(b.endedAt === null) - Number(a.endedAt === null);
      if (activeDelta !== 0) return activeDelta;
      return b.startedAt - a.startedAt;
    }),
    [events],
  );

  const visible = sorted.slice(0, visibleCount);
  const hasMoreLoaded = visibleCount < sorted.length;

  // Pre-compute new-event animation index (capped at 3 animated entries).
  const newIndexMap = useMemo(() => {
    const map = new Map<number, number>();
    let idx = 0;
    for (const evt of visible) {
      if (!seenIds.has(evt.id) && idx < 3) {
        map.set(evt.id, idx++);
      }
    }
    return map;
  }, [visible, seenIds]);

  // After render, mark all current events as seen.
  useEffect(() => {
    if (events.length > 0) {
      // These IDs must be committed after paint so only newly arrived rows animate once.
      // Scope the set to the current event ids so it can't grow without bound across
      // a long polled session; ids that age out of the feed can't animate anyway.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSeenIds((prev) => {
        const next = new Set(events.map((event) => event.id));
        if (next.size === prev.size && [...next].every((id) => prev.has(id))) {
          return prev;
        }
        return next;
      });
    }
  }, [events]);

  return (
    <div className="pharos-card-shell flex flex-col p-4">
      <h2 className="pharos-section-title pb-3">
        {title}
      </h2>
      <div className="flex-1 overflow-y-auto grid grid-cols-1 items-start gap-y-1.5 lg:grid-cols-3 lg:gap-x-4 lg:gap-y-2" aria-live="polite">
        {events.length === 0 ? (
          <p className="pharos-empty-note lg:col-span-3">
            {emptyMessage}
          </p>
        ) : visible.map((evt) => {
          const isOngoing = evt.endedAt === null;
          const newIndex = newIndexMap.get(evt.id);
          return (
            <Link
              key={evt.id}
              href={buildStablecoinUrl(evt.stablecoinId)}
              className="pharos-focus-ring flex items-start justify-between gap-3 py-2 px-2 min-h-11 rounded-lg hover:bg-accent/50 transition-colors group"
              onMouseEnter={() => prefetch(evt.stablecoinId)}
              style={newIndex != null ? {
                animation: 'pharos-slide-in-right 300ms var(--motion-ease-standard) both',
                animationDelay: `${newIndex * 100}ms`,
              } : undefined}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <StablecoinLogo src={logos?.[evt.stablecoinId]} name={evt.symbol} size={20} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium group-hover:underline">{evt.symbol}</span>
                    <span className={`pharos-numeric text-xs font-semibold ${deviationColorClass(Math.abs(evt.peakDeviationBps))}`}>
                      {formatBps(evt.peakDeviationBps)}
                    </span>
                    <Badge
                      variant="outline"
                      className={`text-xs px-1.5 py-0 ${deviationBorderClass(Math.abs(evt.peakDeviationBps))} ${deviationColorClass(Math.abs(evt.peakDeviationBps))}`}
                    >
                      {evt.direction}
                    </Badge>
                    <DepegProvenanceBadges
                      pendingReason={evt.pendingReason}
                      confirmationSources={evt.confirmationSources}
                      source={evt.source}
                    />
                    {isOngoing && (
                      <span className="flex items-center gap-1 text-xs text-red-700 dark:text-red-400 font-medium">
                        <span className="relative flex h-2 w-2">
                          <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                        </span>
                        LIVE
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatEventDate(evt.startedAt)}
                  </span>
                </div>
              </div>

              <span className="pharos-numeric text-xs text-muted-foreground flex-shrink-0">
                {formatDuration(evt.startedAt, evt.endedAt)}
              </span>
            </Link>
          );
        })}

        {(hasMoreLoaded || hasMore) && (
          <div className="pt-2 text-center lg:col-span-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setVisibleCount((c) => c + pageSize);
                if (hasMoreLoaded) {
                  return;
                }
                onLoadMore?.();
              }}
              className="pharos-focus-ring text-xs"
              disabled={isLoadingMore}
            >
              {isLoadingMore
                ? "Loading..."
                : hasMoreLoaded
                  ? `Load more (${sorted.length - visibleCount} loaded remaining)`
                  : "Load more history"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
