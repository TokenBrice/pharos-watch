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
import { TELEGRAM_DISPATCH_TIMEOUT_MS } from "./telegram-delivery-policy";
import { PUBLIC_DATASET_CRON_TIMEOUT_MS } from "./public-dataset-snapshot-budget";

export const DEFAULT_CRON_TIMEOUT_MS = 5 * 60_000;
export type ScheduledTaskDuePolicy = "always" | "conditional-admission" | "dex-publication" | "monday";

export interface ScheduledTaskLeaseOptions {
  heartbeatSec?: number;
  maxRenewFailures?: number;
}

interface ScheduledTaskPolicy {
  timeoutMs?: number;
  leaseOptions?: Readonly<ScheduledTaskLeaseOptions>;
  due?: ScheduledTaskDuePolicy;
}

// Tighter renewal detects lease loss within long-running jobs' own timeout.
// Unspecified options retain runCronWithLease's TTL-derived defaults.
const LONG_RUNNING_LEASE_OPTIONS = { heartbeatSec: 30, maxRenewFailures: 3 } as const;
const SENTINEL_TASK_POLICY = { timeoutMs: 13 * 60_000 } as const;
// Eight minutes of RPC work leaves one minute to publish a complete generation.
const MEASURED_EXECUTION_TASK_POLICY = {
  timeoutMs: 9 * 60_000, leaseOptions: LONG_RUNNING_LEASE_OPTIONS,
} as const;
const YIELD_SUPPLEMENTAL_TASK_POLICY = {
  timeoutMs: 12 * 60_000, leaseOptions: LONG_RUNNING_LEASE_OPTIONS,
} as const;
const PUBLIC_DATASET_TASK_POLICY = {
  timeoutMs: PUBLIC_DATASET_CRON_TIMEOUT_MS, leaseOptions: LONG_RUNNING_LEASE_OPTIONS,
} as const;
// The 12-minute Anthropic cap leaves two minutes for persistence and delivery,
// still below the platform's 15-minute scheduled-event ceiling.
const DIGEST_TASK_POLICY = {
  timeoutMs: 14 * 60_000, leaseOptions: LONG_RUNNING_LEASE_OPTIONS,
} as const;

export type ScheduledWorkerRole = "public" | "heavy";

/** Recovery must not load producer graphs beside a live heavy scheduled slot. */
export const RESERVE_RECOVERY_HEAVY_SLOT_KEYS = [
  "fourHourlyReserveSync",
  "halfHourlyChartsOffset",
  "v9PublicationOffset",
] as const satisfies readonly CronScheduleKey[];
export type ScheduledSlotJobChain = readonly string[];

interface ScheduledSlotPlanInput {
  worker: ScheduledWorkerRole;
  jobChains: readonly ScheduledSlotJobChain[];
  budgetOnlyJobs?: readonly string[];
  taskPolicies?: Readonly<Record<string, ScheduledTaskPolicy>>;
}

export interface ScheduledSlotPlan extends Omit<ScheduledSlotPlanInput, "taskPolicies"> {
  scheduleKey: CronScheduleKey;
  schedule: CronScheduleExpression;
  triggerSchedules: readonly string[];
}

