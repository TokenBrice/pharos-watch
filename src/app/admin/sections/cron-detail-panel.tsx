"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { formatElapsedSeconds } from "@shared/lib/format";
import { CronInFlightProgress } from "@/components/status/cron-in-flight-progress";
import { formatInterval } from "@/components/status/format";
import { summarizeCronMetadata } from "@/components/status/cron-metadata-summary";
import { formatCronRunTiming, type CronWorkbenchRow } from "@/lib/cron-workbench-model";
import {
  CRON_DETAIL_ID,
  CRON_STATE_LABELS,
  formatDurationValue,
  formatLastGood,
  formatLastRun,
  formatTimestamp,
  getStateBadgeClass,
} from "./cron-lane-format";
import { CronRunHistoryPanel, StaleArtifactEvidence } from "./cron-run-history";

export function CronDetailPanel({ row, nowSeconds }: { row: CronWorkbenchRow; nowSeconds: number }) {
  const lastRun = row.cron.lastRun;
  const lastRunTiming = lastRun ? formatCronRunTiming(lastRun) : null;
  const metadataSummary = summarizeCronMetadata(row.job, lastRun?.metadata);

  return (
    <aside
      id={CRON_DETAIL_ID}
      aria-label={`Details for ${row.display.label}`}
      className="min-w-0 rounded-lg border border-border/60 bg-background/45 p-4 xl:sticky xl:top-[calc(var(--ops-sticky-offset)+0.75rem)] xl:max-h-[calc(100vh-var(--ops-sticky-offset)-1.5rem)] xl:self-start xl:overflow-y-auto xl:overscroll-contain"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold text-foreground">{row.display.label}</h3>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{row.job}</p>
        </div>
        <Badge className={`max-w-full text-xs ${getStateBadgeClass(row.state)}`}>{CRON_STATE_LABELS[row.state]}</Badge>
      </div>

      <dl className="mt-4 grid min-w-0 grid-cols-2 gap-3 text-xs">
        <div className="min-w-0">
          <dt className="text-muted-foreground">Trigger group</dt>
          <dd className="mt-1 break-words font-medium text-foreground">{row.group.title}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Impact class</dt>
          <dd className="mt-1 font-medium text-foreground">{row.impactLabel}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Trigger mode</dt>
          <dd className="mt-1 text-foreground">{row.display.triggerMode === "isolated" ? "Isolated" : "Shared"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Cadence</dt>
          <dd className="mt-1 font-mono tabular-nums text-foreground">
            {formatInterval(row.cron.expectedIntervalSec)}
          </dd>
        </div>
        <div className="min-w-0 col-span-2">
          <dt className="text-muted-foreground">Schedule</dt>
          <dd className="mt-1 break-all font-mono text-foreground">{row.display.schedule ?? "Unknown"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Last run</dt>
          <dd className="mt-1 font-mono tabular-nums text-foreground">{formatLastRun(row, nowSeconds)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Last completed</dt>
          <dd className="mt-1 font-mono tabular-nums text-foreground">{formatLastGood(row, nowSeconds)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Latest outcome</dt>
          <dd className="mt-1 text-foreground">{row.statusLabel}</dd>
          <dd className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground">
            Raw: {row.rawStatus ?? "none"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Latest runtime</dt>
          <dd className="mt-1 font-mono tabular-nums text-foreground">
            {formatDurationValue(
              lastRunTiming?.duration ?? null,
              lastRunTiming?.unavailableLabel ?? "Unknown",
            )}
          </dd>
        </div>
        {lastRunTiming?.note ? (
          <div className="col-span-2 min-w-0">
            <dt className="text-muted-foreground">Reconciliation timing</dt>
            <dd className="mt-1 text-foreground">{lastRunTiming.note}</dd>
          </div>
        ) : null}
      </dl>

      {row.cron.inFlight ? (
        <section
          className={cn(
            "mt-4 rounded-md border p-3 text-xs",
            row.cron.inFlight.stale
              ? "border-red-500/25 bg-red-500/5 text-red-800 dark:text-red-300"
              : "border-sky-500/25 bg-sky-500/5 text-sky-800 dark:text-sky-300",
          )}
          aria-label={row.cron.inFlight.stale ? "Stale running progress" : "Current running progress"}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Badge
              className={cn(
                "text-xs",
                row.cron.inFlight.stale
                  ? "bg-red-500/15 text-red-800 dark:text-red-300"
                  : "bg-sky-500/15 text-sky-800 dark:text-sky-300",
              )}
            >
              {row.cron.inFlight.stale ? "Stale heartbeat" : "Running now"}
            </Badge>
            <span>started {formatElapsedSeconds(Math.max(0, nowSeconds - row.cron.inFlight.startedAt))} ago</span>
            <span>heartbeat {formatElapsedSeconds(Math.max(0, nowSeconds - row.cron.inFlight.updatedAt))} ago</span>
          </div>
          <dl className="mt-2 grid min-w-0 grid-cols-2 gap-2">
            <div className="min-w-0">
              <dt>Stage</dt>
              <dd className="break-all font-mono font-medium">{row.cron.inFlight.stage ?? "Unknown"}</dd>
            </div>
            <div className="min-w-0">
              <dt>Lease owner</dt>
              <dd className="break-all font-mono font-medium">{row.cron.inFlight.leaseOwner ?? "Unknown"}</dd>
            </div>
          </dl>
          {row.cron.inFlight.itemsDone != null && row.cron.inFlight.itemsTotal != null ? (
            <div className="mt-2">
              <CronInFlightProgress
                itemsDone={row.cron.inFlight.itemsDone}
                itemsTotal={row.cron.inFlight.itemsTotal}
                stale={row.cron.inFlight.stale}
              />
            </div>
          ) : null}
          {row.cron.inFlight.message ? <div className="mt-2 break-words">{row.cron.inFlight.message}</div> : null}
          {row.cron.inFlight.metadata && Object.keys(row.cron.inFlight.metadata).length > 0 ? (
            <details className="mt-3 text-xs">
              <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md">
                Full progress metadata
              </summary>
              <pre className="mt-2 max-h-40 max-w-full overflow-auto rounded-md bg-background/60 p-2 text-xs text-foreground">
                {JSON.stringify(row.cron.inFlight.metadata, null, 2)}
              </pre>
            </details>
          ) : null}
        </section>
      ) : null}

      <StaleArtifactEvidence artifacts={row.cron.staleArtifacts ?? []} />

      {lastRun?.error ? (
        <details className="mt-4 text-xs">
          <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-red-800 dark:text-red-300">
            Latest run error
          </summary>
          <pre className="mt-2 max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">
            {lastRun.error}
          </pre>
        </details>
      ) : null}

      {metadataSummary.length > 0 ? (
        <div className="mt-4 border-y border-border/55 py-3 text-xs text-muted-foreground">
          {metadataSummary.map((line) => (
            <div key={line} className="break-words">
              {line}
            </div>
          ))}
        </div>
      ) : null}

      {lastRun?.metadata && Object.keys(lastRun.metadata).length > 0 ? (
        <details className="mt-4 text-xs">
          <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-muted-foreground">
            Full run metadata
          </summary>
          <pre className="mt-2 max-h-56 max-w-full overflow-auto rounded-md bg-muted p-2 text-xs">
            {JSON.stringify(lastRun.metadata, null, 2)}
          </pre>
        </details>
      ) : null}

      {row.cron.latestEvent ? (
        <details className="mt-4 text-xs">
          <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-muted-foreground">
            Latest cron event
          </summary>
          <div className="mt-2 min-w-0 border-y border-border/55 py-2">
            <div className="font-medium text-foreground">{row.cron.latestEvent.message}</div>
            <div className="mt-1 break-all font-mono text-muted-foreground">
              {row.cron.latestEvent.eventType} · {row.cron.latestEvent.severity} ·{" "}
              {formatTimestamp(row.cron.latestEvent.recordedAt)}
            </div>
          </div>
        </details>
      ) : null}

      <CronRunHistoryPanel runs={row.cron.recentRuns ?? []} />
    </aside>
  );
}
