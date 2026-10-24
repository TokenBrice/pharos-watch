"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { CronRunDetail, CronRunSummary, CronStaleArtifact } from "@shared/types";
import { formatCronRunStatus, formatCronRunTiming, isCronRunNotStarted } from "@/lib/cron-workbench-model";
import { numberValue as readNumber, readRecord } from "@shared/lib/type-guards";
import {
  formatDurationValue,
  formatTimestamp,
  getCronStatusColor,
  readString,
} from "./cron-lane-format";

/**
 * Recent-run history for a cron lane: the dot strip (row and detail), the
 * bounded history table, and the stale lease/progress evidence block. Each dot carries
 * its outcome in a title tooltip instead of a separate legend.
 */
type RecentRunTone = "success" | "warning" | "skipped" | "failed";

const RECENT_RUN_TONE_COPY: Readonly<Record<RecentRunTone, { label: string; className: string }>> = {
  // Shape carries the outcome without colour: dots succeed or warn, a hollow
  // ring is skipped, a square with an outer ring is failed.
  success: { label: "Succeeded", className: "rounded-full bg-state-positive-solid" },
  warning: { label: "Completed with warnings", className: "rounded-full bg-state-warn-solid" },
  skipped: { label: "Skipped", className: "rounded-full border-2 border-muted-foreground/60 bg-transparent" },
  failed: { label: "Failed", className: "rounded-xs bg-state-danger-solid ring-1 ring-state-danger-solid ring-offset-1 ring-offset-background" },
};

function getRecentRunTone(run: CronRunSummary): RecentRunTone {
  if (isCronRunNotStarted(run)) return "skipped";
  if (run.status === "ok") return "success";
  if (run.status === "degraded") return "warning";
  if (run.status.startsWith("skipped_")) return "skipped";
  return "failed";
}

export function CronRunDots({ runs }: { runs: readonly CronRunSummary[] }) {
  if (runs.length === 0) {
    return <span className="text-xs text-muted-foreground">No recent runs</span>;
  }

  return (
    <div className="flex items-center gap-1" role="list" aria-label="Recent run outcomes, newest first">
      {runs.map((run, index) => {
        const tone = getRecentRunTone(run);
        const timing = formatCronRunTiming(run);
        const durationLabel = timing.duration?.label ?? timing.unavailableLabel ?? "Unknown";
        const outcomeLabel = formatCronRunStatus(run.status, run);
        const label = `${outcomeLabel}: ${formatTimestamp(run.startedAt)}, ${durationLabel}; raw status ${run.status}`;
        return (
          <span
            key={`${run.startedAt}-${index}`}
            role="listitem"
            aria-label={label}
            title={`${label}${timing.duration ? `; ${timing.duration.exactLabel}` : ""}${timing.note ? `; ${timing.note}` : ""}`}
          >
            <span
              className={cn("block size-2.5", RECENT_RUN_TONE_COPY[tone].className)}
              aria-hidden="true"
            />
          </span>
        );
      })}
    </div>
  );
}

