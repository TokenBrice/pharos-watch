import Link from "next/link";
import { deviationColorClass } from "@/lib/severity-colors";
import { formatDeviationBps, formatIsoDate } from "@shared/lib/format";
import {
  DEPEG_EVENT_ENTRIES,
  type DepegEventEntry,
} from "@/lib/depeg-event-page-data";
import {
  MIN_DEPEG_PAGE_DEVIATION_BPS,
  getPeakDeviationMagnitudeBps,
} from "@/lib/depeg-event-config";

const MIN_DEVIATION_PCT = (MIN_DEPEG_PAGE_DEVIATION_BPS / 100).toFixed(MIN_DEPEG_PAGE_DEVIATION_BPS % 100 === 0 ? 0 : 1);

function monthLabel(startedAt: number): string {
  return new Date(startedAt * 1000).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Group newest-first entries into contiguous month buckets, preserving order. */
function groupByMonth(events: readonly DepegEventEntry[]): Array<{ label: string; events: DepegEventEntry[] }> {
  const groups: Array<{ label: string; events: DepegEventEntry[] }> = [];
  for (const event of events) {
    const label = monthLabel(event.startedAt);
    const current = groups[groups.length - 1];
    if (current && current.label === label) current.events.push(event);
    else groups.push({ label, events: [event] });
  }
  return groups;
}

function ArchiveMonthGroups({
  groups,
}: {
  groups: readonly { label: string; events: readonly DepegEventEntry[] }[];
}) {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.label} className="space-y-1.5">
          <h3 className="pharos-kicker">{group.label}</h3>
          <ul className="pharos-card-shell divide-y divide-border/60">
            {group.events.map((event) => {
              const peakBps = getPeakDeviationMagnitudeBps(event);
              const direction = event.direction === "above" ? "↑" : "↓";
              return (
                <li key={event.slug}>
                  <Link
                    href={`/depeg/${event.slug}/`}
                    className="pharos-focus-ring flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm hover:bg-muted/40"
                  >
                    <span className="pharos-numeric text-xs text-muted-foreground">
                      {formatIsoDate(event.startedAt)}
                    </span>
                    <span className="font-semibold text-foreground">
                      {event.symbol}
                    </span>
                    <span className={`pharos-numeric text-xs ${deviationColorClass(peakBps)}`}>
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
        </div>
      ))}
    </div>
  );
}

/**
 * Complete server-rendered index of the grow-only permanent event archive.
 * Every generated event page remains crawl-discoverable from `/depeg/archive/`.
 */
export function DepegEventArchive() {
  const events: readonly DepegEventEntry[] = DEPEG_EVENT_ENTRIES;

  if (events.length === 0) return null;

  const groups = groupByMonth(events);

  return (
    <section aria-labelledby="depeg-event-archive-heading" className="space-y-3">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="depeg-event-archive-heading" className="pharos-section-title">
          Permanent event index
        </h2>
        <p className="pharos-meta">
          {events.length} permanent pages · latest {groups[0]!.label}
        </p>
      </header>
      <p className="pharos-meta">
        Confirmed events at {MIN_DEVIATION_PCT}% deviation or worse.
      </p>

      <ArchiveMonthGroups groups={groups} />
    </section>
  );
}

/**
 * Bounded server-rendered handoff from the live tracker to the permanent index.
 * A calendar month is a stable editorial boundary and currently keeps the
 * preview below ten entries without splitting a month across routes.
 */
export function DepegEventArchivePreview() {
  const latestGroup = groupByMonth(DEPEG_EVENT_ENTRIES)[0];

  if (!latestGroup) return null;

  return (
    <section
      aria-labelledby="depeg-event-preview-heading"
      className="pharos-subtle-band space-y-3"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="depeg-event-preview-heading" className="pharos-section-title">
          Depeg history
        </h2>
        <p className="pharos-meta">
          {latestGroup.events.length} events · {latestGroup.label}
        </p>
      </header>

      <ArchiveMonthGroups groups={[latestGroup]} />

      <p className="pharos-meta text-right">
        <Link
          href="/depeg/archive/"
          className="pharos-prose-link font-medium text-foreground"
        >
          Browse all {DEPEG_EVENT_ENTRIES.length} event pages →
        </Link>
      </p>
    </section>
  );
}
