"use client";

import { Fragment, useMemo, useState } from "react";
import { formatElapsedSeconds } from "@shared/lib/format";
import type { StatusCause, StatusTransition } from "@shared/types";
import Link from "next/link";
import { ChevronDown, ChevronUp, RefreshCw, RotateCcw } from "lucide-react";
import { TableBody, TableCaption, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { Button } from "@/components/ui/button";
import type { StatusHistoryWindow } from "@/hooks/admin-api-hooks";
import {
  DEFAULT_INCIDENT_HISTORY_QUERY,
  INCIDENT_FLAPPING_TRANSITION_THRESHOLD,
  INCIDENT_HISTORY_WINDOWS,
  buildIncidentHistoryView,
  buildIncidentRecurrence,
  foldIncidentEpisodes,
  getCauseSubjects,
  type IncidentHistoryFilters,
  type IncidentPublicImpact,
  type IncidentPublicImpactFilter,
  type IncidentSeverity,
  type IncidentSeverityFilter,
  type IncidentSurfaceFilter,
  type IncidentEpisode,
  type IncidentRecurrenceGroup,
  type IncidentTransitionView,
} from "@/lib/incident-history-view-model";
import { cn } from "@/lib/utils";
import { OPERATIONAL_PILL_CLASS } from "@/lib/status/dashboard-presentation";
import { FilterSelect, Timestamp, VerdictPill } from "@/components/status/page-primitives";
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
  transitionsLast24h: number | null;
  window: StatusHistoryWindow;
  filters: IncidentHistoryFilters;
  onWindowChange: (window: StatusHistoryWindow) => void;
  onFiltersChange: (patch: Partial<IncidentHistoryFilters>) => void;
  isLoading: boolean;
  evidenceScope?: "loaded-window" | "recent-status-fallback";
  /** The transition read failed or returned no completeness marker: an empty list is not "nothing happened" (R2). */
  readFailed?: boolean;
  onRetry?: () => void;
  isRetrying?: boolean;
}

function cronJobHref(jobId: string): string {
  return `/admin/crons/?job=${encodeURIComponent(jobId)}`;
}

function SubjectLinks({ subjects }: { subjects: readonly string[] }) {
  if (subjects.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-x-2 gap-y-1">
      {subjects.map((subject) => (
        <Link
          key={subject}
          href={cronJobHref(subject)}
          className="pharos-focus-ring rounded-sm font-mono text-xs text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
        >
          {subject}
        </Link>
      ))}
    </span>
  );
}

