"use client";

import { Fragment, useMemo, useState } from "react";
import { formatElapsedSeconds } from "@shared/lib/format";
import type { StatusCause, StatusTransition } from "@shared/types";
import { ChevronDown, ChevronUp, RotateCcw } from "lucide-react";
import { TableBody, TableCaption, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { Button } from "@/components/ui/button";
import type { StatusHistoryWindow } from "@/hooks/use-status-history";
import {
  DEFAULT_INCIDENT_HISTORY_QUERY,
  INCIDENT_FLAPPING_TRANSITION_THRESHOLD,
  INCIDENT_HISTORY_WINDOWS,
  buildIncidentHistoryView,
  type IncidentHistoryFilters,
  type IncidentPublicImpact,
  type IncidentPublicImpactFilter,
  type IncidentSeverity,
  type IncidentSeverityFilter,
  type IncidentSurfaceFilter,
  type IncidentTransitionView,
} from "@/lib/incident-history-view-model";
import { cn } from "@/lib/utils";
import { FilterSelect } from "@/components/status/page-primitives";
import { SeverityPill, StatusPill } from "./severity-pill";

const SURFACE_LABELS: Record<StatusCause["layer"], string> = {
  availability: "Availability",
  "data-quality": "Data quality",
  system: "Status system",
};

const PUBLIC_IMPACT_LABELS: Record<IncidentPublicImpact, string> = {
  impacting: "Impacting",
  "not-impacting": "Not impacting",
  unknown: "Unknown",
};

interface TransitionTimelineProps {
  transitions: readonly StatusTransition[];
  nowSeconds: number;
  transitionsLast24h: number;
  window: StatusHistoryWindow;
  filters: IncidentHistoryFilters;
  onWindowChange: (window: StatusHistoryWindow) => void;
  onFiltersChange: (patch: Partial<IncidentHistoryFilters>) => void;
  isLoading: boolean;
  evidenceScope?: "loaded-window" | "recent-status-fallback";
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

function severityPill(severity: IncidentSeverity) {
  return severity === "unknown" ? (
    <StatusPill className="bg-muted text-muted-foreground">unknown</StatusPill>
  ) : (
    <SeverityPill severity={severity} />
  );
}

function publicImpactPill(publicImpact: IncidentPublicImpact) {
  return (
    <StatusPill
      className={cn(
        publicImpact === "impacting" && "bg-red-500/15 text-red-700 dark:text-red-300",
        publicImpact === "not-impacting" && "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
        publicImpact === "unknown" && "bg-muted text-muted-foreground",
      )}
    >
      {PUBLIC_IMPACT_LABELS[publicImpact]}
    </StatusPill>
  );
}

function TransitionDuration({ row }: { row: IncidentTransitionView }) {
  const transition = row.transition;
  return (
    <div className="min-w-[13rem] space-y-1 text-xs">
      <p className="font-medium text-foreground">
        {row.ongoing ? "Current state" : "State duration"}: {formatElapsedSeconds(row.durationSec)}
      </p>
      {row.resolution === "resolved" && row.resolvedAt != null ? (
        <p className="whitespace-normal text-muted-foreground">Resolved at {formatTimestamp(row.resolvedAt)}</p>
      ) : row.resolution === "unresolved" ? (
        <p className="whitespace-normal text-amber-700 dark:text-amber-300">Resolution not present in loaded history</p>
      ) : (
        <p className="text-muted-foreground">
          {transition.transitionType === "init" ? "Initial state" : "No incident resolution"}
        </p>
      )}
    </div>
  );
}

function CauseDetails({ transition }: { transition: StatusTransition }) {
  if (transition.causes.length === 0) {
    return <p className="text-xs text-muted-foreground">No persisted causes are available for this transition.</p>;
  }

  return (
    <ol className="divide-y divide-border/60">
      {transition.causes.map((cause, index) => (
        <li key={`${transition.id}-${cause.code}-${index}`} className="min-w-0 py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityPill severity={cause.severity} />
            <span className="font-mono text-xs text-foreground">{cause.code}</span>
            <span className="text-xs text-muted-foreground">{SURFACE_LABELS[cause.layer]}</span>
          </div>
          <p className="mt-1 whitespace-normal break-words text-xs text-muted-foreground">{cause.message}</p>
          {cause.metric ? (
            <p className="mt-1 whitespace-normal break-all font-mono text-[11px] text-muted-foreground">
              {cause.metric}
              {cause.value != null ? `=${cause.value}` : ""}
              {cause.threshold != null ? ` (threshold ${cause.threshold})` : ""}
            </p>
          ) : null}
          <details className="mt-2 text-xs">
            <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-muted-foreground">
              Raw cause data
            </summary>
            <pre className="mt-2 max-h-48 min-w-0 overflow-auto whitespace-pre-wrap break-all bg-muted/50 p-2 font-mono text-[11px] text-foreground">
              {JSON.stringify(cause, null, 2)}
            </pre>
          </details>
        </li>
      ))}
    </ol>
  );
}

export function TransitionTimeline({
  transitions,
  nowSeconds,
  transitionsLast24h,
  window,
  filters,
  onWindowChange,
  onFiltersChange,
  isLoading,
  evidenceScope = "loaded-window",
}: TransitionTimelineProps) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const view = useMemo(
    () => buildIncidentHistoryView(transitions, nowSeconds, transitionsLast24h, filters),
    [filters, nowSeconds, transitions, transitionsLast24h],
  );
  const hasActiveFilters =
    filters.severity !== "all" ||
    filters.surface !== "all" ||
    filters.causeCode != null ||
    filters.publicImpact !== "all";

  const resetFilters = () => {
    onFiltersChange({
      severity: DEFAULT_INCIDENT_HISTORY_QUERY.severity,
      surface: DEFAULT_INCIDENT_HISTORY_QUERY.surface,
      causeCode: DEFAULT_INCIDENT_HISTORY_QUERY.causeCode,
      publicImpact: DEFAULT_INCIDENT_HISTORY_QUERY.publicImpact,
    });
  };

  return (
    <section aria-labelledby="incident-timeline-title" className="min-w-0 space-y-4">
      <div className="flex flex-col gap-3 border-b border-border/60 pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 id="incident-timeline-title" className="text-base font-semibold text-foreground">
            Incident timeline
          </h3>
          <p className="mt-1 text-xs text-muted-foreground" aria-live="polite" aria-atomic="true">
            {view.visibleTransitions} of {view.totalTransitions} transitions in the{" "}
            {evidenceScope === "loaded-window" ? "loaded window" : "recent status fallback"}
          </p>
        </div>
        <div
          role="group"
          aria-label="Incident history window"
          className="inline-flex w-fit max-w-full overflow-x-auto rounded-md border border-border/70"
        >
          {INCIDENT_HISTORY_WINDOWS.map((option) => {
            const selected = option === window;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={selected}
                onClick={() => onWindowChange(option)}
                className={cn(
                  "pharos-focus-ring min-h-11 min-w-12 border-r border-border/70 px-3 text-xs font-medium last:border-r-0",
                  selected
                    ? "bg-foreground text-background forced-colors:text-[Highlight]"
                    : "bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                {option}
              </button>
            );
          })}
        </div>
      </div>

      {view.isFlapping ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2.5 text-sm text-amber-950 dark:text-amber-100">
          <span className="font-medium">Flapping detected.</span> {view.transitionsLast24h} transitions were recorded in
          the last 24 hours; the stable baseline is at most {INCIDENT_FLAPPING_TRANSITION_THRESHOLD}.
        </div>
      ) : null}

      <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
        <FilterSelect
          label="Severity"
          value={filters.severity}
          onChange={(value) => onFiltersChange({ severity: value as IncidentSeverityFilter })}
        >
          <option value="all">All severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Informational</option>
          <option value="unknown">Unknown</option>
        </FilterSelect>
        <FilterSelect
          label="Surface"
          value={filters.surface}
          onChange={(value) => onFiltersChange({ surface: value as IncidentSurfaceFilter })}
        >
          <option value="all">All surfaces</option>
          <option value="availability">Availability</option>
          <option value="data-quality">Data quality</option>
          <option value="system">Status system</option>
          <option value="unknown">Unknown</option>
        </FilterSelect>
        <FilterSelect
          label="Cause code"
          value={filters.causeCode ?? ""}
          onChange={(value) => onFiltersChange({ causeCode: value || null })}
        >
          <option value="">All cause codes</option>
          {view.causeCodeOptions.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          label="Public impact"
          value={filters.publicImpact}
          onChange={(value) => onFiltersChange({ publicImpact: value as IncidentPublicImpactFilter })}
        >
          <option value="all">All impact states</option>
          <option value="impacting">Impacting</option>
          <option value="not-impacting">Not impacting</option>
          <option value="unknown">Unknown</option>
        </FilterSelect>
        <div className="flex items-end">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-11"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
          >
            <RotateCcw aria-hidden="true" />
            Reset filters
          </Button>
        </div>
      </div>

      {isLoading && transitions.length === 0 ? (
        <p
          role="status"
          aria-live="polite"
          className="border-y border-border/60 py-8 text-center text-sm text-muted-foreground"
        >
          Loading status history...
        </p>
      ) : transitions.length === 0 ? (
        <p className="border-y border-border/60 py-8 text-center text-sm text-muted-foreground">
          {evidenceScope === "loaded-window"
            ? "No status transitions recorded in this window."
            : "No recent transitions are included in the status fallback; the selected history window is unavailable."}
        </p>
      ) : view.rows.length === 0 ? (
        <div className="border-y border-border/60 py-8 text-center">
          <p className="text-sm text-muted-foreground">No transitions match the current filters.</p>
        </div>
      ) : (
        <TableFrame
          tableId="status-transition-timeline"
          testId="status-transition-timeline-table"
          chrome="bare"
          density="compact"
          stickyHeader
          className="min-w-0 max-w-full overflow-hidden rounded-md border border-border/60"
          viewportClassName="max-h-[38rem]"
          viewportProps={{ vertical: true }}
          tableClassName="min-w-[76rem] border-collapse"
          tableProps={{ "aria-busy": isLoading }}
        >
          <TableCaption className="sr-only">Status transition history</TableCaption>
          <TableHeader className="bg-muted">
            <TableRow rowIntent="static" className="border-b text-left text-muted-foreground">
              <TableHead scope="col" className="font-medium">
                Time
              </TableHead>
              <TableHead scope="col" className="font-medium">
                Transition
              </TableHead>
              <TableHead scope="col" className="font-medium">
                Severity
              </TableHead>
              <TableHead scope="col" className="font-medium">
                Surface
              </TableHead>
              <TableHead scope="col" className="font-medium">
                Public impact
              </TableHead>
              <TableHead scope="col" className="font-medium">
                Duration
              </TableHead>
              <TableHead scope="col" className="font-medium">
                Reason
              </TableHead>
              <TableHead scope="col" className="font-medium">
                Causes
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.rows.map((row) => {
              const transition = row.transition;
              const isExpanded = expanded[transition.id] ?? false;
              const causesId = `transition-causes-${transition.id}`;
              return (
                <Fragment key={transition.id}>
                  <TableRow rowIntent="scan" className="border-b">
                    <TableHead
                      scope="row"
                      className="whitespace-normal py-2 text-left text-xs font-normal text-muted-foreground"
                    >
                      <time dateTime={new Date(transition.at * 1000).toISOString()}>
                        {formatTimestamp(transition.at)}
                      </time>
                    </TableHead>
                    <TableCell className="py-2 align-top text-xs">
                      <div className="font-mono tabular-nums text-foreground">
                        {transition.from ?? "init"} -&gt; {transition.to}
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                        raw {transition.rawStatus} · {transition.transitionType}
                      </div>
                    </TableCell>
                    <TableCell className="py-2 align-top">{severityPill(row.severity)}</TableCell>
                    <TableCell className="whitespace-normal py-2 align-top text-xs text-muted-foreground">
                      {row.surfaces.length > 0
                        ? row.surfaces.map((surface) => SURFACE_LABELS[surface]).join(", ")
                        : "Unknown"}
                    </TableCell>
                    <TableCell className="py-2 align-top">{publicImpactPill(row.publicImpact)}</TableCell>
                    <TableCell className="whitespace-normal py-2 align-top">
                      <TransitionDuration row={row} />
                    </TableCell>
                    <TableCell className="max-w-[22rem] whitespace-normal py-2 align-top text-xs text-muted-foreground">
                      <p className="break-words">{transition.reason}</p>
                      <p className="mt-1 font-mono text-[11px] tabular-nums">
                        confidence {(transition.confidence * 100).toFixed(1)}%
                      </p>
                    </TableCell>
                    <TableCell className="py-2 align-top">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="min-h-11"
                        aria-expanded={isExpanded}
                        aria-controls={isExpanded ? causesId : undefined}
                        aria-label={`${isExpanded ? "Hide" : "Show"} ${transition.causes.length} causes for transition ${transition.id}`}
                        onClick={() => setExpanded((previous) => ({ ...previous, [transition.id]: !isExpanded }))}
                      >
                        {isExpanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                        {transition.causes.length}
                      </Button>
                    </TableCell>
                  </TableRow>
                  {isExpanded ? (
                    <TableRow id={causesId} rowIntent="static" className="border-b bg-muted/20 last:border-0">
                      <TableCell colSpan={8} className="whitespace-normal py-3">
                        <CauseDetails transition={transition} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </TableFrame>
      )}
    </section>
  );
}
