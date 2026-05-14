"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { useEvents, useLatestEvents } from "@/hooks/use-events";
import { useLogos } from "@/hooks/use-logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { EventCard } from "@/components/tape/event-card";
import {
  TapeFilters,
  readTapeFilterState,
  tapeWindowSince,
} from "@/components/tape/tape-filters";
import { TapeKpiStrip } from "@/components/tape/tape-kpi-strip";
import type { TapeEvent } from "@shared/types/tape-event";

const HIGHLIGHT_DURATION_MS = 2000;

function EventSkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-lg" />
      ))}
    </div>
  );
}

function EmptyState({ onClear }: { onClear: () => void }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 px-6 py-12 text-center text-sm text-muted-foreground">
      <Calendar className="mx-auto mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <p className="font-medium text-foreground">No events match these filters.</p>
      <p className="mt-1">Try widening the time window or clearing the type chips.</p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}

function eventDomId(eventId: string): string {
  return `tape-event-card-${eventId}`;
}

function passesClientFilters(event: TapeEvent, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    event.title.toLowerCase().includes(q) ||
    event.summary.toLowerCase().includes(q) ||
    (event.coinId ?? "").toLowerCase().includes(q)
  );
}

function passesPegFilter(event: TapeEvent, peg: string): boolean {
  if (peg === "all" || !peg) return true;
  return event.pegCurrency === peg;
}

