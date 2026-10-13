import {
  PUBLIC_COMPONENT_STATES,
  PUBLIC_STATUS_COMPONENT_IDS,
  type PublicComponentState,
  type PublicStatusComponent,
  type PublicStatusComponentId,
  type PublicStatusTransition,
} from "@shared/types/status";

/**
 * Pure derivations for the public /status/ page: per-component daily bars and
 * incidents folded from the public transition log. Both read only `source:
 * "public"` rows (the persisted public projection, ADR-32); time those rows do
 * not cover is "no-data", never operational (R1/R2).
 */

const DAY_SEC = 86_400;
const STATE_RANK = Object.fromEntries(PUBLIC_COMPONENT_STATES.map((state, index) => [state, index])) as Record<
  PublicComponentState,
  number
>;

function worse(a: PublicComponentState, b: PublicComponentState): PublicComponentState {
  return STATE_RANK[b] > STATE_RANK[a] ? b : a;
}

/** Component states after a change; absent ids are operational. `null` = unknown. */
type Snapshot = ReadonlyMap<PublicStatusComponentId, PublicComponentState> | null;

function isPublicRow(row: PublicStatusTransition): boolean {
  return row.source === "public";
}

function rowSnapshot(row: PublicStatusTransition): Snapshot {
  if (!row.components) return null;
  return new Map(row.components.map((component) => [component.id, component.state]));
}

function liveSnapshot(components: readonly Pick<PublicStatusComponent, "id" | "state">[]): Snapshot {
  return new Map(
    components.filter((component) => component.state !== "operational").map((component) => [component.id, component.state]),
  );
}

export type ComponentDayState = PublicComponentState | "no-data";

export interface ComponentDayCell {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  state: ComponentDayState;
}

interface Segment {
  start: number;
  end: number;
  snapshot: Snapshot;
}

/**
 * Known-state segments covering the loaded window, oldest first. The state
 * before the oldest loaded public row is known only when that row says it
 * left an all-operational (`healthy`) state and is not the first public row
 * ever written; otherwise that stretch is left out (no data).
 */
function buildSegments(
  transitions: readonly PublicStatusTransition[],
  live: Snapshot,
  publicHistoryStartedAt: number | null,
  windowStart: number,
  nowSec: number,
  truncated: boolean,
): Segment[] {
  const rows = transitions.filter(isPublicRow).sort((a, b) => a.at - b.at || a.id - b.id);
  if (rows.length === 0) {
    // No public change inside the window: the projection held one state the
    // whole time, provided public history existed before the window opened.
    // ponytail: that state is taken from the live projection; a persisted
    // seed row would make this exact if the two ever diverge.
    if (publicHistoryStartedAt == null || publicHistoryStartedAt > nowSec) return [];
    return [{ start: Math.max(windowStart, publicHistoryStartedAt), end: nowSec, snapshot: live }];
  }

  const segments: Segment[] = [];
  const first = rows[0];
  const firstEverRow = publicHistoryStartedAt != null && first.at <= publicHistoryStartedAt;
  // A truncated page (hasMore) hides older changes, so the stretch before the
  // oldest loaded row stays unknown rather than painted operational (R2/R7).
  if (!truncated && !firstEverRow && first.transitionType !== "init" && first.from === "healthy") {
    segments.push({ start: windowStart, end: first.at, snapshot: new Map() });
  }
  rows.forEach((row, index) => {
    segments.push({ start: row.at, end: rows[index + 1]?.at ?? nowSec, snapshot: rowSnapshot(row) });
  });
  return segments;
}

/**
 * Per-component daily cells for the last `days` UTC days (oldest first). Each
 * cell is the worst state the component held during that day; today also
 * includes the live projection.
 */
export function buildComponentDayCells({
  transitions,
  liveComponents,
  publicHistoryStartedAt,
  nowSec,
  days = 30,
  truncated = false,
}: {
  transitions: readonly PublicStatusTransition[];
  liveComponents: readonly Pick<PublicStatusComponent, "id" | "state">[];
  publicHistoryStartedAt: number | null | undefined;
  nowSec: number;
  days?: number;
  /** True when the history page did not hold the whole window (`hasMore`). */
  truncated?: boolean;
}): Record<PublicStatusComponentId, ComponentDayCell[]> {
  const todayStart = Math.floor(nowSec / DAY_SEC) * DAY_SEC;
  const windowStart = todayStart - (days - 1) * DAY_SEC;
  const live = liveSnapshot(liveComponents);
  const segments = buildSegments(transitions, live, publicHistoryStartedAt ?? null, windowStart, nowSec, truncated);

  const result = {} as Record<PublicStatusComponentId, ComponentDayCell[]>;
  for (const id of PUBLIC_STATUS_COMPONENT_IDS) result[id] = [];

  for (let index = 0; index < days; index += 1) {
    const dayStart = windowStart + index * DAY_SEC;
    const dayEnd = dayStart + DAY_SEC;
    const date = new Date(dayStart * 1000).toISOString().slice(0, 10);
    const active: ReadonlyMap<PublicStatusComponentId, PublicComponentState>[] = [];
    for (const segment of segments) {
      if (segment.snapshot && segment.start < dayEnd && segment.end > dayStart) active.push(segment.snapshot);
    }
    if (dayStart === todayStart && live) active.push(live);
    for (const id of PUBLIC_STATUS_COMPONENT_IDS) {
      const state: ComponentDayState = active.length === 0
        ? "no-data"
        : active.reduce<PublicComponentState>((lead, snapshot) => worse(lead, snapshot.get(id) ?? "operational"), "operational");
      result[id].push({ date, state });
    }
  }
  return result;
}

