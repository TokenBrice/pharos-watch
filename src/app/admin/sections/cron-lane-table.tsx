"use client";

import { useMemo, useState } from "react";
import { Circle, CircleDot, Search, X } from "lucide-react";
import { CRON_STATUS_COLORS } from "@shared/lib/classification";
import { formatElapsedSeconds } from "@shared/lib/format";
import type { BudgetOnlySurfaceStatus, CronRun, CronStaleArtifact } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CronInFlightProgress } from "@/components/status/cron-in-flight-progress";
import { LazyDetails } from "@/components/status/lazy-details";
import { formatInterval } from "@/components/status/format";
import { summarizeCronMetadata } from "@/components/status/cron-metadata-summary";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import {
  buildBudgetOnlySurfaceGroups,
  buildCronWorkbenchModel,
  DEFAULT_CRON_WORKBENCH_FILTERS,
  formatCronRunStatus,
  formatCronRunTiming,
  isCronRunNotStarted,
  type BudgetOnlySurfaceRow,
  type CronImpactFilter,
  type CronRunningFilter,
  type CronWorkbenchFilters,
  type CronWorkbenchRow,
  type CronWorkbenchState,
  type CronWorkbenchStateFilter,
  type FormattedCronDuration,
} from "@/lib/cron-workbench-model";
import { countConsecutiveStatus, getLastSuccessfulRun } from "@/lib/status/cron-run-utils";
import { cn } from "@/lib/utils";
import type { CronGroup } from "./cron-lane-types";
import { STATUS_PANEL_SHELL_CLASS } from "@/components/status/page-primitives";

interface CronLaneTableProps {
  groups: CronGroup[];
  budgetOnlySurfaces: BudgetOnlySurfaceStatus[];
  nowSeconds: number;
}

const CRON_DETAIL_ID = "cron-selected-job-detail";
const CRON_COLUMN_COUNT = 9;

const FILTER_FIELD_CLASS_NAME =
  "h-9 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40";

const CRON_STATE_LABELS: Readonly<Record<CronWorkbenchState, string>> = {
  unhealthy: "Unavailable",
  degraded: "Run warning",
  unknown: "Unknown",
  skipped: "Skipped",
  running: "Running",
  healthy: "Healthy",
};

function getCronStatusColor(status: string | undefined): string {
  const statusColors: Readonly<Record<string, string>> = CRON_STATUS_COLORS;
  return status == null ? "bg-muted text-muted-foreground" : (statusColors[status] ?? "bg-muted text-muted-foreground");
}

function getStateBadgeClass(state: CronWorkbenchState): string {
  if (state === "unhealthy") return "bg-red-500/15 text-red-800 dark:text-red-300";
  if (state === "degraded") return "bg-amber-500/15 text-amber-800 dark:text-amber-300";
  if (state === "skipped") return "bg-muted text-muted-foreground";
  if (state === "running") return "bg-sky-500/15 text-sky-800 dark:text-sky-300";
  if (state === "unknown") return "bg-slate-500/15 text-slate-800 dark:text-slate-300";
  return "bg-green-500/15 text-green-800 dark:text-green-300";
}

function getRowTone(state: CronWorkbenchState): string {
  if (state === "unhealthy") return "border-l-red-500/70";
  if (state === "degraded") return "border-l-amber-500/70";
  if (state === "skipped") return "border-l-muted-foreground/40";
  if (state === "running") return "border-l-sky-500/70";
  if (state === "unknown") return "border-l-slate-500/60";
  return "border-l-green-500/60";
}

function formatLastRun(row: CronWorkbenchRow, nowSeconds: number): string {
  if (!row.cron.lastRun) return row.cron.telemetryUnknown ? "Unknown" : "No runs";
  return `${formatElapsedSeconds(Math.max(0, nowSeconds - row.cron.lastRun.startedAt))} ago`;
}

function formatLastGood(row: CronWorkbenchRow, nowSeconds: number): string {
  const lastSuccessfulRun = getLastSuccessfulRun(row.cron.recentRuns ?? []);
  if (!lastSuccessfulRun) return "No successful run";
  return `${formatElapsedSeconds(Math.max(0, nowSeconds - lastSuccessfulRun.startedAt))} ago`;
}

