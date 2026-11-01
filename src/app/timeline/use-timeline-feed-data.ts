"use client";

import { useMemo } from "react";
import { useEvents, useLatestEvents } from "@/hooks/use-events";
import { projectTapeEventsForReader } from "@/lib/tape-derive";
import { digestPage, mergeDigestedPages } from "@/lib/tape-digest";
import type { TimelineEventQueryParams } from "./timeline-controller";
import { useActiveDepegEvents } from "@/hooks/use-depeg-events";
import { deriveDataHealth } from "@/lib/data-health";
import { CRON_15MIN } from "@/lib/cron-intervals";

export type TimelineActiveStatus = "available" | "retained" | "loading" | "incomplete" | "unavailable";

interface UseTimelineFeedDataArgs {
  queryParams: TimelineEventQueryParams;
  permalinkId: string;
  nowMs: number;
}
export function useTimelineFeedData({ queryParams, permalinkId, nowMs }: UseTimelineFeedDataArgs) {
  const events = useEvents(queryParams, { autoLoadAll: false });
  const activeIncidents = useActiveDepegEvents({ autoLoadAll: true });
  const activeHealth = deriveDataHealth({
    label: "Active incidents",
    staleTime: CRON_15MIN,
    dataUpdatedAt: activeIncidents.dataUpdatedAt,
    meta: activeIncidents.meta,
    error: activeIncidents.error,
    hasData: activeIncidents.data != null,
  }, nowMs);
  // A complete cached census stays a dated observation through failed or aged refreshes; the
  // shared hook's `isFullyLoaded` also folds in transport errors, so completeness is assessed here.
  const activeData = activeIncidents.data;
  const activeCensusComplete = activeData != null && !activeIncidents.isLoading && activeData.nextCursor == null
    && !activeIncidents.hasNextPage && !activeIncidents.isAutoLoadCapped && !activeIncidents.isFetchingNextPage
    && (!activeData.totalExact || activeData.total === 0 || activeData.events.length >= activeData.total);
  const activeStatus: TimelineActiveStatus = activeIncidents.isFullyLoaded && activeHealth.state === "fresh" ? "available"
    : activeCensusComplete && activeHealth.dataUpdatedAt > 0 ? "retained"
    : activeIncidents.error ? "unavailable"
    : activeIncidents.isLoading ? "loading"
    : !activeData ? "unavailable"
    : !activeIncidents.isFullyLoaded ? "incomplete"
    : "unavailable";

  const {
    data: { events: rawEvents },
    pages,
  } = events;

  // Peg is filtered server-side (`pegCurrency` SQL clause in /api/events);
  // no client-side re-filter is needed.
  // Operational yield advisories are projected out of every reader surface;
  // raw events and cursors still drive pagination.
  const visibleEvents = useMemo(() => projectTapeEventsForReader(rawEvents), [rawEvents]);
  const suppressedCount = rawEvents.length - visibleEvents.length;
  // Only a complete, fresh canonical read can establish current activity; a retained
  // complete read is shown as of its producer observation. Tape openings, recoveries
  // and filters never participate in this authority.
  const openIncidents = useMemo(
    () => activeStatus === "available" || activeStatus === "retained"
      ? [...activeIncidents.data!.events].sort((a, b) => a.startedAt - b.startedAt || a.id - b.id)
      : null,
    [activeStatus, activeIncidents.data],
  );

  // Per-page digestion + seam reducer. Each TanStack Query page reference is
  // stable across renders (see use-events.ts), so memoising on `pages` keeps
  // Load More O(page-size + seam) instead of O(total).
  const perPageDigests = useMemo(
    () => (pages ? pages.map((page) => digestPage(projectTapeEventsForReader(page.data.events), nowMs)) : []),
    [pages, nowMs],
  );
  const digestedDays = useMemo(() => mergeDigestedPages(perPageDigests), [perPageDigests]);

  // A permalink miss resolves one exact identity, never a capped latest page.
  // Existing loaded events still avoid a redundant round-trip.
  const isInLoadedFeed = useMemo(
    () => (permalinkId ? rawEvents.some((e) => e.id === permalinkId) : false),
    [permalinkId, rawEvents],
  );
  const permalinkBuffer = useLatestEvents({
    eventId: permalinkId,
    enabled: !!permalinkId && !isInLoadedFeed,
  });

  const rawBufferEvent = useMemo(() => {
    if (!permalinkId || isInLoadedFeed) return null;
    return permalinkBuffer.data?.events.find((e) => e.id === permalinkId) ?? null;
  }, [permalinkId, isInLoadedFeed, permalinkBuffer.data]);
  const bufferEvent = useMemo(
    () => (rawBufferEvent ? projectTapeEventsForReader([rawBufferEvent])[0] ?? null : null),
    [rawBufferEvent],
  );
  // A linked event that exists but is suppressed is resolved, not a missing identity.
  const permalinkSuppressed = rawBufferEvent != null && bufferEvent == null;
  const permalinkResolved = !!permalinkId && (isInLoadedFeed || rawBufferEvent != null);

  // The server total counts suppressed rows too, so a visible total is only
  // known once the raw traversal is complete.
  const visibleTotal: number | null = events.hasNextPage
    ? null
    : suppressedCount === 0 ? events.total : visibleEvents.length;

  return {
    events,
    visibleEvents,
    openIncidents,
    activeIncidents,
    activeStatus,
    activeHealth,
    digestedDays,
    permalinkBuffer,
    bufferEvent,
    permalinkSuppressed,
    permalinkResolved,
    visibleTotal,
  };
}
