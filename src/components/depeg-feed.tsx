"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { formatDuration, formatEventDate, formatBps } from "@/lib/format";
import type { DepegEvent } from "@/lib/types";

interface DepegFeedProps {
  events: DepegEvent[];
  logos?: Record<string, string>;
}

const PAGE_SIZE = 20;

export function DepegFeed({ events, logos }: DepegFeedProps) {
  const prefetch = usePrefetchStablecoin();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const sorted = useMemo(
    () => [...events].sort((a, b) => b.startedAt - a.startedAt),
    [events],
  );

  const visible = sorted.slice(0, visibleCount);
  const hasMore = visibleCount < sorted.length;

  if (events.length === 0) return null;

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-3">
        <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Recent Depeg Events
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 lg:grid-cols-2 gap-x-4 gap-y-1.5" aria-live="polite">
        {visible.map((evt) => {
          const isOngoing = evt.endedAt === null;
          return (
            <Link
              key={evt.id}
              href={`/stablecoin/${evt.stablecoinId}`}
              className="flex items-center justify-between gap-3 py-2 px-2 rounded-lg hover:bg-accent/50 transition-colors group"
              onMouseEnter={() => prefetch(evt.stablecoinId)}
            >
              <div className="flex items-center gap-3 min-w-0">
                <StablecoinLogo src={logos?.[evt.stablecoinId]} name={evt.symbol} size={20} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium group-hover:underline">{evt.symbol}</span>
                    <span className={`font-mono text-xs font-semibold ${
                      Math.abs(evt.peakDeviationBps) >= 500 ? "text-red-500" : "text-amber-500"
                    }`}>
                      {formatBps(evt.peakDeviationBps)}
                    </span>
                    <Badge
                      variant="outline"
                      className={`text-xs px-1.5 py-0 ${
                        evt.direction === "below"
                          ? "border-red-500/50 text-red-500"
                          : "border-amber-500/50 text-amber-500"
                      }`}
                    >
                      {evt.direction}
                    </Badge>
                    {isOngoing && (
                      <span className="flex items-center gap-1 text-xs text-red-500 font-medium">
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
          <div className="pt-2 text-center lg:col-span-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
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