function formatTimestamp(timestampSeconds: number | null | undefined): string {
  if (timestampSeconds == null) return "Unknown";
  return new Date(timestampSeconds * 1000).toLocaleString(undefined, { timeZoneName: "short" });
}

function formatDurationValue(
  duration: FormattedCronDuration | null,
  unavailableLabel: "Unknown" | "N/A" = "Unknown",
): React.ReactNode {
  if (!duration) return unavailableLabel;
  return (
    <span title={duration.exactLabel}>
      {duration.label}
      <span className="sr-only">; exact {duration.exactLabel}</span>
    </span>
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function formatPrerequisiteEvidence(skippedReason: string | null): string | null {
  for (const [prefix, label] of [
    ["upstream-incomplete:", "prerequisite incomplete"],
    ["upstream-failure:", "prerequisite failed"],
    ["upstream-blocked:", "prerequisite blocked"],
  ] as const) {
    if (skippedReason?.startsWith(prefix)) return `${label}: ${skippedReason.slice(prefix.length)}`;
  }
  return null;
}

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

function RecentRunLegend() {
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

function CronRunDots({ runs }: { runs: CronRun[] }) {
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

function CronRunHistoryPanel({ runs }: { runs: CronRun[] }) {
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

function StaleArtifactEvidence({ artifacts }: { artifacts: CronStaleArtifact[] }) {
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

function CronDetailPanel({ row, nowSeconds }: { row: CronWorkbenchRow; nowSeconds: number }) {
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

function CronWorkbenchControls({
  filters,
  triggerGroups,
  visibleCount,
  totalCount,
  hasActiveFilters,
  onFiltersChange,
  onReset,
}: {
  filters: CronWorkbenchFilters;
  triggerGroups: Array<{ value: string; label: string; count: number }>;
  visibleCount: number;
  totalCount: number;
  hasActiveFilters: boolean;
  onFiltersChange: (patch: Partial<CronWorkbenchFilters>) => void;
  onReset: () => void;
}) {
  return (
    <div role="group" className="space-y-3 border-y border-border/60 py-3" aria-label="Cron job filters">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="min-w-0 space-y-1 sm:col-span-2">
          <span className="text-xs font-medium text-muted-foreground">Search jobs</span>
          <span className="relative block">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              value={filters.search}
              placeholder="Job, label, schedule, or artifact"
              onChange={(event) => onFiltersChange({ search: event.target.value })}
            />
          </span>
        </label>

        <label className="min-w-0 space-y-1">
          <span className="text-xs font-medium text-muted-foreground">State</span>
          <select
            className={cn(FILTER_FIELD_CLASS_NAME, "w-full")}
            value={filters.state}
            onChange={(event) => onFiltersChange({ state: event.target.value as CronWorkbenchStateFilter })}
          >
            <option value="attention">Needs attention</option>
            <option value="all">All states</option>
            <option value="unhealthy">Unavailable</option>
            <option value="degraded">Run warning</option>
            <option value="unknown">Unknown</option>
            <option value="skipped">Skipped</option>
            <option value="running">Running</option>
            <option value="healthy">Healthy</option>
          </select>
        </label>

        <label className="min-w-0 space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Impact class</span>
          <select
            className={cn(FILTER_FIELD_CLASS_NAME, "w-full")}
            value={filters.impact}
            onChange={(event) => onFiltersChange({ impact: event.target.value as CronImpactFilter })}
          >
            <option value="all">All impact classes</option>
            <option value="public-critical">Public critical</option>
            <option value="admin-watch">Admin watch</option>
          </select>
        </label>

        <label className="min-w-0 space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Running status</span>
          <select
            className={cn(FILTER_FIELD_CLASS_NAME, "w-full")}
            value={filters.running}
            onChange={(event) => onFiltersChange({ running: event.target.value as CronRunningFilter })}
          >
            <option value="all">Any running status</option>
            <option value="running">Running now</option>
            <option value="stale">Stale heartbeat</option>
            <option value="idle">Not running</option>
          </select>
        </label>

        <label className="min-w-0 space-y-1 sm:col-span-2 lg:col-span-2">
          <span className="text-xs font-medium text-muted-foreground">Trigger group</span>
          <select
            className={cn(FILTER_FIELD_CLASS_NAME, "w-full")}
            value={filters.triggerGroup}
            onChange={(event) => onFiltersChange({ triggerGroup: event.target.value })}
          >
            <option value="all">All trigger groups</option>
            {triggerGroups.map((group) => (
              <option key={group.value} value={group.value}>
                {group.label} ({group.count})
              </option>
            ))}
          </select>
        </label>

        <div className="flex min-w-0 items-end justify-between gap-3 sm:col-span-2 lg:col-span-3">
          <span className="pb-2 font-mono text-xs tabular-nums text-muted-foreground">
            {visibleCount}/{totalCount} jobs
          </span>
          {hasActiveFilters ? (
            <Button type="button" size="sm" variant="ghost" onClick={onReset}>
              <X className="size-4" aria-hidden="true" />
              Reset filters
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-5 gap-y-2">
        <RecentRunLegend />
        <p className="max-w-2xl text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">State:</span> Unavailable means there is no fresh usable run.
          Run warning means the job completed but reported partial, fallback, or threshold metadata.
        </p>
      </div>
    </div>
  );
}

function BudgetSurfaceStatus({ row }: { row: BudgetOnlySurfaceRow }) {
  const surface = row.surface;
  const checkedAge = surface.ageSeconds == null ? "Unknown" : `${formatElapsedSeconds(surface.ageSeconds)} ago`;
  return (
    <LazyDetails
      className="group min-w-0 border-t border-border/55 py-3 first:border-t-0"
      summary={
        <summary className="pharos-focus-ring flex min-h-11 min-w-0 cursor-pointer list-none flex-wrap items-start justify-between gap-3 rounded-md marker:hidden">
          <span className="min-w-0">
            <span className="block break-words text-sm font-medium text-foreground">{row.label}</span>
            <span className="mt-1 block break-all font-mono text-[11px] text-muted-foreground">{row.job}</span>
          </span>
          <span className="flex flex-wrap items-center justify-end gap-2">
            <Badge
              className={cn(
                "text-[11px]",
                surface.telemetryStatus === "fresh"
                  ? "bg-green-500/15 text-green-800 dark:text-green-300"
                  : surface.telemetryStatus === "stale"
                    ? "bg-amber-500/15 text-amber-800 dark:text-amber-300"
                    : "bg-red-500/15 text-red-800 dark:text-red-300",
              )}
            >
              {row.telemetryLabel} telemetry
            </Badge>
            <Badge
              className={`max-w-full whitespace-normal break-words text-left text-[11px] leading-tight ${getCronStatusColor(surface.outcome)}`}
            >
              {row.outcomeLabel}
            </Badge>
          </span>
        </summary>
      }
    >
      <dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-4">
        <div className="min-w-0 col-span-2 sm:col-span-4">
          <dt className="text-muted-foreground">Raw telemetry / outcome</dt>
          <dd className="mt-1 break-all font-mono text-foreground">
            {surface.telemetryStatus} / {surface.outcome}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Checked</dt>
          <dd className="mt-1 text-foreground">{checkedAge}</dd>
          <dd className="mt-0.5 break-words text-[10px] text-muted-foreground">{formatTimestamp(surface.checkedAt)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Runtime</dt>
          <dd className="mt-1 font-mono tabular-nums text-foreground">{formatDurationValue(row.duration)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Due / processed</dt>
          <dd className="mt-1 font-mono tabular-nums text-foreground">
            {surface.dueCount ?? "Unknown"} / {surface.processedCount ?? "Unknown"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Connection budget</dt>
          <dd className="mt-1 font-mono tabular-nums text-foreground">{surface.maxConnections} max</dd>
        </div>
        <div className="min-w-0 col-span-2">
          <dt className="text-muted-foreground">Connection group</dt>
          <dd className="mt-1 break-all font-mono text-foreground">{surface.connectionGroup ?? "Unassigned"}</dd>
        </div>
        <div className="min-w-0 col-span-2">
          <dt className="text-muted-foreground">Expected / stale after</dt>
          <dd className="mt-1 font-mono tabular-nums text-foreground">
            {formatInterval(surface.expectedIntervalSec)} / {formatInterval(surface.maxAgeSec)}
          </dd>
        </div>
      </dl>
      {surface.skippedReason ? (
        <p className="mt-3 break-words text-xs text-muted-foreground">Skipped: {surface.skippedReason}</p>
      ) : null}
      {surface.error ? (
        <p className="mt-3 break-words font-mono text-xs text-red-800 dark:text-red-300">{surface.error}</p>
      ) : null}
      {surface.metadata && Object.keys(surface.metadata).length > 0 ? (
        <details className="mt-3 text-xs">
          <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-muted-foreground">
            Full surface metadata
          </summary>
          <pre className="mt-2 max-h-48 max-w-full overflow-auto rounded-md bg-muted p-2 text-xs">
            {JSON.stringify(surface.metadata, null, 2)}
          </pre>
        </details>
      ) : null}
    </LazyDetails>
  );
}

function BudgetOnlySurfacePanel({ surfaces }: { surfaces: BudgetOnlySurfaceStatus[] }) {
  const groups = useMemo(() => buildBudgetOnlySurfaceGroups(surfaces), [surfaces]);
  return (
    <section className="min-w-0 border-t border-border/70 pt-5" aria-labelledby="budget-only-surfaces-heading">
      <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h3 id="budget-only-surfaces-heading" className="text-sm font-semibold text-foreground">
            Budget-only scheduled surfaces
          </h3>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            Scheduled side work with connection and telemetry budgets but no separate cron-run job row.
          </p>
        </div>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{surfaces.length} surfaces</span>
      </div>

      {groups.length === 0 ? (
        <div className="mt-3 border-y border-border/55 py-4 text-sm text-muted-foreground">
          No budget-only surface telemetry was reported. State is unknown.
        </div>
      ) : (
        <div className="mt-3 divide-y divide-border/70 border-y border-border/70">
          {groups.map((group) => (
            <section
              key={group.scheduleKey}
              className="min-w-0 py-4"
              aria-labelledby={`budget-group-${group.scheduleKey}`}
            >
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h4
                    id={`budget-group-${group.scheduleKey}`}
                    className="break-all font-mono text-xs font-semibold text-foreground"
                  >
                    {group.scheduleKey}
                  </h4>
                  <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{group.schedule}</p>
                </div>
                <span className="text-xs text-muted-foreground">
                  {group.summary.total} surfaces · {group.summary.stale} stale · {group.summary.missing} missing ·{" "}
                  {group.summary.errors} failed
                </span>
              </div>
              <div className="mt-2">
                {group.rows.map((row) => (
                  <BudgetSurfaceStatus key={row.job} row={row} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

export function CronLaneTable({ groups, budgetOnlySurfaces, nowSeconds }: CronLaneTableProps) {
  const [filters, setFilters] = useState<CronWorkbenchFilters>({ ...DEFAULT_CRON_WORKBENCH_FILTERS });
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const model = useMemo(
    () => buildCronWorkbenchModel(groups, filters, nowSeconds),
    [filters, groups, nowSeconds],
  );
  const selectedRow = model.rows.find((row) => row.key === selectedRowKey) ?? model.rows[0] ?? null;
  const isDefaultAttentionView = filters.state === "attention" && !model.hasActiveFilters;

  const updateFilters = (patch: Partial<CronWorkbenchFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  };

  const resetFilters = () => {
    setFilters({ ...DEFAULT_CRON_WORKBENCH_FILTERS });
  };

  const showAllJobs = () => {
    setFilters({ ...DEFAULT_CRON_WORKBENCH_FILTERS, state: "all" });
  };

  return (
    <div className="min-w-0 max-w-full space-y-5">
      <CronWorkbenchControls
        filters={filters}
        triggerGroups={model.triggerGroups}
        visibleCount={model.filteredCount}
        totalCount={model.totalCount}
        hasActiveFilters={model.hasActiveFilters}
        onFiltersChange={updateFilters}
        onReset={resetFilters}
      />

      {model.totalCount === 0 ? (
        <div className="border-y border-border/60 py-5 text-sm leading-relaxed text-muted-foreground">
          No cron job telemetry was reported. State is unknown.
        </div>
      ) : model.filteredCount === 0 ? (
        <div className="border-y border-border/60 py-5 text-sm leading-relaxed text-muted-foreground">
          <p>
            {isDefaultAttentionView
              ? "No cron jobs need attention. Healthy and routine skipped jobs are not mounted in the default view."
              : "No cron jobs match the current filters."}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mt-2"
            onClick={isDefaultAttentionView ? showAllJobs : resetFilters}
          >
            {isDefaultAttentionView ? "Show all jobs" : "Reset filters"}
          </Button>
        </div>
      ) : (
        <div className="grid min-w-0 max-w-full items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,23rem)]">
          <TableFrame
            tableId="cron-lane"
            chrome="bare"
            stickyHeader
            className={cn("min-w-0 max-w-full overflow-hidden rounded-lg", STATUS_PANEL_SHELL_CLASS)}
            tableClassName="min-w-[64rem] border-collapse text-left text-xs"
            tableProps={{ "aria-label": "Cron jobs by trigger group" }}
            viewportClassName="min-w-0 max-w-full max-h-[min(70vh,44rem)]"
            viewportProps={{
              vertical: true,
              mobileScrollHint: "Scroll within the cron table for more jobs and columns",
            }}
          >
            <TableHeader className="border-b border-border/70 bg-muted text-[11px] font-medium text-muted-foreground">
              <TableRow rowIntent="static">
                <TableHead className="w-12 px-2 py-2">
                  <span className="sr-only">Select</span>
                </TableHead>
                <TableHead className="px-3 py-2">State</TableHead>
                <TableHead className="px-3 py-2">Job</TableHead>
                <TableHead className="px-3 py-2">Impact</TableHead>
                <TableHead className="px-3 py-2">Trigger</TableHead>
                <TableHead className="px-3 py-2">Last / completed</TableHead>
                <TableHead className="px-3 py-2">Runtime</TableHead>
                <TableHead className="px-3 py-2">Items</TableHead>
                <TableHead className="px-3 py-2">Evidence</TableHead>
              </TableRow>
            </TableHeader>
            {model.groups.map((group) => (
              <TableBody key={group.key} aria-label={`${group.title} cron jobs`}>
                <TableRow rowIntent="static" className="border-y border-border/70 bg-muted/55">
                  <th scope="rowgroup" colSpan={CRON_COLUMN_COUNT} className="px-3 py-3 text-left font-normal">
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-semibold text-foreground">{group.title}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">{group.badge}</span>
                        </div>
                        <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
                          {group.description}
                        </p>
                      </div>
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        {group.summary.visible}/{group.summary.total} shown · {group.summary.unhealthy} unavailable ·{" "}
                        {group.summary.degraded} warning{group.summary.degraded === 1 ? "" : "s"} ·{" "}
                        {group.summary.unknown} unknown · {group.summary.skipped} skipped · {group.summary.running} running
                      </span>
                    </div>
                  </th>
                </TableRow>
                {group.rows.map((row) => {
                  const isSelected = selectedRow?.key === row.key;
                  const lastRun = row.cron.lastRun;
                  const timing = lastRun ? formatCronRunTiming(lastRun) : null;
                  const errorStreak = countConsecutiveStatus(row.cron.recentRuns ?? [], "error");
                  const skippedStreak = countConsecutiveStatus(row.cron.recentRuns ?? [], "skipped_locked");
                  const artifacts = row.cron.staleArtifacts?.length ?? 0;
                  const skippedReason = readString(lastRun?.metadata?.skippedReason);
                  const prerequisiteEvidence = formatPrerequisiteEvidence(skippedReason);
                  return (
                    <TableRow
                      key={row.key}
                      data-testid={`cron-row-${row.job}`}
                      aria-selected={isSelected}
                      aria-controls={isSelected ? CRON_DETAIL_ID : undefined}
                      onClick={() => setSelectedRowKey(row.key)}
                      className={cn(
                        "cursor-pointer border-l-2",
                        getRowTone(row.state),
                        isSelected ? "bg-primary/8" : "hover:bg-muted/25",
                      )}
                    >
                      <TableCell className="px-2 py-1 align-top">
                        <button
                          type="button"
                          aria-label={`${isSelected ? "Selected" : "Select"} ${row.display.label}`}
                          aria-pressed={isSelected}
                          aria-controls={isSelected ? CRON_DETAIL_ID : undefined}
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedRowKey(row.key);
                          }}
                          className="pharos-focus-ring inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          {isSelected ? (
                            <CircleDot className="size-4" aria-hidden="true" />
                          ) : (
                            <Circle className="size-4" aria-hidden="true" />
                          )}
                        </button>
                      </TableCell>
                      <TableCell className="px-3 py-2 align-top">
                        <Badge className={`text-xs ${getStateBadgeClass(row.state)}`}>
                          {CRON_STATE_LABELS[row.state]}
                        </Badge>
                        <span className="mt-1 block max-w-32 whitespace-normal text-[11px] leading-tight text-muted-foreground">
                          {row.statusLabel}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[15rem] px-3 py-2 align-top">
                        <span className="block truncate text-sm font-medium text-foreground">{row.display.label}</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">{row.job}</span>
                      </TableCell>
                      <TableCell className="px-3 py-2 align-top">
                        <span
                          className={cn(
                            "text-xs font-medium",
                            row.impactClass === "public-critical"
                              ? "text-red-800 dark:text-red-300"
                              : "text-muted-foreground",
                          )}
                        >
                          {row.impactLabel}
                        </span>
                      </TableCell>
                      <TableCell className="px-3 py-2 align-top text-muted-foreground">
                        <div>{row.display.triggerMode === "isolated" ? "Isolated" : "Shared"}</div>
                        <div className="font-mono tabular-nums">
                          every {formatInterval(row.cron.expectedIntervalSec)}
                        </div>
                      </TableCell>
                      <TableCell className="px-3 py-2 align-top font-mono tabular-nums">
                        <div className="text-foreground">{formatLastRun(row, nowSeconds)}</div>
                        <div className="text-muted-foreground">completed {formatLastGood(row, nowSeconds)}</div>
                      </TableCell>
                      <TableCell className="px-3 py-2 align-top font-mono tabular-nums text-muted-foreground">
                        {formatDurationValue(timing?.duration ?? null, timing?.unavailableLabel ?? "Unknown")}
                      </TableCell>
                      <TableCell className="px-3 py-2 align-top font-mono tabular-nums text-muted-foreground">
                        {lastRun ? (lastRun.itemCount ?? "N/A") : (row.cron.telemetryUnknown ? "Unknown" : "N/A")}
                      </TableCell>
                      <TableCell className="px-3 py-2 align-top text-muted-foreground">
                        {row.runningState === "running" ? <div>running now</div> : null}
                        {row.runningState === "stale" ? (
                          <div className="text-red-800 dark:text-red-300">stale heartbeat</div>
                        ) : null}
                        {errorStreak > 0 ? <div>errors {errorStreak}</div> : null}
                        {skippedStreak > 0 ? <div>lease skips {skippedStreak}</div> : null}
                        {artifacts > 0 ? <div>stale artifacts {artifacts}</div> : null}
                        {prerequisiteEvidence ? <div>{prerequisiteEvidence}</div> : null}
                        {row.runningState === "idle" &&
                        errorStreak === 0 &&
                        skippedStreak === 0 &&
                        artifacts === 0 &&
                        !prerequisiteEvidence ? (
                          <div>No extra evidence</div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            ))}
          </TableFrame>
          {selectedRow ? <CronDetailPanel row={selectedRow} nowSeconds={nowSeconds} /> : null}
        </div>
      )}

      <BudgetOnlySurfacePanel surfaces={budgetOnlySurfaces} />
    </div>
  );
}
