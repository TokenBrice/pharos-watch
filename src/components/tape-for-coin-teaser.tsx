"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useLatestEvents } from "@/hooks/use-events";
import { EventCard } from "@/components/tape/event-card";
import { useLogos } from "@/hooks/use-logos";

interface TapeForCoinTeaserProps {
  /** Canonical stablecoin id (e.g. `usdt-tether`). */
  coinId: string;
}

export function TapeForCoinTeaser({ coinId }: TapeForCoinTeaserProps) {
  const { data, isLoading } = useLatestEvents({ coin: coinId, limit: 5 });
  const { data: logos } = useLogos();
  const events = data?.events ?? [];

  if (!isLoading && events.length === 0) {
    return null;
  }

  return (
    <div className="pharos-card-shell space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">On the timeline</h2>
        <Link
          href={`/timeline/?coin=${encodeURIComponent(coinId)}`}
          className="pharos-focus-ring inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          View all
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </div>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading recent events…</p>
      ) : (
        <div className="space-y-2">
          {events.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              logoSrc={event.coinId ? logos[event.coinId] : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
