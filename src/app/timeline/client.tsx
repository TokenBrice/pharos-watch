"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Radar, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { useEvents, useLatestEvents } from "@/hooks/use-events";
import { useLogos } from "@/hooks/use-logos";
import { useThemeToggle } from "@/hooks/use-theme-toggle";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { EventCard, SEVERITY_GLYPH, SEVERITY_LABEL } from "@/components/tape/event-card";
import { ClassDigestRow } from "@/components/tape/class-digest-row";
import {
  TapeFilters,
  readTapeFilterState,
  tapeWindowSince,
  TAPE_DEFAULT_SEVERITY,
  type TapeWindowKey,
} from "@/components/tape/tape-filters";
import { digestPage, mergeDigestedPages, type DigestedDay } from "@/lib/tape-digest";
import { deriveTicker, utcDayKey } from "@/lib/tape-derive";
import { eventClassSlug } from "@/lib/tape-collapse";
import { timeAgo } from "@shared/lib/format";
import { formatRelativeTimeMs } from "@shared/lib/relative-time";
import {
  SEVERITY_LABEL as SEVERITY_LABEL_BARE,
  type TapeEvent,
  type TapeEventSeverity,
} from "@shared/types/tape-event";

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

// Compact uppercase form used in the status-line footer.
const WINDOW_SHORT: Record<TapeWindowKey, string> = {
  "24h": "24H",
  "7d": "7D",
  "30d": "30D",
  "90d": "90D",
  all: "ALL",
};

function EventSkeleton() {
  return (
    <div className="divide-y divide-border/60 border-y border-border/60" aria-hidden="true">
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
  fallbackLabel,
}: {
  onClearAll: () => void;
  activeChips: readonly ActiveFilterChip[];
  fallbackLabel: string;
}) {
  return (
    <div className="border-y border-border/60 px-3 py-10 text-center font-mono text-xs text-muted-foreground">
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
                aria-label={`Clear filter: ${chip.label}`}
                className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-none border border-border/60 px-3 py-2 font-mono text-xs uppercase tracking-wide text-foreground hover:bg-accent/40 sm:min-h-0 sm:px-2 sm:py-0.5"
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
            {fallbackLabel}
          </Button>
        </>
      )}
    </div>
  );
}

function eventDomId(eventId: string): string {
  return `tape-event-card-${eventId}`;
}

function formatDayLabel(dayKey: string, nowMs: number): { primary: string; secondary: string } {
  const todayKey = utcDayKey(nowMs);
  const yesterdayKey = utcDayKey(nowMs - DAY_MS);
  const date = new Date(`${dayKey}T00:00:00Z`);
  const absoluteFull = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  if (dayKey === todayKey) return { primary: "Today", secondary: absoluteFull };
  if (dayKey === yesterdayKey) return { primary: "Yesterday", secondary: absoluteFull };
  // For older days, drop the weekday word and the redundant year — the
  // weekday abbrev + month/day carries enough context for scanning.
  const weekday = date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }).toUpperCase();
  const absoluteShort = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return { primary: weekday, secondary: absoluteShort };
}

// Pair `depeg.opened` events against `depeg.resolved` events with the same
// `sourceRowId` within the same dataset; an unmatched opened row is treated
// as currently active. Window-scoped: depegs whose opened/resolved rows fall
// outside the current view will be missed. Dedupes per-coin to keep the
// banner glanceable. Sorted by duration desc (oldest open first) so the
// longest-running incidents lead.
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
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function bucketByDay(events: readonly TapeEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    const key = utcDayKey(e.ts);
    out.set(key, (out.get(key) ?? 0) + 1);
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
  lastEventTs: number | null;
  phosphor: boolean;
  showPhosphorToggle: boolean;
  onTogglePhosphor: () => void;
}

