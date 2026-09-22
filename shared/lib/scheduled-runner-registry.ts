import {
  CRON_CONNECTION_BUDGET_ENTRIES,
  CRON_JOB_DEFINITIONS,
  CRON_SCHEDULES,
  CRON_TRIGGER_SCHEDULES,
  SHARED_SCHEDULED_JOB_IDENTITIES,
  type CronScheduleExpression,
  type CronScheduleKey,
} from "./cron-jobs";
import { isDexLiquidityPublicationSlot } from "./cron-cadences";

export type ScheduledRunnerKey = CronScheduleKey;
export type ScheduledSlotJobChain = readonly string[];

interface ScheduledSlotPlanInput {
  jobChains: readonly ScheduledSlotJobChain[];
  budgetOnlyJobs?: readonly string[];
}

export interface ScheduledSlotPlan extends ScheduledSlotPlanInput {
  scheduleKey: CronScheduleKey;
  schedule: CronScheduleExpression;
  triggerSchedules: readonly string[];
  runnerKey: ScheduledRunnerKey;
}

const SCHEDULED_SLOT_PLAN_INPUTS = {
  quarterHourly: {
    jobChains: [[
      "sync-fx-rates",
      "sync-stablecoins",
      "snapshot-supply",
      "snapshot-chain-supply",
      "snapshot-psi",
      "snapshot-public-dataset",
    ]],
  },
  v9SupplyAttributionOffset: {
    jobChains: [["sync-v9-supply-attribution"]],
  },
  depegResolverOffset: {
    jobChains: [["compute-depeg-resolver"]],
  },
  v9PublicationOffset: {
    jobChains: [["compute-safety-score-v9"]],
  },
  statusSelfCheckOffset: {
    jobChains: [[
      "status-self-check",
      "data-invariant-canary",
      "cron-sentinel",
    ]],
    budgetOnlyJobs: ["price-corroboration"],
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
  halfHourlyMeasuredExecution: {
    jobChains: [["sync-cl-exit-depth"]],
  },
  halfHourlyOffset: {
    jobChains: [["sync-dex-liquidity-stage"]],
  },
  halfHourlyChartsOffset: {
    jobChains: [[
      "sync-dex-liquidity",
      "cron-sentinel",
      "prepare-safety-score-v9-input",
      "sync-stablecoin-charts",
    ]],
  },
  dewsPsiOffset: {
    jobChains: [["compute-dews", "stability-index", "project-tape"]],
  },
  fourHourlyReserveSync: {
    // Three independent chains, not one queue. sync-live-reserves is the
    // slot's measured head (p95 458s); when it stalls, the slot fence
    // abandons everything still queued behind it. Only the backstop
    // computation actually consumes its output, so kinesis supply and the
    // reserve watchdog run beside it: a watchdog must never be abandoned by
    // the thing it watches. Declared peak 2 + 1 + 1 = 4/6.
    jobChains: [
      ["sync-live-reserves", "sync-redemption-backstops"],
      ["sync-kinesis-supply"],
      ["cron-sentinel"],
    ],
  },
  hourlyYieldSync: {
    // Serially ordered on purpose: the opportunistic supplemental catch-up and
    // the benchmark-registry retry both publish evidence that sync-yield-data
    // reads in the same slot, so they must land first. One serial chain keeps
    // the trigger's declared peak at max(3, 1, 2) instead of summing the three
    // jobs' budgets.
    jobChains: [["sync-yield-supplemental", "fetch-tbill-rate", "sync-yield-data"]],
  },
  fourHourlyYieldSupplemental: {
    jobChains: [["sync-yield-supplemental"]],
  },
  fiveMinuteTelegramAlerts: {
    jobChains: [[
      "dispatch-telegram-alerts",
      "telegram-personalized-recap-planner",
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
    jobChains: [["daily-digest", "weekly-recap"]],
    budgetOnlyJobs: ["telegram-digest-outbox-drain", "digest-trigger-poll"],
  },
  daily0300Utc: {
    jobChains: [[
      "cron-sentinel",
      "prune-status-probe-runs",
      "prune-cron-history",
      "prune-detail-cache",
      "telegram-inactive-cleanup",
      "telegram-retention-cleanup",
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
      ["daily-digest"],
    ],
  },
  daily0810Utc: {
    jobChains: [["weekly-recap"], ["sync-cl-exit-depth"]],
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
          triggerSchedules: CRON_TRIGGER_SCHEDULES[scheduleKey as CronScheduleKey],
          jobChains: planInput.jobChains,
          budgetOnlyJobs: planInput.budgetOnlyJobs ?? [],
        },
      ];
    }),
  ) as Record<CronScheduleKey, ScheduledSlotPlan>,
);

