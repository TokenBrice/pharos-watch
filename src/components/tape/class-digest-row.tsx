"use client";

import { EventCard, SEVERITY_LABEL } from "@/components/tape/event-card";
import { tapeClassRowBg } from "@/lib/tape-class-style";
import type { DigestedClass } from "@/lib/tape-digest";
import { SEVERITY_TEXT_CLASS } from "@shared/types/tape-event";

interface ClassDigestRowProps {
  digest: DigestedClass;
  logos: Record<string, string>;
  highlightedId: string | null;
  eventDomId: (id: string) => string;
}

export function ClassDigestRow({ digest, logos, highlightedId, eventDomId }: ClassDigestRowProps) {
  const tint = tapeClassRowBg(digest.classSlug);
  const severityText = SEVERITY_TEXT_CLASS[digest.maxSeverity];
  const severityLabel = SEVERITY_LABEL[digest.maxSeverity];
  const eventNoun = digest.rawCount === 1 ? "event" : "events";
  const summaryAriaLabel = `${digest.classLabel} group, ${digest.rawCount} ${eventNoun}, max severity ${severityLabel}`;

  const rows = (
    <>
      {digest.collapsed.map(({ key, event, count }) => (
        <EventCard
          key={key}
          event={event}
          count={count}
          logoSrc={event.coinId ? logos[event.coinId] : undefined}
          highlighted={highlightedId === event.id}
          domId={eventDomId(event.id)}
        />
      ))}
    </>
  );

  if (!digest.useDigestWrapper) {
    return <div className="border-b border-border/30">{rows}</div>;
  }

  return (
    <details className="group border-b border-border/30">
      <summary
        aria-label={summaryAriaLabel}
        className={`pharos-focus-ring flex cursor-pointer list-none items-center gap-x-2.5 gap-y-1 px-3 py-2 font-mono text-xs transition-colors hover:bg-muted/30 ${tint} flex-wrap`}
      >
        <span aria-hidden="true" className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90">▸</span>
        <span className="shrink-0 font-semibold uppercase tracking-wide text-foreground">{digest.classLabel}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {digest.rawCount} {digest.rawCount === 1 ? "event" : "events"}
        </span>
        {digest.summary ? (
          <span className="min-w-0 flex-[1_1_12rem] break-words text-muted-foreground">· {digest.summary}</span>
        ) : null}
        <span className="hidden flex-1 sm:block" aria-hidden="true" />
        <span className={`shrink-0 uppercase tracking-wide ${severityText}`} aria-label={`max severity ${severityLabel}`}>
          max {severityLabel}
        </span>
      </summary>
      <div className="border-t border-border/20">{rows}</div>
    </details>
  );
}
