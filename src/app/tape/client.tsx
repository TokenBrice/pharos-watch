"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Calendar, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { useEvents, useLatestEvents } from "@/hooks/use-events";
import { useLogos } from "@/hooks/use-logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { EventCard, SEVERITY_LABEL } from "@/components/tape/event-card";
import {
  TapeFilters,
  readTapeFilterState,
  tapeWindowSince,
  TAPE_DEFAULT_SEVERITY,
  type TapeWindowKey,
} from "@/components/tape/tape-filters";
import { collapseByCoinClass, type CollapsedTapeEntry } from "@/lib/tape-collapse";
import type { TapeEvent } from "@shared/types/tape-event";

const HIGHLIGHT_DURATION_MS = 2000;
const DAY_MS = 86_400_000;

const WINDOW_LABEL: Record<TapeWindowKey, string> = {
  "24h": "last 24h",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
  all: "all time",
};

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
      <p className="mt-1">Try widening the time window, dropping the severity floor, or clearing the type chips.</p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onClear}>
        Reset filters
      </Button>
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

interface DayGroup {
  dayKey: string;
  collapsed: CollapsedTapeEntry[];
}

function groupAndCollapse(events: readonly TapeEvent[]): DayGroup[] {
  const groups: { dayKey: string; events: TapeEvent[] }[] = [];
  const indexByKey = new Map<string, number>();
  for (const event of events) {
    const key = utcDayKey(event.ts);
    const idx = indexByKey.get(key);
    if (idx != null) {
      groups[idx]!.events.push(event);
    } else {
      indexByKey.set(key, groups.length);
      groups.push({ dayKey: key, events: [event] });
    }
  }
  return groups.map((g) => ({ dayKey: g.dayKey, collapsed: collapseByCoinClass(g.events) }));
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
}

function SummaryBand({ loadedCount, totalCount, openCount, windowLabel, severityLabel }: SummaryBandProps) {
  const showsPartial = totalCount != null && totalCount > loadedCount;
  const countNode = showsPartial ? (
    <span className="font-medium text-foreground">
      Showing {loadedCount.toLocaleString()} of {totalCount!.toLocaleString()} events
    </span>
  ) : (
    <span className="font-medium text-foreground">
      {loadedCount.toLocaleString()} {loadedCount === 1 ? "event" : "events"}
    </span>
  );
  const parts: React.ReactNode[] = [
    countNode,
    <span key="window">{windowLabel}</span>,
    <span key="severity">{severityLabel}</span>,
  ];
  if (openCount > 0) {
    parts.splice(1, 0, (
      <span key="open" className="font-medium text-amber-700 dark:text-amber-400">
        {openCount} currently open
      </span>
    ));
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
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
    <section
      aria-labelledby="tape-open-incidents-heading"
      className="pharos-card-shell p-3 space-y-2"
    >
      <h2
        id="tape-open-incidents-heading"
        className="pharos-kicker flex items-center gap-1.5 text-amber-700 dark:text-amber-400"
      >
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        Currently open · {incidents.length} {incidents.length === 1 ? "incident" : "incidents"}
      </h2>
      <div className="space-y-2">
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

interface DayGroupSectionProps {
  group: DayGroup;
  nowMs: number;
  logos: Record<string, string>;
  highlightedId: string | null;
}

function DayGroupSection({ group, nowMs, logos, highlightedId }: DayGroupSectionProps) {
  const { primary, secondary } = formatDayLabel(group.dayKey, nowMs);
  return (
    <section aria-label={`${primary} ${secondary}`} className="space-y-2">
      <div className="flex items-baseline justify-between border-b border-border/50 pb-1.5">
        <h3 className="text-sm font-semibold text-foreground">{primary}</h3>
        <span className="text-[11px] tabular-nums text-muted-foreground">{secondary}</span>
      </div>
      <div className="space-y-2">
        {group.collapsed.map(({ key, event, count }) => (
          <EventCard
            key={key}
            event={event}
            count={count}
            logoSrc={event.coinId ? logos[event.coinId] : undefined}
            highlighted={highlightedId === event.id}
            domId={eventDomId(event.id)}
          />
        ))}
      </div>
    </section>
  );
}

export function TapeClient() {
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
  const dayGroups = useMemo(() => groupAndCollapse(visibleEvents), [visibleEvents]);

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
      const el = document.getElementById(eventDomId(permalinkId));
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
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

  return (
    <div className="space-y-6">
      <SummaryBand
        loadedCount={visibleEvents.length}
        totalCount={total}
        openCount={openIncidents.length}
        windowLabel={WINDOW_LABEL[filters.window]}
        severityLabel={severityLabel}
      />

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

      {openIncidents.length > 0 ? (
        <OpenIncidentsSection incidents={openIncidents} logos={logos} />
      ) : null}

      {isLoading ? (
        <EventSkeleton />
      ) : visibleEvents.length === 0 ? (
        <EmptyState onClear={hasActiveFilters ? handleClearFilters : () => setParam("window", "all")} />
      ) : (
        <div className="space-y-6" aria-live="polite">
          {dayGroups.map((group) => (
            <DayGroupSection
              key={group.dayKey}
              group={group}
              nowMs={nowMs}
              logos={logos}
              highlightedId={highlightedId}
            />
          ))}
          {hasNextPage ? (
            <div className="pt-2 text-center">
              <Button variant="outline" size="sm" onClick={handleLoadMore} disabled={isFetchingNextPage}>
                {isFetchingNextPage
                  ? "Loading…"
                  : total != null && total > rawEvents.length
                    ? `Load more (${(total - rawEvents.length).toLocaleString()} remaining)`
                    : "Load more"}
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
