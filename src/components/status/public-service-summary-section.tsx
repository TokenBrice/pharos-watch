"use client";

import type { PublicComponentState, PublicStatusComponent, PublicStatusComponentId } from "@shared/types/status/public-health";
import { PUBLIC_COMPONENT_LABEL, PUBLIC_COMPONENT_SCOPE, PUBLIC_COMPONENT_STATE_TONE } from "@shared/lib/classification";
import { formatElapsedSeconds } from "@shared/lib/format";
import { STATUS_SYSTEM_FRESHNESS_SEC } from "@shared/lib/public-health";
import { Skeleton } from "@/components/ui/skeleton";
import { ComponentStatePill, StatusSection, TechnicalDetail, Timestamp } from "@/components/status/page-primitives";
import { UptimeBar } from "@/components/status/uptime-bar";
import type { ComponentDayCell } from "@/lib/status/public-status-timeline";
import { cn } from "@/lib/utils";

const COMPONENT_ROW_ACCENT: Record<PublicComponentState, string> = {
  operational: "",
  delayed: "-mx-2 rounded-lg border-l-[3px] border-l-state-info-solid bg-state-info-subtle px-2",
  degraded: "-mx-2 rounded-lg border-l-[3px] border-l-state-warn-solid bg-state-warn-subtle px-2",
  outage: "-mx-2 rounded-lg border-l-[3px] border-l-state-danger-solid bg-state-danger-subtle px-2",
};

const UPTIME_LEGEND_ITEMS = [
  { label: PUBLIC_COMPONENT_STATE_TONE.operational.label, swatch: PUBLIC_COMPONENT_STATE_TONE.operational.bar },
  { label: PUBLIC_COMPONENT_STATE_TONE.delayed.label, swatch: PUBLIC_COMPONENT_STATE_TONE.delayed.bar },
  { label: PUBLIC_COMPONENT_STATE_TONE.degraded.label, swatch: PUBLIC_COMPONENT_STATE_TONE.degraded.bar },
  { label: PUBLIC_COMPONENT_STATE_TONE.outage.label, swatch: PUBLIC_COMPONENT_STATE_TONE.outage.bar },
  { label: "No data", swatch: "bg-muted/60 ring-1 ring-inset ring-border/60" },
] as const;

export type PublicHistoryLoadState = "loading" | "error" | "ready";

interface PublicServiceSummarySectionProps {
  /** Every public component, in PUBLIC_STATUS_COMPONENT_IDS order. */
  components: readonly PublicStatusComponent[];
  /** Per-component daily cells; read only when `historyState` is "ready". */
  dayCells: Record<PublicStatusComponentId, ComponentDayCell[]> | null;
  historyState: PublicHistoryLoadState;
  historyDays: number;
  /** History sample time (epoch seconds), the "today" of the bars. */
  nowSec: number;
  /** First persisted public row; days before it render as no data. */
  publicHistoryStartedAt: number | null;
  /** Informational note on reviewed price gaps (not an incident). */
  footnote?: string | null;
  /** The page's minute clock (epoch seconds) for hold labels; defaults to `nowSec`. */
  clockSec?: number;
}

function formatBudget(budget: NonNullable<PublicStatusComponent["budget"]>): string {
  return `Delayed after ${formatElapsedSeconds(budget.delayedAfterSec)}, degraded after ${formatElapsedSeconds(budget.degradedAfterSec)}, outage after ${formatElapsedSeconds(budget.outageAfterSec)} without an update.`;
}