const SCHEDULED_SLOT_PLAN_INPUTS = {
  quarterHourly: {
    worker: "public",
    jobChains: [[
      "sync-fx-rates",
      "sync-stablecoins",
      "snapshot-supply",
      "snapshot-chain-supply",
      "snapshot-psi",
      "snapshot-public-dataset",
    ]],
    taskPolicies: {
      "sync-stablecoins": { timeoutMs: 8 * 60_000, leaseOptions: LONG_RUNNING_LEASE_OPTIONS },
      "snapshot-psi": { due: "conditional-admission" },
      "snapshot-public-dataset": { ...PUBLIC_DATASET_TASK_POLICY, due: "conditional-admission" },
    },
  },
  v9SupplyAttributionOffset: {
    worker: "heavy",
    jobChains: [["sync-v9-supply-attribution"]],
    taskPolicies: { "sync-v9-supply-attribution": { leaseOptions: LONG_RUNNING_LEASE_OPTIONS } },
  },
  depegResolverOffset: {
    worker: "public",
    jobChains: [["compute-depeg-resolver"]],
  },
  v9PublicationOffset: {
    worker: "heavy",
    jobChains: [["compute-safety-score-v9"]],
  },
  statusSelfCheckOffset: {
    worker: "public",
    jobChains: [[
      "status-self-check",
      "data-invariant-canary",
      "cron-sentinel",
    ]],
    budgetOnlyJobs: ["price-corroboration"],
    taskPolicies: { "cron-sentinel": SENTINEL_TASK_POLICY },
  },
  sixHourlyBlacklist: {
    worker: "public",
    jobChains: [["sync-blacklist"]],
    taskPolicies: { "sync-blacklist": { timeoutMs: 12 * 60_000, leaseOptions: LONG_RUNNING_LEASE_OPTIONS } },
  },
  halfHourlyMintBurnCritical: {
    worker: "public",
    jobChains: [["sync-mint-burn"]],
    taskPolicies: { "sync-mint-burn": { timeoutMs: 10 * 60_000, leaseOptions: LONG_RUNNING_LEASE_OPTIONS } },
  },
  twoHourlyDexDiscovery: {
    worker: "public",
    jobChains: [["sync-dex-discovery"]],
    taskPolicies: { "sync-dex-discovery": { timeoutMs: 13 * 60_000, leaseOptions: LONG_RUNNING_LEASE_OPTIONS } },
  },
  halfHourlyMintBurnExtended: {
    worker: "public",
    jobChains: [["sync-mint-burn-extended"]],
    taskPolicies: { "sync-mint-burn-extended": { timeoutMs: 10 * 60_000, leaseOptions: LONG_RUNNING_LEASE_OPTIONS } },
  },
  halfHourlyMeasuredExecution: {
    worker: "public",
    jobChains: [["sync-cl-exit-depth"]],
    taskPolicies: { "sync-cl-exit-depth": MEASURED_EXECUTION_TASK_POLICY },
  },
  halfHourlyMeasuredExecutionSupplemental: {
    worker: "public",
    jobChains: [["sync-cl-exit-depth"]],
    taskPolicies: { "sync-cl-exit-depth": MEASURED_EXECUTION_TASK_POLICY },
  },
  halfHourlyOffset: {
    worker: "public",
    jobChains: [["sync-dex-liquidity-stage"]],
    taskPolicies: { "sync-dex-liquidity-stage": { timeoutMs: 13 * 60_000, leaseOptions: LONG_RUNNING_LEASE_OPTIONS } },
  },
  halfHourlyChartsOffset: {
    worker: "heavy",
    jobChains: [[
      "sync-dex-liquidity",
      "cron-sentinel",
      "prepare-safety-score-v9-input",
      "sync-stablecoin-charts",
    ]],
    taskPolicies: {
      "sync-dex-liquidity": { timeoutMs: 13 * 60_000, leaseOptions: LONG_RUNNING_LEASE_OPTIONS },
      "cron-sentinel": { ...SENTINEL_TASK_POLICY, due: "dex-publication" },
    },
  },
  dewsPsiOffset: {
    worker: "public",
    jobChains: [["compute-dews", "stability-index", "project-tape"]],
  },
  fourHourlyReserveSync: {
    worker: "public",
    // Two chains, not one queue. sync-live-reserves is the slot's measured
    // head (p95 458s), and both consumers of the generation it writes stay
    // ordered behind it: the backstop computation and the reserve watchdog.
    // `cron-sentinel` publishes a reserve-drift envelope stamped with the
    // current time, so running it beside the head let it observe and re-publish
    // the previous generation before this slot's rows landed. Kinesis supply
    // reads no reserve output and keeps running beside the head. A head the
    // slot fence abandons delays the watchdog instead of losing it: the
    // five-minute reserve-recovery lane replays the abandoned checkpoint in
    // chain order (chain prerequisites are derived from this plan).
    // Declared peak max(reserve 2, redemption 3, sentinel 1) + Kinesis 1 = 4/6.
    jobChains: [
      // Redemption can consume prior sealed acceptance after an incomplete head;
      // only the sentinel requires the current cohort's successful exhaustion.
      ["sync-live-reserves", "sync-redemption-backstops", "cron-sentinel"],
      ["sync-kinesis-supply"],
    ],
    taskPolicies: {
      "sync-live-reserves": { timeoutMs: 12 * 60_000, leaseOptions: LONG_RUNNING_LEASE_OPTIONS },
      "cron-sentinel": SENTINEL_TASK_POLICY,
    },
  },
  hourlyYieldSync: {
    worker: "public",
    // Serially ordered on purpose: the opportunistic supplemental catch-up and
    // the benchmark-registry retry both publish evidence that sync-yield-data
    // reads in the same slot, so they must land first. One serial chain keeps
    // the trigger's declared peak at max(3, 1, 2) instead of summing the three
    // jobs' budgets.
    //
    // `observe-rpc-provider-parity` is a second, independent chain: it shares
    // the one invocation per hour the yield publication already pays for, is
    // strictly serial (one connection), and reads no yield output, so it must
    // neither delay the publication nor inherit its chain's stop-on-failure.
    // Declared peak: max(3, 1, 2) + 1 = 4/6, including catch-up Royco/Aave fanouts.
    jobChains: [
      ["sync-yield-supplemental", "fetch-tbill-rate", "sync-yield-data"],
      ["observe-rpc-provider-parity"],
    ],
    taskPolicies: {
      "sync-yield-supplemental": { ...YIELD_SUPPLEMENTAL_TASK_POLICY, due: "conditional-admission" },
      "fetch-tbill-rate": { due: "conditional-admission" },
      "sync-yield-data": { timeoutMs: 10 * 60_000, leaseOptions: LONG_RUNNING_LEASE_OPTIONS },
    },
  },
  fourHourlyYieldSupplemental: {
    worker: "public",
    jobChains: [["sync-yield-supplemental"]],
    taskPolicies: { "sync-yield-supplemental": YIELD_SUPPLEMENTAL_TASK_POLICY },
  },
  fiveMinuteTelegramAlerts: {
    worker: "public",
    jobChains: [[
      "dispatch-telegram-alerts",
      "telegram-personalized-recap-planner",
      "telegram-degradation-watchdog",
      "telegram-disambiguation-cleanup",
      "telegram-pulse-snapshot",
    ]],
    budgetOnlyJobs: ["telegram-registration-reconciliation"],
    // Batch admission stops at four minutes; reserve 30 seconds for finalization
    // and terminate before the next five-minute dispatch can lose its lease.
    taskPolicies: {
      "dispatch-telegram-alerts": { timeoutMs: TELEGRAM_DISPATCH_TIMEOUT_MS, leaseOptions: LONG_RUNNING_LEASE_OPTIONS },
    },
  },
  fiveMinuteReserveRecovery: {
    worker: "public",
    jobChains: [["reserve-recovery"]],
    taskPolicies: { "reserve-recovery": { timeoutMs: 13 * 60_000, leaseOptions: LONG_RUNNING_LEASE_OPTIONS } },
  },
  digestTriggerPoll: {
    worker: "public",
    jobChains: [["daily-digest", "weekly-recap"]],
    budgetOnlyJobs: ["telegram-digest-outbox-drain", "safety-map-producer-kick", "digest-trigger-poll"],
    taskPolicies: {
      "daily-digest": { ...DIGEST_TASK_POLICY, due: "conditional-admission" },
      "weekly-recap": { ...DIGEST_TASK_POLICY, due: "conditional-admission" },
    },
  },
  daily0300Utc: {
    worker: "public",
    jobChains: [[
      "cron-sentinel",
      "prune-status-probe-runs",
      "prune-cron-history",
      "prune-detail-cache",
      "telegram-inactive-cleanup",
      "telegram-retention-cleanup",
    ]],
    taskPolicies: { "cron-sentinel": SENTINEL_TASK_POLICY },
  },
  daily0800Utc: {
    worker: "public",
    jobChains: [
      ["snapshot-supply"],
      ["snapshot-safety-grade-history", "snapshot-psi", "snapshot-public-dataset"],
      ["fetch-tbill-rate", "sync-usds-status"],
    ],
    taskPolicies: { "snapshot-public-dataset": PUBLIC_DATASET_TASK_POLICY },
  },
  daily0805Utc: {
    worker: "public",
    jobChains: [
      ["sync-bluechip"],
      ["daily-digest"],
    ],
    taskPolicies: { "daily-digest": DIGEST_TASK_POLICY },
  },
  daily0810Utc: {
    worker: "public",
    jobChains: [["weekly-recap"], ["sync-cl-exit-depth"]],
    taskPolicies: {
      "weekly-recap": { ...DIGEST_TASK_POLICY, due: "monday" },
      "sync-cl-exit-depth": MEASURED_EXECUTION_TASK_POLICY,
    },
  },
  monthlyYieldAudit: {
    worker: "public",
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
          worker: planInput.worker,
          scheduleKey: scheduleKey as CronScheduleKey,
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
function indexScheduledSlotPlansByTriggerSchedule(
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

export function getScheduledWorkerRoleForExpression(expression: string): ScheduledWorkerRole {
  const plan = SCHEDULED_SLOT_PLANS_BY_SCHEDULE[expression];
  if (!plan) throw new Error(`Unknown scheduled cron expression: ${expression}`);
  return plan.worker;
}

export function listScheduledExpressionsForWorker(role: ScheduledWorkerRole): string[] {
  return Object.values(SCHEDULED_SLOT_PLANS)
    .filter((plan) => plan.worker === role)
    .flatMap((plan) => [...plan.triggerSchedules]);
}

/**
 * Producers that carry a cron identity and cadence but are not members of a
 * slot chain: the scheduled slot only triggers them and a separate execution
 * surface writes their `cron_runs` row. Declaring them here keeps chain
 * coverage enforceable instead of letting an unimplemented chain member hide
 * among genuinely off-slot work.
 */
export const OFF_SLOT_SCHEDULED_PRODUCERS = {
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
  job: string;
  producerPath: string;
  producerKind: ScheduledProducerKind;
  statusTracked: boolean;
  maxConnections: number;
  connectionGroup?: string;
  chainIndex: number | null;
  taskIndex: number;
  calendarIdentity?: ScheduledCalendarIdentity;
  timeoutMs: number;
  leaseOptions: Readonly<ScheduledTaskLeaseOptions>;
  due: ScheduledTaskDuePolicy;
}

function descriptorKey(scheduleKey: CronScheduleKey, job: string): string {
  return `${scheduleKey}\u0000${job}`;
}

/**
 * Whether an unstarted slot member was due by the clock on this occurrence. Unknown
 * slot/job pairs are treated as due so an unregistered member is never
 * silently excused.
 */
export function isScheduledTaskDueAt(
  scheduleKey: CronScheduleKey,
  job: string,
  slotStartedAtSec: number,
): boolean {
  const due = SCHEDULED_TASK_DESCRIPTOR_BY_KEY.get(descriptorKey(scheduleKey, job))?.due ?? "always";
  switch (due) {
    case "conditional-admission": return false;
    case "dex-publication": return isDexLiquidityPublicationSlot(slotStartedAtSec);
    case "monday": return new Date(slotStartedAtSec * 1_000).getUTCDay() === 1;
    case "always": return true;
  }
}

function buildScheduledTaskDescriptors(): ScheduledTaskDescriptor[] {
  const descriptors: ScheduledTaskDescriptor[] = [];
  for (const plan of Object.values(SCHEDULED_SLOT_PLANS)) {
    const policies = (SCHEDULED_SLOT_PLAN_INPUTS[plan.scheduleKey] as ScheduledSlotPlanInput).taskPolicies ?? {};
    const plannedJobs = new Set(getScheduledSlotPlanBudgetEntries(plan));
    for (const job of Object.keys(policies)) {
      if (!plannedJobs.has(job)) throw new Error(`Scheduled task policy references unplanned job ${plan.scheduleKey}/${job}`);
    }
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
          job,
          producerPath: plan.scheduleKey,
          producerKind: "scheduled-job",
          statusTracked: true,
          maxConnections: definition.maxConnections ?? 0,
          ...(definition.connectionGroup ? { connectionGroup: definition.connectionGroup } : {}),
          chainIndex,
          taskIndex,
          ...(plan.scheduleKey === "monthlyYieldAudit" ? { calendarIdentity: "utc-month" } : {}),
          timeoutMs: policies[job]?.timeoutMs ?? DEFAULT_CRON_TIMEOUT_MS,
          leaseOptions: policies[job]?.leaseOptions ?? {},
          due: policies[job]?.due ?? "always",
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
        job,
        producerPath: plan.scheduleKey,
        producerKind: "budget-only",
        statusTracked: false,
        maxConnections: definition.maxConnections,
        ...(definition.connectionGroup ? { connectionGroup: definition.connectionGroup } : {}),
        chainIndex: null,
        taskIndex,
        ...(plan.scheduleKey === "monthlyYieldAudit" ? { calendarIdentity: "utc-month" } : {}),
        timeoutMs: policies[job]?.timeoutMs ?? DEFAULT_CRON_TIMEOUT_MS,
        leaseOptions: policies[job]?.leaseOptions ?? {},
        due: policies[job]?.due ?? "always",
      });
    }
  }
  return descriptors;
}

export const SCHEDULED_TASK_DESCRIPTORS: readonly ScheduledTaskDescriptor[] = Object.freeze(
  buildScheduledTaskDescriptors(),
);

/** Retry/poll lanes require admission evidence; a slot alone never proves work was due. */
export const CONDITIONALLY_ADMITTED_SCHEDULED_TASKS: readonly { scheduleKey: CronScheduleKey; job: string }[] = SCHEDULED_TASK_DESCRIPTORS
  .filter((descriptor) => descriptor.due === "conditional-admission")
  .map(({ scheduleKey, job }) => ({ scheduleKey, job }));

export function isConditionallyAdmittedScheduledTask(scheduleKey: string | null, job: string): boolean {
  return CONDITIONALLY_ADMITTED_SCHEDULED_TASKS.some((task) => task.scheduleKey === scheduleKey && task.job === job);
}

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