/** Selected-job history from `/api/status-cron-detail` (runs carry full metadata). */
export function CronRunHistoryPanel({ runs }: { runs: readonly CronRunDetail[] }) {
  const recentRuns = runs;
  const hasReserveQueueLane = recentRuns.some((run) => {
    const metadata = readRecord(run.metadata);
    return (
      readNumber(metadata?.deferredCoins) != null ||
      readString(metadata?.nextCursorStablecoinId) ||
      readString(metadata?.loadedCursorNextStablecoinId) ||
      readString(metadata?.cursorTailState)
    );
  });

  if (recentRuns.length === 0) {
    return (
      <div className="mt-4 border-t border-border/60 pt-4 text-xs text-muted-foreground">
        No recent run history was reported.
      </div>
    );
  }

  return (
    <section className="mt-4 space-y-2 border-t border-border/60 pt-4" aria-labelledby="cron-recent-run-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="cron-recent-run-heading" className="text-xs font-semibold text-foreground">
          Recent runs and retained evidence
        </h4>
        <CronRunDots runs={recentRuns} />
      </div>
      <div className="overflow-hidden rounded-md border border-border/60">
        <div className="hidden grid-cols-[minmax(7rem,0.8fr)_minmax(5rem,0.5fr)_minmax(0,1.7fr)] gap-2 border-b border-border/60 bg-muted/35 px-3 py-2 text-xs font-medium text-muted-foreground sm:grid">
          <span>Outcome</span>
          <span>Runtime</span>
          <span>Reserve queue</span>
        </div>
        <div className="divide-y divide-border/55">
          {recentRuns.map((run, index) => {
            const metadata = readRecord(run.metadata);
            const deferredCoins = readNumber(metadata?.deferredCoins);
            const nextCursor = readString(metadata?.nextCursorStablecoinId);
            const loadedCursor = readString(metadata?.loadedCursorNextStablecoinId);
            const cursorTailState = readString(metadata?.cursorTailState);
            const reserveQueue =
              deferredCoins != null || nextCursor || loadedCursor || cursorTailState
                ? [
                    deferredCoins != null ? `${deferredCoins} deferred` : null,
                    nextCursor ? `next ${nextCursor}` : null,
                    loadedCursor ? `loaded ${loadedCursor}` : null,
                    cursorTailState ? `tail ${cursorTailState}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : !hasReserveQueueLane
                  ? "Not applicable"
                  : "No reserve queue metadata on this run";
            const timing = formatCronRunTiming(run);

            return (
              <div
                key={`${run.startedAt}-${index}`}
                className="grid min-w-0 gap-2 px-3 py-2 text-xs sm:grid-cols-[minmax(7rem,0.8fr)_minmax(5rem,0.5fr)_minmax(0,1.7fr)]"
              >
                <span className="min-w-0">
                  <Badge
                    className={`max-w-full whitespace-normal break-words text-left text-xs leading-tight ${getCronStatusColor(
                      isCronRunNotStarted(run) ? "skipped_neutral" : run.status,
                    )}`}
                  >
                    {formatCronRunStatus(run.status, run)}
                  </Badge>
                  <span className="mt-1 block break-all font-mono text-xs text-muted-foreground">{run.status}</span>
                </span>
                <span
                  className="font-mono tabular-nums text-muted-foreground"
                  title={timing.duration?.exactLabel ?? timing.note ?? undefined}
                >
                  {formatDurationValue(timing.duration, timing.unavailableLabel ?? "Unknown")}
                  {timing.note ? (
                    <span className="mt-1 block max-w-48 whitespace-normal font-sans text-xs leading-tight">
                      {timing.note}
                    </span>
                  ) : null}
                </span>
                <span className="min-w-0 break-words text-muted-foreground">{reserveQueue}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function StaleArtifactEvidence({ artifacts }: { artifacts: CronStaleArtifact[] }) {
  if (artifacts.length === 0) return null;

  return (
    <section className="mt-4 border-t border-border/60 pt-4" aria-labelledby="cron-stale-artifacts-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="cron-stale-artifacts-heading" className="text-xs font-semibold text-foreground">
          Stale lease and progress evidence
        </h4>
        <Badge className="bg-state-danger-solid/15 text-state-danger-strong">{artifacts.length}</Badge>
      </div>
      <ul className="mt-2 divide-y divide-border/55 border-y border-border/55 text-xs">
        {artifacts.map((artifact, index) => (
          <li key={`${artifact.kind}-${artifact.leaseOwner ?? "none"}-${index}`} className="min-w-0 py-3">
            <div className="font-medium text-foreground">
              {artifact.kind === "expired-lease" ? "Expired lease" : "Orphaned progress"}
            </div>
            <dl className="mt-2 grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 text-muted-foreground">
              <div className="min-w-0">
                <dt>Owner</dt>
                <dd className="mt-0.5 break-all font-mono text-foreground">{artifact.leaseOwner ?? "Unknown"}</dd>
              </div>
              <div className="min-w-0">
                <dt>Lease until</dt>
                <dd className="mt-0.5 break-words text-foreground">{formatTimestamp(artifact.leaseUntil)}</dd>
              </div>
              <div className="min-w-0">
                <dt>Progress updated</dt>
                <dd className="mt-0.5 break-words text-foreground">{formatTimestamp(artifact.progressUpdatedAt)}</dd>
              </div>
              <div className="min-w-0">
                <dt>Progress stage</dt>
                <dd className="mt-0.5 break-all font-mono text-foreground">{artifact.progressStage ?? "Unknown"}</dd>
              </div>
              <div className="min-w-0 col-span-2">
                <dt>Scheduled slot</dt>
                <dd className="mt-0.5 break-words text-foreground">{formatTimestamp(artifact.slotStartedAt)}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
