"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { buildStablecoinUrl } from "@/lib/urls";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { formatDuration, formatEventDate, formatBps } from "@shared/lib/format";
import type { DepegEvent } from "@shared/types";

interface DepegFeedProps {
  events: DepegEvent[];
  logos?: Record<string, string>;
  className?: string;
}

const MOBILE_PAGE_SIZE = 3;
const DESKTOP_PAGE_SIZE = 6;

export function DepegFeed({ events, logos, className }: DepegFeedProps) {
  const prefetch = usePrefetchStablecoin();
  const [pageSize, setPageSize] = useState(MOBILE_PAGE_SIZE);
  const [visibleCount, setVisibleCount] = useState(MOBILE_PAGE_SIZE);

  // Track seen event IDs so only genuinely new arrivals animate.
  // Seed with initial events to prevent animation on first render.
  const [seenIds, setSeenIds] = useState<Set<number>>(() => new Set(events.map((e) => e.id)));

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const syncPageSize = () => {
      const nextPageSize = mql.matches ? DESKTOP_PAGE_SIZE : MOBILE_PAGE_SIZE;
      setPageSize(nextPageSize);
      // Keep already-loaded rows visible, but ensure a larger desktop default when expanding.
      setVisibleCount((current) => (current < nextPageSize ? nextPageSize : current));
    };

    syncPageSize();
    mql.addEventListener("change", syncPageSize);
    return () => mql.removeEventListener("change", syncPageSize);
  }, []);

  const sorted = useMemo(
    () => [...events].sort((a, b) => b.startedAt - a.startedAt),
    [events],
  );

  const visible = sorted.slice(0, visibleCount);
  const hasMore = visibleCount < sorted.length;

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
      setSeenIds((prev) => {
        const next = new Set(prev);
        for (const e of events) next.add(e.id);
        return next.size === prev.size ? prev : next;
      });
    }
  }, [events]);

  if (events.length === 0) return null;

  return (
    <Card className={["rounded-xl flex flex-col", className].filter(Boolean).join(" ")}>
      <CardHeader className="pb-3">
        <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Recent Depeg Events
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto grid grid-cols-1 gap-y-1.5 lg:grid-cols-3 lg:gap-x-4 lg:gap-y-2" aria-live="polite">
        {visible.map((evt) => {
          const isOngoing = evt.endedAt === null;
          const newIndex = newIndexMap.get(evt.id);
          return (
            <Link
              key={evt.id}
              href={buildStablecoinUrl(evt.stablecoinId)}
              className="flex items-center justify-between gap-3 py-2 px-2 rounded-lg hover:bg-accent/50 transition-colors group"
              onMouseEnter={() => prefetch(evt.stablecoinId)}
              style={newIndex != null ? {
                animation: 'pharos-slide-in-right 300ms var(--motion-ease-standard) both',
                animationDelay: `${newIndex * 100}ms`,
              } : undefined}
            >
              <div className="flex items-center gap-3 min-w-0">
                <StablecoinLogo src={logos?.[evt.stablecoinId]} name={evt.symbol} size={20} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium group-hover:underline">{evt.symbol}</span>
                    <span className={`font-mono text-xs font-semibold ${
                      Math.abs(evt.peakDeviationBps) >= 500 ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400"
                    }`}>
                      {formatBps(evt.peakDeviationBps)}
                    </span>
                    <Badge
                      variant="outline"
                      className={`text-xs px-1.5 py-0 ${
                        evt.direction === "below"
                          ? "border-red-500/50 text-red-700 dark:text-red-400"
                          : "border-amber-500/50 text-amber-700 dark:text-amber-400"
                      }`}
                    >
                      {evt.direction}
                    </Badge>
                    {isOngoing && (
                      <span className="flex items-center gap-1 text-xs text-red-700 dark:text-red-400 font-medium">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
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

              <span className="text-xs text-muted-foreground font-mono flex-shrink-0">
                {formatDuration(evt.startedAt, evt.endedAt)}
              </span>
            </Link>
          );
        })}

        {hasMore && (
          <div className="pt-2 text-center lg:col-span-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setVisibleCount((c) => c + pageSize)}
              className="text-xs"
            >
              Load more ({sorted.length - visibleCount} remaining)
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
