"use client";

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import type { BudgetOnlySurfaceStatus, StatusCause } from "@shared/types";
import { OPERATOR_VERDICT_TONE } from "@shared/lib/classification";
import { Button } from "@/components/ui/button";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import {
  buildCronWorkbenchModel,
  DEFAULT_CRON_WORKBENCH_FILTERS,
  formatCronGroupSummary,
  formatCronRunTiming,
  getCronNextExpected,
  type CronImpactFilter,
  type CronVerdictFilter,
  type CronWorkbenchFilters,
  type CronWorkbenchModel,
  type CronWorkbenchRow,
} from "@/lib/cron-workbench-model";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { cn } from "@/lib/utils";
import type { CronGroup } from "./cron-lane-types";
import {
  CountValue,
  FilterSelect,
  STATUS_FILTER_FIELD_CLASS,
  STATUS_PANEL_SHELL_CLASS,
  Timestamp,
  VerdictPill,
} from "@/components/status/page-primitives";
import { BudgetOnlySurfacePanel } from "./budget-only-surfaces";
import { CronDetailPanel } from "./cron-detail-panel";
import {
  CRON_COLUMN_COUNT,
  CRON_DETAIL_ID,
  formatDurationValue,
  formatPrerequisiteEvidence,
  readString,
} from "./cron-lane-format";
import { CronRunDots } from "./cron-run-history";

interface CronLaneTableProps {
  groups: CronGroup[];
  budgetOnlySurfaces: BudgetOnlySurfaceStatus[];
  causes?: readonly StatusCause[];
  nowSeconds: number;
}

function getVerdictOptions(counts: CronWorkbenchModel["verdictCounts"], total: number) {
  const attention = counts.act + counts.watch + counts.running + counts.unavailable;
  return [
    { value: "attention" as const, label: `Needs attention ${attention}` },
    { value: "act" as const, label: `Act now ${counts.act}` },
    { value: "watch" as const, label: `Watch ${counts.watch}` },
    { value: "running" as const, label: `Running ${counts.running}` },
    ...(counts.unavailable > 0 ? [{ value: "unavailable" as const, label: `Unavailable ${counts.unavailable}` }] : []),
    { value: "all" as const, label: `All ${total}` },
  ];
}

function CronWorkbenchControls({
  filters,
  model,
  onFiltersChange,
  onReset,
}: {
  filters: CronWorkbenchFilters;
  model: CronWorkbenchModel;
  onFiltersChange: (patch: Partial<CronWorkbenchFilters>) => void;
  onReset: () => void;
}) {
  const extraFilterCount = Number(filters.impact !== "all") + Number(filters.triggerGroup !== "all");
  return (
    <div role="group" className="flex min-w-0 flex-wrap items-center gap-3" aria-label="Cron job filters">
      <label className="relative block min-w-0 flex-1 basis-56">
        <span className="sr-only">Search jobs</span>
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          type="search"
          className={cn(STATUS_FILTER_FIELD_CLASS, "pl-9")}
          value={filters.search}
          placeholder="Search job, schedule, or reason"
          onChange={(event) => onFiltersChange({ search: event.target.value })}
        />
      </label>
      <ControlPillToggle<CronVerdictFilter>
        variant="segmented"
        ariaLabel="Verdict"
        className="max-w-full flex-wrap"
        buttonClassName="h-11 tabular-nums"
        options={getVerdictOptions(model.verdictCounts, model.totalCount)}
        value={filters.verdict}
        onChange={(verdict) => onFiltersChange({ verdict })}
      />
      <details className="open:basis-full">
        <summary className="pharos-focus-ring flex h-11 cursor-pointer list-none items-center rounded-md border border-input bg-background px-3 text-sm text-foreground marker:hidden">
          More filters{extraFilterCount > 0 ? ` (${extraFilterCount})` : ""}
        </summary>
        <div className="mt-3 grid max-w-xl gap-3 sm:grid-cols-2">
          <FilterSelect
            label="Impact class"
            value={filters.impact}
            onChange={(value) => onFiltersChange({ impact: value as CronImpactFilter })}
          >
            <option value="all">All impact classes</option>
            <option value="public-critical">Public critical</option>
            <option value="admin-watch">Admin watch</option>
          </FilterSelect>
          <FilterSelect
            label="Trigger group"
            value={filters.triggerGroup}
            onChange={(value) => onFiltersChange({ triggerGroup: value })}
          >
            <option value="all">All trigger groups</option>
            {model.triggerGroups.map((group) => (
              <option key={group.value} value={group.value}>
                {group.label} ({group.count})
              </option>
            ))}
          </FilterSelect>
        </div>
      </details>
      <span className="pharos-numeric text-xs text-muted-foreground">
        {model.filteredCount} of {model.totalCount} jobs
      </span>
      {model.hasActiveFilters ? (
        <Button type="button" size="sm" variant="ghost" onClick={onReset}>
          <X className="size-4" aria-hidden="true" />
          Reset filters
        </Button>
      ) : null}
    </div>
  );
}

