import { CRON_CONNECTION_BUDGET_ENTRIES, CRON_JOB_DEFINITIONS, getCronStatusImpact } from "@shared/lib/cron-jobs";
import type {
  BudgetOnlySurfaceStatus,
  CronRun,
  CronRunStatus,
  CronStatus,
  StatusResponse,
  WorkerJobAttemptState,
  WorkerJobAttemptStatusClass,
} from "@shared/types";
import { getStatusCronDisplay } from "@/lib/status/cron-config";

export type CronWorkbenchState = "unhealthy" | "degraded" | "unknown" | "skipped" | "running" | "healthy";
export type CronWorkbenchStateFilter = "all" | "attention" | CronWorkbenchState;
export type CronImpactClass = "public-critical" | "admin-watch";
export type CronImpactFilter = "all" | CronImpactClass;
export type CronRunningFilter = "all" | "running" | "stale" | "idle";

export interface CronWorkbenchFilters {
  search: string;
  state: CronWorkbenchStateFilter;
  impact: CronImpactFilter;
  triggerGroup: string;
  running: CronRunningFilter;
}

export const DEFAULT_CRON_WORKBENCH_FILTERS: Readonly<CronWorkbenchFilters> = Object.freeze({
  search: "",
  state: "attention",
  impact: "all",
  triggerGroup: "all",
  running: "all",
});

export interface CronWorkbenchGroupInput {
  key: string;
  title: string;
  badge: string;
  description: string;
  entries: ReadonlyArray<readonly [string, CronStatus]>;
}

export interface CronWorkbenchRow {
  key: string;
  job: string;
  cron: CronStatus;
  display: ReturnType<typeof getStatusCronDisplay>;
  group: Omit<CronWorkbenchGroupInput, "entries">;
  state: CronWorkbenchState;
  severity: number;
  impactClass: CronImpactClass;
  impactLabel: "Public critical" | "Admin watch";
  runningState: Exclude<CronRunningFilter, "all">;
  rawStatus: CronRunStatus | null;
  statusLabel: string;
  registryIndex: number;
  sourceIndex: number;
}

export interface CronWorkbenchGroupSummary {
  total: number;
  visible: number;
  unhealthy: number;
  degraded: number;
  unknown: number;
  skipped: number;
  running: number;
  healthy: number;
  publicCritical: number;
  adminWatch: number;
  staleRunning: number;
}

export interface CronWorkbenchGroup {
  key: string;
  title: string;
  badge: string;
  description: string;
  rows: CronWorkbenchRow[];
  summary: CronWorkbenchGroupSummary;
}

export interface CronWorkbenchTriggerGroupOption {
  value: string;
  label: string;
  count: number;
}

export interface CronWorkbenchModel {
  groups: CronWorkbenchGroup[];
  allRows: CronWorkbenchRow[];
  rows: CronWorkbenchRow[];
  totalCount: number;
  filteredCount: number;
  triggerGroups: CronWorkbenchTriggerGroupOption[];
  hasActiveFilters: boolean;
}

export interface FormattedCronDuration {
  label: string;
  exactLabel: string;
}

export interface FormattedCronRunTiming {
  duration: FormattedCronDuration | null;
  unavailableLabel: "N/A" | null;
  note: string | null;
}

export interface BudgetOnlySurfaceRow {
  surface: BudgetOnlySurfaceStatus;
  job: string;
  label: string;
  scheduleKey: string;
  schedule: string;
  telemetryLabel: string;
  outcomeLabel: string;
  duration: FormattedCronDuration | null;
  severity: number;
  registryIndex: number;
  sourceIndex: number;
}

export interface BudgetOnlySurfaceGroup {
  scheduleKey: string;
  schedule: string;
  rows: BudgetOnlySurfaceRow[];
  summary: {
    total: number;
    fresh: number;
    stale: number;
    missing: number;
    unreadable: number;
    errors: number;
  };
}

const CRON_REGISTRY_INDEX = new Map(CRON_JOB_DEFINITIONS.map((definition, index) => [definition.job, index]));
const BUDGET_SURFACE_REGISTRY_INDEX = new Map(
  CRON_CONNECTION_BUDGET_ENTRIES.filter((entry) => !entry.statusTracked).map((entry, index) => [entry.job, index]),
);

const CRON_STATE_SEVERITY: Readonly<Record<CronWorkbenchState, number>> = {
  unhealthy: 5,
  degraded: 4,
  unknown: 3,
  skipped: 2,
  running: 1,
  healthy: 0,
};

