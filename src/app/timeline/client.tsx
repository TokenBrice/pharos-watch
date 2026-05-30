"use client";

import { useCallback, useMemo, useState } from "react";
import { CoinCrossTrackerHatnote } from "@/components/coin-cross-tracker-hatnote";
import { TapeFilters, readTapeFilterState, tapeWindowSince, TAPE_DEFAULT_SEVERITY } from "@/components/tape/tape-filters";
import { SEVERITY_LABEL } from "@/components/tape/event-card";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { useLogos } from "@/hooks/use-logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { SummaryBand } from "./timeline-feed-sections";
import { TimelineFeed } from "./timeline-feed";
import { useTimelineFeedData } from "./use-timeline-feed-data";
import { useTimelineFeedInteractions } from "./use-timeline-feed-interactions";
import { useTimelinePhosphor } from "./use-timeline-phosphor";
import {
  WINDOW_LABEL,
  buildTimelineFeedController,
  buildTimelineResetParams,
  type ActiveFilterChip,
} from "./timeline-controller";

export {
  buildTimelineFeedController,
  buildTimelineFilterSignature,
  buildTimelineResetParams,
} from "./timeline-controller";

export type {
  TimelineEventQueryParams,
  TimelineFeedController,
} from "./timeline-controller";

export function TimelineClient() {
  const { getParam, setParam, setParams } = useUrlFilters();
  const filters = readTapeFilterState(getParam);
  const { data: logos } = useLogos();
  const [nowMs] = useState(() => Date.now());

  // Pass `nowMs` (frozen at mount) so the queryKey stays stable across
  // renders — otherwise `tapeWindowSince` calls Date.now() each render and
  // the infinite query restarts every tick.
  const since = tapeWindowSince(filters.window, nowMs);
  const feedController = useMemo(
    () => buildTimelineFeedController(filters, since),
    [filters, since],
  );

  const permalinkId = getParam("event", "");
  const feed = useTimelineFeedData({
    queryParams: feedController.queryParams,
    permalinkId,
    nowMs,
  });

  const {
    data: { events: rawEvents, nextCursor },
    isLoading,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    meta,
    dataUpdatedAt,
    total,
  } = feed.events;

  const interactions = useTimelineFeedInteractions({
    filterSignature: feedController.filterSignature,
    permalinkId,
    permalinkResolved: feed.permalinkResolved,
    loadedCount: feed.visibleEvents.length,
    total,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  });

  const handleClearFilters = useCallback(() => {
    setParams(buildTimelineResetParams());
  }, [setParams]);

  const emptyStateChips: ActiveFilterChip[] = useMemo(() => {
    const chips: ActiveFilterChip[] = [];
    if (filters.window !== "7d") {
      chips.push({ key: "window", label: `Window: ${WINDOW_LABEL[filters.window]}`, onClear: () => setParam("window", "7d") });
    }
    if (filters.severity !== TAPE_DEFAULT_SEVERITY) {
      chips.push({ key: "severity", label: `Severity: ${SEVERITY_LABEL[filters.severity]}`, onClear: () => setParam("severity", "") });
    }
    if (filters.chain !== "all") {
      chips.push({ key: "chain", label: `Chain: ${filters.chain}`, onClear: () => setParam("chain", "all") });
    }
    if (filters.peg !== "all") {
      chips.push({ key: "peg", label: `Peg: ${filters.peg}`, onClear: () => setParam("peg", "all") });
    }
    if (filters.type.length > 0) {
      chips.push({ key: "type", label: `${filters.type.length} class filter${filters.type.length === 1 ? "" : "s"}`, onClear: () => setParam("type", "") });
    }
    if (filters.coin !== "") {
      chips.push({ key: "coin", label: `Coin: ${filters.coin}`, onClear: () => setParam("coin", "") });
    }
    if (filters.q !== "") {
      chips.push({ key: "q", label: `Search: "${filters.q}"`, onClear: () => setParam("q", "") });
    }
    return chips;
  }, [filters.window, filters.severity, filters.chain, filters.peg, filters.type, filters.coin, filters.q, setParam]);

  // Empty-state fallback prefers the smallest step that widens the view:
  // clear active filters → drop severity floor → widen window. `alltime` URL
  // token bypasses the "all" sentinel in useUrlFilters.
  const emptyStateFallback: { label: string; apply: () => void } = feedController.hasActiveFilters
    ? { label: "Reset all filters", apply: handleClearFilters }
    : filters.severity !== "info"
    ? { label: "Show info-tier too", apply: () => setParam("severity", "info") }
    : { label: "Widen to all time", apply: () => setParam("window", "alltime") };

  const { phosphorActive, phosphorToggleVisible, togglePhosphor } = useTimelinePhosphor();
  const focusedCoinMeta = filters.coin ? TRACKED_META_BY_ID.get(filters.coin) : null;
  const lastEventTs = rawEvents.length > 0 ? rawEvents[0].ts : null;

  return (
    <div className={`space-y-6${phosphorActive ? " phosphor-green" : ""}`}>
      <a
        href="#tape-feed"
        className="pharos-focus-ring sr-only rounded-md bg-background px-3 py-1.5 text-xs font-medium focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
      >
        Skip to events
      </a>

      {focusedCoinMeta ? (
        <CoinCrossTrackerHatnote
          coinId={focusedCoinMeta.id}
          coinSymbol={focusedCoinMeta.symbol}
          currentTracker="timeline"
        />
      ) : null}

      <SummaryBand
        loadedCount={feed.visibleEvents.length}
        totalCount={total}
        openCount={feed.openIncidents.length}
        windowLabel={feedController.windowLabel}
        severityLabel={feedController.severityLabel}
        dataUpdatedAt={dataUpdatedAt}
        nowMs={nowMs}
        lastEventTs={lastEventTs}
        phosphor={phosphorActive}
        showPhosphorToggle={phosphorToggleVisible}
        onTogglePhosphor={togglePhosphor}
      />

      <TapeFilters
        state={filters}
        setParam={setParam}
        coin={filters.coin || undefined}
        onClearCoin={filters.coin ? () => setParam("coin", "") : undefined}
      />

      <TimelineFeed
        filters={filters}
        controller={feedController}
        logos={logos}
        nowMs={nowMs}
        rawEvents={rawEvents}
        visibleEvents={feed.visibleEvents}
        openIncidents={feed.openIncidents}
        digestedDays={feed.digestedDays}
        isLoading={isLoading}
        error={error}
        refetch={refetch}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        nextCursor={nextCursor}
        total={total}
        meta={meta}
        dataUpdatedAt={dataUpdatedAt}
        permalinkId={permalinkId}
        permalinkBufferIsLoading={feed.permalinkBuffer.isLoading}
        bufferEvent={feed.bufferEvent}
        highlightedId={interactions.highlightedId}
        loadAnnouncement={interactions.loadAnnouncement}
        emptyStateChips={emptyStateChips}
        emptyStateFallback={emptyStateFallback}
        onLoadMore={interactions.handleLoadMore}
        sentinelRef={interactions.sentinelRef}
      />
    </div>
  );
}
