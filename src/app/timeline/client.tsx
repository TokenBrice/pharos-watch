"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Radar, AlertTriangle, Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { useEvents, useLatestEvents } from "@/hooks/use-events";
import { useLogos } from "@/hooks/use-logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { EventCard, SEVERITY_LABEL } from "@/components/tape/event-card";
import { ClassDigestRow } from "@/components/tape/class-digest-row";
import {
  TapeFilters,
  readTapeFilterState,
  tapeWindowSince,
  TAPE_DEFAULT_SEVERITY,
  type TapeWindowKey,
} from "@/components/tape/tape-filters";
import { digestByDay, type DigestedDay } from "@/lib/tape-digest";
import { timeAgo } from "@shared/lib/format";
import type { TapeEvent } from "@shared/types/tape-event";

const HIGHLIGHT_DURATION_MS = 2000;
const DAY_MS = 86_400_000;
const TAPE_FRESH_WINDOW_MS = 10 * 60 * 1000;

const WINDOW_LABEL: Record<TapeWindowKey, string> = {
  "24h": "last 24h",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
  all: "all time",
};

function EventSkeleton() {
  return (
    <div className="divide-y divide-border/30 border-y border-border/30" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-none" />
      ))}
    </div>
  );
}

interface ActiveFilterChip {
  key: string;
  label: string;
  onClear: () => void;
}

function EmptyState({
  onClearAll,
  activeChips,
}: {
  onClearAll: () => void;
  activeChips: readonly ActiveFilterChip[];
}) {
  return (
    <div className="border-y border-border/30 px-3 py-10 text-center font-mono text-xs text-muted-foreground">
      <Radar className="mx-auto mb-3 h-6 w-6 text-muted-foreground" aria-hidden="true" />
      <p className="uppercase tracking-wider text-foreground">No events match these filters.</p>
      {activeChips.length > 0 ? (
        <>
          <p className="mt-1">Remove a filter to widen the view:</p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.onClear}
                className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-none border border-border/60 px-2 py-0.5 font-mono text-xs uppercase tracking-wide text-foreground hover:bg-accent/40"
              >
                <span>{chip.label}</span>
                <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" className="mt-4 font-mono text-xs uppercase tracking-wide text-muted-foreground" onClick={onClearAll}>
            Reset all filters
          </Button>
        </>
      ) : (
        <>
          <p className="mt-1">Try widening the time window or dropping the severity floor.</p>
          <Button variant="outline" size="sm" className="mt-4 font-mono uppercase tracking-wide" onClick={onClearAll}>
            Widen to all time
          </Button>
        </>
      )}
    </div>
  );
}

function eventDomId(eventId: string): string {
  return `tape-event-card-${eventId}`;
}

function passesPegFilter(event: TapeEvent, peg: string): boolean {
  if (peg === "all" || !peg) return true;
  return event.pegCurrency === peg;
}

function utcDayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function formatDayLabel(dayKey: string, nowMs: number): { primary: string; secondary: string } {
  const todayKey = utcDayKey(nowMs);
  const yesterdayKey = utcDayKey(nowMs - DAY_MS);
  const date = new Date(`${dayKey}T00:00:00Z`);
  const absolute = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  if (dayKey === todayKey) return { primary: "Today", secondary: absolute };
  if (dayKey === yesterdayKey) return { primary: "Yesterday", secondary: absolute };
  const weekday = date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return { primary: weekday, secondary: absolute };
}

// Pair `depeg.opened` events against `depeg.resolved` events with the same
// `sourceRowId` within the same dataset; an unmatched opened row is treated
// as currently active. Window-scoped: depegs whose opened/resolved rows fall
// outside the current view will be missed. Dedupes per-coin to keep the
// banner glanceable.
function deriveOpenIncidents(events: readonly TapeEvent[]): TapeEvent[] {
  const resolvedSourceRowIds = new Set<string>();
  for (const e of events) {
    if (e.type === "depeg.resolved") resolvedSourceRowIds.add(e.sourceRowId);
  }
  const seenCoins = new Set<string>();
  const out: TapeEvent[] = [];
  for (const e of events) {
    if (e.type !== "depeg.opened") continue;
    if (resolvedSourceRowIds.has(e.sourceRowId)) continue;
    const coin = e.coinId ?? "";
    if (coin && seenCoins.has(coin)) continue;
    if (coin) seenCoins.add(coin);
    out.push(e);
  }
  return out;
}

interface SummaryBandProps {
  loadedCount: number;
  totalCount: number | null;
  openCount: number;
  windowLabel: string;
  severityLabel: string;
  dataUpdatedAt: number;
  nowMs: number;
}