function SummaryBand({ loadedCount, totalCount, openCount, windowLabel, severityLabel, dataUpdatedAt, nowMs, lastEventTs, phosphor, showPhosphorToggle, onTogglePhosphor }: SummaryBandProps) {
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
          <span
            aria-hidden="true"
            className="font-mono leading-none text-emerald-600 motion-safe:animate-pulse motion-reduce:animate-none dark:text-emerald-400"
          >
            ▌
          </span>
        ) : null}
        <span>Updated {timeAgo(Math.floor(dataUpdatedAt / 1000))}</span>
      </span>,
    );
  }
  const lastEventNode =
    lastEventTs != null ? (
      <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        Last event: {formatRelativeTimeMs(lastEventTs, { now: nowMs })}{" "}
        <span className="text-muted-foreground/70">· {new Date(lastEventTs).toISOString().replace("T", " ").slice(0, 16)} UTC</span>
      </p>
    ) : null;
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        {parts.map((part, i) => (
          <span key={i} className="contents">
            {i > 0 ? <span aria-hidden="true">·</span> : null}
            {part}
          </span>
        ))}
        {showPhosphorToggle ? (
          <>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={onTogglePhosphor}
              aria-pressed={phosphor}
              aria-label={phosphor ? "Turn off phosphor reading mode" : "Turn on phosphor reading mode"}
              className="phosphor-toggle"
            >
              {phosphor ? "[■] CRT" : "[ ] CRT"}
            </button>
          </>
        ) : null}
      </p>
      {lastEventNode}
    </div>
  );
}

interface OpenIncidentsSectionProps {
  incidents: readonly TapeEvent[];
  logos: Record<string, string>;
  nowMs: number;
}

function openIncidentPrefix(event: TapeEvent, nowMs: number): string {
  const duration = formatRelativeTimeMs(event.ts, { now: nowMs });
  const abs = event.payload?.absDeviationBps;
  const dir = event.payload?.direction;
  if (typeof abs === "number" && (dir === "above" || dir === "below")) {
    const sign = dir === "below" ? "−" : "+";
    return `OPEN ${duration} · ${sign}${abs}bps`;
  }
  return `OPEN ${duration}`;
}