function RecurrenceSummary({
  groups,
  window,
  evidenceScope,
}: {
  groups: readonly IncidentRecurrenceGroup[];
  window: StatusHistoryWindow;
  evidenceScope: "loaded-window" | "recent-status-fallback";
}) {
  if (groups.length === 0) return null;
  return (
    <div className="space-y-2 rounded-md border border-state-warn bg-state-warn-subtle px-3 py-2.5">
      <h4 className="text-sm font-medium text-state-warn">
        {evidenceScope === "loaded-window"
          ? `Recurring causes in the loaded ${window} window`
          : "Recurring causes in the recent status fallback"}
      </h4>
      <ul className="space-y-1.5 text-xs text-foreground">
        {groups.map((group) => (
          <li key={group.key} className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
            <span className="pharos-numeric font-medium">{group.count}×</span>
            <span className="font-mono">{group.causeCode}</span>
            {group.subjects.length > 0 ? (
              <>
                <span className="text-muted-foreground">on</span>
                <SubjectLinks subjects={group.subjects} />
              </>
            ) : null}
            {group.meanIntervalSec != null && group.meanIntervalSec > 0 ? (
              <span className="text-muted-foreground">
                about every {formatElapsedSeconds(group.meanIntervalSec)}, last <Timestamp epochSec={group.lastAt} />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function IncidentList({ episodes, nowSeconds }: { episodes: readonly IncidentEpisode[]; nowSeconds: number }) {
  if (episodes.length === 0) return null;
  return (
    <section aria-labelledby="incident-episodes-title" className="space-y-2">
      <h4 id="incident-episodes-title" className="text-sm font-semibold text-foreground">
        Incidents <span className="pharos-numeric font-normal text-muted-foreground">({episodes.length})</span>
      </h4>
      <ol className="divide-y divide-border/60 border-y border-border/60">
        {episodes.map((episode) => (
          <li key={episode.id} className="flex flex-col gap-1 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <VerdictPill verdict={episode.ongoing ? episode.verdict : "ok"} label={episode.ongoing ? "Ongoing" : "Recovered"} />
              <span className="text-foreground" title={`Worst admin state: ${episode.worstState}`}>
                {episode.durationSec == null
                  ? episode.ongoing ? "Held since before the loaded window" : "Started before the loaded window"
                  : `${episode.ongoing ? "Held for" : "Lasted"} ${formatElapsedSeconds(episode.durationSec)}`}
              </span>
              <span className="min-w-0 break-words font-mono text-muted-foreground">
                {episode.causeCodes == null ? "—" : episode.causeCodes.join(", ") || "No persisted causes"}
              </span>
            </div>
            <div className="shrink-0 text-muted-foreground">
              {episode.startedAt == null ? (
                "Started before the loaded window"
              ) : (
                <>
                  Started <Timestamp epochSec={episode.startedAt} nowSec={nowSeconds} />
                </>
              )}
              {episode.endedAt != null ? (
                <>
                  {" "}· recovered <Timestamp epochSec={episode.endedAt} nowSec={nowSeconds} />
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function severityPill(severity: IncidentSeverity) {
  return severity === "unknown" ? (
    <StatusPill className={OPERATIONAL_PILL_CLASS.unknown}>Unknown</StatusPill>
  ) : (
    <SeverityPill severity={severity} />
  );
}

function publicImpactPill(publicImpact: IncidentPublicImpact) {
  return (
    <StatusPill
      className={cn(
        publicImpact === "impacting" && "bg-state-danger-solid/15 text-state-danger-bright",
        publicImpact === "not-impacting" && "bg-state-positive-solid/12 text-state-positive-bright",
        publicImpact === "unknown" && OPERATIONAL_PILL_CLASS.unknown,
      )}
    >
      {PUBLIC_IMPACT_LABELS[publicImpact]}
    </StatusPill>
  );
}

function TransitionDuration({ row, nowSeconds }: { row: IncidentTransitionView; nowSeconds: number }) {
  const transition = row.transition;
  return (
    <div className="min-w-[13rem] space-y-1 text-xs">
      <p className="font-medium text-foreground">
        {row.ongoing ? "Current state" : "State duration"}: {formatElapsedSeconds(row.durationSec)}
      </p>
      {row.resolution === "resolved" && row.resolvedAt != null ? (
        <p className="whitespace-normal text-muted-foreground">
          Resolved <Timestamp epochSec={row.resolvedAt} nowSec={nowSeconds} />
        </p>
      ) : row.resolution === "unresolved" ? (
        <p className="whitespace-normal text-state-warn-bright">Resolution not present in loaded history</p>
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
          {getCauseSubjects(cause).length > 0 ? (
            <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">
              <span>Jobs:</span>
              <SubjectLinks subjects={getCauseSubjects(cause)} />
            </p>
          ) : null}
          {cause.metric ? (
            <p className="mt-1 whitespace-normal break-all font-mono text-xs text-muted-foreground">
              {cause.metric}
              {cause.value != null ? `=${cause.value}` : ""}
              {cause.threshold != null ? ` (threshold ${cause.threshold})` : ""}
            </p>
          ) : null}
          <details className="mt-2 text-xs">
            <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-muted-foreground">
              Raw cause data
            </summary>
            <pre className="mt-2 max-h-48 min-w-0 overflow-auto whitespace-pre-wrap break-all bg-muted/50 p-2 font-mono text-xs text-foreground">
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
  readFailed = false,
  onRetry,
  isRetrying = false,
}: TransitionTimelineProps) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const view = useMemo(
    () => buildIncidentHistoryView(transitions, nowSeconds, transitionsLast24h, filters),
    [filters, nowSeconds, transitions, transitionsLast24h],
  );
  const episodes = useMemo(() => foldIncidentEpisodes(transitions, nowSeconds), [transitions, nowSeconds]);
  const recurrence = useMemo(() => buildIncidentRecurrence(transitions), [transitions]);
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
      {view.isFlapping == null && (
        <p className="text-sm text-muted-foreground">Recent transition count unavailable; flapping cannot be assessed.</p>
      )}

      <RecurrenceSummary groups={recurrence} window={window} evidenceScope={evidenceScope} />

      {view.isFlapping ? (
        <div className="rounded-md border border-state-warn-solid/40 bg-state-warn-solid/[0.06] px-3 py-2.5 text-sm text-state-warn-ink">
          <span className="font-medium">Flapping detected.</span> {view.transitionsLast24h} transitions were recorded in
          the last 24 hours; the stable baseline is at most {INCIDENT_FLAPPING_TRANSITION_THRESHOLD}.
        </div>
      ) : null}

      <IncidentList episodes={episodes} nowSeconds={nowSeconds} />

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
      ) : transitions.length === 0 && readFailed ? (
        <div role="alert" className="flex flex-col items-center gap-3 border-y border-border/60 py-8 text-center">
          <p className="text-sm text-foreground">Status transitions could not be loaded for this window.</p>
          <p className="max-w-xl text-xs text-muted-foreground">
            The read failed or returned no completeness marker, so this empty list does not mean no transitions
            happened.
          </p>
          {onRetry ? (
            <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={isRetrying} onClick={onRetry}>
              <RefreshCw className={isRetrying ? "animate-spin" : ""} aria-hidden="true" />
              Retry history
            </Button>
          ) : null}
        </div>
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
                      <Timestamp epochSec={transition.at} nowSec={nowSeconds} />
                    </TableHead>
                    <TableCell className="py-2 align-top text-xs">
                      <div className="font-mono tabular-nums text-foreground">
                        {transition.from ?? "init"} -&gt; {transition.to}
                      </div>
                      <div className="mt-1 font-mono text-xs text-muted-foreground">
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
                      <TransitionDuration row={row} nowSeconds={nowSeconds} />
                    </TableCell>
                    <TableCell className="max-w-[22rem] whitespace-normal py-2 align-top text-xs text-muted-foreground">
                      <p className="break-words">{transition.reason}</p>
                      <p className="mt-1 font-mono text-xs tabular-nums">
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
