"use client";

import Link from "next/link";
import { isResolverBookAvailable } from "@/components/depeg/depeg-resolver-book-summary";
import {
  DDR_EVENT_STATE_LABELS,
  getLiveCurrentDeviationBps,
  isLiveCurrentDeviationHeld,
} from "@/components/depeg/depeg-resolver-row-card-model";
import { describeDdrVerdict } from "@/components/depeg/depeg-resolver-row-card-state";
import { useDepegResolver } from "@/hooks/api-hooks";
import { useMinuteClockSec } from "@/hooks/use-minute-clock-sec";
import { isDepegResolverEnabled } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";
import { formatDeviationBps, formatElapsedSeconds } from "@shared/lib/format";
import { buildStablecoinUrl } from "@shared/lib/urls";

function Fact({ label, children, className }: { label: string; children: string; className?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("pharos-numeric font-medium text-foreground", className)}>{children}</span>
    </span>
  );
}

/**
 * The live state of an event the static record still lists as ongoing. The page
 * is built from the archive snapshot, so its title and summary carry the
 * recorded peak; this strip reads the resolver's live overlay for the same
 * incident and claims no more than that row says.
 */
export function DepegEventNowStrip({
  stablecoinId,
  eventId,
  symbol,
  startedAt,
}: {
  stablecoinId: string;
  eventId: number;
  symbol: string;
  startedAt: number;
}) {
  const enabled = isDepegResolverEnabled();
  const resolver = useDepegResolver({ enabled });
  const nowSec = useMinuteClockSec();
  // Without the resolver there is no live state to read and no #depeg-resolver to link to.
  if (!enabled) return null;
  const data = resolver.data;
  const loading = data == null && resolver.error == null;
  const available = isResolverBookAvailable(data);
  const row = available
    ? data.rows.find((candidate) => candidate.stablecoinId === stablecoinId
      && (candidate.eventId === eventId || candidate.live.currentEventId === eventId)) ?? null
    : null;
  const bps = row ? getLiveCurrentDeviationBps(row) : null;
  const deviation = !row ? "…"
    : isLiveCurrentDeviationHeld(row) ? "Reference market closed"
    : bps == null ? "Unavailable"
    : bps === 0 ? "At peg"
    : `${formatDeviationBps(bps)} ${bps < 0 ? "below" : "above"} peg`;
  const verdict = row ? describeDdrVerdict(row) : { label: "…", accent: undefined };
  // Only an active row states live facts; otherwise name why there are none.
  const status = loading ? null
    : !available ? "Live state unavailable"
    : !row ? "No live resolver row for this incident"
    : row.live.eventState !== "active" ? DDR_EVENT_STATE_LABELS[row.live.eventState]
    : null;

  return (
    <section
      aria-label={`${symbol} live state`}
      className="pharos-card-shell flex min-h-12 flex-wrap items-center gap-x-5 gap-y-1.5 px-4 py-2.5 text-sm"
    >
      <span className="pharos-label">Now</span>
      {status ? (
        <span className="text-muted-foreground">{status}</span>
      ) : (
        <>
          <Fact label="Deviation">{deviation}</Fact>
          <Fact label="DDR" className={verdict.accent}>{verdict.label}</Fact>
          <Fact label="Age">{nowSec > 0 ? `${formatElapsedSeconds(Math.max(0, nowSec - startedAt))} so far` : "…"}</Fact>
        </>
      )}
      <Link
        prefetch={false}
        href={buildStablecoinUrl(stablecoinId, "#depeg-resolver")}
        className="pharos-focus-ring ml-auto rounded-sm text-sm font-medium text-foreground underline-offset-2 hover:underline"
      >
        Live forecast on the {symbol} page →
      </Link>
    </section>
  );
}
