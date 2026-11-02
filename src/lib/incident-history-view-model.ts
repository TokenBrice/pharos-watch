import { transitionHasPublicImpact } from "@shared/lib/status-public-impact";
import type { StatusCause, StatusTransition } from "@shared/types";
import type { StatusHistoryWindow } from "@/lib/admin-api-query-descriptors";
import { STATUS_CAUSE_SEVERITY_RANK } from "@/lib/status/cause-severity";
import { getCausesVerdict } from "@/lib/status/triage-inbox";

export const INCIDENT_HISTORY_WINDOWS: readonly StatusHistoryWindow[] = ["6h", "24h", "7d", "30d"];
export const INCIDENT_FLAPPING_TRANSITION_THRESHOLD = 2;

export type IncidentSeverity = StatusCause["severity"] | "unknown";
export type IncidentSeverityFilter = "all" | IncidentSeverity;
export type IncidentSurface = StatusCause["layer"] | "unknown";
export type IncidentSurfaceFilter = "all" | IncidentSurface;
export type IncidentPublicImpact = "impacting" | "not-impacting" | "unknown";
export type IncidentPublicImpactFilter = "all" | IncidentPublicImpact;

export interface IncidentHistoryFilters {
  severity: IncidentSeverityFilter;
  surface: IncidentSurfaceFilter;
  causeCode: string | null;
  publicImpact: IncidentPublicImpactFilter;
}

export interface IncidentHistoryQuery extends IncidentHistoryFilters {
  window: StatusHistoryWindow;
}

export interface IncidentTransitionView {
  transition: StatusTransition;
  severity: IncidentSeverity;
  surfaces: StatusCause["layer"][];
  publicImpact: IncidentPublicImpact;
  causeCodes: string[];
  durationSec: number;
  durationEndsAt: number | null;
  ongoing: boolean;
  resolvedAt: number | null;
  resolution: "resolved" | "unresolved" | "not-applicable";
}

export interface IncidentHistoryView {
  rows: IncidentTransitionView[];
  totalTransitions: number;
  visibleTransitions: number;
  causeCodeOptions: string[];
  transitionsLast24h: number | null;
  isFlapping: boolean | null;
}

export const DEFAULT_INCIDENT_HISTORY_QUERY: IncidentHistoryQuery = {
  window: "24h",
  severity: "all",
  surface: "all",
  causeCode: null,
  publicImpact: "all",
};

const HISTORY_WINDOW_SET = new Set<string>(INCIDENT_HISTORY_WINDOWS);
const SEVERITY_FILTER_SET = new Set<string>(["all", "critical", "warning", "info", "unknown"]);
const SURFACE_FILTER_SET = new Set<string>(["all", "availability", "data-quality", "system", "unknown"]);
const PUBLIC_IMPACT_FILTER_SET = new Set<string>(["all", "impacting", "not-impacting", "unknown"]);

function readEnum<T extends string>(value: string | null, allowed: ReadonlySet<string>, fallback: T): T {
  return value != null && allowed.has(value) ? (value as T) : fallback;
}

export function parseIncidentHistoryQuery(search: string | URLSearchParams): IncidentHistoryQuery {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const causeCode = params.get("cause")?.trim() || null;
  return {
    window: readEnum(params.get("window"), HISTORY_WINDOW_SET, DEFAULT_INCIDENT_HISTORY_QUERY.window),
    severity: readEnum(params.get("severity"), SEVERITY_FILTER_SET, DEFAULT_INCIDENT_HISTORY_QUERY.severity),
    surface: readEnum(params.get("surface"), SURFACE_FILTER_SET, DEFAULT_INCIDENT_HISTORY_QUERY.surface),
    causeCode,
    publicImpact: readEnum(params.get("impact"), PUBLIC_IMPACT_FILTER_SET, DEFAULT_INCIDENT_HISTORY_QUERY.publicImpact),
  };
}

export function buildIncidentHistoryUrl(
  location: Pick<Location, "pathname" | "search" | "hash">,
  query: IncidentHistoryQuery,
): string {
  const params = new URLSearchParams(location.search);
  const setOrDelete = (key: string, value: string, defaultValue: string) => {
    if (value === defaultValue) params.delete(key);
    else params.set(key, value);
  };

  setOrDelete("window", query.window, DEFAULT_INCIDENT_HISTORY_QUERY.window);
  setOrDelete("severity", query.severity, DEFAULT_INCIDENT_HISTORY_QUERY.severity);
  setOrDelete("surface", query.surface, DEFAULT_INCIDENT_HISTORY_QUERY.surface);
  setOrDelete("impact", query.publicImpact, DEFAULT_INCIDENT_HISTORY_QUERY.publicImpact);
  if (query.causeCode) params.set("cause", query.causeCode);
  else params.delete("cause");

  const serialized = params.toString();
  return `${location.pathname}${serialized ? `?${serialized}` : ""}${location.hash}`;
}