export function TapeClient() {
  const { getParam, setParam, setParams } = useUrlFilters();
  const filters = readTapeFilterState(getParam);
  const { data: logos } = useLogos();

  // Convert window → since (ms).
  const since = useMemo(
    () => tapeWindowSince(filters.window),
    [filters.window],
  );

  // `type` is a multi-select wildcard list; pass through directly.
  const events = useEvents(
    {
      type: filters.type.length > 0 ? filters.type : undefined,
      coin: filters.coin || undefined,
      pegCurrency: filters.peg !== "all" ? filters.peg : undefined,
      chain: filters.chain !== "all" ? filters.chain : undefined,
      severityFloor: filters.severity ?? undefined,
      since,
    },
    { autoLoadAll: false },
  );

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
  } = events;

  const visibleEvents = useMemo(
    () =>
      rawEvents.filter((event) => passesPegFilter(event, filters.peg) && passesClientFilters(event, filters.q)),
    [rawEvents, filters.peg, filters.q],
  );

  // Permalink: `?event=<id>` deep-link. Fetch a small recent window first; if
  // the id is not present, surface a notice and fall back to the loaded view.
  const permalinkId = getParam("event", "");
  const [autoLoadEnabled, setAutoLoadEnabled] = useState(false);
  // The currently-lit event id. We mark it lit when scroll lands and clear it
  // ~2s later. Single state owned by the timer effect — no derive-from-prop.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const permalinkBuffer = useLatestEvents({
    limit: 200,
    enabled: !!permalinkId,
  });

  const isInLoadedFeed = useMemo(
    () => (permalinkId ? rawEvents.some((e) => e.id === permalinkId) : false),
    [permalinkId, rawEvents],
  );
  const bufferEvent = useMemo(() => {
    if (!permalinkId || isInLoadedFeed) return null;
    return permalinkBuffer.data?.events.find((e) => e.id === permalinkId) ?? null;
  }, [permalinkId, isInLoadedFeed, permalinkBuffer.data]);
  const permalinkResolved = !!permalinkId && (isInLoadedFeed || bufferEvent != null);

  // Scroll-into-view + 2s highlight. The effect keys on the resolved id so
  // changing the URL param naturally restarts the timer.
  useEffect(() => {
    if (!permalinkResolved || !permalinkId) {
      return undefined;
    }
    if (typeof window === "undefined") return undefined;
    // Light the row up after paint; cleared by the timer below. The
    // permalink-id dependency means this only fires when the URL changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlightedId(permalinkId);
    const rafId = window.requestAnimationFrame(() => {
      const el = document.getElementById(eventDomId(permalinkId));
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
    const timeoutId = window.setTimeout(() => {
      // Clear after the highlight duration. Using a functional setter keeps
      // the effect dependency-free of `highlightedId`.
      setHighlightedId((current) => (current === permalinkId ? null : current));
    }, HIGHLIGHT_DURATION_MS);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timeoutId);
    };
  }, [permalinkResolved, permalinkId]);

  // Intersection-observer autoload after first manual click.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!autoLoadEnabled) return;
    const node = sentinelRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && hasNextPage && !isFetchingNextPage) {
            void fetchNextPage();
          }
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [autoLoadEnabled, fetchNextPage, hasNextPage, isFetchingNextPage]);

  const handleLoadMore = useCallback(() => {
    setAutoLoadEnabled(true);
    void fetchNextPage();
  }, [fetchNextPage]);

  const handleClearFilters = useCallback(() => {
    setParams({
      type: "",
      severity: "",
      coin: "",
      peg: "all",
      chain: "all",
      window: "7d",
      q: "",
    });
  }, [setParams]);

  const hasActiveFilters =
    filters.type.length > 0 ||
    filters.severity != null ||
    filters.coin !== "" ||
    filters.peg !== "all" ||
    filters.chain !== "all" ||
    filters.q !== "" ||
    filters.window !== "7d";

  return (
    <div className="space-y-6">
      <TapeKpiStrip />

      <TapeFilters state={filters} setParam={setParam} />

      <StaleDataBanner
        queries={[
          {
            label: "Tape",
            dataUpdatedAt,
            error,
            hasData: rawEvents.length > 0,
            meta,
          },
        ]}
      />

      {error ? (
        <QueryErrorNotice error={error} hasData={rawEvents.length > 0} onRetry={() => void refetch()} />
      ) : null}

      {permalinkId && !permalinkBuffer.isLoading && !bufferEvent && !rawEvents.some((e) => e.id === permalinkId) ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          Event <code className="font-mono text-xs">{permalinkId}</code> isn&apos;t in this view. Try widening the
          filters or removing the time window.
        </div>
      ) : null}

      {bufferEvent ? (
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Linked event</p>
          <EventCard
            event={bufferEvent}
            logoSrc={bufferEvent.coinId ? logos[bufferEvent.coinId] : undefined}
            highlighted={highlightedId === bufferEvent.id}
            domId={eventDomId(bufferEvent.id)}
          />
        </div>
      ) : null}

      {isLoading ? (
        <EventSkeleton />
      ) : visibleEvents.length === 0 ? (
        <EmptyState onClear={hasActiveFilters ? handleClearFilters : () => setParam("window", "all")} />
      ) : (
        <div className="space-y-2" aria-live="polite">
          {visibleEvents.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              logoSrc={event.coinId ? logos[event.coinId] : undefined}
              highlighted={highlightedId === event.id}
              domId={eventDomId(event.id)}
            />
          ))}
          {hasNextPage ? (
            <div className="pt-2 text-center">
              <Button variant="outline" size="sm" onClick={handleLoadMore} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
              <div ref={sentinelRef} aria-hidden="true" />
            </div>
          ) : nextCursor == null && rawEvents.length > 0 ? (
            <p className="pt-2 text-center text-xs text-muted-foreground">End of tape.</p>
          ) : null}
        </div>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        Browse by class:{" "}
        <Link href="/depeg/" className="underline-offset-4 hover:underline">Depeg Tracker</Link>
        {" · "}
        <Link href="/freezewatch/" className="underline-offset-4 hover:underline">FreezeWatch</Link>
        {" · "}
        <Link href="/flows/" className="underline-offset-4 hover:underline">Mint/Burn Flows</Link>
        {" · "}
        <Link href="/safety-scores/" className="underline-offset-4 hover:underline">Safety Scores</Link>
      </p>
    </div>
  );
}