function SummaryBand({ loadedCount, totalCount, openCount, windowLabel, severityLabel, dataUpdatedAt, nowMs }: SummaryBandProps) {
  const showsPartial = totalCount != null && totalCount > loadedCount;
  const countNode = showsPartial ? (
    <span className="font-semibold text-foreground">
      Showing {loadedCount.toLocaleString()} of {totalCount!.toLocaleString()} events
    </span>
  ) : (
    <span className="font-semibold text-foreground">
      {loadedCount.toLocaleString()} {loadedCount === 1 ? "event" : "events"}
    </span>
  );
  const parts: React.ReactNode[] = [];
  if (openCount > 0) {
    parts.push(
      <span key="open" className="font-semibold text-amber-700 dark:text-amber-400">
        {openCount} open {openCount === 1 ? "incident" : "incidents"}
      </span>,
    );
  }
  parts.push(countNode);
  parts.push(<span key="window">{windowLabel}</span>);
  parts.push(<span key="severity">{severityLabel}</span>);
  const isFresh = dataUpdatedAt > 0 && nowMs - dataUpdatedAt < TAPE_FRESH_WINDOW_MS;
  if (dataUpdatedAt > 0) {
    parts.push(
      <span key="updated" className="inline-flex items-center gap-1.5">
        {isFresh ? (
          <span className="relative inline-flex h-1.5 w-1.5" aria-hidden="true">
            <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
        ) : null}
        <span>Updated {timeAgo(Math.floor(dataUpdatedAt / 1000))}</span>
      </span>,
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
      {parts.map((part, i) => (
        <span key={i} className="contents">
          {i > 0 ? <span aria-hidden="true">·</span> : null}
          {part}
        </span>
      ))}
    </p>
  );
}

interface OpenIncidentsSectionProps {
  incidents: readonly TapeEvent[];
  logos: Record<string, string>;
}

function OpenIncidentsSection({ incidents, logos }: OpenIncidentsSectionProps) {
  return (
    <section aria-labelledby="tape-open-incidents-heading" className="space-y-1">
      <h2
        id="tape-open-incidents-heading"
        className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-amber-700 dark:text-amber-400"
      >
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        ⚠ Currently open · {incidents.length} {incidents.length === 1 ? "incident" : "incidents"}
      </h2>
      <div className="border-y border-amber-500/30">
        {incidents.map((event) => (
          <EventCard
            key={event.id}
            event={event}
            logoSrc={event.coinId ? logos[event.coinId] : undefined}
          />
        ))}
      </div>
    </section>
  );
}

interface DayDigestSectionProps {
  day: DigestedDay;
  nowMs: number;
  logos: Record<string, string>;
  highlightedId: string | null;
}

function DayDigestSection({ day, nowMs, logos, highlightedId }: DayDigestSectionProps) {
  const { primary, secondary } = formatDayLabel(day.dayKey, nowMs);
  const classCount = day.classes.length;
  return (
    <section aria-label={`${primary} ${secondary}`}>
      <div className="sticky top-0 z-10 -mx-1 bg-background/90 px-1 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          <span aria-hidden="true">───</span>
          <h3 className="shrink-0 text-foreground">
            {primary} <span className="text-muted-foreground">· {secondary}</span>
          </h3>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            · {day.totalCount} {day.totalCount === 1 ? "event" : "events"} · {classCount} {classCount === 1 ? "class" : "classes"}
          </span>
          <span aria-hidden="true" className="flex-1 border-t border-border/40" />
        </div>
      </div>
      <div>
        {day.classes.map((digest) => (
          <ClassDigestRow
            key={`${day.dayKey}-${digest.classSlug}`}
            digest={digest}
            logos={logos}
            highlightedId={highlightedId}
            eventDomId={eventDomId}
          />
        ))}
      </div>
    </section>
  );
}

export function TimelineClient() {
  const { getParam, setParam, setParams } = useUrlFilters();
  const filters = readTapeFilterState(getParam);
  const { data: logos } = useLogos();
  const [nowMs] = useState(() => Date.now());

  const since = useMemo(
    () => tapeWindowSince(filters.window),
    [filters.window],
  );

  const events = useEvents(
    {
      type: filters.type.length > 0 ? filters.type : undefined,
      coin: filters.coin || undefined,
      pegCurrency: filters.peg !== "all" ? filters.peg : undefined,
      chain: filters.chain !== "all" ? filters.chain : undefined,
      severityFloor: filters.severity,
      since,
      q: filters.q || undefined,
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
    total,
  } = events;

  const visibleEvents = useMemo(
    () => rawEvents.filter((event) => passesPegFilter(event, filters.peg)),
    [rawEvents, filters.peg],
  );

  const openIncidents = useMemo(() => deriveOpenIncidents(visibleEvents), [visibleEvents]);
  const digestedDays = useMemo(() => digestByDay(visibleEvents, nowMs), [visibleEvents, nowMs]);

  const permalinkId = getParam("event", "");
  const [autoLoadEnabled, setAutoLoadEnabled] = useState(false);
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

  useEffect(() => {
    if (!permalinkResolved || !permalinkId) {
      return undefined;
    }
    if (typeof window === "undefined") return undefined;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlightedId(permalinkId);
    const rafId = window.requestAnimationFrame(() => {
      // Expand any <details> ancestor of the target so the row is visible.
      const el = document.getElementById(eventDomId(permalinkId));
      if (el) {
        let parent: HTMLElement | null = el.parentElement;
        while (parent) {
          if (parent.tagName === "DETAILS") {
            (parent as HTMLDetailsElement).open = true;
          }
          parent = parent.parentElement;
        }
        if (typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    });
    const timeoutId = window.setTimeout(() => {
      setHighlightedId((current) => (current === permalinkId ? null : current));
    }, HIGHLIGHT_DURATION_MS);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timeoutId);
    };
  }, [permalinkResolved, permalinkId]);

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
    filters.severity !== TAPE_DEFAULT_SEVERITY ||
    filters.coin !== "" ||
    filters.peg !== "all" ||
    filters.chain !== "all" ||
    filters.q !== "" ||
    filters.window !== "7d";

  const severityLabel = `${SEVERITY_LABEL[filters.severity]} severity`;

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
  }, [filters, setParam]);

  const emptyStateFallback = useCallback(() => {
    if (hasActiveFilters) handleClearFilters();
    // Write the alltime URL token to bypass the "all" sentinel in useUrlFilters.
    else setParam("window", "alltime");
  }, [hasActiveFilters, handleClearFilters, setParam]);

  return (
    <div className="space-y-6">
      <a
        href="#tape-feed"
        className="pharos-focus-ring sr-only rounded-md bg-background px-3 py-1.5 text-xs font-medium focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
      >
        Skip to events
      </a>

      <SummaryBand
        loadedCount={visibleEvents.length}
        totalCount={total}
        openCount={openIncidents.length}
        windowLabel={WINDOW_LABEL[filters.window]}
        severityLabel={severityLabel}
        dataUpdatedAt={dataUpdatedAt}
        nowMs={nowMs}
      />

      {filters.coin ? (
        <div>
          <button
            type="button"
            onClick={() => setParam("coin", "")}
            className="pharos-focus-ring inline-flex items-center gap-1.5 border border-border/60 px-2 py-0.5 font-mono text-xs uppercase tracking-wide text-foreground hover:bg-accent/40"
            aria-label={`Clear coin filter ${filters.coin}`}
          >
            <span>Filtered to <span className="font-semibold">{filters.coin}</span></span>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ) : null}

      <TapeFilters state={filters} setParam={setParam} />

      <StaleDataBanner
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

      {error ? (
        <QueryErrorNotice error={error} hasData={rawEvents.length > 0} onRetry={() => void refetch()} />
      ) : null}

      {permalinkId && !permalinkBuffer.isLoading && !bufferEvent && !rawEvents.some((e) => e.id === permalinkId) ? (
        <div
          title={permalinkId}
          className="border-y border-amber-500/30 px-3 py-2 font-mono text-xs text-amber-700 dark:text-amber-400"
        >
          ⚠ The linked event isn&apos;t in this view. Try widening the filters or removing the time window.
        </div>
      ) : null}

      {bufferEvent ? (
        <section aria-labelledby="tape-linked-event-heading" className="space-y-1">
          <h2 id="tape-linked-event-heading" className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-foreground/70">
            <Link2 className="h-3 w-3" aria-hidden="true" />
            ↗ You followed a link to this event
          </h2>
          <div className="border-y border-border/40">
            <EventCard
              event={bufferEvent}
              logoSrc={bufferEvent.coinId ? logos[bufferEvent.coinId] : undefined}
              highlighted={highlightedId === bufferEvent.id}
              domId={eventDomId(bufferEvent.id)}
            />
          </div>
        </section>
      ) : null}

      {openIncidents.length > 0 ? (
        <OpenIncidentsSection incidents={openIncidents} logos={logos} />
      ) : null}

      {isLoading ? (
        <EventSkeleton />
      ) : visibleEvents.length === 0 ? (
        <EmptyState onClearAll={emptyStateFallback} activeChips={emptyStateChips} />
      ) : (
        <div id="tape-feed" className="space-y-4" aria-live="polite">
          {digestedDays.map((day) => (
            <DayDigestSection
              key={day.dayKey}
              day={day}
              nowMs={nowMs}
              logos={logos}
              highlightedId={highlightedId}
            />
          ))}
          {hasNextPage ? (
            <div className="pt-2 text-center">
              <Button variant="outline" size="sm" onClick={handleLoadMore} disabled={isFetchingNextPage}>
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
            <p className="pt-2 text-center font-mono text-[11px] uppercase tracking-wider text-muted-foreground">─── End of timeline ───</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
