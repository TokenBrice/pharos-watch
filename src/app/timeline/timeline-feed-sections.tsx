"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EventCard, SEVERITY_GLYPH } from "@/components/tape/event-card";
import { ClassDigestRow } from "@/components/tape/class-digest-row";
import { timeAgo } from "@shared/lib/format";
import { formatRelativeTimeMs } from "@shared/lib/relative-time";
import type { DigestedDay } from "@/lib/tape-digest";
import type { TapeEvent, TapeEventSeverity } from "@shared/types/tape-event";
import type { ActiveFilterChip } from "./timeline-controller";
import {
  eventDomId,
  formatDayLabel,
  openIncidentPrefix,
  quietDayEventTokens,
  TAPE_FRESH_WINDOW_MS,
} from "./timeline-feed-helpers";

export function EventSkeleton() {
  return (
    <div className="divide-y divide-border/60 border-y border-border/60" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-none" />
      ))}
    </div>
  );
}
export function EmptyState({
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

export function SummaryBand({ loadedCount, totalCount, openCount, windowLabel, severityLabel, dataUpdatedAt, nowMs, lastEventTs, phosphor, showPhosphorToggle, onTogglePhosphor }: SummaryBandProps) {
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
  const parts: ReactNode[] = [];
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
              className="phosphor-toggle inline-flex min-h-11 items-center rounded px-2 py-2"
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

export function OpenIncidentsSection({ incidents, logos, nowMs }: OpenIncidentsSectionProps) {
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

export function DayDigestSection({ day, nowMs, logos, highlightedId, openCount }: DayDigestSectionProps) {
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
