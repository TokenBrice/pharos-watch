"use client";

import { useMemo, useState } from "react";
import { CRON_STATUS_COLORS } from "@shared/lib/classification";
import { formatElapsedSeconds } from "@shared/lib/format";
import { Badge } from "@/components/ui/badge";
import { getStatusCronDisplay } from "@/lib/status/cron-config";
import { cn } from "@/lib/utils";
import { CronInFlightProgress } from "@/components/status/cron-in-flight-progress";
import { formatInterval, formatLatency } from "@/components/status/format";
import { summarizeCronMetadata } from "@/components/status/cron-metadata-summary";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import type { CronGroup } from "./crons-section";

type CronEntry = CronGroup["entries"][number];
type CronStatus = CronEntry[1];
type RecentRun = CronStatus["recentRuns"][number];

interface CronLaneTableProps {
  groups: CronGroup[];
  nowSeconds: number;
  emptyLabel: string;
}

interface CronLaneRow {
  group: CronGroup;
  job: string;
  cron: CronStatus;
  display: ReturnType<typeof getStatusCronDisplay>;
  metadataSummary: string[];
  lastSuccessfulRun: RecentRun | null;
  errorStreak: number;
  skippedStreak: number;
}

function countConsecutiveStatus(runs: RecentRun[], status: string): number {
  let count = 0;
  for (const run of runs) {
    if (run.status !== status) break;
    count += 1;
  }
  return count;
}

function getLastSuccessfulRun(runs: RecentRun[]): RecentRun | null {
  return runs.find((run) => run.status === "ok" || run.status === "degraded") ?? null;
}

function getRowTone(row: CronLaneRow): string {
  const latestStatus = row.cron.lastRun?.status;
  if (row.cron.telemetryUnknown) return "border-l-slate-500/60";
  if (!row.cron.healthy || latestStatus === "error") return "border-l-red-500/70";
  if (latestStatus === "degraded") return "border-l-amber-500/70";
  if (row.cron.inFlight && !row.cron.inFlight.stale) return "border-l-sky-500/70";
  return "border-l-green-500/60";
}

function formatLastRun(row: CronLaneRow, nowSeconds: number): string {
  if (!row.cron.lastRun) return row.cron.telemetryUnknown ? "unknown" : "none";
  return `${formatElapsedSeconds(Math.max(0, nowSeconds - row.cron.lastRun.startedAt))} ago`;
}

function formatLastGood(row: CronLaneRow, nowSeconds: number): string {
  if (!row.lastSuccessfulRun) return "none";
  return `${formatElapsedSeconds(Math.max(0, nowSeconds - row.lastSuccessfulRun.startedAt))} ago`;
}

function CronRunDots({ runs }: { runs: RecentRun[] }) {
  if (runs.length === 0) {
    return <span className="text-xs text-muted-foreground">none</span>;
  }

  return (
    <div className="flex items-center gap-1">
      {runs.map((run, index) => (
        <span
          key={`${run.startedAt}-${index}`}
          className={cn(
            "h-2.5 w-2.5 rounded-full",
            run.status === "ok"
              ? "bg-green-500"
              : run.status === "degraded"
                ? "bg-amber-500"
                : run.status === "skipped_locked"
                  ? "bg-zinc-500"
                  : "bg-red-500",
          )}
          title={`${run.status} - ${new Date(run.startedAt * 1000).toLocaleString()} (${formatLatency(run.durationMs)})`}
        />
      ))}
    </div>
  );
}

