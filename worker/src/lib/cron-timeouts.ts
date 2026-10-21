import {
  DEFAULT_CRON_TIMEOUT_MS,
  getScheduledTaskDescriptor,
} from "@shared/lib/scheduled-runner-registry";
import { CRON_JOB_DEFINITIONS } from "@shared/lib/cron-jobs";

export const SCHEDULED_EVENT_WALL_CLOCK_LIMIT_MS = 15 * 60_000;
export const SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS = 60_000;
export const SCHEDULED_SLOT_JOB_BUDGET_MS =
  SCHEDULED_EVENT_WALL_CLOCK_LIMIT_MS - SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS;

export interface CronTimeoutBudgetOptions {
  nowMs?: number;
  slotBudgetStartedAtMs?: number | null;
  deadline?: SlotDeadline;
  platformTimeoutMs?: number;
  controlledErrorReserveMs?: number;
}

export interface ResolvedCronTimeoutBudget {
  configuredTimeoutMs: number;
  effectiveTimeoutMs: number;
  truncated: boolean;
  exhausted: boolean;
  slotBudgetStartedAtMs: number | null;
  slotPlatformDeadlineMs: number | null;
  slotControlledDeadlineMs: number | null;
  remainingSlotBudgetMs: number | null;
  platformTimeoutMs: number;
  controlledErrorReserveMs: number;
}

export interface CronTimeoutBudgetMetadata {
  reason: "cron-timeout";
  configuredTimeoutMs: number;
  effectiveTimeoutMs: number;
  slotBudgetTruncated?: true;
  slotBudgetExhausted?: true;
  slotBudgetStartedAtMs?: number;
  slotPlatformDeadlineMs?: number;
  slotControlledDeadlineMs?: number;
  remainingSlotBudgetMs?: number;
  platformTimeoutMs?: number;
  controlledErrorReserveMs?: number;
}

/**
 * These status-tracked jobs are known short-lived control-plane/maintenance
 * work. Their terminal cron_runs row remains useful, but an in-flight
 * cron_run_progress row cannot provide meaningful operator value before they
 * finish. Keep this explicit rather than deriving it from timeout overrides:
 * those are conservative wall-clock caps, not p95 runtime measurements.
 */
export const PROGRESS_TELEMETRY_SKIP_JOBS: Readonly<Record<string, true>> = {
  "stability-index": true,
  "compute-dews": true,
  "project-tape": true,
  "telegram-pulse-snapshot": true,
  "snapshot-supply": true,
  "snapshot-chain-supply": true,
  "cron-sentinel": true,
};

export function shouldSkipCronProgress(job: string): boolean {
  return PROGRESS_TELEMETRY_SKIP_JOBS[job] === true
    || job.startsWith("prune-")
    || job.endsWith("-watchdog");
}

export const CRON_TIMEOUT_MS: Record<string, number> = Object.fromEntries(
  CRON_JOB_DEFINITIONS.map(({ job, scheduleKey }) => [
    job, getScheduledTaskDescriptor(scheduleKey, job).timeoutMs,
  ]),
);

function positiveFiniteMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value != null && value > 0 ? value : fallback;
}

function getConfiguredCronTimeoutMs(job: string): number {
  return CRON_TIMEOUT_MS[job] ?? DEFAULT_CRON_TIMEOUT_MS;
}

/** One event-entry clock, inherited unchanged by waits and replay children. */
export interface SlotDeadline {
  readonly eventEntryMs: number;
  readonly platformDeadlineMs: number;
  remainingMs(nowMs?: number): number;
  childCeilingMs(budgetMs: number, nowMs?: number): number;
  latestAdmissionMs(budgetMs: number, reservedWorkMs: number): number;
}

export function createSlotDeadline(
  eventEntryMs: number,
  controlledDeadlineMs = eventEntryMs + SCHEDULED_SLOT_JOB_BUDGET_MS,
): SlotDeadline {
  const platformDeadlineMs = controlledDeadlineMs;
  return Object.freeze({
    eventEntryMs,
    platformDeadlineMs,
    remainingMs: (nowMs = Date.now()) => Math.max(0, platformDeadlineMs - nowMs),
    childCeilingMs: (budgetMs: number, nowMs = Date.now()) =>
      Math.max(0, Math.min(budgetMs, platformDeadlineMs - nowMs)),
    latestAdmissionMs: (budgetMs: number, reservedWorkMs: number) =>
      platformDeadlineMs - budgetMs - reservedWorkMs,
  });
}

