"use client";

import { useMemo } from "react";
import { useEvents, useLatestEvents } from "@/hooks/use-events";
import { digestPage, mergeDigestedPages } from "@/lib/tape-digest";
import type { TimelineEventQueryParams } from "./timeline-controller";
import { deriveOpenIncidents } from "./timeline-feed-helpers";

interface UseTimelineFeedDataArgs {
  queryParams: TimelineEventQueryParams;
  permalinkId: string;
  nowMs: number;
}
export function useTimelineFeedData({ queryParams, permalinkId, nowMs }: UseTimelineFeedDataArgs) {
  const events = useEvents(queryParams, { autoLoadAll: false });

  const {
    data: { events: rawEvents },
    pages,
  } = events;

  // Peg is filtered server-side (`pegCurrency` SQL clause in /api/events);
  // no client-side re-filter is needed.
  const visibleEvents = rawEvents;
  const openIncidents = useMemo(() => deriveOpenIncidents(visibleEvents), [visibleEvents]);

  // Per-page digestion + seam reducer. Each TanStack Query page reference is
  // stable across renders (see use-events.ts), so memoising on `pages` keeps
  // Load More O(page-size + seam) instead of O(total).
  const perPageDigests = useMemo(
    () => (pages ? pages.map((page) => digestPage(page.data.events, nowMs)) : []),
    [pages, nowMs],
  );
  const digestedDays = useMemo(() => mergeDigestedPages(perPageDigests), [perPageDigests]);

  // Common case: an internal-link permalink follows from a tracker page and
  // the event is already in the loaded window. Gate the 200-row buffer on
  // the miss so we skip the extra round-trip.
  const isInLoadedFeed = useMemo(
    () => (permalinkId ? rawEvents.some((e) => e.id === permalinkId) : false),
    [permalinkId, rawEvents],
  );
  const permalinkBuffer = useLatestEvents({
    limit: 200,
    enabled: !!permalinkId && !isInLoadedFeed,
  });

  const bufferEvent = useMemo(() => {
    if (!permalinkId || isInLoadedFeed) return null;
    return permalinkBuffer.data?.events.find((e) => e.id === permalinkId) ?? null;
  }, [permalinkId, isInLoadedFeed, permalinkBuffer.data]);
  const permalinkResolved = !!permalinkId && (isInLoadedFeed || bufferEvent != null);

  return {
    events,
    visibleEvents,
    openIncidents,
    digestedDays,
    permalinkBuffer,
    bufferEvent,
    permalinkResolved,
  };
}