const RUN_STATUS_LABELS: Readonly<Record<CronRunStatus, string>> = {
  ok: "Succeeded",
  degraded: "Completed with warnings",
  error: "Failed",
  skipped_locked: "Skipped: lease held",
  skipped_neutral: "Skipped: no work required",
  skipped_duplicate: "Skipped: duplicate slot",
  skipped_running: "Skipped: already running",
};

const NEUTRAL_SKIP_REASON_LABELS: Readonly<Record<string, string>> = {
  "v9-slot-window-too-short": "Skipped: V9 window too short",
  "v9-core-slot-not-ready": "Skipped: core slot not ready",
  "v9-competing-slot-active": "Skipped: competing slot active",
  "v9-memory-lane-active": "Skipped: V9 memory lane active",
};

const ATTEMPT_STATE_LABELS: Readonly<Record<WorkerJobAttemptState, string>> = {
  queued: "Queued",
  claimed: "Claimed",
  running: "Running",
  completed: "Completed",
  deferred: "Deferred",
  abandoned: "Abandoned",
  failed: "Failed",
  skipped_locked: "Skipped: lease held",
  cancelled: "Cancelled",
};

const ATTEMPT_STATUS_CLASS_LABELS: Readonly<Record<WorkerJobAttemptStatusClass, string>> = {
  ok: "Succeeded",
  degraded: "Completed with warnings",
  controlled_error: "Controlled error",
  thrown_error: "Unhandled error",
  abandoned: "Abandoned",
  deferred: "Deferred",
  skipped_duplicate: "Skipped: duplicate slot",
  skipped_running: "Skipped: already running",
  skipped_locked: "Skipped: lease held",
};

const BUDGET_TELEMETRY_LABELS: Readonly<Record<BudgetOnlySurfaceStatus["telemetryStatus"], string>> = {
  fresh: "Fresh",
  stale: "Stale",
  missing: "Missing",
  unreadable: "Unreadable",
};

const BUDGET_OUTCOME_LABELS: Readonly<Record<BudgetOnlySurfaceStatus["outcome"], string>> = {
  ok: "Succeeded",
  degraded: "Completed with warnings",
  error: "Failed",
  skipped: "Skipped",
  unknown: "Unknown",
};

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function getRegistryIndex(job: string): number {
  return CRON_REGISTRY_INDEX.get(job) ?? Number.MAX_SAFE_INTEGER;
}

function getBudgetSurfaceRegistryIndex(job: string): number {
  return BUDGET_SURFACE_REGISTRY_INDEX.get(job) ?? Number.MAX_SAFE_INTEGER;
}

function compareStableRegistryOrder(
  a: Pick<CronWorkbenchRow, "registryIndex" | "sourceIndex">,
  b: Pick<CronWorkbenchRow, "registryIndex" | "sourceIndex">,
): number {
  const registryDelta = a.registryIndex - b.registryIndex;
  return registryDelta || a.sourceIndex - b.sourceIndex;
}

function isAttentionState(state: CronWorkbenchState): boolean {
  return state === "unhealthy" || state === "degraded" || state === "unknown";
}

function isFreshNeutralSkip(cron: CronStatus, nowSeconds?: number): boolean {
  if (cron.lastRun?.status !== "skipped_neutral") return false;
  if (nowSeconds == null) return true;
  return nowSeconds - cron.lastRun.startedAt <= cron.expectedIntervalSec * 2;
}

function getRunningState(cron: CronStatus): Exclude<CronRunningFilter, "all"> {
  if (!cron.inFlight) return "idle";
  return cron.inFlight.stale ? "stale" : "running";
}

type InheritedRequiredOutcome = Extract<CronRunStatus, "degraded" | "error"> | null;

function getInheritedRequiredOutcome(cron: CronStatus): InheritedRequiredOutcome {
  if (cron.lastRun?.status !== "skipped_neutral") return null;
  const latestRequiredRun = cron.recentRuns.find((run) => run.status !== "skipped_neutral");
  return latestRequiredRun?.status === "degraded" || latestRequiredRun?.status === "error"
    ? latestRequiredRun.status
    : null;
}

