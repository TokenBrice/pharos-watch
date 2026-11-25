"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";
import type { CaseStudySeverity, CaseStudyTimelineEntry } from "@shared/types/editorial-content";
import { formatEventWindowDate } from "./case-study-format";

// Desktop track geometry — keep in sync with `auto-cols-[15.375rem]` (the dot
// pitch) and `w-[23rem]` (the card width) on the grid below. The scrollable
// extent is the last dot's column start plus a full card width, plus inner
// card padding allowance.
const TIMELINE_PITCH_REM = 15.375;
const TIMELINE_CARD_REM = 23;
const TIMELINE_CARD_PADDING_REM = 3;

type TimelineDesktopView = "track" | "linear";

const TIMELINE_VIEW_OPTIONS: ReadonlyArray<{ value: TimelineDesktopView; label: string }> = [
  { value: "track", label: "Track" },
  { value: "linear", label: "Linear" },
];

const SEVERITY_DOT: Record<CaseStudySeverity, string> = {
  high: "bg-[var(--severity-severe)]",
  med: "bg-[var(--severity-moderate)]",
  low: "bg-muted-foreground/80",
};

const SEVERITY_TEXT: Record<CaseStudySeverity, string> = {
  high: "text-state-danger",
  med: "text-state-warn",
  low: "text-muted-foreground",
};

const SEVERITY_LEGEND: readonly { severity: CaseStudySeverity; label: string }[] = [
  { severity: "high", label: "High" },
  { severity: "med", label: "Medium" },
  { severity: "low", label: "Low" },
];

const SEVERITY_SHORT_LABEL: Record<CaseStudySeverity, string> = {
  high: "High",
  med: "Medium",
  low: "Low",
};

function TimelineSeverityLegend() {
  return (
    <ul
      aria-label="Severity legend"
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5"
    >
      {SEVERITY_LEGEND.map(({ severity, label }) => (
        <li key={severity} className="pharos-chart-legend-chip">
          <span
            aria-hidden="true"
            className={cn("inline-block h-2 w-2 shrink-0 rounded-full", SEVERITY_DOT[severity])}
          />
          <span>{label}</span>
        </li>
      ))}
    </ul>
  );
}

function TimelineEntryMeta({
  dateISO,
  severity,
  index,
  total,
}: {
  dateISO: string;
  severity: CaseStudySeverity;
  index: number;
  total: number;
}) {
  const dayAttr = dateISO.split("T")[0];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <time dateTime={dayAttr} className="pharos-numeric text-2xs text-muted-foreground">
        {formatEventWindowDate(dateISO)}
      </time>
      <span aria-hidden="true" className="text-2xs text-muted-foreground/50">
        ·
      </span>
      <span className={cn("inline-flex items-center gap-1 text-2xs font-medium", SEVERITY_TEXT[severity])}>
        <span
          aria-hidden="true"
          className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", SEVERITY_DOT[severity])}
        />
        <span>{SEVERITY_SHORT_LABEL[severity]}</span>
        <span className="sr-only"> severity</span>
      </span>
      <span className="sr-only">
        {" "}
        (Event {index + 1} of {total})
      </span>
    </div>
  );
}

function TimelineHeadline({ children }: { children: string }) {
  return (
    <h3 className="text-base font-semibold leading-snug tracking-tight text-foreground">
      {children}
    </h3>
  );
}

