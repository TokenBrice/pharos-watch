import { transitionHasPublicImpact } from "@shared/lib/status-public-impact";
import type { StatusCause, StatusResponse, StatusTransition } from "@shared/types";
import type { StatusHistoryWindow } from "@/lib/admin-api-query-descriptors";
import { STATUS_CAUSE_SEVERITY_RANK } from "@/lib/status/cause-severity";

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
  transitionsLast24h: number;
  isFlapping: boolean;
}

export interface WorkerVersionEvidence {
  status: "observed" | "unavailable";
  version: string | null;
  observedAt: number | null;
  sourceCount: number;
  sources: string[];
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
  transitionsLast24h: number,
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
    isFlapping: transitionsLast24h > INCIDENT_FLAPPING_TRANSITION_THRESHOLD,
  };
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

export function deriveWorkerVersionEvidence(
  input: Pick<StatusResponse, "producerHeads">,
): WorkerVersionEvidence {
  const candidates: Array<{ version: string; observedAt: number | null; source: string }> = [];

  for (const producer of input.producerHeads ?? []) {
    const version = producer.lastWorkerVersion?.trim();
    if (version) {
      candidates.push({
        version,
        observedAt: producer.lastInvokedAt,
        source: `producer:${producer.job}`,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      (right.observedAt ?? Number.NEGATIVE_INFINITY) - (left.observedAt ?? Number.NEGATIVE_INFINITY) ||
      left.source.localeCompare(right.source),
  );
  const latest = candidates[0];
  if (!latest) {
    return { status: "unavailable", version: null, observedAt: null, sourceCount: 0, sources: [] };
  }

  const matchingSources = candidates
    .filter((candidate) => candidate.version === latest.version)
    .map((candidate) => candidate.source)
    .sort((left, right) => left.localeCompare(right));
  return {
    status: "observed",
    version: latest.version,
    observedAt: latest.observedAt,
    sourceCount: matchingSources.length,
    sources: matchingSources,
  };
}
