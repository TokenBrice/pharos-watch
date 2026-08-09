"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { CronRun, CronStaleArtifact } from "@shared/types";
import { formatCronRunStatus, formatCronRunTiming, isCronRunNotStarted } from "@/lib/cron-workbench-model";
import {
  formatDurationValue,
  formatTimestamp,
  getCronStatusColor,
  readNumber,
  readRecord,
  readString,
} from "./cron-lane-format";

/**
 * Recent-run history for a cron lane: the dot strip, its legend, the last-5
 * table, and the stale lease/progress evidence block. Rendered only inside the
 * cron detail panel.
 */
type RecentRunTone = "success" | "warning" | "skipped" | "failed";

const RECENT_RUN_TONE_COPY: Readonly<Record<RecentRunTone, { label: string; className: string }>> = {
  success: { label: "Succeeded", className: "bg-green-500" },
  warning: { label: "Completed with warnings", className: "bg-amber-500" },
  skipped: { label: "Skipped", className: "bg-zinc-500" },
  failed: { label: "Failed", className: "bg-red-500" },
};

function getRecentRunTone(run: CronRun): RecentRunTone {
  if (isCronRunNotStarted(run)) return "skipped";
  if (run.status === "ok") return "success";
  if (run.status === "degraded") return "warning";
  if (run.status.startsWith("skipped_")) return "skipped";
  return "failed";
}

export function RecentRunLegend() {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">Recent runs</span>
      {(Object.keys(RECENT_RUN_TONE_COPY) as RecentRunTone[]).map((tone) => (
        <span key={tone} className="inline-flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-full", RECENT_RUN_TONE_COPY[tone].className)} aria-hidden="true" />
          {RECENT_RUN_TONE_COPY[tone].label}
        </span>
      ))}
    </div>
  );
}

export function CronRunDots({ runs }: { runs: CronRun[] }) {
  if (runs.length === 0) {
    return <span className="text-xs text-muted-foreground">No recent runs</span>;
  }

  return (
    <div className="flex items-center gap-1" role="list" aria-label="Recent run outcomes, newest first">
      {runs.map((run, index) => {
        const tone = getRecentRunTone(run);
        const timing = formatCronRunTiming(run);
        const durationLabel = timing.duration?.label ?? timing.unavailableLabel ?? "Unknown";
        const outcomeLabel = formatCronRunStatus(run.status, run.metadata);
        const label = `${outcomeLabel}: ${formatTimestamp(run.startedAt)}, ${durationLabel}; raw status ${run.status}`;
        return (
          <span
            key={`${run.startedAt}-${index}`}
            role="listitem"
            aria-label={label}
            title={`${label}${timing.duration ? `; ${timing.duration.exactLabel}` : ""}${timing.note ? `; ${timing.note}` : ""}`}
          >
            <span
              className={cn("block size-2.5 rounded-full", RECENT_RUN_TONE_COPY[tone].className)}
              aria-hidden="true"
            />
          </span>
        );
      })}
    </div>
  );
}

export function CronRunHistoryPanel({ runs }: { runs: CronRun[] }) {
  const recentRuns = runs.slice(0, 5);
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
          Last 5 runs
        </h4>
        <CronRunDots runs={recentRuns} />
      </div>
      <div className="overflow-hidden rounded-md border border-border/60">
        <div className="hidden grid-cols-[minmax(7rem,0.8fr)_minmax(5rem,0.5fr)_minmax(0,1.7fr)] gap-2 border-b border-border/60 bg-muted/35 px-3 py-2 text-[11px] font-medium text-muted-foreground sm:grid">
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
                  : index === 0
                    ? "No reserve queue metadata"
                    : "Metadata retained for latest run only";
            const timing = formatCronRunTiming(run);

            return (
              <div
                key={`${run.startedAt}-${index}`}
                className="grid min-w-0 gap-2 px-3 py-2 text-xs sm:grid-cols-[minmax(7rem,0.8fr)_minmax(5rem,0.5fr)_minmax(0,1.7fr)]"
              >
                <span className="min-w-0">
                  <Badge
                    className={`max-w-full whitespace-normal break-words text-left text-[11px] leading-tight ${getCronStatusColor(
                      isCronRunNotStarted(run) ? "skipped_neutral" : run.status,
                    )}`}
                  >
                    {formatCronRunStatus(run.status, run.metadata)}
                  </Badge>
                  <span className="mt-1 block break-all font-mono text-[10px] text-muted-foreground">{run.status}</span>
                </span>
                <span
                  className="font-mono tabular-nums text-muted-foreground"
                  title={timing.duration?.exactLabel ?? timing.note ?? undefined}
                >
                  {formatDurationValue(timing.duration, timing.unavailableLabel ?? "Unknown")}
                  {timing.note ? (
                    <span className="mt-1 block max-w-48 whitespace-normal font-sans text-[10px] leading-tight">
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
        <Badge className="bg-red-500/15 text-red-800 dark:text-red-300">{artifacts.length}</Badge>
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