function TimelineBody({ children }: { children: string }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

function TimelineSourceLink({ href, headline }: { href: string; headline: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="pharos-prose-link inline-flex text-xs font-medium text-foreground"
    >
      Source
      <span className="sr-only"> for {headline} (opens in a new tab)</span>
    </a>
  );
}

/** Desktop (lg+): events alternate above/below a drawn axis as a snap-scroll track. */
function HorizontalTimeline({
  entries,
  scrollerRef,
}: {
  entries: readonly CaseStudyTimelineEntry[];
  scrollerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { ref, near } = useNearViewport<HTMLDivElement>("240px");
  return (
    <div ref={ref} data-revealed={near} className="hidden lg:block">
      <div
        ref={scrollerRef}
        tabIndex={0}
        role="region"
        aria-label="Event timeline"
        aria-describedby="case-study-timeline-help"
        className="scroll-shadow pharos-focus-ring snap-x snap-mandatory overflow-x-auto px-5 py-4 sm:px-6 sm:py-5"
      >
        <p id="case-study-timeline-help" className="sr-only">
          Use horizontal scrolling, the previous and next timeline controls, or arrow keys when focused to review events in chronological order.
        </p>
        {/* No column gap: each cell's row-2 line segment is flush with its
            neighbours, so the drawn axis reads as one continuous arrow that
            begins at the first event's dot. */}
        {/* auto-cols is the dot pitch; cards are wider than the pitch and
            overflow into the neighbouring (opposite-lane) column, so the dots
            sit close together while titles/bodies keep their full width. */}
        <ol className="grid w-max auto-cols-[15.375rem] grid-flow-col grid-rows-[1fr_auto_1fr]">
          {entries.map((entry, i) => {
            const above = i % 2 === 0;
            const isLast = i === entries.length - 1;
            const severity = entry.severity ?? "low";
            return (
              <li
                key={`${entry.dateISO}-${i}`}
                className="row-span-3 grid grid-rows-subgrid snap-start"
              >
                <div
                  style={{ transitionDelay: `${i * 70}ms` }}
                  className={cn(
                    "pharos-timeline-card w-[23rem] space-y-1.5 pr-6",
                    above ? "row-start-1 self-end pb-5" : "row-start-3 self-start pt-5",
                  )}
                >
                  <TimelineEntryMeta
                    dateISO={entry.dateISO}
                    severity={severity}
                    index={i}
                    total={entries.length}
                  />
                  <TimelineHeadline>{entry.headline}</TimelineHeadline>
                  <TimelineBody>{entry.body}</TimelineBody>
                  {entry.href ? <TimelineSourceLink href={entry.href} headline={entry.headline} /> : null}
                </div>
                <div
                  aria-hidden="true"
                  className="pointer-events-none relative row-start-2 flex items-center self-center"
                >
                  <span className="pharos-timeline-line h-0.5 w-full bg-foreground/40" />
                  {/* Stem binding the event card to its point on the axis. */}
                  <span
                    className={cn(
                      "absolute left-1.5 h-5 w-px -translate-x-1/2 bg-foreground/40",
                      above ? "bottom-1/2" : "top-1/2",
                    )}
                  />
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute left-0 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full ring-4 ring-card",
                      SEVERITY_DOT[severity],
                    )}
                  />
                  {isLast ? (
                    <svg
                      viewBox="0 0 10 10"
                      width={10}
                      height={10}
                      aria-hidden="true"
                      className="absolute right-0 top-1/2 h-2.5 w-2.5 -translate-y-1/2 text-foreground/45"
                    >
                      <path d="M1 1.5L8.5 5L1 8.5V1.5Z" fill="currentColor" />
                    </svg>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

/** Vertical spine layout, rendered on mobile by default and on desktop when Linear view is active. */
function VerticalTimeline({
  entries,
  mobileOnly = false,
}: {
  entries: readonly CaseStudyTimelineEntry[];
  mobileOnly?: boolean;
}) {
  return (
    <div className={cn("p-5 sm:p-6", mobileOnly && "lg:hidden")}>
      <ol className="space-y-6 border-l border-border/50 pl-6 sm:pl-7">
        {entries.map((entry, i) => {
          const severity = entry.severity ?? "low";
          return (
            <li key={`${entry.dateISO}-${i}`} className="relative max-w-[68ch]">
              <span
                aria-hidden="true"
                className={cn(
                  "absolute -left-[1.8125rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-card sm:-left-[2.0625rem]",
                  SEVERITY_DOT[severity],
                )}
              />
              <div className="space-y-1.5">
                <TimelineEntryMeta
                  dateISO={entry.dateISO}
                  severity={severity}
                  index={i}
                  total={entries.length}
                />
                <TimelineHeadline>{entry.headline}</TimelineHeadline>
                <TimelineBody>{entry.body}</TimelineBody>
                {entry.href ? <TimelineSourceLink href={entry.href} headline={entry.headline} /> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function CaseStudyTimeline({
  entries,
}: {
  entries: readonly CaseStudyTimelineEntry[];
}) {
  const [desktopView, setDesktopView] = useState<TimelineDesktopView>("track");
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollState, setScrollState] = useState({ canLeft: false, canRight: false });
  const prefersReducedMotion = usePrefersReducedMotion();

  const updateScrollState = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) {
      setScrollState({ canLeft: false, canRight: false });
      return;
    }
    const maxScroll = Math.max(0, node.scrollWidth - node.clientWidth);
    const nextCanLeft = node.scrollLeft > 4;
    const nextCanRight = maxScroll - node.scrollLeft > 4;
    setScrollState((prev) =>
      prev.canLeft === nextCanLeft && prev.canRight === nextCanRight
        ? prev
        : { canLeft: nextCanLeft, canRight: nextCanRight },
    );
  }, []);

  useEffect(() => {
    if (desktopView !== "track") return;
    const node = scrollerRef.current;
    if (!node) return;

    updateScrollState();
    node.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(updateScrollState);
      observer.observe(node);
    }

    return () => {
      node.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
      observer?.disconnect();
    };
  }, [desktopView, entries.length, updateScrollState]);

  const scrollTrack = useCallback(
    (direction: -1 | 1) => {
      const node = scrollerRef.current;
      if (!node) return;
      const step = Math.max(246, Math.round(node.clientWidth * 0.6));
      node.scrollBy({
        left: direction * step,
        behavior: prefersReducedMotion ? "auto" : "smooth",
      });
    },
    [prefersReducedMotion],
  );

  const trackRem =
    Math.max(0, entries.length - 1) * TIMELINE_PITCH_REM +
    TIMELINE_CARD_REM +
    TIMELINE_CARD_PADDING_REM;

  return (
    <div
      className={cn(
        "pharos-card-shell overflow-hidden",
        desktopView === "track" && "pharos-timeline-wide",
      )}
      style={
        desktopView === "track"
          ? ({ "--tl-track": `${trackRem}rem` } as CSSProperties)
          : undefined
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-3.5 sm:px-6">
        <TimelineSeverityLegend />
        <div className="hidden items-center gap-2 lg:flex">
          {desktopView === "track" ? (
            <div className="inline-flex items-center gap-1" role="group" aria-label="Scroll timeline">
              <button
                type="button"
                onClick={() => scrollTrack(-1)}
                disabled={!scrollState.canLeft}
                aria-label="Scroll timeline left"
                className="pharos-focus-ring pharos-control-pill min-h-8 px-2 disabled:pointer-events-none disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => scrollTrack(1)}
                disabled={!scrollState.canRight}
                aria-label="Scroll timeline right"
                className="pharos-focus-ring pharos-control-pill min-h-8 px-2 disabled:pointer-events-none disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <ControlPillToggle
            variant="segmented"
            ariaLabel="Timeline layout"
            options={TIMELINE_VIEW_OPTIONS}
            value={desktopView}
            onChange={setDesktopView}
            buttonClassName="min-h-8"
          />
        </div>
      </div>

      {desktopView === "track" ? (
        <>
          <HorizontalTimeline entries={entries} scrollerRef={scrollerRef} />
          <VerticalTimeline entries={entries} mobileOnly />
        </>
      ) : (
        <VerticalTimeline entries={entries} />
      )}
    </div>
  );
}