function CronDetailPanel({ row, nowSeconds }: { row: CronLaneRow; nowSeconds: number }) {
  const lastRun = row.cron.lastRun;
  const fullMetadata = lastRun?.metadata;

  return (
    <aside className="rounded-xl border border-border/60 bg-background/45 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{row.display.label}</h3>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{row.job}</p>
        </div>
        <Badge className={`text-xs ${CRON_STATUS_COLORS[lastRun?.status as keyof typeof CRON_STATUS_COLORS] ?? "bg-muted text-muted-foreground"}`}>
          {lastRun?.status ?? (row.cron.telemetryUnknown ? "unknown" : "no-runs")}
        </Badge>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 xl:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Group</dt>
          <dd className="mt-1 font-medium text-foreground">{row.group.title}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cadence</dt>
          <dd className="mt-1 font-mono tabular-nums text-foreground">{formatInterval(row.cron.expectedIntervalSec)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last run</dt>
          <dd className="mt-1 font-mono tabular-nums text-foreground">{formatLastRun(row, nowSeconds)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last good</dt>
          <dd className="mt-1 font-mono tabular-nums text-foreground">{formatLastGood(row, nowSeconds)}</dd>
        </div>
      </dl>

      {row.cron.inFlight ? (
        <div className={cn(
          "mt-4 rounded-lg border p-3 text-xs",
          row.cron.inFlight.stale
            ? "border-red-500/20 bg-red-500/5 text-red-700 dark:text-red-300"
            : "border-sky-500/20 bg-sky-500/5 text-sky-700 dark:text-sky-300",
        )}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={`text-xs ${row.cron.inFlight.stale ? "bg-red-500/15 text-red-700 dark:text-red-300" : "bg-sky-500/15 text-sky-700 dark:text-sky-300"}`}>
              {row.cron.inFlight.stale ? "running-stale" : "running"}
            </Badge>
            <span>started {formatElapsedSeconds(nowSeconds - row.cron.inFlight.startedAt)} ago</span>
            <span>heartbeat {formatElapsedSeconds(nowSeconds - row.cron.inFlight.updatedAt)} ago</span>
            {row.cron.inFlight.stage ? <span>stage {row.cron.inFlight.stage}</span> : null}
          </div>
          {row.cron.inFlight.itemsDone != null && row.cron.inFlight.itemsTotal != null ? (
            <div className="mt-2">
              <CronInFlightProgress
                itemsDone={row.cron.inFlight.itemsDone}
                itemsTotal={row.cron.inFlight.itemsTotal}
                stale={row.cron.inFlight.stale}
              />
            </div>
          ) : null}
          {row.cron.inFlight.message ? <div className="mt-2">{row.cron.inFlight.message}</div> : null}
        </div>
      ) : null}

      {lastRun?.error ? (
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer text-red-700 dark:text-red-400">Error details</summary>
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 text-xs">{lastRun.error}</pre>
        </details>
      ) : null}

      {row.metadataSummary.length > 0 ? (
        <div className="mt-4 rounded-lg border border-border/60 bg-muted/25 p-3 text-xs text-muted-foreground">
          {row.metadataSummary.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      ) : null}

      {fullMetadata && Object.keys(fullMetadata).length > 0 ? (
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Full run metadata</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded bg-muted p-2 text-xs">
            {JSON.stringify(fullMetadata, null, 2)}
          </pre>
        </details>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">History</span>
        <CronRunDots runs={row.cron.recentRuns ?? []} />
      </div>
    </aside>
  );
}

export function CronLaneTable({ groups, nowSeconds, emptyLabel }: CronLaneTableProps) {
  const rows = useMemo<CronLaneRow[]>(() => groups.flatMap((group) =>
    group.entries.map(([job, cron]) => {
      const recentRuns = cron.recentRuns ?? [];

      return {
        group,
        job,
        cron,
        display: getStatusCronDisplay(job),
        metadataSummary: summarizeCronMetadata(job, cron.lastRun?.metadata),
        lastSuccessfulRun: getLastSuccessfulRun(recentRuns),
        errorStreak: countConsecutiveStatus(recentRuns, "error"),
        skippedStreak: countConsecutiveStatus(recentRuns, "skipped_locked"),
      };
    }),
  ), [groups]);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const selectedRow = rows.find((row) => row.job === selectedJob) ?? rows[0] ?? null;

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border/60 bg-background/35 p-4 text-sm leading-relaxed text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.38fr)]">
      <TableFrame
        tableId="cron-lane"
        chrome="bare"
        className="overflow-hidden rounded-xl border border-border/60 bg-background/35"
        tableClassName="min-w-[58rem] border-collapse text-left text-xs"
      >
        <TableHeader className="border-b border-border/70 bg-muted/30 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          <TableRow rowIntent="static">
            <TableHead className="px-3 py-2 font-medium">State</TableHead>
            <TableHead className="px-3 py-2 font-medium">Job</TableHead>
            <TableHead className="px-3 py-2 font-medium">Trigger</TableHead>
            <TableHead className="px-3 py-2 font-medium">Last</TableHead>
            <TableHead className="px-3 py-2 font-medium">Good</TableHead>
            <TableHead className="px-3 py-2 font-medium">Run</TableHead>
            <TableHead className="px-3 py-2 font-medium">Items</TableHead>
            <TableHead className="px-3 py-2 font-medium">Streak</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="divide-y divide-border/55">
              {rows.map((row) => {
                const isSelected = selectedRow?.job === row.job;
                const lastRun = row.cron.lastRun;
                return (
                  <TableRow
                    key={row.job}
                    data-testid={`cron-row-${row.job}`}
                    className={cn(
                      "border-l-2 transition-colors",
                      getRowTone(row),
                      isSelected ? "bg-primary/8" : "hover:bg-muted/25",
                    )}
                  >
                    <TableCell className="px-3 py-2 align-top">
                      <button
                        type="button"
                        onClick={() => setSelectedJob(row.job)}
                        className="pharos-focus-ring rounded-sm text-left"
                      >
                        <Badge className={`text-xs ${CRON_STATUS_COLORS[lastRun?.status as keyof typeof CRON_STATUS_COLORS] ?? "bg-muted text-muted-foreground"}`}>
                          {lastRun?.status ?? (row.cron.telemetryUnknown ? "unknown" : "none")}
                        </Badge>
                      </button>
                    </TableCell>
                    <TableCell className="max-w-[15rem] px-3 py-2 align-top">
                      <button
                        type="button"
                        onClick={() => setSelectedJob(row.job)}
                        className="pharos-focus-ring block max-w-full rounded-sm text-left"
                      >
                        <span className="block truncate text-sm font-medium text-foreground">{row.display.label}</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">{row.job}</span>
                      </button>
                    </TableCell>
                    <TableCell className="px-3 py-2 align-top text-muted-foreground">
                      <div>{row.display.triggerMode === "isolated" ? "isolated" : "shared"}</div>
                      <div className="font-mono tabular-nums">{row.display.schedule ?? "—"}</div>
                      <div>every {formatInterval(row.cron.expectedIntervalSec)}</div>
                    </TableCell>
                    <TableCell className="px-3 py-2 align-top font-mono tabular-nums text-foreground">{formatLastRun(row, nowSeconds)}</TableCell>
                    <TableCell className="px-3 py-2 align-top font-mono tabular-nums text-muted-foreground">{formatLastGood(row, nowSeconds)}</TableCell>
                    <TableCell className="px-3 py-2 align-top font-mono tabular-nums text-muted-foreground">
                      {lastRun ? formatLatency(lastRun.durationMs) : "—"}
                    </TableCell>
                    <TableCell className="px-3 py-2 align-top font-mono tabular-nums text-muted-foreground">
                      {lastRun?.itemCount ?? "—"}
                    </TableCell>
                    <TableCell className="px-3 py-2 align-top text-muted-foreground">
                      {row.errorStreak > 0 ? <div>errors {row.errorStreak}</div> : null}
                      {row.skippedStreak > 0 ? <div>leases {row.skippedStreak}</div> : null}
                      {row.errorStreak === 0 && row.skippedStreak === 0 ? <div>clear</div> : null}
                    </TableCell>
                  </TableRow>
                );
              })}
        </TableBody>
      </TableFrame>
      {selectedRow ? <CronDetailPanel row={selectedRow} nowSeconds={nowSeconds} /> : null}
    </div>
  );
}
