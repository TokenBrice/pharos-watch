"use client";

import { useMemo, useState } from "react";
import { useEvents, useLatestEvents } from "@/hooks/use-events";
import { ApiFetchError } from "@/lib/api";
import { projectTapeEventsForReader } from "@/lib/tape-derive";
import { digestPage, mergeDigestedPages } from "@/lib/tape-digest";
import type { TimelineEventQueryParams } from "./timeline-controller";
import { useActiveDepegEvents } from "@/hooks/use-depeg-events";
import { deriveDataHealth } from "@/lib/data-health";
import { CRON_15MIN } from "@/lib/cron-intervals";
import { ACTIVE_STABLECOIN_ID_SET } from "@/lib/stablecoin-static-data";
import { DEPEG_CLAIM_RETRACTED_REASON, FLOW_CLAIM_RETRACTED_REASON, FREEZE_CLAIM_RETRACTED_REASON } from "@shared/types/tape-event-constants";

export type TimelineActiveStatus = "available" | "retained" | "loading" | "incomplete" | "unavailable";

interface UseTimelineFeedDataArgs {
  queryParams: TimelineEventQueryParams;
  permalinkId: string;
  nowMs: number;
}

function isRetractedPermalinkError(error: Error | null): boolean {
  if (!(error instanceof ApiFetchError) || error.status !== 404 || !error.bodyText) return false;
  try {
    const body: unknown = JSON.parse(error.bodyText);
    return typeof body === "object" && body !== null && "reason" in body && (
      body.reason === DEPEG_CLAIM_RETRACTED_REASON || body.reason === FLOW_CLAIM_RETRACTED_REASON ||
      body.reason === FREEZE_CLAIM_RETRACTED_REASON
    );
  } catch {
    return false;
  }
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

  // A permalink miss resolves one exact identity. Loaded events avoid a redundant round-trip.
  const isInLoadedFeed = useMemo(
    () => (permalinkId ? rawEvents.some((e) => e.id === permalinkId) : false),
    [permalinkId, rawEvents],
  );
  const [retractedEventIds, setRetractedEventIds] = useState<ReadonlySet<string>>(() => new Set());
  const permalinkRetracted = retractedEventIds.has(permalinkId);
  const permalinkBuffer = useLatestEvents({
    eventId: permalinkId,
    enabled: !!permalinkId && !isInLoadedFeed && !permalinkRetracted,
  });
  // An authoritative withdrawal outlives a later refresh error or a replay of cached rows.
  if (permalinkId && !permalinkRetracted && isRetractedPermalinkError(permalinkBuffer.error)) {
    setRetractedEventIds(new Set([...retractedEventIds, permalinkId]));
  }

  // Peg is filtered server-side (`pegCurrency` SQL clause in /api/events);
  // no client-side re-filter is needed.
  // Operational yield advisories are projected out of every reader surface;
  // raw events and cursors still drive pagination.
  const unretractedEvents = useMemo(
    () => retractedEventIds.size ? rawEvents.filter((event) => !retractedEventIds.has(event.id)) : rawEvents,
    [rawEvents, retractedEventIds],
  );
  const visibleEvents = useMemo(() => projectTapeEventsForReader(unretractedEvents), [unretractedEvents]);
  const suppressedCount = rawEvents.length - visibleEvents.length;
  // Only a complete, fresh canonical read can establish current activity; a retained
  // complete read is shown as of its producer observation. Tape openings, recoveries
  // and filters never participate in this authority. The census is the active
  // registry, as on /depeg/; open records on frozen or retired coins stay apart.
  const openCohorts = useMemo(() => {
    if (activeStatus !== "available" && activeStatus !== "retained") return null;
    const newestFirst = [...activeIncidents.data!.events].sort((a, b) => b.startedAt - a.startedAt || b.id - a.id);
    return {
      census: newestFirst.filter((event) => ACTIVE_STABLECOIN_ID_SET.has(event.stablecoinId)),
      inactive: newestFirst.filter((event) => !ACTIVE_STABLECOIN_ID_SET.has(event.stablecoinId)),
    };
  }, [activeStatus, activeIncidents.data]);
  const openIncidents = openCohorts?.census ?? null;
  const inactiveOpenIncidents = openCohorts?.inactive ?? null;

  // Per-page digestion + seam reducer. Each TanStack Query page reference is
  // stable across renders (see use-events.ts), so memoising on `pages` keeps
  // Load More O(page-size + seam) instead of O(total).
  const perPageDigests = useMemo(
    () => (pages ?? []).map(({ data: { events: pageEvents } }) => {
      const admitted = retractedEventIds.size ? pageEvents.filter((event) => !retractedEventIds.has(event.id)) : pageEvents;
      return digestPage(projectTapeEventsForReader(admitted), nowMs);
    }),
    [pages, nowMs, retractedEventIds],
  );
  const digestedDays = useMemo(() => mergeDigestedPages(perPageDigests), [perPageDigests]);

  const rawBufferEvent = useMemo(() => {
    if (!permalinkId || isInLoadedFeed || permalinkRetracted) return null;
    return permalinkBuffer.data?.events.find((e) => e.id === permalinkId) ?? null;
  }, [permalinkId, isInLoadedFeed, permalinkRetracted, permalinkBuffer.data]);
  const bufferEvent = useMemo(
    () => (rawBufferEvent ? projectTapeEventsForReader([rawBufferEvent])[0] ?? null : null),
    [rawBufferEvent],
  );
  // Operational advisories can still resolve the permalink even if the reader hides them.
  const permalinkResolved = !permalinkRetracted && (isInLoadedFeed || rawBufferEvent != null);

  // The server total counts suppressed and rejected rows too, so a visible
  // total is only known once the raw traversal is complete; the loaded visible
  // rows then carry the honest count.
  const visibleTotal: number | null = events.hasNextPage
    ? null
    : suppressedCount === 0 && events.droppedRows === 0 ? events.total : visibleEvents.length;

  return {
    events,
    visibleEvents,
    openIncidents,
    inactiveOpenIncidents,
    activeIncidents,
    activeStatus,
    activeHealth,
    digestedDays,
    lastEventTs: unretractedEvents[0]?.ts ?? null,
    permalinkBuffer,
    bufferEvent,
    permalinkRetracted,
    permalinkResolved,
    visibleTotal,
  };
}