function matchesSearch(row: CronWorkbenchRow, normalizedSearch: string): boolean {
  if (!normalizedSearch) return true;
  const attempt = row.cron.latestAttempt;
  const artifactText = (row.cron.staleArtifacts ?? [])
    .map((artifact) => `${artifact.kind} ${artifact.leaseOwner ?? ""} ${artifact.progressStage ?? ""}`)
    .join(" ");
  const searchable = [
    row.job,
    row.display.label,
    row.display.schedule,
    row.display.triggerMode,
    row.group.key,
    row.group.title,
    row.group.badge,
    row.state,
    row.rawStatus,
    row.statusLabel,
    row.impactClass,
    attempt?.attemptId,
    attempt?.state,
    attempt?.statusClass,
    artifactText,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
  return searchable.includes(normalizedSearch);
}

function matchesFilters(row: CronWorkbenchRow, filters: CronWorkbenchFilters): boolean {
  if (!matchesSearch(row, normalizeSearch(filters.search))) return false;
  if (filters.state === "attention") {
    if (!isAttentionState(row.state) && !(row.state === "skipped" && !row.cron.healthy)) return false;
  } else if (filters.state !== "all" && row.state !== filters.state) {
    return false;
  }
  if (filters.impact !== "all" && row.impactClass !== filters.impact) return false;
  if (filters.triggerGroup !== "all" && row.group.key !== filters.triggerGroup) return false;
  if (filters.running !== "all" && row.runningState !== filters.running) return false;
  return true;
}

function summarizeGroup(allRows: CronWorkbenchRow[], visibleRows: CronWorkbenchRow[]): CronWorkbenchGroupSummary {
  return {
    total: allRows.length,
    visible: visibleRows.length,
    unhealthy: allRows.filter((row) => row.state === "unhealthy").length,
    degraded: allRows.filter((row) => row.state === "degraded").length,
    unknown: allRows.filter((row) => row.state === "unknown").length,
    skipped: allRows.filter((row) => row.state === "skipped").length,
    running: allRows.filter((row) => row.runningState === "running").length,
    healthy: allRows.filter((row) => row.state === "healthy").length,
    publicCritical: allRows.filter((row) => row.impactClass === "public-critical").length,
    adminWatch: allRows.filter((row) => row.impactClass === "admin-watch").length,
    staleRunning: allRows.filter((row) => row.runningState === "stale").length,
  };
}

export function classifyCronWorkbenchState(cron: CronStatus, nowSeconds?: number): CronWorkbenchState {
  if (cron.telemetryUnknown) return "unknown";
  const inheritedRequiredOutcome = getInheritedRequiredOutcome(cron);
  if (
    cron.lastRun?.status === "error" ||
    inheritedRequiredOutcome === "error" ||
    cron.inFlight?.stale
  ) {
    return "unhealthy";
  }
  if (cron.lastRun?.status === "degraded" || inheritedRequiredOutcome === "degraded") return "degraded";
  if (cron.inFlight && !cron.inFlight.stale) return "running";
  if (isFreshNeutralSkip(cron, nowSeconds)) return "skipped";
  if (!cron.healthy) return "unhealthy";
  return "healthy";
}

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readMetadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type CronRunNotStartedReason =
  | "upstream-abandoned"
  | "upstream-incomplete"
  | "upstream-failure"
  | "upstream-blocked";

function getCronRunNotStartedReason(run: Pick<CronRun, "metadata">): CronRunNotStartedReason | null {
  if (readMetadataString(run.metadata, "childDisposition") !== "not_started") return null;
  if (readMetadataString(run.metadata, "reason") === "stale-slot-reconciled") {
    return "upstream-abandoned";
  }
  const skippedReason = readMetadataString(run.metadata, "skippedReason");
  for (const reason of ["upstream-incomplete", "upstream-failure", "upstream-blocked"] as const) {
    if (skippedReason?.startsWith(`${reason}:`)) return reason;
  }
  return null;
}

export function isCronRunNotStarted(run: Pick<CronRun, "metadata">): boolean {
  return getCronRunNotStartedReason(run) != null;
}

function isCronRunPlatformAbandoned(run: Pick<CronRun, "metadata">): boolean {
  return (
    readMetadataString(run.metadata, "reason") === "stale-slot-reconciled"
    && !isCronRunNotStarted(run)
  );
}

export function formatCronRunStatus(
  status: CronRunStatus | null | undefined,
  metadata?: Record<string, unknown>,
): string {
  const notStartedReason = getCronRunNotStartedReason({ metadata });
  if (notStartedReason === "upstream-abandoned") return "Not started: upstream abandoned";
  if (notStartedReason === "upstream-incomplete") return "Not started: upstream incomplete";
  if (notStartedReason === "upstream-failure") return "Not started: prerequisite failed";
  if (notStartedReason === "upstream-blocked") return "Not started: prerequisite blocked";
  if (isCronRunPlatformAbandoned({ metadata })) return "Abandoned";
  if (status === "skipped_neutral") {
    const reason = readMetadataString(metadata, "reason");
    if (reason && NEUTRAL_SKIP_REASON_LABELS[reason]) return NEUTRAL_SKIP_REASON_LABELS[reason];
  }
  return status ? RUN_STATUS_LABELS[status] : "No runs";
}

export function formatCronAttemptState(state: WorkerJobAttemptState): string {
  return ATTEMPT_STATE_LABELS[state];
}

export function formatCronAttemptStatusClass(statusClass: WorkerJobAttemptStatusClass | null): string {
  return statusClass ? ATTEMPT_STATUS_CLASS_LABELS[statusClass] : "Pending outcome";
}

function formatExactSeconds(durationMs: number): string {
  const seconds = durationMs / 1000;
  const value = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${value}s (${durationMs}ms)`;
}

export function formatCronDuration(durationMs: number): FormattedCronDuration {
  const safeDurationMs = Math.max(0, Math.round(durationMs));
  if (safeDurationMs < 1000) {
    return { label: `${safeDurationMs}ms`, exactLabel: formatExactSeconds(safeDurationMs) };
  }

  if (safeDurationMs < 60_000) {
    const seconds = safeDurationMs / 1000;
    const label = Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
    return { label, exactLabel: formatExactSeconds(safeDurationMs) };
  }

  const totalSeconds = Math.floor(safeDurationMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [
    days > 0 ? `${days}d` : null,
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    seconds > 0 || (days === 0 && hours === 0 && minutes === 0) ? `${seconds}s` : null,
  ].filter((part): part is string => part != null);

  return { label: parts.join(" "), exactLabel: formatExactSeconds(safeDurationMs) };
}

export function formatCronRunTiming(run: CronRun): FormattedCronRunTiming {
  const notStartedReason = getCronRunNotStartedReason(run);
  if (notStartedReason) {
    return {
      duration: null,
      unavailableLabel: "N/A",
      note: notStartedReason === "upstream-abandoned"
        ? "Did not start because the parent slot was abandoned."
        : "Did not start because the prerequisite job did not complete.",
    };
  }
  if (!isCronRunPlatformAbandoned(run)) {
    return {
      duration: formatCronDuration(run.durationMs),
      unavailableLabel: null,
      note: null,
    };
  }

  const metadataActiveDurationMs = readMetadataNumber(run.metadata, "activeDurationMs");
  const progressUpdatedAt = readMetadataNumber(run.metadata, "progressUpdatedAt");
  const reconciledAt = readMetadataNumber(run.metadata, "reconciledAt");
  const activeDurationMs =
    metadataActiveDurationMs
    ?? (progressUpdatedAt == null ? null : Math.max(0, progressUpdatedAt - run.startedAt) * 1000);
  const metadataReconciliationDelayMs = readMetadataNumber(run.metadata, "reconciliationDelayMs");
  const reconciliationDelayMs =
    metadataReconciliationDelayMs
    ?? (progressUpdatedAt == null || reconciledAt == null
      ? null
      : Math.max(0, reconciledAt - progressUpdatedAt) * 1000);
  const duration = formatCronDuration(activeDurationMs ?? run.durationMs);
  const reconciliationDelay =
    reconciliationDelayMs == null ? null : formatCronDuration(reconciliationDelayMs);
  return {
    duration,
    unavailableLabel: null,
    note: reconciliationDelay
      ? `Last heartbeat after ${duration.label}; reconciled ${reconciliationDelay.label} later.`
      : `Last heartbeat after ${duration.label}; reconciliation time was not reported.`,
  };
}

export function buildCronWorkbenchModel(
  groups: readonly CronWorkbenchGroupInput[],
  filters: CronWorkbenchFilters = DEFAULT_CRON_WORKBENCH_FILTERS,
  nowSeconds?: number,
): CronWorkbenchModel {
  let sourceIndex = 0;
  const rowsByGroup = groups.map((group) => {
    const groupMeta = {
      key: group.key,
      title: group.title,
      badge: group.badge,
      description: group.description,
    };
    const rows = group.entries.map(([job, cron]) => {
      const state = classifyCronWorkbenchState(cron, nowSeconds);
      const inheritedRequiredOutcome = getInheritedRequiredOutcome(cron);
      const impactClass: CronImpactClass = getCronStatusImpact(job) === "critical" ? "public-critical" : "admin-watch";
      const rawStatus = cron.lastRun?.status ?? null;
      const row: CronWorkbenchRow = {
        key: `${group.key}:${job}`,
        job,
        cron,
        display: getStatusCronDisplay(job),
        group: groupMeta,
        state,
        severity: CRON_STATE_SEVERITY[state],
        impactClass,
        impactLabel: impactClass === "public-critical" ? "Public critical" : "Admin watch",
        runningState: getRunningState(cron),
        rawStatus,
        statusLabel: cron.telemetryUnknown
          ? "Telemetry unknown"
          : inheritedRequiredOutcome === "error"
            ? "Failed (latest required run)"
            : inheritedRequiredOutcome === "degraded"
              ? "Completed with warnings (latest required run)"
              : formatCronRunStatus(rawStatus, cron.lastRun?.metadata),
        registryIndex: getRegistryIndex(job),
        sourceIndex,
      };
      sourceIndex += 1;
      return row;
    });
    return { group, rows };
  });

  const allRows = rowsByGroup.flatMap(({ rows }) => rows);
  const visibleRowKeys = new Set(allRows.filter((row) => matchesFilters(row, filters)).map((row) => row.key));
  const visibleGroups = rowsByGroup.flatMap(({ group, rows }) => {
    const visibleRows = rows
      .filter((row) => visibleRowKeys.has(row.key))
      .sort((a, b) => b.severity - a.severity || compareStableRegistryOrder(a, b));
    if (visibleRows.length === 0) return [];
    return [
      {
        key: group.key,
        title: group.title,
        badge: group.badge,
        description: group.description,
        rows: visibleRows,
        summary: summarizeGroup(rows, visibleRows),
      },
    ];
  });
  const rows = visibleGroups.flatMap((group) => group.rows);

  return {
    groups: visibleGroups,
    allRows,
    rows,
    totalCount: allRows.length,
    filteredCount: rows.length,
    triggerGroups: groups.map((group) => ({
      value: group.key,
      label: group.title,
      count: group.entries.length,
    })),
    hasActiveFilters:
      filters.search.trim().length > 0 ||
      filters.state !== DEFAULT_CRON_WORKBENCH_FILTERS.state ||
      filters.impact !== DEFAULT_CRON_WORKBENCH_FILTERS.impact ||
      filters.triggerGroup !== DEFAULT_CRON_WORKBENCH_FILTERS.triggerGroup ||
      filters.running !== DEFAULT_CRON_WORKBENCH_FILTERS.running,
  };
}

function getBudgetSurfaceSeverity(surface: BudgetOnlySurfaceStatus): number {
  if (surface.outcome === "error") return 4;
  if (surface.telemetryStatus === "missing" || surface.telemetryStatus === "unreadable") return 3;
  if (surface.telemetryStatus === "stale" || surface.outcome === "degraded") return 2;
  if (surface.outcome === "unknown") return 1;
  return 0;
}

export function buildBudgetOnlySurfaceGroups(
  surfaces: readonly StatusResponse["budgetOnlySurfaces"][number][],
): BudgetOnlySurfaceGroup[] {
  const rows = surfaces.map((surface, sourceIndex): BudgetOnlySurfaceRow => ({
    surface,
    job: surface.job,
    label: surface.label,
    scheduleKey: surface.scheduleKey,
    schedule: surface.schedule,
    telemetryLabel: BUDGET_TELEMETRY_LABELS[surface.telemetryStatus],
    outcomeLabel: BUDGET_OUTCOME_LABELS[surface.outcome],
    duration: surface.durationMs == null ? null : formatCronDuration(surface.durationMs),
    severity: getBudgetSurfaceSeverity(surface),
    registryIndex: getBudgetSurfaceRegistryIndex(surface.job),
    sourceIndex,
  }));
  const grouped = new Map<string, BudgetOnlySurfaceRow[]>();
  for (const row of rows) {
    const groupRows = grouped.get(row.scheduleKey) ?? [];
    groupRows.push(row);
    grouped.set(row.scheduleKey, groupRows);
  }

  return Array.from(grouped.entries()).map(([scheduleKey, groupRows]) => {
    const sortedRows = [...groupRows].sort((a, b) => b.severity - a.severity || compareStableRegistryOrder(a, b));
    return {
      scheduleKey,
      schedule: sortedRows[0]?.schedule ?? "—",
      rows: sortedRows,
      summary: {
        total: groupRows.length,
        fresh: groupRows.filter((row) => row.surface.telemetryStatus === "fresh").length,
        stale: groupRows.filter((row) => row.surface.telemetryStatus === "stale").length,
        missing: groupRows.filter((row) => row.surface.telemetryStatus === "missing").length,
        unreadable: groupRows.filter((row) => row.surface.telemetryStatus === "unreadable").length,
        errors: groupRows.filter((row) => row.surface.outcome === "error").length,
      },
    };
  });
}
