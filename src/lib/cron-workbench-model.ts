import { CRON_CONNECTION_BUDGET_ENTRIES, CRON_JOB_DEFINITIONS, CRON_SCHEDULE_DEFINITIONS, CRON_TRIGGER_SCHEDULES, getCronJobMeta, getCronStatusImpact, isProvenSatisfiedNeutralSkipReason } from "@shared/lib/cron-jobs";
import { getCronQualityReasons } from "@shared/lib/cron-quality-reasons";
import type { OperatorVerdict } from "@shared/lib/classification";
import { formatElapsedSeconds } from "@shared/lib/format";
import type {
  BudgetOnlySurfaceStatus,
  CronRun,
  CronRunStatus,
  CronStatus,
  StatusCause,
  StatusResponse,
} from "@shared/types";
import { getStatusCronDisplay } from "@/lib/status/cron-config";

export type CronWorkbenchState = "unhealthy" | "degraded" | "unknown" | "skipped" | "running" | "healthy";
/** `attention` is every non-OK verdict (act, watch, running, unavailable). */
export type CronVerdictFilter = "all" | "attention" | OperatorVerdict;
export type CronImpactClass = "public-critical" | "admin-watch";
export type CronImpactFilter = "all" | CronImpactClass;
export type CronRunningState = "running" | "stale" | "idle";

export interface CronWorkbenchFilters {
  search: string;
  verdict: CronVerdictFilter;
  impact: CronImpactFilter;
  triggerGroup: string;
}

export const DEFAULT_CRON_WORKBENCH_FILTERS: Readonly<CronWorkbenchFilters> = Object.freeze({
  search: "",
  verdict: "attention",
  impact: "all",
  triggerGroup: "all",
});

/**
 * Cron-health availability treats a job as stale once its latest run is older
 * than this multiple of its cadence (`worker/src/lib/status/cron-health.ts`
 * `staleAt: { multiplier: 2 }`).
 */
export const CRON_STALE_BUDGET_MULTIPLIER = 2;

export interface CronVerdictReason {
  verdict: OperatorVerdict;
  /** Machine-readable reason (R4). */
  code: string;
  /** One plain sentence. */
  sentence: string;
}

export interface CronNextExpected {
  kind: "scheduled" | "due" | "overdue" | "running" | "unknown";
  label: string;
  /** Names the cadence and stale budget (R3). */
  budget: string;
}

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
  verdict: OperatorVerdict;
  verdictReason: CronVerdictReason;
  severity: number;
  impactClass: CronImpactClass;
  impactLabel: "Public critical" | "Admin watch";
  runningState: CronRunningState;
  rawStatus: CronRunStatus | null;
  /** Latest run outcome. Never carries findings; those are `qualityReasons`. */
  statusLabel: string;
  qualityReasons: string[];
  /** Consecutive failed required runs, newest first. */
  errorStreak: number;
  registryIndex: number;
  sourceIndex: number;
}

