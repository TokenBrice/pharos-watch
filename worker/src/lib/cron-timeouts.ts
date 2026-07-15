import { TELEGRAM_DISPATCH_TIMEOUT_MS } from "@shared/lib/telegram-delivery-policy";
import { CRON_JOB_DEFINITIONS } from "@shared/lib/cron-jobs";

import { PUBLIC_DATASET_CRON_TIMEOUT_MS } from "./public-dataset-snapshot-budget";

export const DEFAULT_CRON_TIMEOUT_MS = 5 * 60_000;
export const SCHEDULED_EVENT_WALL_CLOCK_LIMIT_MS = 15 * 60_000;
export const SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS = 60_000;
export const SCHEDULED_SLOT_JOB_BUDGET_MS =
  SCHEDULED_EVENT_WALL_CLOCK_LIMIT_MS - SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS;

export interface CronTimeoutBudgetOptions {
  nowMs?: number;
  slotBudgetStartedAtMs?: number | null;
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

const CRON_TIMEOUT_OVERRIDES_MS: Record<string, number> = {
  // Keep app-level timeout below the platform wall-clock limit so we can log
  // a controlled error instead of losing the invocation without a cron_runs row.
  "sync-stablecoins": 8 * 60_000,
  "reserve-recovery": 13 * 60_000,
  "sync-live-reserves": 12 * 60_000,
  // The producer stops RPC work at eight minutes, leaving one minute to publish
  // a complete quote generation and record the cron result.
  "sync-cl-exit-depth": 9 * 60_000,
  "sync-dex-liquidity": 13 * 60_000,
  "sync-dex-discovery": 13 * 60_000,
  "sync-yield-data": 10 * 60_000,
  "sync-yield-supplemental": 12 * 60_000,
  "sync-blacklist": 12 * 60_000,
  "sync-mint-burn": 10 * 60_000,
  "sync-mint-burn-extended": 10 * 60_000,
  // Telegram alert fan-out targets a 15-minute normal SLO for 5k watchers.
  // Keep the app timeout under Cloudflare's scheduled-event ceiling while
  // leaving room for cron_runs logging and sidecar skips.
  "dispatch-telegram-alerts": TELEGRAM_DISPATCH_TIMEOUT_MS,
  "snapshot-public-dataset": PUBLIC_DATASET_CRON_TIMEOUT_MS,
  // Daily digest: Anthropic budget is 12 min, wrapper caps at 14 min to leave
  // ~2 min for D1 persistence, Telegram/Twitter delivery, and cron_runs logging
  // before Cloudflare's 15-min scheduled-event ceiling.
  "daily-digest": 14 * 60_000,
  "weekly-recap": 12 * 60_000,
};

const cronJobIds = new Set(CRON_JOB_DEFINITIONS.map((definition) => definition.job));
for (const job of Object.keys(CRON_TIMEOUT_OVERRIDES_MS)) {
  if (!cronJobIds.has(job)) {
    throw new Error(`Cron timeout override references unknown job "${job}"`);
  }
}

export const CRON_TIMEOUT_MS: Record<string, number> = Object.fromEntries(
  CRON_JOB_DEFINITIONS.map(({ job }) => [job, CRON_TIMEOUT_OVERRIDES_MS[job] ?? DEFAULT_CRON_TIMEOUT_MS]),
);

function positiveFiniteMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value != null && value > 0 ? value : fallback;
}

export function getConfiguredCronTimeoutMs(job: string): number {
  return CRON_TIMEOUT_MS[job] ?? DEFAULT_CRON_TIMEOUT_MS;
}

export function getScheduledSlotControlledDeadlineMs(
  slotBudgetStartedAtMs: number,
  options: Pick<CronTimeoutBudgetOptions, "platformTimeoutMs" | "controlledErrorReserveMs"> = {},
): number {
  const platformTimeoutMs = positiveFiniteMs(options.platformTimeoutMs, SCHEDULED_EVENT_WALL_CLOCK_LIMIT_MS);
  const reserveMs = Math.max(
    0,
    Math.min(
      options.controlledErrorReserveMs ?? SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS,
      platformTimeoutMs - 1,
    ),
  );
  return slotBudgetStartedAtMs + platformTimeoutMs - reserveMs;
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
  const slotBudgetStartedAtMs = options.slotBudgetStartedAtMs ?? null;

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
  const slotControlledDeadlineMs = slotPlatformDeadlineMs - controlledErrorReserveMs;
  const remainingSlotBudgetMs = Math.max(0, slotControlledDeadlineMs - nowMs);
  const effectiveTimeoutMs = Math.min(configuredTimeoutMs, remainingSlotBudgetMs);

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