function formatUtcMinute(epochSec: number): string {
  return `${new Date(epochSec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * A failed read keeps the last confirmed state (ADR-42); this line says so.
 * The page clock re-dates a retained response, so "held" cannot outlive its bound.
 */
function formatHeld(held: NonNullable<PublicStatusComponent["held"]>, clockSec: number): string {
  if (!held.expired && held.confirmedAt != null && clockSec - held.confirmedAt <= STATUS_SYSTEM_FRESHNESS_SEC) {
    return `Held since ${formatUtcMinute(held.since)}. Some evidence cannot be read right now, so the last confirmed state is shown.`;
  }
  return held.confirmedAt == null ? "Not confirmed. Some evidence cannot be read right now."
    : `Not confirmed since ${formatUtcMinute(held.confirmedAt)}. Some evidence cannot be read, so the last confirmed state is shown.`;
}

function ComponentRow({
  component,
  cells,
  historyState,
  clockSec,
}: {
  component: PublicStatusComponent;
  cells: ComponentDayCell[] | undefined;
  historyState: PublicHistoryLoadState;
  clockSec: number;
}) {
  const label = PUBLIC_COMPONENT_LABEL[component.id];
  const operational = component.state === "operational";
  return (
    <li
      className={cn(
        "border-b border-border/60 py-3 last:border-0",
        !operational && "my-1 border-b-0",
        COMPONENT_ROW_ACCENT[component.state],
      )}
      data-testid={`public-component-${component.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">{label}</h3>
          <p className="text-xs text-muted-foreground">{PUBLIC_COMPONENT_SCOPE[component.id]}</p>
        </div>
        <ComponentStatePill state={component.state} className="shrink-0" />
      </div>
      {!operational || component.summary || component.held ? (
        <div className="mt-2 space-y-1 text-sm text-foreground">
          {component.summary ? <p>{component.summary}</p> : null}
          {component.held ? <p className="text-xs text-muted-foreground">{formatHeld(component.held, clockSec)}</p> : null}
          <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            {!operational && component.since != null ? (
              <span>
                For <Timestamp epochSec={component.since} variant="duration" />
              </span>
            ) : null}
            {component.budget ? <span>{formatBudget(component.budget)}</span> : null}
          </p>
          {component.reasons.length > 0 ? (
            <TechnicalDetail>
              <ul className="space-y-0.5">
                {component.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </TechnicalDetail>
          ) : null}
        </div>
      ) : null}
      <div className="mt-2">
        {historyState === "loading" ? (
          <Skeleton variant="shimmer" className="h-5 w-full rounded-sm" aria-label={`Loading ${label} history`} role="status" />
        ) : historyState === "ready" && cells ? (
          <UptimeBar cells={cells} label={label} />
        ) : null}
      </div>
    </li>
  );
}

export function PublicServiceSummarySection({
  components,
  dayCells,
  historyState,
  historyDays,
  nowSec,
  publicHistoryStartedAt,
  footnote,
  clockSec = nowSec,
}: PublicServiceSummarySectionProps) {
  const windowStart = nowSec - historyDays * 86_400;
  const operationalCount = components.filter((component) => component.state === "operational").length;
  const hasNonOperational = operationalCount < components.length;

  return (
    <StatusSection
      id="overview"
      title="Components"
      summary={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 lg:justify-end">
          {hasNonOperational ? (
            <span className="pharos-numeric inline-flex items-center rounded-full border border-border/60 bg-background/80 px-2.5 py-0.5 text-xs font-medium text-foreground dark:bg-background/45">
              {operationalCount} of {components.length} operational
            </span>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Component history legend">
            {UPTIME_LEGEND_ITEMS.map((item) => (
              <span key={item.label} className="pharos-chart-legend-chip">
                <span aria-hidden="true" className={cn("h-2.5 w-2 rounded-xs", item.swatch)} />
                {item.label}
              </span>
            ))}
          </div>
        </div>
      }
    >
      {historyState === "ready" ? (
        <div className="flex justify-between text-2xs text-muted-foreground" aria-hidden="true">
          <span>{historyDays} days ago</span>
          <span>Today</span>
        </div>
      ) : null}
      <ul>
        {components.map((component) => (
          <ComponentRow
            key={component.id}
            component={component}
            cells={dayCells?.[component.id]}
            historyState={historyState}
            clockSec={clockSec}
          />
        ))}
      </ul>
      <div className="space-y-1 text-2xs text-muted-foreground">
        {historyState === "ready" ? (
          <div className="flex justify-between">
            <span>{historyDays} days ago</span>
            <span>Today</span>
          </div>
        ) : null}
        {historyState === "error" ? (
          <p className="text-xs">Component history could not be loaded, so the {historyDays}-day bars are not shown.</p>
        ) : null}
        {historyState === "ready" && (publicHistoryStartedAt == null || publicHistoryStartedAt > windowStart) ? (
          <p className="text-xs">
            {publicHistoryStartedAt == null
              ? "Component history has not started recording yet; earlier days show no data."
              : <>Component history began <Timestamp epochSec={publicHistoryStartedAt} nowSec={nowSec} />; earlier days show no data.</>}
          </p>
        ) : null}
        {footnote ? <p className="text-xs">{footnote}</p> : null}
      </div>
    </StatusSection>
  );
}