function ItemsValue({ row }: { row: CronWorkbenchRow }) {
  const lastRun = row.cron.runs[0];
  if (lastRun?.itemCount != null) return <CountValue value={lastRun.itemCount} />;
  const title = lastRun
    ? "N/A: this job does not report an item count."
    : row.cron.telemetryUnknown
      ? "Unknown: cron history could not be read."
      : "N/A: no run recorded yet.";
  return (
    <span title={title} className="pharos-numeric text-muted-foreground">
      —<span className="sr-only">{title}</span>
    </span>
  );
}

const NEXT_EXPECTED_TONE = {
  scheduled: "text-muted-foreground",
  due: "text-foreground",
  overdue: OPERATOR_VERDICT_TONE.watch.text,
  running: OPERATOR_VERDICT_TONE.running.text,
  unknown: "text-muted-foreground",
} as const;

function CronRow({
  row,
  nowSeconds,
  isSelected,
  onSelect,
}: {
  row: CronWorkbenchRow;
  nowSeconds: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const lastRun = row.cron.runs[0];
  const timing = lastRun ? formatCronRunTiming(lastRun) : null;
  const prerequisite = formatPrerequisiteEvidence(readString(lastRun?.skippedReason));
  const next = getCronNextExpected(row.cron, nowSeconds, row.job);
  return (
    <TableRow
      data-testid={`cron-row-${row.job}`}
      onClick={onSelect}
      className={cn("cursor-pointer", isSelected ? "bg-primary/8" : "hover:bg-muted/25")}
    >
      <TableCell className="px-3 py-2 align-top">
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <VerdictPill verdict={row.verdict} />
          {row.qualityReasons.length > 0 ? (
            <span
              className="rounded-full border border-border/60 bg-muted/30 px-1.5 py-0.5 text-xs text-muted-foreground"
              title={`Findings: ${row.qualityReasons.join(", ")}`}
            >
              {row.qualityReasons.length} {row.qualityReasons.length === 1 ? "finding" : "findings"}
            </span>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="max-w-[16rem] px-3 py-2 align-top">
        <button
          type="button"
          aria-current={isSelected ? "true" : undefined}
          aria-controls={isSelected ? CRON_DETAIL_ID : undefined}
          className="pharos-focus-ring block w-full min-w-0 rounded-sm text-left"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{row.display.label}</span>
            {row.impactClass === "public-critical" ? (
              <span
                className="shrink-0 rounded border border-border/70 px-1 text-xs text-muted-foreground"
                title="Public critical: public data depends on this job."
              >
                Public
              </span>
            ) : null}
          </span>
          <span className="block truncate font-mono text-xs text-muted-foreground">{row.job}</span>
        </button>
        {row.verdict !== "ok" ? (
          <p className="mt-0.5 line-clamp-2 whitespace-normal text-xs leading-snug text-muted-foreground">
            {row.verdictReason.sentence}
          </p>
        ) : null}
      </TableCell>
      <TableCell className="px-3 py-2 align-top text-xs">
        {lastRun ? (
          <Timestamp epochSec={lastRun.startedAt} nowSec={nowSeconds} className="text-foreground" />
        ) : (
          <span className="text-muted-foreground">{row.cron.telemetryUnknown ? "Unknown" : "No runs"}</span>
        )}
        {lastRun ? (
          <div className="text-muted-foreground">
            <span>{row.statusLabel}</span> ·{" "}
            <span className="pharos-numeric">
              {formatDurationValue(timing?.duration ?? null, timing?.unavailableLabel ?? "Unknown")}
            </span>
          </div>
        ) : null}
        {prerequisite ? <div className="text-muted-foreground">{prerequisite}</div> : null}
      </TableCell>
      <TableCell className={cn("pharos-numeric whitespace-nowrap px-3 py-2 align-top text-xs", NEXT_EXPECTED_TONE[next.kind])}>
        <span title={next.budget}>{next.label}</span>
      </TableCell>
      <TableCell className="px-3 py-2 align-top">
        <CronRunDots runs={row.cron.runs} />
      </TableCell>
      <TableCell className="px-3 py-2 text-right align-top text-xs">
        <ItemsValue row={row} />
      </TableCell>
    </TableRow>
  );
}

export function CronLaneTable({ groups, budgetOnlySurfaces, causes, nowSeconds }: CronLaneTableProps) {
  const [filters, setFilters] = useState<CronWorkbenchFilters>({ ...DEFAULT_CRON_WORKBENCH_FILTERS });
  const { getParam, setParam } = useUrlFilters();
  const selectedJob = getParam("job") || null;
  const model = useMemo(
    () => buildCronWorkbenchModel(groups, filters, nowSeconds, selectedJob),
    [filters, groups, nowSeconds, selectedJob],
  );
  const selectedRow = model.rows.find((row) => row.job === selectedJob) ?? model.rows[0] ?? null;
  const isDefaultAttentionView = filters.verdict === "attention" && !model.hasActiveFilters;

  const updateFilters = (patch: Partial<CronWorkbenchFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  };

  const resetFilters = () => {
    setFilters({ ...DEFAULT_CRON_WORKBENCH_FILTERS });
  };

  const selectJob = (job: string) => {
    setParam("job", job);
    // Below 2xl the detail renders under the table; bring it into view.
    if (typeof window !== "undefined" && !window.matchMedia?.("(min-width: 1536px)").matches) {
      window.requestAnimationFrame(() => {
        document.getElementById(CRON_DETAIL_ID)?.scrollIntoView?.({ block: "start", behavior: "smooth" });
      });
    }
  };

  return (
    <div className="min-w-0 max-w-full space-y-5">
      <CronWorkbenchControls
        filters={filters}
        model={model}
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
              ? `Nothing to act on or watch. ${model.verdictCounts.ok} OK job${model.verdictCounts.ok === 1 ? " is" : "s are"} hidden.`
              : "No cron jobs match the current filters."}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mt-2"
            onClick={() => (isDefaultAttentionView ? updateFilters({ verdict: "all" }) : resetFilters())}
          >
            {isDefaultAttentionView ? "Show all jobs" : "Reset filters"}
          </Button>
        </div>
      ) : (
        <div className="grid min-w-0 max-w-full items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(22rem,26rem)]">
          <TableFrame
            tableId="cron-lane"
            chrome="bare"
            stickyHeader
            className={cn("min-w-0 max-w-full overflow-hidden rounded-lg", STATUS_PANEL_SHELL_CLASS)}
            tableClassName="min-w-[46rem] border-separate border-spacing-0 text-left text-xs"
            tableProps={{ "aria-label": "Cron jobs by trigger group" }}
            viewportClassName="min-w-0 max-w-full max-h-[min(70vh,44rem)]"
            viewportProps={{
              vertical: true,
              mobileScrollHint: "Scroll inside the table for more jobs and columns",
            }}
          >
            <TableHeader className="text-xs font-medium text-muted-foreground">
              <TableRow rowIntent="static">
                <TableHead className="border-b border-border/70 px-3 py-2">Verdict</TableHead>
                <TableHead className="border-b border-border/70 px-3 py-2">Job</TableHead>
                <TableHead className="border-b border-border/70 px-3 py-2">Last run</TableHead>
                <TableHead className="border-b border-border/70 px-3 py-2">Next opportunity</TableHead>
                <TableHead className="border-b border-border/70 px-3 py-2">Recent runs</TableHead>
                <TableHead className="border-b border-border/70 px-3 py-2 text-right">Items</TableHead>
              </TableRow>
            </TableHeader>
            {model.groups.map((group) => (
              <TableBody key={group.key} aria-label={`${group.title} cron jobs`}>
                <TableRow rowIntent="static">
                  <th
                    scope="rowgroup"
                    colSpan={CRON_COLUMN_COUNT}
                    className="border-y border-border/70 bg-muted px-3 py-2 text-left font-normal"
                  >
                    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="flex min-w-0 flex-wrap items-baseline gap-2" title={group.description}>
                        <span className="text-xs font-semibold text-foreground">{group.title}</span>
                        <span className="font-mono text-xs text-muted-foreground">{group.badge}</span>
                      </span>
                      <span className="pharos-numeric text-xs text-muted-foreground">
                        {formatCronGroupSummary(group.summary)}
                      </span>
                    </div>
                  </th>
                </TableRow>
                {group.rows.map((row) => (
                  <CronRow
                    key={row.key}
                    row={row}
                    nowSeconds={nowSeconds}
                    isSelected={selectedRow?.key === row.key}
                    onSelect={() => selectJob(row.job)}
                  />
                ))}
              </TableBody>
            ))}
          </TableFrame>
          {selectedRow ? <CronDetailPanel row={selectedRow} causes={causes} nowSeconds={nowSeconds} /> : null}
        </div>
      )}

      <BudgetOnlySurfacePanel surfaces={budgetOnlySurfaces} />
    </div>
  );
}