/**
 * One trigger expression dispatches exactly one slot plan. Two plans claiming
 * the same expression used to collapse silently into whichever one was
 * enumerated first, so half the topology stopped running with no gate failing.
 */
export function indexScheduledSlotPlansByTriggerSchedule(
  plans: Readonly<Record<string, ScheduledSlotPlan>>,
): Record<string, ScheduledSlotPlan> {
  const byTriggerSchedule: Record<string, ScheduledSlotPlan> = {};
  for (const plan of Object.values(plans)) {
    for (const triggerSchedule of plan.triggerSchedules) {
      const claimed = byTriggerSchedule[triggerSchedule];
      if (claimed) {
        throw new Error(
          `Duplicate scheduled trigger "${triggerSchedule}" claimed by ${claimed.scheduleKey} and ${plan.scheduleKey}`,
        );
      }
      byTriggerSchedule[triggerSchedule] = plan;
    }
  }
  return byTriggerSchedule;
}

export const SCHEDULED_SLOT_PLANS_BY_SCHEDULE: Readonly<Record<string, ScheduledSlotPlan>> = Object.freeze(
  indexScheduledSlotPlansByTriggerSchedule(SCHEDULED_SLOT_PLANS),
);

/**
 * Producers that carry a cron identity and cadence but are not members of a
 * slot chain: the scheduled slot only triggers them and a separate execution
 * surface writes their `cron_runs` row. Declaring them here keeps chain
 * coverage enforceable instead of letting an unimplemented chain member hide
 * among genuinely off-slot work.
 */
export const OFF_SLOT_SCHEDULED_PRODUCERS = {
  // Dispatched by the V9 publication slot; the Cloudflare Workflow instance
  // executes it and logs its own run.
  "compute-safety-score-v9-workflow": "v9PublicationOffset",
} as const satisfies Record<string, CronScheduleKey>;

export { SHARED_SCHEDULED_JOB_IDENTITIES };

export type ScheduledProducerKind = "scheduled-job" | "budget-only";
export type ScheduledCalendarIdentity = "utc-month";

/**
 * Canonical executable identity for one job/path in a scheduled slot. A job
 * may appear more than once only when each occurrence has a distinct path.
 */
export interface ScheduledTaskDescriptor {
  scheduleKey: CronScheduleKey;
  schedule: CronScheduleExpression;
  runnerKey: ScheduledRunnerKey;
  job: string;
  producerPath: string;
  producerKind: ScheduledProducerKind;
  statusTracked: boolean;
  maxConnections: number;
  connectionGroup?: string;
  chainIndex: number | null;
  taskIndex: number;
  calendarIdentity?: ScheduledCalendarIdentity;
}

function descriptorKey(scheduleKey: CronScheduleKey, job: string): string {
  return `${scheduleKey}\u0000${job}`;
}

/**
 * Slot members whose occurrence is gated by a cadence inside the slot. A
 * member that was never due on this occurrence was not "abandoned before
 * start", so stale-slot reconciliation must not invent an error row for it
 * (rule R4). Unlisted members are unconditionally due.
 */
const SCHEDULED_TASK_DUE_PREDICATES: Readonly<
  Record<string, (slotStartedAtSec: number) => boolean>
> = {
  // Turnover evidence only exists on the hourly DEX publication slot.
  [descriptorKey("halfHourlyChartsOffset", "cron-sentinel")]: isDexLiquidityPublicationSlot,
  // Weekly generation is Monday-only; `generateWeeklyRecap` re-checks the same
  // UTC day from the same slot clock.
  [descriptorKey("daily0810Utc", "weekly-recap")]: (slotStartedAtSec) =>
    new Date(slotStartedAtSec * 1_000).getUTCDay() === 1,
  // The five-minute poll runs a digest edition only when a stored request or
  // a missed-edition resume asks for one; no occurrence is due by the clock.
  [descriptorKey("digestTriggerPoll", "daily-digest")]: () => false,
  [descriptorKey("digestTriggerPoll", "weekly-recap")]: () => false,
};

/**
 * Whether a slot member was due to run on the given occurrence. Unknown
 * slot/job pairs are treated as due so an unregistered member is never
 * silently excused.
 */
export function isScheduledTaskDueAt(
  scheduleKey: CronScheduleKey,
  job: string,
  slotStartedAtSec: number,
): boolean {
  const isDue = SCHEDULED_TASK_DUE_PREDICATES[descriptorKey(scheduleKey, job)];
  return isDue ? isDue(slotStartedAtSec) : true;
}