/** Check both sides of mandatory awaits; an expired delivery never admits work. */
export function assertSlotDeadline(deadline: SlotDeadline | undefined, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (deadline && deadline.remainingMs() <= 0) {
    throw new Error("scheduled-slot-deadline-exceeded");
  }
}

export function resolveCronTimeoutBudget(
  job: string,
  options: CronTimeoutBudgetOptions = {},
): ResolvedCronTimeoutBudget {
  const configuredTimeoutMs = getConfiguredCronTimeoutMs(job);
  const platformTimeoutMs = positiveFiniteMs(options.platformTimeoutMs, SCHEDULED_EVENT_WALL_CLOCK_LIMIT_MS);
  const controlledErrorReserveMs = Math.max(
    0,
    Math.min(
      options.controlledErrorReserveMs ?? SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS,
      platformTimeoutMs - 1,
    ),
  );
  const slotBudgetStartedAtMs = options.deadline?.eventEntryMs ?? options.slotBudgetStartedAtMs ?? null;

  if (slotBudgetStartedAtMs == null) {
    return {
      configuredTimeoutMs,
      effectiveTimeoutMs: configuredTimeoutMs,
      truncated: false,
      exhausted: false,
      slotBudgetStartedAtMs: null,
      slotPlatformDeadlineMs: null,
      slotControlledDeadlineMs: null,
      remainingSlotBudgetMs: null,
      platformTimeoutMs,
      controlledErrorReserveMs,
    };
  }

  const nowMs = options.nowMs ?? Date.now();
  const slotPlatformDeadlineMs = slotBudgetStartedAtMs + platformTimeoutMs;
  const slotControlledDeadlineMs = options.deadline?.platformDeadlineMs ?? slotPlatformDeadlineMs - controlledErrorReserveMs;
  const remainingSlotBudgetMs = options.deadline?.remainingMs(nowMs) ?? Math.max(0, slotControlledDeadlineMs - nowMs);
  const effectiveTimeoutMs = options.deadline?.childCeilingMs(configuredTimeoutMs, nowMs)
    ?? Math.min(configuredTimeoutMs, remainingSlotBudgetMs);

  return {
    configuredTimeoutMs,
    effectiveTimeoutMs,
    truncated: effectiveTimeoutMs < configuredTimeoutMs,
    exhausted: remainingSlotBudgetMs <= 0,
    slotBudgetStartedAtMs,
    slotPlatformDeadlineMs,
    slotControlledDeadlineMs,
    remainingSlotBudgetMs,
    platformTimeoutMs,
    controlledErrorReserveMs,
  };
}

export function getCronTimeoutBudgetMetadata(
  budget: ResolvedCronTimeoutBudget,
): CronTimeoutBudgetMetadata | undefined {
  if (!budget.truncated && !budget.exhausted) return undefined;
  return {
    reason: "cron-timeout",
    configuredTimeoutMs: budget.configuredTimeoutMs,
    effectiveTimeoutMs: budget.effectiveTimeoutMs,
    ...(budget.truncated ? { slotBudgetTruncated: true as const } : {}),
    ...(budget.exhausted ? { slotBudgetExhausted: true as const } : {}),
    ...(budget.slotBudgetStartedAtMs != null ? { slotBudgetStartedAtMs: budget.slotBudgetStartedAtMs } : {}),
    ...(budget.slotPlatformDeadlineMs != null ? { slotPlatformDeadlineMs: budget.slotPlatformDeadlineMs } : {}),
    ...(budget.slotControlledDeadlineMs != null ? { slotControlledDeadlineMs: budget.slotControlledDeadlineMs } : {}),
    ...(budget.remainingSlotBudgetMs != null ? { remainingSlotBudgetMs: budget.remainingSlotBudgetMs } : {}),
    platformTimeoutMs: budget.platformTimeoutMs,
    controlledErrorReserveMs: budget.controlledErrorReserveMs,
  };
}
