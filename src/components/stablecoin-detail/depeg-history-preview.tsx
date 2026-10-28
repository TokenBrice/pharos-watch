import { TableFrame } from "@/components/table";
import { formatBps, formatDuration, formatIsoDate } from "@shared/lib/format";
import { getDepegClosureSnapshotLabel } from "@shared/lib/classification";
import type {
  DepegHistorySnapshotEvent,
  StablecoinDetailHistorySnapshot,
} from "@/lib/stablecoin-detail-history-snapshot";

const SOURCE_KIND_LABELS = {
  live: "Live observation",
  backfill: "Historical backfill",
} as const;

function SourceCell({ event }: { event: DepegHistorySnapshotEvent }) {
  if (event.href) {
    return (
      <a
        href={event.href}
        className="pharos-focus-ring rounded-sm text-frost-blue underline-offset-2 hover:underline"
      >
        Event record
      </a>
    );
  }
  return <>{SOURCE_KIND_LABELS[event.source]}</>;
}

/**
 * Chart-free, server-rendered slice of the retained depeg ledger. It carries
 * only the newest recorded incidents plus the capture date and coverage
 * qualification; charts, live reads and the full history stay behind the
 * History viewport gate.
 *
 * Rows use plain table elements and one shared variant class per body: the
 * shared cell primitives repeat their utility classes on every cell, which
 * would add several kilobytes to a profile whose raw HTML is already near the
 * 830 KB ceiling. TableFrame still owns the shell, caption and viewport.
 */
export function DepegHistoryPreview({ snapshot }: { snapshot: StablecoinDetailHistorySnapshot }) {
  const shown = snapshot.events.length;
  return (
    <TableFrame
      testId="depeg-history-preview"
      chrome="embedded"
      mobileScrollHint={false}
      tableClassName="caption-top"
      caption={
        <>
          Latest {shown} of {snapshot.recordedCount.toLocaleString("en-US")} archived incidents · as of{" "}
          {formatIsoDate(snapshot.capturedAt)} UTC. Recorded history; coverage may be incomplete.
        </>
      }
    >
      <thead>
        <tr className="border-b [&>th]:px-2 [&>th]:py-2 [&>th]:text-left [&>th]:text-xs [&>th]:font-medium">
          <th>Date</th>
          <th className="text-right">Peak deviation</th>
          <th className="text-right">Duration</th>
          <th>Recorded status</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody className="text-xs [&>tr]:border-b [&>tr>td]:px-2 [&>tr>td]:py-1">
        {snapshot.events.map((event) => (
          <tr key={event.id}>
            <td>{formatIsoDate(event.startedAt)}</td>
            <td className="text-right">{formatBps(event.peakDeviationBps)}</td>
            <td className="text-right">
              {event.endedAt == null ? (
                <span aria-label="Duration unavailable at capture">—</span>
              ) : (
                formatDuration(event.startedAt, event.endedAt)
              )}
            </td>
            <td>{getDepegClosureSnapshotLabel(event.closure)}</td>
            <td>
              <SourceCell event={event} />
            </td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}
