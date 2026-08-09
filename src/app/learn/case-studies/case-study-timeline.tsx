"use client";

import type { CSSProperties } from "react";
import { useNearViewport } from "@/hooks/use-near-viewport";
import type { CaseStudySeverity, CaseStudyTimelineEntry } from "./content/types";
import { formatUtcDayLabel } from "@shared/lib/format";

// Desktop track geometry — keep in sync with `auto-cols-[15.375rem]` (the dot
// pitch) and `w-[23rem]` (the card width) on the grid below. The scrollable
// extent is the last dot's column start plus a full card width.
const TIMELINE_PITCH_REM = 15.375;
const TIMELINE_CARD_REM = 23;

const SEVERITY_DOT: Record<CaseStudySeverity, string> = {
  high: "bg-[var(--severity-severe)]",
  med: "bg-[var(--severity-moderate)]",
  low: "bg-muted-foreground/80",
};

const SEVERITY_LEGEND: readonly { severity: CaseStudySeverity; label: string }[] = [
  { severity: "high", label: "High" },
  { severity: "med", label: "Medium" },
  { severity: "low", label: "Low" },
];

const SEVERITY_LABEL: Record<CaseStudySeverity, string> = {
  high: "High severity",
  med: "Medium severity",
  low: "Low severity",
};

function TimelineSeverityLegend() {
  return (
    <ul
      aria-label="Severity legend"
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] uppercase tracking-[0.12em] text-muted-foreground"
    >
      {SEVERITY_LEGEND.map(({ severity, label }) => (
        <li key={severity} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[severity]}`}
          />
          <span className="font-mono">{label}</span>
        </li>
      ))}
    </ul>
  );
}

function formatTimelineDate(dateISO: string): string {
  // Day-precision ISO ("2023-03-11") rendered without timezone drift.
  const [y, m, d] = dateISO.split("T")[0].split("-").map(Number);
  if (!y || !m || !d) return dateISO;
  return formatUtcDayLabel(new Date(Date.UTC(y, m - 1, d)));
}

function TimelineDate({ dateISO }: { dateISO: string }) {
  return (
    <p className="pharos-numeric text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
      {formatTimelineDate(dateISO)}
    </p>
  );
}

function TimelineHeadline({ children }: { children: string }) {
  return (
    <h3 className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
      {children}
    </h3>
  );
}

function TimelineBody({ children }: { children: string }) {
  return <p className="text-[15px] leading-relaxed text-muted-foreground">{children}</p>;
}

function TimelineSourceLink({ href, headline }: { href: string; headline: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="pharos-focus-ring inline-flex text-xs font-medium text-foreground underline-offset-4 hover:underline"
    >
      Source
      <span className="sr-only"> for {headline} (opens in a new tab)</span>
    </a>
  );
}

/** Desktop (lg+): events alternate above/below a drawn axis as a snap-scroll track. */
function HorizontalTimeline({ entries }: { entries: readonly CaseStudyTimelineEntry[] }) {
  const { ref, near } = useNearViewport<HTMLDivElement>("240px");
  const trackRem = (entries.length - 1) * TIMELINE_PITCH_REM + TIMELINE_CARD_REM;
  return (
    <div
      ref={ref}
      data-revealed={near}
      className="pharos-timeline-wide hidden lg:block"
      style={{ "--tl-track": `${trackRem}rem` } as CSSProperties}
    >
      <div
        tabIndex={0}
        role="region"
        aria-label="Event timeline"
        aria-describedby="case-study-timeline-help"
        className="scroll-shadow pharos-focus-ring snap-x snap-mandatory overflow-x-auto py-2"
      >
        <p id="case-study-timeline-help" className="sr-only">
          Use horizontal scrolling or arrow keys when the timeline is focused to review events in chronological order.
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
                  className={`pharos-timeline-card w-[23rem] space-y-1.5 pr-6 ${
                    above ? "row-start-1 self-end pb-5" : "row-start-3 self-start pt-5"
                  }`}
                >
                  <TimelineDate dateISO={entry.dateISO} />
                  <p className="sr-only">
                    Event {i + 1} of {entries.length}. {SEVERITY_LABEL[severity]}.
                  </p>
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
                    className={`absolute left-1.5 h-5 w-px -translate-x-1/2 bg-foreground/40 ${
                      above ? "bottom-1/2" : "top-1/2"
                    }`}
                  />
                  <span
                    aria-hidden="true"
                    className={`absolute left-0 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full ring-4 ring-background ${SEVERITY_DOT[severity]}`}
                  />
                  {isLast ? (
                    <span className="absolute right-0 top-1/2 h-0 w-0 -translate-y-1/2 border-y-[5px] border-l-[9px] border-y-transparent border-l-foreground/40" />
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

/** Vertical spine layout, used by default on mobile and as an optional desktop linear view. */
function VerticalTimeline({
  entries,
  desktop = false,
}: {
  entries: readonly CaseStudyTimelineEntry[];
  desktop?: boolean;
}) {
  return (
    <ol
      className={
        desktop
          ? "mt-6 space-y-7 border-l border-border/40 pl-6 sm:pl-8"
          : "space-y-7 border-l border-border/40 pl-6 sm:pl-8 lg:hidden"
      }
    >
      {entries.map((entry, i) => {
        const severity = entry.severity ?? "low";
        return (
        <li key={`${entry.dateISO}-${i}`} className="relative">
          <span
            aria-hidden="true"
            className={`absolute -left-[1.9375rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-background sm:-left-[2.4375rem] ${
              SEVERITY_DOT[severity]
            }`}
          />
          <div className="space-y-1.5">
            <TimelineDate dateISO={entry.dateISO} />
            <p className="sr-only">
              Event {i + 1} of {entries.length}. {SEVERITY_LABEL[severity]}.
            </p>
            <TimelineHeadline>{entry.headline}</TimelineHeadline>
            <TimelineBody>{entry.body}</TimelineBody>
            {entry.href ? <TimelineSourceLink href={entry.href} headline={entry.headline} /> : null}
          </div>
        </li>
        );
      })}
    </ol>
  );
}

function DesktopLinearTimeline({ entries }: { entries: readonly CaseStudyTimelineEntry[] }) {
  return (
    <details className="hidden rounded-xl border border-border/50 bg-card/30 p-5 lg:block">
      <summary className="pharos-focus-ring cursor-pointer font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:text-frost-blue">
        Linear timeline
      </summary>
      <VerticalTimeline entries={entries} desktop />
    </details>
  );
}

export function CaseStudyTimeline({
  entries,
}: {
  entries: readonly CaseStudyTimelineEntry[];
}) {
  return (
    <div className="space-y-5">
      <TimelineSeverityLegend />
      <HorizontalTimeline entries={entries} />
      <VerticalTimeline entries={entries} />
      <DesktopLinearTimeline entries={entries} />
    </div>
  );
}