function buildScheduledTaskDescriptors(): ScheduledTaskDescriptor[] {
  const descriptors: ScheduledTaskDescriptor[] = [];
  for (const plan of Object.values(SCHEDULED_SLOT_PLANS)) {
    for (let chainIndex = 0; chainIndex < plan.jobChains.length; chainIndex += 1) {
      const chain = plan.jobChains[chainIndex] ?? [];
      for (let taskIndex = 0; taskIndex < chain.length; taskIndex += 1) {
        const job = chain[taskIndex]!;
        const exactDefinition = CRON_JOB_DEFINITIONS.find((candidate) => (
          candidate.scheduleKey === plan.scheduleKey && candidate.job === job
        ));
        const sharedSchedules = (SHARED_SCHEDULED_JOB_IDENTITIES as Partial<
          Record<string, readonly CronScheduleKey[]>
        >)[job];
        const definition = exactDefinition ?? (
          sharedSchedules?.includes(plan.scheduleKey)
            ? CRON_JOB_DEFINITIONS.find((candidate) => candidate.job === job)
            : undefined
        );
        if (!definition) {
          throw new Error(`Missing cron definition for ${plan.scheduleKey}/${job}`);
        }
        descriptors.push({
          scheduleKey: plan.scheduleKey,
          schedule: plan.schedule,
          runnerKey: plan.runnerKey,
          job,
          producerPath: plan.scheduleKey,
          producerKind: "scheduled-job",
          statusTracked: true,
          maxConnections: definition.maxConnections ?? 0,
          ...(definition.connectionGroup ? { connectionGroup: definition.connectionGroup } : {}),
          chainIndex,
          taskIndex,
          ...(plan.scheduleKey === "monthlyYieldAudit" ? { calendarIdentity: "utc-month" } : {}),
        });
      }
    }

    const budgetOnlyJobs = plan.budgetOnlyJobs ?? [];
    for (let taskIndex = 0; taskIndex < budgetOnlyJobs.length; taskIndex += 1) {
      const job = budgetOnlyJobs[taskIndex]!;
      const definition = CRON_CONNECTION_BUDGET_ENTRIES.find((candidate) => (
        candidate.scheduleKey === plan.scheduleKey && candidate.job === job && !candidate.statusTracked
      ));
      if (!definition) {
        throw new Error(`Missing budget-only cron definition for ${plan.scheduleKey}/${job}`);
      }
      descriptors.push({
        scheduleKey: plan.scheduleKey,
        schedule: plan.schedule,
        runnerKey: plan.runnerKey,
        job,
        producerPath: plan.scheduleKey,
        producerKind: "budget-only",
        statusTracked: false,
        maxConnections: definition.maxConnections,
        ...(definition.connectionGroup ? { connectionGroup: definition.connectionGroup } : {}),
        chainIndex: null,
        taskIndex,
        ...(plan.scheduleKey === "monthlyYieldAudit" ? { calendarIdentity: "utc-month" } : {}),
      });
    }
  }
  return descriptors;
}

export const SCHEDULED_TASK_DESCRIPTORS: readonly ScheduledTaskDescriptor[] = Object.freeze(
  buildScheduledTaskDescriptors(),
);

const SCHEDULED_TASK_DESCRIPTOR_BY_KEY = new Map(
  SCHEDULED_TASK_DESCRIPTORS.map((descriptor) => [
    descriptorKey(descriptor.scheduleKey, descriptor.job),
    descriptor,
  ]),
);

export function getScheduledTaskDescriptor(
  scheduleKey: CronScheduleKey,
  job: string,
): ScheduledTaskDescriptor {
  const descriptor = SCHEDULED_TASK_DESCRIPTOR_BY_KEY.get(descriptorKey(scheduleKey, job));
  if (!descriptor) {
    throw new Error(`Scheduled task ${scheduleKey}/${job} is not in the canonical executable manifest`);
  }
  return descriptor;
}

export function flattenScheduledSlotPlanJobs(plan: ScheduledSlotPlan): string[] {
  return plan.jobChains.flatMap((chain) => chain);
}

/**
 * Jobs that must have completed before each member of a slot may run, derived
 * from the chain each member sits in. Members of different chains have no
 * ordering relationship by construction.
 */
export function getScheduledSlotPlanChainPrerequisites(
  plan: ScheduledSlotPlan,
): Readonly<Record<string, readonly string[]>> {
  const prerequisites: Record<string, readonly string[]> = {};
  for (const chain of plan.jobChains) {
    for (let index = 0; index < chain.length; index += 1) {
      prerequisites[chain[index]!] = chain.slice(0, index);
    }
  }
  return prerequisites;
}

export function getScheduledSlotPlanBudgetEntries(plan: ScheduledSlotPlan): string[] {
  return [
    ...flattenScheduledSlotPlanJobs(plan),
    ...(plan.budgetOnlyJobs ?? []),
  ];
}
