"use client";

import { useMemo, useState } from "react";
import { Circle, CircleDot, Search, X } from "lucide-react";
import type { BudgetOnlySurfaceStatus } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import {
  buildCronWorkbenchModel,
  DEFAULT_CRON_WORKBENCH_FILTERS,
  formatCronRunTiming,
  type CronImpactFilter,
  type CronRunningFilter,
  type CronWorkbenchFilters,
  type CronWorkbenchStateFilter,
} from "@/lib/cron-workbench-model";
import { countConsecutiveStatus } from "@/lib/status/cron-run-utils";
import { cn } from "@/lib/utils";
import type { CronGroup } from "./cron-lane-types";
import { formatInterval } from "@/components/status/format";
import { STATUS_PANEL_SHELL_CLASS } from "@/components/status/page-primitives";
import { BudgetOnlySurfacePanel } from "./budget-only-surfaces";
import { CronDetailPanel } from "./cron-detail-panel";
import {
  CRON_COLUMN_COUNT,
  CRON_DETAIL_ID,
  CRON_STATE_LABELS,
  FILTER_FIELD_CLASS_NAME,
  formatDurationValue,
  formatLastGood,
  formatLastRun,
  formatPrerequisiteEvidence,
  getRowTone,
  getStateBadgeClass,
  readString,
} from "./cron-lane-format";
import { RecentRunLegend } from "./cron-run-history";

interface CronLaneTableProps {
  groups: CronGroup[];
  budgetOnlySurfaces: BudgetOnlySurfaceStatus[];
  nowSeconds: number;
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

