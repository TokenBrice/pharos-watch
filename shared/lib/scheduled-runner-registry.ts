import { CRON_SCHEDULES, type CronScheduleExpression, type CronScheduleKey } from "./cron-jobs";

export type ScheduledRunnerKey = CronScheduleKey;
export type ScheduledSlotJobChain = readonly string[];

interface ScheduledSlotPlanInput {
  jobChains: readonly ScheduledSlotJobChain[];
  budgetOnlyJobs?: readonly string[];
}

export interface ScheduledSlotPlan extends ScheduledSlotPlanInput {
  scheduleKey: CronScheduleKey;
  schedule: CronScheduleExpression;
  runnerKey: ScheduledRunnerKey;
}

const SCHEDULED_SLOT_PLAN_INPUTS = {
  quarterHourly: {
    jobChains: [[
      "sync-fx-rates",
      "sync-stablecoins",
      "snapshot-supply",
      "snapshot-chain-supply",
      "publish-report-card-cache",
      "compute-depeg-resolver",
    ]],
  },
  statusSelfCheckOffset: {
    jobChains: [["cron-slot-sweeper", "status-self-check", "data-invariant-canary", "cron-staleness-watchdog"]],
  },
  sixHourlyBlacklist: {
    jobChains: [["sync-blacklist"]],
  },
  halfHourlyMintBurnCritical: {
    jobChains: [["sync-mint-burn"]],
  },
  twoHourlyDexDiscovery: {
    jobChains: [["sync-dex-discovery"]],
  },
  halfHourlyMintBurnExtended: {
    jobChains: [["sync-mint-burn-extended"]],
  },
  halfHourlyOffset: {
    jobChains: [["sync-dex-liquidity"]],
  },
  halfHourlyChartsOffset: {
    jobChains: [["sync-stablecoin-charts"]],
  },
  dewsPsiOffset: {
    jobChains: [["compute-dews", "stability-index", "project-tape"]],
  },
  fourHourlyReserveSync: {
    jobChains: [["sync-live-reserves", "sync-redemption-backstops", "sync-kinesis-supply", "reserve-post-sync-watchdog"]],
  },
  hourlyYieldSync: {
    jobChains: [["sync-yield-data"]],
  },
  fourHourlyYieldSupplemental: {
    jobChains: [["sync-yield-supplemental"]],
  },
  fiveMinuteTelegramAlerts: {
    jobChains: [[
      "dispatch-telegram-alerts",
      "telegram-degradation-watchdog",
      "telegram-disambiguation-cleanup",
      "telegram-pulse-snapshot",
    ]],
    budgetOnlyJobs: ["telegram-registration-reconciliation"],
  },
  fiveMinuteReserveRecovery: {
    jobChains: [["reserve-recovery"]],
  },
  digestTriggerPoll: {
    jobChains: [["daily-digest"]],
    budgetOnlyJobs: ["digest-trigger-poll"],
  },
  daily0300Utc: {
    jobChains: [[
      "prune-status-probe-runs",
      "prune-cron-history",
      "worker-repair-runner",
      "prune-detail-cache",
      "telegram-inactive-cleanup",
      "telegram-retention-cleanup",
      "mint-burn-growth-watchdog",
      "cron-duration-watchdog",
    ]],
  },
  daily0800Utc: {
    jobChains: [
      ["snapshot-supply"],
      ["snapshot-safety-grade-history", "snapshot-psi", "snapshot-public-dataset"],
      ["fetch-tbill-rate", "sync-usds-status"],
    ],
  },
  daily0805Utc: {
    jobChains: [
      ["sync-bluechip"],
      ["daily-digest", "weekly-recap"],
    ],
  },
  daily0810Utc: {
    jobChains: [["discovery-scan"]],
  },
  monthlyYieldAudit: {
    jobChains: [["yield-coverage-audit"]],
  },
} as const satisfies Record<CronScheduleKey, ScheduledSlotPlanInput>;

export const SCHEDULED_SLOT_PLANS: Readonly<Record<CronScheduleKey, ScheduledSlotPlan>> = Object.freeze(
  Object.fromEntries(
    Object.entries(SCHEDULED_SLOT_PLAN_INPUTS).map(([scheduleKey, input]) => {
      const planInput = input as ScheduledSlotPlanInput;
      return [
        scheduleKey,
        {
          scheduleKey: scheduleKey as CronScheduleKey,
          runnerKey: scheduleKey as ScheduledRunnerKey,
          schedule: CRON_SCHEDULES[scheduleKey as CronScheduleKey],
          jobChains: planInput.jobChains,
          budgetOnlyJobs: planInput.budgetOnlyJobs ?? [],
        },
      ];
    }),
  ) as Record<CronScheduleKey, ScheduledSlotPlan>,
);

export const SCHEDULED_SLOT_PLANS_BY_SCHEDULE: Readonly<Record<string, ScheduledSlotPlan>> = Object.freeze(
  Object.fromEntries(
    Object.values(SCHEDULED_SLOT_PLANS).map((plan) => [plan.schedule, plan]),
  ),
);

/**
 * Jobs that intentionally share one logical `cron_runs.job` identity across
 * more than one scheduled runner slot. Each entry uses one lease/status row on
 * purpose; anything not listed here should have a distinct job name.
 */
export const SHARED_SCHEDULED_JOB_IDENTITIES = {
  "daily-digest": ["digestTriggerPoll", "daily0805Utc"],
  "snapshot-supply": ["quarterHourly", "daily0800Utc"],
} as const satisfies Record<string, readonly CronScheduleKey[]>;

export function flattenScheduledSlotPlanJobs(plan: ScheduledSlotPlan): string[] {
  return plan.jobChains.flatMap((chain) => chain);
}

export function getScheduledSlotPlanBudgetEntries(plan: ScheduledSlotPlan): string[] {
  return [
    ...flattenScheduledSlotPlanJobs(plan),
    ...(plan.budgetOnlyJobs ?? []),
  ];
}
