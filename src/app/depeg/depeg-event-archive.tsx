import Link from "next/link";
import { formatIsoDate } from "@shared/lib/format";
import {
  INDEXABLE_DEPEG_EVENT_ENTRIES,
  type DepegEventEntry,
} from "@/app/depeg/[event]/page-data";
import {
  MIN_DEPEG_PAGE_DEVIATION_BPS,
  getPeakDeviationMagnitudeBps,
} from "@/app/depeg/[event]/config";

const MIN_DEVIATION_PCT = (MIN_DEPEG_PAGE_DEVIATION_BPS / 100).toFixed(MIN_DEPEG_PAGE_DEVIATION_BPS % 100 === 0 ? 0 : 1);

function formatDeviationBps(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "—";
  if (bps >= 1000) return `${(bps / 100).toFixed(1)}%`;
  return `${(bps / 100).toFixed(2)}%`;
}

function severityClass(bps: number): string {
  if (bps >= 1000) return "text-amber-500 dark:text-amber-400";
  if (bps >= 500) return "text-amber-600/80 dark:text-amber-300/80";
  return "text-muted-foreground";
}

/**
 * Server-rendered list of confirmed depeg events that are in the bounded
 * static-page subset and indexable archive set.
 */
export function DepegEventArchive() {
  const events: readonly DepegEventEntry[] = INDEXABLE_DEPEG_EVENT_ENTRIES;

  if (events.length === 0) return null;

  return (
    <section
      aria-labelledby="depeg-event-archive-heading"
      className="space-y-3"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2
          id="depeg-event-archive-heading"
          className="text-lg font-semibold tracking-tight text-foreground"
        >
          Event archive
        </h2>
        <p className="text-xs text-muted-foreground">
          Permanent pages for confirmed events at {MIN_DEVIATION_PCT}% deviation or worse.
        </p>
      </header>

      <ul className="pharos-card-shell divide-y divide-border/60">
        {events.map((event) => {
          const peakBps = getPeakDeviationMagnitudeBps(event);
          const direction = event.direction === "above" ? "↑" : "↓";
          return (
            <li key={event.slug}>
              <Link
                href={`/depeg/${event.slug}/`}
                className="pharos-focus-ring flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm hover:bg-muted/40"
              >
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {formatIsoDate(event.startedAt)}
                </span>
                <span className="font-semibold text-foreground">
                  {event.symbol}
                </span>
                <span className={`font-mono text-xs tabular-nums ${severityClass(peakBps)}`}>
                  {direction} {formatDeviationBps(peakBps)}
                </span>
                <span className="ml-auto text-xs text-muted-foreground hover:text-foreground">
                  View page →
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
