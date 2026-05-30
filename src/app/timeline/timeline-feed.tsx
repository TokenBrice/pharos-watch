"use client";

import type { RefObject } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { EventCard } from "@/components/tape/event-card";
import {
  SEVERITY_LABEL as SEVERITY_LABEL_BARE,
  type TapeEvent,
} from "@shared/types/tape-event";
import type { ApiMeta } from "@/lib/api";
import type { DigestedDay } from "@/lib/tape-digest";
import type { TapeFilterState } from "@/components/tape/tape-filters";
import type { ActiveFilterChip, TimelineFeedController } from "./timeline-controller";
import { bucketByDay, eventDomId } from "./timeline-feed-helpers";
import { DayDigestSection, EmptyState, EventSkeleton, OpenIncidentsSection } from "./timeline-feed-sections";

interface TimelineFeedProps {
  filters: TapeFilterState;
  controller: TimelineFeedController;
  logos: Record<string, string>;
  nowMs: number;
  rawEvents: readonly TapeEvent[];
  visibleEvents: readonly TapeEvent[];
  openIncidents: readonly TapeEvent[];
  digestedDays: readonly DigestedDay[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  nextCursor: string | null;
  total: number | null;
  meta: ApiMeta | null;
  dataUpdatedAt: number;
  permalinkId: string;
  permalinkBufferIsLoading: boolean;
  bufferEvent: TapeEvent | null;
  highlightedId: string | null;
  loadAnnouncement: string;
  emptyStateChips: readonly ActiveFilterChip[];
  emptyStateFallback: { label: string; apply: () => void };
  onLoadMore: () => void;
  sentinelRef: RefObject<HTMLDivElement | null>;
}

export function TimelineFeed({
  filters,
  controller,
  logos,
  nowMs,
  rawEvents,
  visibleEvents,
  openIncidents,
  digestedDays,
  isLoading,
  error,
  refetch,
  hasNextPage,
  isFetchingNextPage,
  nextCursor,
  total,
  meta,
  dataUpdatedAt,
  permalinkId,
  permalinkBufferIsLoading,
  bufferEvent,
  highlightedId,
  loadAnnouncement,
  emptyStateChips,
  emptyStateFallback,
  onLoadMore,
  sentinelRef,
}: TimelineFeedProps) {
  const openCountByDay = bucketByDay(openIncidents);
  const lastEventTs = rawEvents.length > 0 ? rawEvents[0].ts : null;

  return (
    <>
      <QueryFreshnessNotices
        error={error}
        hasData={rawEvents.length > 0}
        onRetry={() => void refetch()}
        queries={[
          {
            label: "Timeline",
            dataUpdatedAt,
            error,
            hasData: rawEvents.length > 0,
            meta,
          },
        ]}
      />

      {permalinkId && !permalinkBufferIsLoading && !bufferEvent && !rawEvents.some((e) => e.id === permalinkId) ? (
        <div
          title={permalinkId}
          className="border-y border-amber-500/30 px-3 py-2 font-mono text-xs text-amber-700 dark:text-amber-400"
        >
          ⚠ The linked event isn&apos;t in this view. Try widening the filters or removing the time window.
        </div>
      ) : null}

      {openIncidents.length > 0 ? (
        <OpenIncidentsSection incidents={openIncidents} logos={logos} nowMs={nowMs} />
      ) : null}

      {/* Discrete sr-only announcer for paginated loads (T1.4). The feed
          wrapper below intentionally omits `aria-live` so each Load More
          doesn't re-narrate the whole event list. */}
      <div role="status" aria-live="polite" className="sr-only">
        {loadAnnouncement}
      </div>

      <section id="data" aria-label="Event tape" tabIndex={-1}>
        {isLoading ? (
          <div>
            <EventSkeleton />
          </div>
        ) : visibleEvents.length === 0 ? (
          <div>
            <EmptyState
              onClearAll={emptyStateFallback.apply}
              activeChips={emptyStateChips}
              fallbackLabel={emptyStateFallback.label}
            />
          </div>
        ) : (
          <div className="space-y-4">
            <div id="tape-feed" className="space-y-4">
              {bufferEvent ? (
                <div className="border-y border-border/60 bg-amber-500/5">
                  <p className="px-3 pt-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                    <span aria-hidden="true">► </span>
                    <span className="font-semibold text-foreground">PINNED</span>
                    <span aria-hidden="true"> · </span>
                    <span>Linked from URL</span>
                  </p>
                  <EventCard
                    event={bufferEvent}
                    logoSrc={bufferEvent.coinId ? logos[bufferEvent.coinId] : undefined}
                    highlighted={highlightedId === bufferEvent.id}
                    domId={eventDomId(bufferEvent.id)}
                  />
                </div>
              ) : null}
              {digestedDays.map((day) => (
                <DayDigestSection
                  key={day.dayKey}
                  day={day}
                  nowMs={nowMs}
                  logos={logos}
                  highlightedId={highlightedId}
                  openCount={openCountByDay.get(day.dayKey) ?? 0}
                />
              ))}
              {hasNextPage ? (
                <div className="pt-2 text-center">
                  <Button variant="outline" size="sm" onClick={onLoadMore} disabled={isFetchingNextPage}>
                    {isFetchingNextPage ? (
                      <>
                        <Loader2 className="mr-1.5 h-3 w-3 animate-spin" aria-hidden="true" />
                        Loading…
                      </>
                    ) : total != null && total > rawEvents.length ? (
                      `Load more (${(total - rawEvents.length).toLocaleString()} remaining)`
                    ) : (
                      "Load more"
                    )}
                  </Button>
                  <div ref={sentinelRef} aria-hidden="true" />
                </div>
              ) : nextCursor == null && rawEvents.length > 0 ? (
                <p className="pt-2 text-center font-mono text-[11px] uppercase tracking-wider tabular-nums text-muted-foreground">
                  ───── END OF TAPE
                  {" · "}
                  {(total ?? rawEvents.length).toLocaleString()} EVT
                  {" · WINDOW "}
                  {controller.windowShort}
                  {" · "}
                  {SEVERITY_LABEL_BARE[filters.severity].toUpperCase()}
                  {filters.severity === "critical" ? "" : "+"}
                  {" · CURSOR: NULL · LAST FILE: "}
                  {lastEventTs != null
                    ? new Date(lastEventTs).toISOString().replace(".000Z", "Z")
                    : new Date(dataUpdatedAt).toISOString().replace(".000Z", "Z")}
                  {" ─────"}
                </p>
              ) : null}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