export interface PublicIncident {
  /** First row of the incident. */
  id: number;
  startedAt: number;
  /** False when the incident was already open at the oldest loaded row. */
  startKnown: boolean;
  /** Null while ongoing. */
  resolvedAt: number | null;
  worstState: PublicComponentState;
  /** Affected components in page order, with the worst state each reached. */
  components: { id: PublicStatusComponentId; worstState: PublicComponentState }[];
  /** Machine-readable reasons and transition reasons, for the technical disclosure (R4). */
  reasons: string[];
}

export interface LegacyIncident {
  id: number;
  startedAt: number;
  startKnown: boolean;
  resolvedAt: number | null;
  /** The operator log stopped at the cutover; the component log carries on from `resolvedAt`. */
  handedOff?: boolean;
  worstStatus: "degraded" | "stale";
  reasons: string[];
}

function rowIsOperational(row: PublicStatusTransition): boolean {
  if (row.headline) return row.headline.state === "operational";
  if (row.components) return row.components.length === 0;
  return row.to === "healthy";
}

/** Fold public rows into incidents (operational → non-operational → operational), newest first. */
export function foldPublicIncidents(transitions: readonly PublicStatusTransition[]): PublicIncident[] {
  const rows = transitions.filter(isPublicRow).sort((a, b) => a.at - b.at || a.id - b.id);
  type OpenIncident = PublicIncident & { byId: Map<PublicStatusComponentId, PublicComponentState>; reasonSet: Set<string> };
  const incidents: OpenIncident[] = [];
  let open: OpenIncident | null = null;

  rows.forEach((row, index) => {
    if (rowIsOperational(row)) {
      if (open) {
        open.resolvedAt = row.at;
        open = null;
      }
      return;
    }
    if (!open) {
      open = {
        id: row.id,
        startedAt: row.at,
        startKnown: !(index === 0 && (row.transitionType === "init" || (row.from != null && row.from !== "healthy"))),
        resolvedAt: null,
        worstState: "operational",
        components: [],
        reasons: [],
        byId: new Map(),
        reasonSet: new Set(),
      };
      incidents.push(open);
    }
    // Rows without a component record still mark the incident non-operational.
    if (!row.components || row.components.length === 0) open.worstState = worse(open.worstState, "degraded");
    for (const component of row.components ?? []) {
      open.byId.set(component.id, worse(open.byId.get(component.id) ?? "operational", component.state));
      open.worstState = worse(open.worstState, component.state);
      for (const reason of component.reasons) open.reasonSet.add(reason);
    }
    if (row.reason) open.reasonSet.add(row.reason);
  });

  return incidents
    .map(({ byId, reasonSet, ...incident }) => ({
      ...incident,
      components: PUBLIC_STATUS_COMPONENT_IDS.filter((id) => byId.has(id)).map((id) => ({ id, worstState: byId.get(id)! })),
      reasons: [...reasonSet],
    }))
    .reverse();
}

/** Fold legacy operator rows (one overall state, no components) into incidents, newest first. */
export function foldLegacyIncidents(
  transitions: readonly PublicStatusTransition[],
  publicHistoryStartedAt: number | null = null,
): LegacyIncident[] {
  // Rows without `source` predate the public projection, so they are operator rows too.
  const rows = transitions.filter((row) => row.source !== "public").sort((a, b) => a.at - b.at || a.id - b.id);
  const incidents: LegacyIncident[] = [];
  let open: LegacyIncident | null = null;
  rows.forEach((row, index) => {
    if (row.to === "healthy") {
      if (open) open.resolvedAt = row.at;
      open = null;
      return;
    }
    if (!open) {
      open = {
        id: row.id,
        startedAt: row.at,
        startKnown: !(index === 0 && row.from != null && row.from !== "healthy"),
        resolvedAt: null,
        worstStatus: "degraded",
        reasons: [],
      };
      incidents.push(open);
    }
    if (row.to === "stale") open.worstStatus = "stale";
    if (row.reason && !open.reasons.includes(row.reason)) open.reasons.push(row.reason);
  });
  // Legacy rows end at the cutover, so an incident still open there was handed
  // to the component log; it is not ongoing in the operator log.
  // `open` is reassigned inside the forEach callback, which TS flow analysis cannot see.
  const lastOpen = open as LegacyIncident | null;
  if (lastOpen && publicHistoryStartedAt != null) {
    lastOpen.resolvedAt = publicHistoryStartedAt;
    lastOpen.handedOff = true;
  }
  return incidents.reverse();
}

/**
 * When the current headline state began: for a non-operational headline the
 * earliest known `since` among affected components; for operational the
 * latest `since` (the last recovery), only when every component reports one.
 */
export function getHeadlineSince(
  components: readonly Pick<PublicStatusComponent, "state" | "since">[],
): number | null {
  const affected = components.filter((component) => component.state !== "operational");
  if (affected.length > 0) {
    const known = affected.map((component) => component.since).filter((since): since is number => since != null);
    return known.length > 0 ? Math.min(...known) : null;
  }
  if (components.length === 0 || components.some((component) => component.since == null)) return null;
  return Math.max(...components.map((component) => component.since!));
}
