import type { StatusHealthValue } from "@shared/types";

/**
 * Shared scaffolding for the admin "workspace" surfaces (reliability, pipeline).
 * Each workspace owns its own mode list and issue taxonomy, but the severity
 * vocabulary, the `?view=` URL contract, and the initial-mode ranking are the
 * same everywhere — they live here so the workspaces cannot drift apart.
 *
 * Note the direction: this rank orders *best first* (`healthy` = 0), so the
 * worst severity is the numeric maximum. The status-cause rank in
 * `@/lib/status/cause-severity` orders the opposite way; the two vocabularies
 * are distinct and must not be swapped.
 */
export type WorkspaceSeverity = "healthy" | "watch" | "critical" | "unknown";

export const SEVERITY_RANK: Readonly<Record<WorkspaceSeverity, number>> = {
  healthy: 0,
  watch: 1,
  unknown: 2,
  critical: 3,
};

export const WORKSPACE_MODE_QUERY_PARAM = "view";

export function worstSeverity(states: readonly WorkspaceSeverity[]): WorkspaceSeverity {
  return states.reduce<WorkspaceSeverity>(
    (worst, state) => (SEVERITY_RANK[state] > SEVERITY_RANK[worst] ? state : worst),
    "healthy",
  );
}

export function healthSeverity(status: StatusHealthValue | "unknown" | null | undefined): WorkspaceSeverity {
  if (status === "stale") return "critical";
  if (status === "degraded") return "watch";
  if (status === "healthy") return "healthy";
  return "unknown";
}

export interface WorkspaceModeOption<TMode extends string> {
  readonly id: TMode;
}

export interface WorkspaceModeSummary<TMode extends string> extends WorkspaceModeOption<TMode> {
  readonly issueCount: number;
  readonly severity: WorkspaceSeverity;
}

export function parseWorkspaceMode<TMode extends string>(
  modes: readonly WorkspaceModeOption<TMode>[],
  search: string | URLSearchParams,
): TMode | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const candidate = params.get(WORKSPACE_MODE_QUERY_PARAM);
  return candidate != null && modes.some((mode) => mode.id === candidate) ? (candidate as TMode) : null;
}

export function buildWorkspaceModeUrl(
  location: Pick<Location, "pathname" | "search" | "hash">,
  mode: string,
): string {
  const params = new URLSearchParams(location.search);
  params.set(WORKSPACE_MODE_QUERY_PARAM, mode);
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}

/**
 * Landing view when the URL has no `?view=` (B7): the first view, in
 * declaration order, with a watch or critical finding; otherwise the first
 * (overview) view. `unknown` does not pull the landing because it is mostly
 * "still loading", and ranking by worst severity made the landing jump
 * between views as evidence arrived.
 */
export function pickInitialMode<TMode extends string>(
  summaries: readonly WorkspaceModeSummary<TMode>[],
  modes: readonly WorkspaceModeOption<TMode>[],
  fallback: TMode,
): TMode {
  const withIssue = new Set(
    summaries
      .filter((summary) => summary.severity === "watch" || summary.severity === "critical")
      .map((summary) => summary.id),
  );
  return modes.find((mode) => withIssue.has(mode.id))?.id ?? fallback;
}
