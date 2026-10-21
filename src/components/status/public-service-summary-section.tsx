"use client";

import type { PublicStatusComponent, PublicStatusComponentId } from "@shared/types";
import { PUBLIC_COMPONENT_LABEL, PUBLIC_COMPONENT_SCOPE } from "@shared/lib/classification";
import { formatElapsedSeconds } from "@shared/lib/format";
import { ComponentStatePill, StatusSection, Timestamp } from "@/components/status/page-primitives";
import { UptimeBar } from "@/components/status/uptime-bar";
import type { ComponentDayCell } from "@/lib/status/public-status-timeline";

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
}

function formatBudget(budget: NonNullable<PublicStatusComponent["budget"]>): string {
  return `Delayed after ${formatElapsedSeconds(budget.delayedAfterSec)}, degraded after ${formatElapsedSeconds(budget.degradedAfterSec)}, outage after ${formatElapsedSeconds(budget.outageAfterSec)} without an update.`;
}

function ComponentRow({
  component,
  cells,
  historyState,
}: {
  component: PublicStatusComponent;
  cells: ComponentDayCell[] | undefined;
  historyState: PublicHistoryLoadState;
}) {
  const label = PUBLIC_COMPONENT_LABEL[component.id];
  const operational = component.state === "operational";
  return (
    <li className="border-b border-border/60 py-3 last:border-0" data-testid={`public-component-${component.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">{label}</h3>
          <p className="text-xs text-muted-foreground">{PUBLIC_COMPONENT_SCOPE[component.id]}</p>
        </div>
        <ComponentStatePill state={component.state} className="shrink-0" />
      </div>
      {!operational || component.summary ? (
        <div className="mt-2 space-y-1 text-sm text-foreground">
          {component.summary ? <p>{component.summary}</p> : null}
          <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            {!operational && component.since != null ? (
              <span>
                For <Timestamp epochSec={component.since} variant="duration" />
              </span>
            ) : null}
            {component.budget ? <span>{formatBudget(component.budget)}</span> : null}
          </p>
          {component.reasons.length > 0 ? (
            <details className="text-xs text-muted-foreground">
              <summary className="pharos-focus-ring cursor-pointer rounded-sm hover:text-foreground">Technical detail</summary>
              <ul className="mt-1 space-y-0.5 font-mono">
                {component.reasons.map((reason) => (
                  <li key={reason} className="break-all">{reason}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
      <div className="mt-2">
        {historyState === "loading" ? (
          <div className="h-5 animate-pulse rounded-sm bg-muted/40" aria-label={`Loading ${label} history`} role="img" />
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
}: PublicServiceSummarySectionProps) {
  const windowStart = nowSec - historyDays * 86_400;
  return (
    <StatusSection id="overview" title="Components">
      <ul>
        {components.map((component) => (
          <ComponentRow
            key={component.id}
            component={component}
            cells={dayCells?.[component.id]}
            historyState={historyState}
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