function getTransitionSeverity(causes: readonly StatusCause[]): IncidentSeverity {
  let severity: StatusCause["severity"] | null = null;
  for (const cause of causes) {
    if (severity == null || STATUS_CAUSE_SEVERITY_RANK[cause.severity] < STATUS_CAUSE_SEVERITY_RANK[severity]) {
      severity = cause.severity;
    }
  }
  return severity ?? "unknown";
}

function getTransitionSurfaces(causes: readonly StatusCause[]): StatusCause["layer"][] {
  const order: StatusCause["layer"][] = ["availability", "data-quality", "system"];
  const observed = new Set(causes.map((cause) => cause.layer));
  return order.filter((surface) => observed.has(surface));
}

function getTransitionPublicImpact(causes: readonly StatusCause[]): IncidentPublicImpact {
  if (causes.length === 0) return "unknown";
  return transitionHasPublicImpact([...causes]) ? "impacting" : "not-impacting";
}

function findResolvedAt(transitions: readonly StatusTransition[], rowIndex: number): number | null {
  const transition = transitions[rowIndex];
  if (!transition) return null;
  if (transition.to === "healthy") return transition.transitionType === "recover" ? transition.at : null;

  for (let index = rowIndex - 1; index >= 0; index -= 1) {
    const newer = transitions[index];
    if (newer?.to === "healthy") return newer.at;
  }
  return null;
}

function buildTransitionRows(transitions: readonly StatusTransition[], nowSeconds: number): IncidentTransitionView[] {
  const ordered = [...transitions].sort((left, right) => right.at - left.at || right.id - left.id);
  return ordered.map((transition, index) => {
    const newerTransition = ordered[index - 1] ?? null;
    const durationEndsAt = newerTransition?.at ?? null;
    const ongoing = durationEndsAt == null;
    const resolvedAt = findResolvedAt(ordered, index);
    const resolution =
      transition.to === "healthy"
        ? transition.transitionType === "recover"
          ? "resolved"
          : "not-applicable"
        : resolvedAt == null
          ? "unresolved"
          : "resolved";

    return {
      transition,
      severity: getTransitionSeverity(transition.causes),
      surfaces: getTransitionSurfaces(transition.causes),
      publicImpact: getTransitionPublicImpact(transition.causes),
      causeCodes: [...new Set(transition.causes.map((cause) => cause.code))].sort((left, right) =>
        left.localeCompare(right),
      ),
      durationSec: Math.max(0, (durationEndsAt ?? nowSeconds) - transition.at),
      durationEndsAt,
      ongoing,
      resolvedAt,
      resolution,
    };
  });
}

function rowMatchesFilters(row: IncidentTransitionView, filters: IncidentHistoryFilters): boolean {
  if (filters.severity !== "all" && row.severity !== filters.severity) return false;
  if (filters.surface !== "all") {
    if (filters.surface === "unknown" ? row.surfaces.length > 0 : !row.surfaces.includes(filters.surface)) {
      return false;
    }
  }
  if (filters.causeCode != null && !row.causeCodes.includes(filters.causeCode)) return false;
  if (filters.publicImpact !== "all" && row.publicImpact !== filters.publicImpact) return false;
  return true;
}

export function buildIncidentHistoryView(
  transitions: readonly StatusTransition[],
  nowSeconds: number,
  transitionsLast24h: number | null,
  filters: IncidentHistoryFilters,
): IncidentHistoryView {
  const allRows = buildTransitionRows(transitions, nowSeconds);
  const causeCodeOptions = [...new Set(allRows.flatMap((row) => row.causeCodes))].sort((left, right) =>
    left.localeCompare(right),
  );
  const rows = allRows.filter((row) => rowMatchesFilters(row, filters));

  return {
    rows,
    totalTransitions: allRows.length,
    visibleTransitions: rows.length,
    causeCodeOptions,
    transitionsLast24h,
    isFlapping: transitionsLast24h == null ? null : transitionsLast24h > INCIDENT_FLAPPING_TRANSITION_THRESHOLD,
  };
}

/**
 * Named subjects behind a cause (cron job ids). Prefers the structured
 * `subjects` field; older persisted causes only carry the trailing
 * "Jobs: a, b." message suffix, so that is parsed as a fallback.
 */
export function getCauseSubjects(cause: Pick<StatusCause, "subjects" | "message">): string[] {
  if (cause.subjects && cause.subjects.length > 0) return [...cause.subjects];
  const match = /Jobs?:\s*([^.]+)\.?\s*$/u.exec(cause.message);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    // "a, b and 3 more" names b; the remainder is only counted.
    .map((subject) => subject.replace(/\s+and \d+ more$/u, "").trim())
    .filter(Boolean);
}

export interface IncidentEpisode {
  id: string;
  /** null when the incident started before the loaded window. */
  startedAt: number | null;
  endedAt: number | null;
  ongoing: boolean;
  /** null when the start is outside the loaded window. */
  durationSec: number | null;
  worstState: StatusTransition["to"];
  /** null when the start predates the loaded window, so no causes were observed for it. */
  causeCodes: string[] | null;
  /** Triage verdict for the episode's causes (`getCausesVerdict`); recovered episodes still carry it. */
  verdict: "act" | "watch";
  transitionCount: number;
}

