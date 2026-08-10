"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { LazyDetails } from "@/components/status/lazy-details";
import { formatElapsedSeconds } from "@shared/lib/format";
import { formatInterval } from "@/components/status/format";
import type { BudgetOnlySurfaceStatus } from "@shared/types";
import { buildBudgetOnlySurfaceGroups, type BudgetOnlySurfaceRow } from "@/lib/cron-workbench-model";
import { formatDurationValue, formatTimestamp, getCronStatusColor } from "./cron-lane-format";

/**
 * Scheduled side work that carries connection and telemetry budgets but no
 * cron-run job row — rendered as a sibling of the cron lane table.
 */
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
                  ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
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

export function BudgetOnlySurfacePanel({ surfaces }: { surfaces: BudgetOnlySurfaceStatus[] }) {
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
