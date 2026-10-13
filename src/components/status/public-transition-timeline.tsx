"use client";

import { useState, type ReactNode } from "react";
import type { PublicStatusTransition } from "@shared/types";
import { PUBLIC_COMPONENT_LABEL, PUBLIC_COMPONENT_STATE_TONE } from "@shared/lib/classification";
import { formatElapsedSeconds } from "@shared/lib/format";
import { ComponentStatePill, Timestamp } from "@/components/status/page-primitives";
import {
  foldLegacyIncidents,
  foldPublicIncidents,
  type LegacyIncident,
  type PublicIncident,
} from "@/lib/status/public-status-timeline";

const INITIAL_VISIBLE_INCIDENTS = 10;

function TechnicalDetail({ reasons }: { reasons: readonly string[] }) {
  if (reasons.length === 0) return null;
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="pharos-focus-ring cursor-pointer rounded-sm hover:text-foreground">Technical detail</summary>
      <ul className="mt-1 space-y-0.5 font-mono">
        {reasons.map((reason) => (
          <li key={reason} className="break-all">{reason}</li>
        ))}
      </ul>
    </details>
  );
}

function IncidentTimes({
  startedAt,
  startKnown,
  resolvedAt,
  nowSec,
  liveRecovered = false,
}: {
  startedAt: number;
  startKnown: boolean;
  resolvedAt: number | null;
  nowSec: number;
  /** The live verdict is operational before the next persisted check records the recovery. */
  liveRecovered?: boolean;
}) {
  const end = resolvedAt ?? nowSec;
  return (
    <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
      <span>
        {startKnown ? "Started" : "Open before"} <Timestamp epochSec={startedAt} nowSec={nowSec} />
      </span>
      <span>
        {resolvedAt != null
          ? <>Resolved <Timestamp epochSec={resolvedAt} nowSec={nowSec} /></>
          : liveRecovered ? "Recovered; the next check records the end time" : "Ongoing"}
      </span>
      <span className="pharos-numeric">
        {startKnown ? "" : "At least "}
        {formatElapsedSeconds(Math.max(0, end - startedAt))}
      </span>
    </p>
  );
}

function PublicIncidentItem({
  incident,
  nowSec,
  liveRecovered,
}: {
  incident: PublicIncident;
  nowSec: number;
  liveRecovered: boolean;
}) {
  const names = incident.components.map((component) => PUBLIC_COMPONENT_LABEL[component.id]);
  return (
    <li className="border-b border-border/60 py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-sm font-medium text-foreground">
          {names.length > 0 ? names.join(", ") : "Public status not operational"}
        </h3>
        <ComponentStatePill state={incident.worstState} className="shrink-0" />
      </div>
      <IncidentTimes {...incident} nowSec={nowSec} liveRecovered={liveRecovered} />
      {incident.components.length > 1 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {incident.components
            .map((component) => `${PUBLIC_COMPONENT_LABEL[component.id]}: ${PUBLIC_COMPONENT_STATE_TONE[component.worstState].label}`)
            .join(" · ")}
        </p>
      ) : null}
      <TechnicalDetail reasons={incident.reasons} />
    </li>
  );
}

function LegacyIncidentItem({ incident, nowSec }: { incident: LegacyIncident; nowSec: number }) {
  return (
    <li className="border-b border-border/60 py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-sm font-medium text-foreground">Earlier incident (overall state only)</h3>
        <ComponentStatePill state={incident.worstStatus === "stale" ? "outage" : "degraded"} className="shrink-0" />
      </div>
      <IncidentTimes {...incident} nowSec={nowSec} />
      <TechnicalDetail reasons={incident.reasons} />
    </li>
  );
}

function BoundedList<T extends { id: number }>({
  items,
  noun,
  render,
}: {
  items: readonly T[];
  noun: string;
  render: (item: T) => ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, INITIAL_VISIBLE_INCIDENTS);
  return (
    <>
      <ol>{visible.map(render)}</ol>
      {items.length > INITIAL_VISIBLE_INCIDENTS ? (
        <button
          type="button"
          className="pharos-focus-ring mt-2 rounded-sm text-xs text-muted-foreground underline hover:text-foreground"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? `Show the latest ${INITIAL_VISIBLE_INCIDENTS} ${noun}` : `Show all ${items.length} ${noun}`}
        </button>
      ) : null}
    </>
  );
}

interface PublicIncidentListProps {
  transitions: readonly PublicStatusTransition[];
  /** History sample time (epoch seconds). */
  nowSec: number;
  historyDays: number;
  /** True when the window held more rows than were loaded (R7). */
  hasMore: boolean;
  /** True when the live headline is operational; closes the newest open incident's wording. */
  liveOperational?: boolean;
  /** When per-component history began; bounds which rows count as legacy. */
  publicHistoryStartedAt?: number | null;
}

/** Incidents folded from the public log; legacy operator rows are kept apart and labelled as such. */
export function PublicIncidentList({
  transitions,
  nowSec,
  historyDays,
  hasMore,
  liveOperational = false,
  publicHistoryStartedAt = null,
}: PublicIncidentListProps) {
  const incidents = foldPublicIncidents(transitions);
  const legacy = foldLegacyIncidents(transitions, publicHistoryStartedAt);
  return (
    <div className="space-y-4">
      {incidents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No incidents recorded in the last {historyDays} days.</p>
      ) : (
        <BoundedList
          items={incidents}
          noun="incidents"
          render={(incident) => (
            <PublicIncidentItem
              key={incident.id}
              incident={incident}
              nowSec={nowSec}
              liveRecovered={liveOperational && incident.resolvedAt == null && incident.id === incidents[0]?.id}
            />
          )}
        />
      )}
      {legacy.length > 0 ? (
        <section aria-labelledby="legacy-incidents-title">
          <h3 id="legacy-incidents-title" className="text-sm font-medium text-foreground">
            Earlier incidents
          </h3>
          <p className="text-xs text-muted-foreground">
            Recorded before per-component history began. The operator log tracks one overall state, so affected
            components are not known for these entries.
          </p>
          <BoundedList
            items={legacy}
            noun="earlier incidents"
            render={(incident) => <LegacyIncidentItem key={incident.id} incident={incident} nowSec={nowSec} />}
          />
        </section>
      ) : null}
      {hasMore ? (
        <p className="text-xs text-muted-foreground">
          Showing the latest {transitions.length} status changes; older changes in this window were not loaded.
        </p>
      ) : null}
    </div>
  );
}