/**
 * Folds the transition stream into incidents: a non-healthy transition opens
 * one, further non-healthy transitions extend it, and a transition back to
 * `healthy` closes it. Newest first.
 */
export function foldIncidentEpisodes(
  transitions: readonly StatusTransition[],
  nowSeconds: number,
): IncidentEpisode[] {
  const ascending = [...transitions].sort((left, right) => left.at - right.at || left.id - right.id);
  const episodes: IncidentEpisode[] = [];
  let open: { first: StatusTransition; startKnown: boolean; members: StatusTransition[] } | null = null;

  const close = (endedAt: number | null) => {
    if (!open) return;
    const startedAt = open.startKnown ? open.first.at : null;
    const end = endedAt ?? nowSeconds;
    // A recovery as the oldest loaded row only observed the state the incident
    // recovered from: its own causes are recovery-time observations, not the
    // incident's, and its `to` says nothing about the worst state.
    const windowStartRecovery = !open.startKnown && open.first.to === "healthy";
    const recoveredFrom = open.first.from;
    episodes.push({
      id: `incident-${open.first.id}`,
      startedAt,
      endedAt,
      ongoing: endedAt == null,
      durationSec: startedAt == null ? null : Math.max(0, end - startedAt),
      worstState: windowStartRecovery && recoveredFrom != null && recoveredFrom !== "healthy"
        ? recoveredFrom
        : open.members.some((member) => member.to === "stale") ? "stale" : "degraded",
      causeCodes: windowStartRecovery
        ? null
        : [...new Set(open.members.flatMap((member) => member.causes.map((cause) => cause.code)))].sort(),
      verdict: getCausesVerdict(open.members.flatMap((member) => member.causes)),
      transitionCount: open.members.length,
    });
    open = null;
  };

  for (const [index, transition] of ascending.entries()) {
    if (transition.to === "healthy") {
      // A recovery as the oldest loaded row means the incident began before the window.
      if (!open && index === 0 && transition.from != null && transition.from !== "healthy") {
        open = { first: transition, startKnown: false, members: [] };
      }
      if (open) open.members.push(transition);
      close(transition.at);
      continue;
    }
    // An escalation as the oldest loaded row also began before the window (R7).
    if (!open) {
      open = { first: transition, startKnown: !(index === 0 && transition.from != null && transition.from !== "healthy"), members: [] };
    }
    open.members.push(transition);
  }
  close(null);
  return episodes.reverse();
}

export interface IncidentRecurrenceGroup {
  key: string;
  causeCode: string;
  subjects: string[];
  count: number;
  firstAt: number;
  lastAt: number;
  /** Mean gap between occurrences, null below two occurrences. */
  meanIntervalSec: number | null;
}

/**
 * Groups incident starts (degrade/init into a non-healthy state) by cause
 * code plus named subjects. Only groups seen at least twice are returned.
 */
export function buildIncidentRecurrence(transitions: readonly StatusTransition[]): IncidentRecurrenceGroup[] {
  const groups = new Map<string, { causeCode: string; subjects: string[]; times: number[] }>();
  for (const transition of transitions) {
    // Only incident starts count; escalations inside one incident do not recur.
    if (transition.to === "healthy" || (transition.from != null && transition.from !== "healthy")) continue;
    const seen = new Set<string>();
    for (const cause of transition.causes) {
      // Info causes ride along on every snapshot; only warning/critical causes open incidents.
      if (cause.severity === "info") continue;
      const subjects = getCauseSubjects(cause).sort();
      const key = `${cause.code}|${subjects.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(key) ?? { causeCode: cause.code, subjects, times: [] };
      group.times.push(transition.at);
      groups.set(key, group);
    }
  }
  return [...groups.entries()]
    .filter(([, group]) => group.times.length >= 2)
    .map(([key, group]) => {
      const times = [...group.times].sort((left, right) => left - right);
      const firstAt = times[0] ?? 0;
      const lastAt = times[times.length - 1] ?? 0;
      return {
        key,
        causeCode: group.causeCode,
        subjects: group.subjects,
        count: times.length,
        firstAt,
        lastAt,
        meanIntervalSec: Math.round((lastAt - firstAt) / (times.length - 1)),
      };
    })
    .sort((left, right) => right.count - left.count || right.lastAt - left.lastAt);
}

export function findFirstDegradationAfter(
  transitions: readonly StatusTransition[],
  timestamp: number | null,
): StatusTransition | null {
  if (timestamp == null) return null;
  return (
    [...transitions]
      .filter((transition) => transition.transitionType === "degrade" && transition.at >= timestamp)
      .sort((left, right) => left.at - right.at || left.id - right.id)[0] ?? null
  );
}