/** `total` covers the whole group; verdict counts cover only the visible rows. */
export interface CronWorkbenchGroupSummary extends Record<OperatorVerdict, number> {
  total: number;
  visible: number;
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
  /** Verdict counts over every job, independent of filters. */
  verdictCounts: Record<OperatorVerdict, number>;
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

const VERDICT_SEVERITY: Readonly<Record<OperatorVerdict, number>> = {
  act: 4,
  watch: 3,
  unavailable: 2,
  running: 1,
  ok: 0,
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
  "v9-slot-window-too-short": "Skipped: V10 window too short",
  "v9-core-slot-not-ready": "Skipped: core slot not ready",
  "v9-competing-slot-active": "Skipped: competing slot active",
  "v9-memory-lane-active": "Skipped: V10 memory lane active",
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

function isFreshNeutralSkip(cron: CronStatus, nowSeconds?: number): boolean {
  if (cron.lastRun?.status !== "skipped_neutral") return false;
  if (nowSeconds == null) return true;
  return nowSeconds - cron.lastRun.startedAt <= cron.expectedIntervalSec * 2;
}

function getRunningState(cron: CronStatus): CronRunningState {
  if (!cron.inFlight) return "idle";
  return cron.inFlight.stale ? "stale" : "running";
}

type InheritedRequiredOutcome = Extract<CronRunStatus, "degraded" | "error"> | null;

function getInheritedRequiredOutcome(cron: CronStatus, nowSeconds?: number): InheritedRequiredOutcome {
  if (cron.lastRun?.status !== "skipped_neutral") return null;
  const latestRequiredRun = cron.recentRuns.find((run) => run.status !== "skipped_neutral");
  if (latestRequiredRun?.status !== "degraded" && latestRequiredRun?.status !== "error") return null;
  if (nowSeconds != null && nowSeconds - latestRequiredRun.startedAt > cron.expectedIntervalSec * 2) return null;
  // The backend supersedes an inherited error when a fresh skip proves the
  // period's write-once artifact exists (it was read and found); the lane
  // must resolve the same way, or one transient precheck failure keeps the
  // row "Unavailable" until the next real run. Later generic admissions keep
  // that readback, which the backend serves behind an all-neutral display
  // window, so resolve against the newest proven skip, not only the last run.
  // A required attempt after the readback still wins. An inherited degraded
  // run stays a warning: the artifact existing does not prove that run's
  // inputs were clean.
  const provenSatisfiedRun = cron.recentRuns.find((run) => run.status === "skipped_neutral"
    && isProvenSatisfiedNeutralSkipReason(run.metadata?.reason));
  if (
    latestRequiredRun.status === "error"
    && provenSatisfiedRun != null
    && (nowSeconds == null || nowSeconds - provenSatisfiedRun.startedAt <= cron.expectedIntervalSec * 2)
    && provenSatisfiedRun.startedAt >= latestRequiredRun.startedAt
  ) {
    return null;
  }
  return latestRequiredRun.status;
}

function getWorkbenchQualityReasons(cron: CronStatus, nowSeconds?: number): string[] {
  const run = cron.lastRun?.status === "skipped_neutral"
    ? cron.recentRuns.find((candidate) => candidate.status !== "skipped_neutral")
    : cron.lastRun;
  if (!run || (nowSeconds != null && nowSeconds - run.startedAt > cron.expectedIntervalSec * 2)) return [];
  return getCronQualityReasons(run.metadata);
}

function matchesSearch(row: CronWorkbenchRow, normalizedSearch: string): boolean {
  if (!normalizedSearch) return true;
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
    row.verdict,
    row.verdictReason.code,
    row.rawStatus,
    row.statusLabel,
    row.impactClass,
    ...row.qualityReasons,
    artifactText,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
  return searchable.includes(normalizedSearch);
}

function matchesFilters(row: CronWorkbenchRow, filters: CronWorkbenchFilters): boolean {
  if (!matchesSearch(row, normalizeSearch(filters.search))) return false;
  if (filters.verdict === "attention") {
    if (row.verdict === "ok") return false;
  } else if (filters.verdict !== "all" && row.verdict !== filters.verdict) {
    return false;
  }
  if (filters.impact !== "all" && row.impactClass !== filters.impact) return false;
  if (filters.triggerGroup !== "all" && row.group.key !== filters.triggerGroup) return false;
  return true;
}

function countVerdicts(rows: readonly CronWorkbenchRow[]): Record<OperatorVerdict, number> {
  const counts: Record<OperatorVerdict, number> = { act: 0, watch: 0, ok: 0, running: 0, unavailable: 0 };
  for (const row of rows) counts[row.verdict] += 1;
  return counts;
}

function summarizeGroup(allRows: CronWorkbenchRow[], visibleRows: CronWorkbenchRow[]): CronWorkbenchGroupSummary {
  return { total: allRows.length, visible: visibleRows.length, ...countVerdicts(visibleRows) };
}

/** Consecutive failed required runs; generic neutral skips are not required attempts. */
function countRequiredErrorStreak(cron: CronStatus, nowSeconds?: number): number {
  if (cron.lastRun?.status !== "error" && getInheritedRequiredOutcome(cron, nowSeconds) !== "error") return 0;
  if (nowSeconds != null && cron.lastRun && nowSeconds - cron.lastRun.startedAt > cron.expectedIntervalSec * 2) return 0;
  let streak = 0;
  for (const run of cron.recentRuns) {
    if (run.status === "skipped_neutral") continue;
    if (run.status !== "error") break;
    streak += 1;
  }
  return Math.max(streak, 1);
}

function describeBudget(cron: CronStatus): string {
  return `Expected every ${formatElapsedSeconds(cron.expectedIntervalSec)}, stale after ${formatElapsedSeconds(
    cron.expectedIntervalSec * CRON_STALE_BUDGET_MULTIPLIER,
  )} without a usable run.`;
}

/** Next primary trigger opportunity; admission and catch-up runs can differ. */
export function getCronNextRunAt(job: string, nowSeconds: number): number | null {
  const definition = getCronJobMeta(job);
  if (!definition) return null;
  const schedule = CRON_SCHEDULE_DEFINITIONS[definition.scheduleKey];
  if (definition.scheduleKey === "monthlyYieldAudit") {
    const date = new Date(nowSeconds * 1000);
    const thisMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000 + schedule.offsetSec;
    return thisMonth > nowSeconds ? thisMonth
      : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000 + schedule.offsetSec;
  }
  // Fixed-minute physical aliases can intentionally dispatch after the logical slot.
  const firstPhysicalMinute = Number(CRON_TRIGGER_SCHEDULES[definition.scheduleKey][0]?.split(" ")[0]);
  const dispatchDelay = Number.isFinite(firstPhysicalMinute)
    ? firstPhysicalMinute * 60 - schedule.offsetSec % 3600 : 0;
  const offset = schedule.offsetSec + dispatchDelay;
  return (Math.floor((nowSeconds - offset) / schedule.intervalSec) + 1) * schedule.intervalSec + offset;
}

export function getCronNextExpected(cron: CronStatus, nowSeconds: number, job?: string): CronNextExpected {
  const budget = describeBudget(cron);
  if (cron.inFlight && !cron.inFlight.stale) return { kind: "running", label: "Running now", budget };
  const nextTrigger = job ? getCronNextRunAt(job, nowSeconds) : null;
  if (nextTrigger != null) {
    return {
      kind: "scheduled",
      label: `in ${formatElapsedSeconds(nextTrigger - nowSeconds)}`,
      budget: `${budget} Next primary trigger opportunity; admission and catch-up runs may differ.`,
    };
  }
  const lastStart = cron.lastRun?.startedAt;
  if (lastStart == null) {
    return { kind: "unknown", label: cron.telemetryUnknown ? "Unknown" : "No runs", budget };
  }
  const late = nowSeconds - (lastStart + cron.expectedIntervalSec);
  if (late <= 0) return { kind: "scheduled", label: `in ${formatElapsedSeconds(-late)}`, budget };
  if (nowSeconds - lastStart < cron.expectedIntervalSec * CRON_STALE_BUDGET_MULTIPLIER) {
    return { kind: "due", label: `Due ${formatElapsedSeconds(late)} ago`, budget };
  }
  return { kind: "overdue", label: `Overdue by ${formatElapsedSeconds(late)}`, budget };
}

/**
 * The single operator verdict for a cron row (plan 3b). A fresh in-flight
 * attempt outranks the previous terminal result, so a row never reads as
 * failed and running at once; the previous outcome stays in `statusLabel`.
 */
export function deriveCronVerdict(
  cron: CronStatus,
  impactClass: CronImpactClass,
  state: CronWorkbenchState,
  qualityReasons: readonly string[],
  nowSeconds?: number,
): CronVerdictReason {
  const ago = (epochSec: number) =>
    nowSeconds == null ? "" : ` ${formatElapsedSeconds(Math.max(0, nowSeconds - epochSec))} ago`;
  const budget = formatElapsedSeconds(cron.expectedIntervalSec * CRON_STALE_BUDGET_MULTIPLIER);
  const critical = impactClass === "public-critical";

  if (cron.telemetryUnknown) {
    return {
      verdict: "unavailable",
      code: cron.telemetryUnknownReason ?? "telemetry-unknown",
      sentence: "Cron history could not be read, so this job's state is unknown.",
    };
  }
  if (cron.inFlight && !cron.inFlight.stale) {
    return {
      verdict: "running",
      code: "in-flight",
      sentence: `A run started${ago(cron.inFlight.startedAt)} and sent its last heartbeat${ago(cron.inFlight.updatedAt)}.`,
    };
  }
  if (cron.inFlight?.stale) {
    return {
      verdict: critical ? "act" : "watch",
      code: "stale-heartbeat",
      sentence: `The running attempt stopped sending heartbeats${ago(cron.inFlight.updatedAt)}.`,
    };
  }
  const errorStreak = countRequiredErrorStreak(cron, nowSeconds);
  if (errorStreak >= 2) {
    return { verdict: "act", code: "repeated-failures", sentence: `The last ${errorStreak} required runs failed.` };
  }
  const publicSuffix = critical ? " Public data depends on this job." : "";
  if (cron.healthy === false) {
    return errorStreak === 1
      ? { verdict: critical ? "act" : "watch", code: "latest-run-failed", sentence: `The latest required run failed.${publicSuffix}` }
      : {
        verdict: critical ? "act" : "watch",
        code: "no-fresh-run",
        sentence: `No usable run within the ${budget} budget.${publicSuffix}`,
      };
  }
  if (cron.healthy == null) {
    return {
      verdict: "unavailable",
      code: "health-unknown",
      sentence: "The status read did not report availability for this job.",
    };
  }
  if (state === "degraded") {
    return { verdict: "watch", code: "run-warnings", sentence: "The latest required run completed with warnings." };
  }
  if (errorStreak === 1) {
    return { verdict: "watch", code: "latest-run-failed", sentence: "The latest required run failed." };
  }
  const staleArtifacts = cron.staleArtifacts?.length ?? 0;
  if (staleArtifacts > 0) {
    return {
      verdict: "watch",
      code: "stale-artifacts",
      sentence: `${staleArtifacts} expired lease or orphaned progress record${staleArtifacts === 1 ? "" : "s"} remain${staleArtifacts === 1 ? "s" : ""}.`,
    };
  }
  if (qualityReasons.length > 0) {
    return {
      verdict: critical ? "watch" : "ok",
      code: "findings",
      sentence: `The latest run succeeded with findings: ${qualityReasons.join(", ")}.`,
    };
  }
  if (cron.bootstrap) {
    return { verdict: "ok", code: "bootstrap", sentence: "This job is in its initial admission window; no required run has completed yet." };
  }
  if (!cron.lastRun) {
    return { verdict: "unavailable", code: "no-runs", sentence: "No run has been recorded for this job." };
  }
  if (cron.lastRun.status.startsWith("skipped_")) {
    return { verdict: "ok", code: "skipped", sentence: "The latest run was skipped and no required run is outstanding." };
  }
  return { verdict: "ok", code: "ok", sentence: `The latest run succeeded within the ${budget} budget.` };
}

export function classifyCronWorkbenchState(cron: CronStatus, nowSeconds?: number): CronWorkbenchState {
  if (cron.telemetryUnknown) return "unknown";
  const inheritedRequiredOutcome = getInheritedRequiredOutcome(cron, nowSeconds);
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
  if (status === "ok" && getCronQualityReasons(metadata).length > 0) return "Succeeded with findings";
  if (status === "skipped_neutral") {
    const reason = readMetadataString(metadata, "reason");
    if (reason && NEUTRAL_SKIP_REASON_LABELS[reason]) return NEUTRAL_SKIP_REASON_LABELS[reason];
  }
  return status ? RUN_STATUS_LABELS[status] : "No runs";
}

function formatExactSeconds(durationMs: number): string {
  const seconds = durationMs / 1000;
  const value = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${value}s (${durationMs}ms)`;
}

/**
 * Deliberately not `formatElapsedSeconds`: cron timings need a sub-second lane
 * ("750ms"), keep the seconds component inside composites ("43m 2s"), and carry
 * an exact-value tooltip label. The shared ladders drop all three.
 */
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
  /** A selected or deep-linked job stays visible whatever the filters say. */
  pinnedJob?: string | null,
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
      const impactClass: CronImpactClass = getCronStatusImpact(job) === "critical" ? "public-critical" : "admin-watch";
      const rawStatus = cron.lastRun?.status ?? null;
      const qualityReasons = getWorkbenchQualityReasons(cron, nowSeconds);
      const verdictReason = deriveCronVerdict(cron, impactClass, state, qualityReasons, nowSeconds);
      const row: CronWorkbenchRow = {
        key: `${group.key}:${job}`,
        job,
        cron,
        display: getStatusCronDisplay(job),
        group: groupMeta,
        state,
        verdict: verdictReason.verdict,
        verdictReason,
        severity: VERDICT_SEVERITY[verdictReason.verdict] * 10 + CRON_STATE_SEVERITY[state],
        impactClass,
        impactLabel: impactClass === "public-critical" ? "Public critical" : "Admin watch",
        runningState: getRunningState(cron),
        rawStatus,
        statusLabel: cron.telemetryUnknown
          ? "Telemetry unknown"
          : rawStatus === "ok" && qualityReasons.length > 0
            ? RUN_STATUS_LABELS.ok
            : formatCronRunStatus(rawStatus, cron.lastRun?.metadata),
        qualityReasons,
        errorStreak: countRequiredErrorStreak(cron, nowSeconds),
        registryIndex: getRegistryIndex(job),
        sourceIndex,
      };
      sourceIndex += 1;
      return row;
    });
    return { group, rows };
  });

  const allRows = rowsByGroup.flatMap(({ rows }) => rows);
  const visibleRowKeys = new Set(
    allRows.filter((row) => row.job === pinnedJob || matchesFilters(row, filters)).map((row) => row.key),
  );
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
    verdictCounts: countVerdicts(allRows),
    triggerGroups: groups.map((group) => ({
      value: group.key,
      label: group.title,
      count: group.entries.length,
    })),
    hasActiveFilters:
      filters.search.trim().length > 0 ||
      filters.verdict !== DEFAULT_CRON_WORKBENCH_FILTERS.verdict ||
      filters.impact !== DEFAULT_CRON_WORKBENCH_FILTERS.impact ||
      filters.triggerGroup !== DEFAULT_CRON_WORKBENCH_FILTERS.triggerGroup,
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

/** Group header counts: scope first, then only the non-zero verdicts of the visible rows. */
export function formatCronGroupSummary(summary: CronWorkbenchGroupSummary): string {
  const scope = summary.visible < summary.total
    ? `${summary.visible} of ${summary.total} shown`
    : `${summary.total} job${summary.total === 1 ? "" : "s"}`;
  const counts = [
    summary.act > 0 ? `${summary.act} act now` : null,
    summary.watch > 0 ? `${summary.watch} watch` : null,
    summary.running > 0 ? `${summary.running} running` : null,
    summary.unavailable > 0 ? `${summary.unavailable} unavailable` : null,
    summary.ok > 0 ? `${summary.ok} OK` : null,
  ].filter((part): part is string => part != null);
  return [scope, ...counts].join(" · ");
}

const RUNBOOK_BLOB_URL = "https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks";

/** Job-owned runbooks: the doc that names the job as its primary subject. */
const CRON_JOB_RUNBOOKS: Readonly<Record<string, string>> = {
  "sync-blacklist": "blacklist-sync.md",
  "sync-stablecoins": "stablecoins-cache.md",
  "sync-mint-burn": "mint-burn-integrity.md",
  "daily-digest": "blocked-digest-edition.md",
  "weekly-recap": "blocked-digest-edition.md",
  "digest-trigger-poll": "blocked-digest-edition.md",
  "sync-yield-data": "yield-health.md",
  "sync-yield-supplemental": "yield-health.md",
  "yield-coverage-audit": "yield-health.md",
  "fetch-tbill-rate": "yield-benchmark-fallback-stale.md",
  "dispatch-telegram-alerts": "telegram-backlog-expiration.md",
  "telegram-digest-outbox-drain": "telegram-digest-outbox.md",
  "telegram-degradation-watchdog": "telegram-rate-limit-storm.md",
};

export interface CronRunbookLink {
  label: string;
  href: string;
}

function runbookLabel(href: string): string {
  const file = href.split("/").pop()?.replace(/\.md$/, "") ?? href;
  const words = file.replace(/-/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} runbook`;
}

/**
 * Runbooks for a cron row, most specific first: a status cause that names
 * this job and carries a runbook, then the runbook for the row's failure
 * mode (abandoned slot, stale lease, missed delivery), then the job's own.
 */
export function getCronRunbooks(
  row: Pick<CronWorkbenchRow, "job" | "cron" | "verdictReason">,
  causes: readonly StatusCause[] = [],
): CronRunbookLink[] {
  const hrefs: string[] = [];
  for (const cause of causes) {
    if (cause.runbookUrl && cause.subjects?.includes(row.job)) hrefs.push(cause.runbookUrl);
  }
  const lastRun = row.cron.lastRun;
  if (lastRun && isCronRunPlatformAbandoned(lastRun)) hrefs.push(`${RUNBOOK_BLOB_URL}/cron-slot-abandonment.md`);
  if (
    row.cron.inFlight?.stale
    || (row.cron.staleArtifacts?.length ?? 0) > 0
    || lastRun?.status === "skipped_locked"
  ) {
    hrefs.push(`${RUNBOOK_BLOB_URL}/lease-and-breaker-recovery.md`);
  }
  if (row.verdictReason.code === "no-fresh-run") hrefs.push(`${RUNBOOK_BLOB_URL}/cron-delivery-stall.md`);
  const owned = CRON_JOB_RUNBOOKS[row.job];
  if (owned) hrefs.push(`${RUNBOOK_BLOB_URL}/${owned}`);
  return [...new Set(hrefs)].map((href) => ({ href, label: runbookLabel(href) }));
}

/** Status causes whose `subjects` name this job. */
export function getCronCauses(job: string, causes: readonly StatusCause[] = []): StatusCause[] {
  return causes.filter((cause) => cause.subjects?.includes(job));
}

export function getCronTailCommand(job: string): string {
  return `wrangler tail stablecoin-api --format pretty --search ${job}`;
}
