"use client";

import type { PublicStatusHeadline } from "@shared/types";
import { PUBLIC_HEADLINE_TONE } from "@shared/lib/classification";
import { Button } from "@/components/ui/button";
import { Timestamp } from "@/components/status/page-primitives";
import { cn } from "@/lib/utils";

/** Accent only when not operational; operational stays a flat neutral card. */
const HEADLINE_ACCENT: Record<PublicStatusHeadline["state"], string> = {
  operational: "",
  delayed: "border-l-[3px] border-l-state-info-solid",
  degraded: "border-l-[3px] border-l-state-warn-solid",
  "partial-outage": "border-l-[3px] border-l-state-danger-solid",
  "major-outage": "border-l-[3px] border-l-state-danger-solid",
};

interface PublicStatusHeroProps {
  headline: PublicStatusHeadline;
  /** When the current headline state began; null when unknown. */
  since: number | null;
  /** Server sample time of the health payload (epoch seconds). */
  checkedAt: number;
  /** Set when the latest health refetch failed; the shown verdict is the last good read. */
  fetchError: Error | null;
  /** True when the last successful fetch is older than its polling budget. */
  fetchStale: boolean;
  onRefresh: () => void;
}

export function PublicStatusHero({ headline, since, checkedAt, fetchError, fetchStale, onRefresh }: PublicStatusHeroProps) {
  const tone = PUBLIC_HEADLINE_TONE[headline.state];
  return (
    <section
      aria-labelledby="status-verdict-title"
      className={cn("pharos-card-shell flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5", HEADLINE_ACCENT[headline.state])}
    >
      <div className="min-w-0 space-y-1">
        <h2 id="status-verdict-title" className="flex items-center gap-2 text-2xl font-bold leading-tight text-foreground">
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", tone.dot)} />
          {headline.title}
        </h2>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {since != null ? (
            <span>
              For <Timestamp epochSec={since} variant="duration" />
            </span>
          ) : null}
          <span>
            Checked <Timestamp epochSec={checkedAt} />
          </span>
        </p>
        {fetchError ? (
          <p className="text-xs text-state-warn" title={fetchError.message}>
            The status check could not be reached. Showing the last good reading.
          </p>
        ) : fetchStale ? (
          <p className="text-xs text-state-warn">This verdict is older than the expected refresh interval.</p>
        ) : null}
      </div>
      {fetchError || fetchStale ? (
        <Button variant="outline" size="sm" className="min-h-11" onClick={onRefresh}>
          Refresh
        </Button>
      ) : null}
    </section>
  );
}