function OpenIncidentsSection({ incidents, logos, nowMs }: OpenIncidentsSectionProps) {
  return (
    <section
      role="region"
      aria-labelledby="tape-open-incidents-heading"
      className="space-y-1"
    >
      <h2
        id="tape-open-incidents-heading"
        className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-amber-700 dark:text-amber-400"
      >
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        Currently open · {incidents.length} {incidents.length === 1 ? "incident" : "incidents"}
      </h2>
      <div className="border-y border-amber-500/30">
        {incidents.map((event) => (
          <div key={event.id}>
            <p className="px-3 pt-2 font-mono text-[11px] uppercase tracking-wider text-amber-700 dark:text-amber-400">
              <span className="font-semibold">[OPEN]</span>
              {" · "}
              {openIncidentPrefix(event, nowMs)}
            </p>
            <EventCard
              event={event}
              logoSrc={event.coinId ? logos[event.coinId] : undefined}
            />
          </div>
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
  openCount: number;
}

function quietDayEventTokens(day: DigestedDay): string[] {
  const out: string[] = [];
  for (const cls of day.classes) {
    for (const entry of cls.collapsed) {
      const ticker = deriveTicker(entry.event);
      const slug = eventClassSlug(entry.event.type);
      out.push(ticker ? `${slug} ${ticker}` : slug);
    }
  }
  return out;
}

function DayDigestSection({ day, nowMs, logos, highlightedId, openCount }: DayDigestSectionProps) {
  const { primary, secondary } = formatDayLabel(day.dayKey, nowMs);
  const classCount = day.classes.length;
  const maxSev: TapeEventSeverity = day.classes[0]?.maxSeverity ?? "info";
  const glyph = SEVERITY_GLYPH[maxSev];
  const isQuiet = day.totalCount <= 3;
  const quietTokens = isQuiet ? quietDayEventTokens(day) : [];
  return (
    <section aria-label={`${primary} ${secondary}`}>
      <div className="sticky top-0 z-10 -mx-1 bg-background/90 px-1 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="flex min-w-0 flex-col items-start gap-1 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground sm:flex-row sm:items-center sm:gap-3">
          <span aria-hidden="true" className="hidden sm:inline">───</span>
          <h3 className="max-w-full break-words leading-snug text-foreground sm:shrink-0">
            {primary} <span className="text-muted-foreground">· {secondary}</span>
          </h3>
          <span className="max-w-full break-words leading-snug tabular-nums text-muted-foreground sm:shrink-0">
            <span aria-hidden="true" className="hidden sm:inline">· </span>
            {day.totalCount} EVT · {classCount} CLS · MAX {glyph}
            {openCount > 0 ? ` · ${openCount} OPEN` : ""}
          </span>
          <span aria-hidden="true" className="w-full border-t border-border/60 sm:flex-1" />
        </div>
      </div>
      {isQuiet ? (
        <details className="group border-b border-border/30">
          <summary
            className="pharos-focus-ring flex cursor-pointer list-none items-center gap-x-2.5 gap-y-1 px-3 py-2 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted/30 flex-wrap"
          >
            <span aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90">▸</span>
            <span className="shrink-0 uppercase tracking-wide tabular-nums text-foreground">
              {primary} · {secondary}
            </span>
            <span className="shrink-0 uppercase tracking-wide tabular-nums">
              · {day.totalCount} EVT
            </span>
            {quietTokens.length > 0 ? (
              <span className="min-w-0 flex-[1_1_12rem] break-words lowercase">
                · {quietTokens.join(" · ")}
              </span>
            ) : null}
          </summary>
          <div className="border-t border-border/20">
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
        </details>
      ) : (
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
      )}
    </section>
  );
}

export function TimelineClient() {
  const { getParam, setParam, setParams } = useUrlFilters();
  const filters = readTapeFilterState(getParam);
  const { data: logos } = useLogos();
  const [nowMs] = useState(() => Date.now());

  // Pass `nowMs` (frozen at mount) so the queryKey stays stable across
  // renders — otherwise `tapeWindowSince` calls Date.now() each render and
  // the infinite query restarts every tick.
  const since = tapeWindowSince(filters.window, nowMs);

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
    { maxAutoPages: 10 },
  );

  const {
    data: { events: rawEvents, nextCursor },
    pages,
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

  const permalinkId = getParam("event", "");
  const [autoLoadEnabled, setAutoLoadEnabled] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // Sr-only announcer for Load More results. We don't `aria-live` the whole
  // feed wrapper because every paginated page would re-flood the queue.
  // Instead, surface a concise summary that only updates when the visible
  // count actually changes.
  const [loadAnnouncement, setLoadAnnouncement] = useState("");
  const prevVisibleCountRef = useRef<number | null>(null);

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

  useEffect(() => {
    if (!permalinkResolved || !permalinkId) {
      return undefined;
    }
    if (typeof window === "undefined") return undefined;
    let timeoutId: number | undefined;
    const rafId = window.requestAnimationFrame(() => {
      setHighlightedId(permalinkId);
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
          // WCAG 2.3.3 — honor `prefers-reduced-motion` by skipping the
          // smooth scroll animation when the user has requested less motion.
          const prefersReducedMotion =
            typeof window.matchMedia === "function" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          el.scrollIntoView({
            behavior: prefersReducedMotion ? "auto" : "smooth",
            block: "center",
          });
        }
        // WCAG 2.4.3 — move keyboard / AT focus to the permalink target so
        // screen-reader users land on the row instead of staying at the top.
        if (typeof (el as HTMLElement).focus === "function") {
          (el as HTMLElement).focus({ preventScroll: true });
        }
      }
      timeoutId = window.setTimeout(() => {
        setHighlightedId((current) => (current === permalinkId ? null : current));
      }, HIGHLIGHT_DURATION_MS);
    });
    return () => {
      window.cancelAnimationFrame(rafId);
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
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
  }, [filters.window, filters.severity, filters.chain, filters.peg, filters.type, filters.coin, filters.q, setParam]);

  // Empty-state fallback prefers the smallest step that widens the view:
  // clear active filters → drop severity floor → widen window. `alltime` URL
  // token bypasses the "all" sentinel in useUrlFilters.
  const fallback: { label: string; apply: () => void } = hasActiveFilters
    ? { label: "Reset all filters", apply: handleClearFilters }
    : filters.severity !== "info"
    ? { label: "Show info-tier too", apply: () => setParam("severity", "info") }
    : { label: "Widen to all time", apply: () => setParam("window", "alltime") };

  const loadedCount = visibleEvents.length;
  useEffect(() => {
    const prev = prevVisibleCountRef.current;
    if (prev != null && loadedCount > prev) {
      const delta = loadedCount - prev;
      const ofTotal = total != null ? ` ${loadedCount} of ${total} shown.` : "";
      setLoadAnnouncement(`Loaded ${delta} more event${delta === 1 ? "" : "s"}.${ofTotal}`);
    }
    prevVisibleCountRef.current = loadedCount;
  }, [loadedCount, total]);

  // `per-day` open-incident counts feed the day-separator `N OPEN` enrichment.
  const openCountByDay = useMemo(() => bucketByDay(openIncidents), [openIncidents]);
  const lastEventTs = rawEvents.length > 0 ? rawEvents[0].ts : null;

  // Phosphor mode is opt-in, dark-mode-only. Persisted in localStorage and
  // applied only while the site is in dark mode — the green-on-black palette is
  // illegible against a light background.
  const { mounted: themeMounted, isDark } = useThemeToggle();
  const phosphorStorageKey = "pharos:timeline-phosphor";
  const [phosphorStorageVersion, setPhosphorStorageVersion] = useState(0);

  const persistedPhosphor =
    typeof window !== "undefined" && window.localStorage.getItem(phosphorStorageKey) === "1";

  useEffect(() => {
    if (typeof window === "undefined" || !themeMounted || isDark) return;
    window.localStorage.removeItem(phosphorStorageKey);
  }, [themeMounted, isDark, phosphorStorageVersion]);

  const togglePhosphor = useCallback(() => {
    const next = !persistedPhosphor;
    if (typeof window !== "undefined") {
      if (next) {
        window.localStorage.setItem(phosphorStorageKey, "1");
      } else {
        window.localStorage.removeItem(phosphorStorageKey);
      }
      setPhosphorStorageVersion((value) => value + 1);
    }
  }, [persistedPhosphor, phosphorStorageKey]);

  const phosphorActive = persistedPhosphor && isDark;
  const phosphorToggleVisible = themeMounted && isDark;

  return (
    <div className={`space-y-6${phosphorActive ? " phosphor-green" : ""}`}>
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

      {openIncidents.length > 0 ? (
        <OpenIncidentsSection incidents={openIncidents} logos={logos} nowMs={nowMs} />
      ) : null}

      {/* Discrete sr-only announcer for paginated loads (T1.4). The feed
          wrapper below intentionally omits `aria-live` so each Load More
          doesn't re-narrate the whole event list. */}
      <div role="status" aria-live="polite" className="sr-only">
        {loadAnnouncement}
      </div>

      {isLoading ? (
        <EventSkeleton />
      ) : visibleEvents.length === 0 ? (
        <EmptyState
          onClearAll={fallback.apply}
          activeChips={emptyStateChips}
          fallbackLabel={fallback.label}
        />
      ) : (
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
            <p className="pt-2 text-center font-mono text-[11px] uppercase tracking-wider tabular-nums text-muted-foreground">
              ───── END OF TAPE
              {" · "}
              {(total ?? rawEvents.length).toLocaleString()} EVT
              {" · WINDOW "}
              {WINDOW_SHORT[filters.window]}
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
      )}
    </div>
  );
}
