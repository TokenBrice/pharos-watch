import { describe, expect, it } from "vitest";
import {
  CRON_CONNECTION_BUDGET_ENTRIES,
  CRON_JOB_DEFINITIONS,
  type CronScheduleKey,
} from "@shared/lib/cron-jobs";
import {
  CONDITIONALLY_ADMITTED_SCHEDULED_TASKS,
  DEFAULT_CRON_TIMEOUT_MS,
  getScheduledTaskDescriptor,
  SCHEDULED_TASK_DESCRIPTORS,
  flattenScheduledSlotPlanJobs,
  getScheduledWorkerRoleForExpression,
  listScheduledExpressionsForWorker,
  getScheduledSlotPlanBudgetEntries,
  isScheduledTaskDueAt,
  SHARED_SCHEDULED_JOB_IDENTITIES,
  SCHEDULED_SLOT_PLANS,
  OFF_SLOT_SCHEDULED_PRODUCERS,
} from "@shared/lib/scheduled-runner-registry";
import { CRON_TIMEOUT_MS } from "../../../lib/cron-timeouts";
import {
  PUBLIC_DATASET_CRON_TIMEOUT_MS,
  PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_BUDGET_MS,
} from "@shared/lib/public-dataset-snapshot-budget";
import { PUBLIC_SLOT_RUNNER_LOADERS } from "../public-runners";
import { HEAVY_SLOT_RUNNER_LOADERS } from "../heavy-runners";
import { bindScheduledSlotPlan } from "../slot-groups";

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

describe("scheduled runner contract", () => {
  it("binds every canonical chain directly without changing task order or implementations", () => {
    for (const plan of Object.values(SCHEDULED_SLOT_PLANS)) {
      const implementations = Object.fromEntries(
        flattenScheduledSlotPlanJobs(plan).map((job) => [job, async () => ({ status: "ok" as const })]),
      );
      const stages = bindScheduledSlotPlan(plan.scheduleKey, { implementations });
      expect(stages).toHaveLength(1);
      expect(stages[0].map((chain) => chain.tasks.map(({ job }) => job))).toEqual(plan.jobChains);
      for (const chain of stages[0]) {
        for (const task of chain.tasks) expect(task.run).toBe(implementations[task.job]);
      }
    }
  });

  it("projects timeout and lease policies from every executable descriptor without changing job caps", () => {
    const timeoutOverrides: Record<string, number> = {
      "sync-stablecoins": 8 * 60_000,
      "reserve-recovery": 13 * 60_000,
      "cron-sentinel": 13 * 60_000,
      "sync-live-reserves": 12 * 60_000,
      "sync-cl-exit-depth": 9 * 60_000,
      "sync-dex-liquidity-stage": 13 * 60_000,
      "sync-dex-liquidity": 13 * 60_000,
      "sync-dex-discovery": 13 * 60_000,
      "sync-yield-data": 10 * 60_000,
      "sync-yield-supplemental": 12 * 60_000,
      "sync-blacklist": 12 * 60_000,
      "sync-mint-burn": 10 * 60_000,
      "sync-mint-burn-extended": 10 * 60_000,
      "dispatch-telegram-alerts": 4 * 60_000 + 30_000,
      "snapshot-public-dataset": PUBLIC_DATASET_CRON_TIMEOUT_MS,
      "daily-digest": 14 * 60_000,
      "weekly-recap": 14 * 60_000,
    };
    const longRunningJobs = [
      ...Object.keys(timeoutOverrides).filter((job) => job !== "cron-sentinel"),
      "sync-v9-supply-attribution",
    ];
    for (const descriptor of SCHEDULED_TASK_DESCRIPTORS) {
      expect(getScheduledTaskDescriptor(descriptor.scheduleKey, descriptor.job)).toBe(descriptor);
      expect(descriptor.timeoutMs).toBe(timeoutOverrides[descriptor.job] ?? DEFAULT_CRON_TIMEOUT_MS);
      expect(descriptor.leaseOptions).toEqual(longRunningJobs.includes(descriptor.job)
        ? { heartbeatSec: 30, maxRenewFailures: 3 } : {});
      if (descriptor.statusTracked) expect(CRON_TIMEOUT_MS[descriptor.job]).toBe(descriptor.timeoutMs);
    }
  });

  it("retains per-occurrence Monday and DEX publication due gates on descriptors", () => {
    const monday = Date.UTC(2026, 9, 12, 8, 10) / 1_000;
    expect(getScheduledTaskDescriptor("daily0810Utc", "weekly-recap").due).toBe("monday");
    expect(isScheduledTaskDueAt("daily0810Utc", "weekly-recap", monday)).toBe(true);
    expect(isScheduledTaskDueAt("daily0810Utc", "weekly-recap", monday + 86_400)).toBe(false);
    expect(getScheduledTaskDescriptor("halfHourlyChartsOffset", "cron-sentinel").due).toBe("dex-publication");
    expect(isScheduledTaskDueAt("halfHourlyChartsOffset", "cron-sentinel", Date.UTC(2026, 9, 12, 8, 16) / 1_000)).toBe(true);
    expect(isScheduledTaskDueAt("halfHourlyChartsOffset", "cron-sentinel", Date.UTC(2026, 9, 12, 8, 46) / 1_000)).toBe(false);
  });

  it("keeps conditional admissions on registered secondary lanes without excusing canonical producers", () => {
    const monday = Date.UTC(2026, 9, 12) / 1_000;
    for (const { scheduleKey, job } of CONDITIONALLY_ADMITTED_SCHEDULED_TASKS) {
      expect(flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS[scheduleKey])).toContain(job);
      const canonical = CRON_JOB_DEFINITIONS.find((definition) => definition.job === job)!;
      expect(canonical.scheduleKey).not.toBe(scheduleKey);
      for (const hour of [0, 7, 8, 23]) {
        expect(isScheduledTaskDueAt(scheduleKey, job, monday + hour * 3_600)).toBe(false);
        expect(isScheduledTaskDueAt(canonical.scheduleKey, job, monday + hour * 3_600)).toBe(true);
      }
    }
    expect(isScheduledTaskDueAt("quarterHourly", "unknown-job", monday)).toBe(true);
  });

  it("keeps heavy inline DEX recovery within the existing connection peak", () => {
    expect(CRON_CONNECTION_BUDGET_ENTRIES.find(
      (entry) => entry.job === "sync-dex-liquidity" && entry.scheduleKey === "halfHourlyChartsOffset",
    )).toMatchObject({ maxConnections: 5 });
  });
  it("owns only the three revised heavy plans without adding expressions", () => {
    expect(Object.values(SCHEDULED_SLOT_PLANS).filter((plan) => plan.worker === "heavy")
      .map((plan) => plan.scheduleKey).sort()).toEqual([
      "halfHourlyChartsOffset", "v9PublicationOffset", "v9SupplyAttributionOffset",
    ]);
    expect(listScheduledExpressionsForWorker("heavy").sort()).toEqual([
      "8 * * * *", "23 * * * *", "38 * * * *", "53 * * * *",
      "16 * * * *", "46 * * * *", "22 * * * *", "52 * * * *",
    ].sort());
    for (const role of ["public", "heavy"] as const) {
      for (const expression of listScheduledExpressionsForWorker(role)) {
        expect(getScheduledWorkerRoleForExpression(expression)).toBe(role);
      }
    }
    expect(getScheduledWorkerRoleForExpression("11 */4 * * *")).toBe("public");
    expect(getScheduledWorkerRoleForExpression("* * * * *")).toBe("public");
    expect(() => getScheduledWorkerRoleForExpression("unknown")).toThrow("Unknown");
  });

  it("shares the measured job lease and three-connection budget across active opportunities", () => {
    for (const scheduleKey of ["halfHourlyMeasuredExecution", "halfHourlyMeasuredExecutionSupplemental"] as const) {
      expect(SCHEDULED_SLOT_PLANS[scheduleKey].worker).toBe("public");
      expect(SCHEDULED_SLOT_PLANS[scheduleKey].jobChains).toEqual([["sync-cl-exit-depth"]]);
      expect(CRON_CONNECTION_BUDGET_ENTRIES.find(
        (entry) => entry.job === "sync-cl-exit-depth" && entry.scheduleKey === scheduleKey,
      )).toMatchObject({ maxConnections: 3 });
    }
    expect(getScheduledWorkerRoleForExpression("20 * * * *")).toBe("public");
    expect(getScheduledWorkerRoleForExpression("50 * * * *")).toBe("public");
    expect(SHARED_SCHEDULED_JOB_IDENTITIES["sync-cl-exit-depth"]).toEqual([
      "halfHourlyMeasuredExecution", "halfHourlyMeasuredExecutionSupplemental", "daily0810Utc",
    ]);
    expect(SCHEDULED_SLOT_PLANS.daily0810Utc.jobChains).toContainEqual(["sync-cl-exit-depth"]);
    expect(CRON_TIMEOUT_MS["sync-cl-exit-depth"]).toBe(9 * 60_000);
  });
  it("keeps scheduled plans, slot runners, and cron definitions in sync", () => {
    const planKeys = Object.keys(SCHEDULED_SLOT_PLANS) as CronScheduleKey[];
    const loaders = { ...PUBLIC_SLOT_RUNNER_LOADERS, ...HEAVY_SLOT_RUNNER_LOADERS };
    expect(sorted(Object.keys(loaders))).toEqual(sorted(planKeys));
    for (const role of ["public", "heavy"] as const) {
      const roleLoaders = role === "public" ? PUBLIC_SLOT_RUNNER_LOADERS : HEAVY_SLOT_RUNNER_LOADERS;
      const ownedKeys = Object.values(SCHEDULED_SLOT_PLANS)
        .filter((plan) => plan.worker === role).map((plan) => plan.scheduleKey);
      expect(sorted(Object.keys(roleLoaders))).toEqual(sorted(ownedKeys));
    }
    for (const plan of Object.values(SCHEDULED_SLOT_PLANS)) {
      expect(loaders[plan.scheduleKey]).toEqual(expect.any(Function));
    }

    const plannedStatusJobs = new Set(
      Object.values(SCHEDULED_SLOT_PLANS).flatMap((plan) => flattenScheduledSlotPlanJobs(plan)),
    );
    const slotExecutedJobs = CRON_JOB_DEFINITIONS
      .map((definition) => definition.job)
      .filter((job) => !(job in OFF_SLOT_SCHEDULED_PRODUCERS));
    expect(sorted(plannedStatusJobs)).toEqual(sorted(slotExecutedJobs));

    for (const definition of CRON_JOB_DEFINITIONS) {
      if (definition.job in OFF_SLOT_SCHEDULED_PRODUCERS) continue;
      const plan = SCHEDULED_SLOT_PLANS[definition.scheduleKey];
      expect(flattenScheduledSlotPlanJobs(plan), `${definition.job} must be planned in ${definition.scheduleKey}`)
        .toContain(definition.job);
    }

    for (const entry of CRON_CONNECTION_BUDGET_ENTRIES) {
      if (entry.job in OFF_SLOT_SCHEDULED_PRODUCERS) continue;
      const plan = SCHEDULED_SLOT_PLANS[entry.scheduleKey];
      expect(getScheduledSlotPlanBudgetEntries(plan), `${entry.job} must have a scheduled budget entry`)
        .toContain(entry.job);
    }

    const durationBudgetJobs = Object.keys(CRON_TIMEOUT_MS);
    expect(sorted(durationBudgetJobs)).toEqual(sorted(CRON_JOB_DEFINITIONS.map((definition) => definition.job)));
    for (const [job, timeoutMs] of Object.entries(CRON_TIMEOUT_MS)) {
      expect(Number.isFinite(timeoutMs), `${job} duration budget must be finite`).toBe(true);
      expect(timeoutMs, `${job} duration budget must be positive`).toBeGreaterThan(0);
    }
  });

  it("keeps the reserve watchdog chained behind the reserve producer", () => {
    // The watchdog publishes a reserve-drift envelope timestamped with the
    // current time, so it must read a completed generation: chained behind the
    // producer, never launched beside it. Kinesis supply reads no reserve
    // output and stays independent.
    expect(SCHEDULED_SLOT_PLANS.fourHourlyReserveSync.jobChains).toEqual([
      ["sync-live-reserves", "sync-redemption-backstops", "cron-sentinel"],
      ["sync-kinesis-supply"],
    ]);
  });

  it("keeps the public dataset cache-wait budget inside its cron timeout", () => {
    const timeoutMs = CRON_TIMEOUT_MS["snapshot-public-dataset"];
    expect(timeoutMs).toBe(PUBLIC_DATASET_CRON_TIMEOUT_MS);
    expect(timeoutMs).toBeGreaterThan(PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_BUDGET_MS);
    expect(timeoutMs - PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_BUDGET_MS).toBeGreaterThanOrEqual(2 * 60_000);
  });

  it("gives Monday daily and weekly digest generation independent trigger budgets", () => {
    expect(SCHEDULED_SLOT_PLANS.daily0805Utc.jobChains).toContainEqual(["daily-digest"]);
    expect(flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS.daily0805Utc)).not.toContain("weekly-recap");
    expect(SCHEDULED_SLOT_PLANS.daily0810Utc.jobChains).toContainEqual(["weekly-recap"]);

    const daily = CRON_JOB_DEFINITIONS.find((definition) => definition.job === "daily-digest");
    const weekly = CRON_JOB_DEFINITIONS.find((definition) => definition.job === "weekly-recap");
    expect(daily?.scheduleKey).toBe("daily0805Utc");
    expect(weekly?.scheduleKey).toBe("daily0810Utc");
    expect(CRON_TIMEOUT_MS["daily-digest"]).toBe(14 * 60_000);
    // Weekly matches daily at 14 min: its own 12-min Anthropic cap previously
    // consumed the entire job budget, leaving no headroom for persistence and
    // the two channel deliveries that follow the LLM call.
    expect(CRON_TIMEOUT_MS["weekly-recap"]).toBe(14 * 60_000);
  });

  it("keeps shared cron job identities explicit", () => {
    const schedulesByJob = new Map<string, CronScheduleKey[]>();
    for (const plan of Object.values(SCHEDULED_SLOT_PLANS)) {
      for (const job of flattenScheduledSlotPlanJobs(plan)) {
        const schedules = schedulesByJob.get(job) ?? [];
        schedules.push(plan.scheduleKey);
        schedulesByJob.set(job, schedules);
      }
    }

    const sharedJobs = Object.fromEntries(
      [...schedulesByJob.entries()]
        .filter(([, schedules]) => schedules.length > 1)
        .map(([job, schedules]) => [job, sorted(schedules)]),
    );

    expect(sharedJobs).toEqual(
      Object.fromEntries(
        Object.entries(SHARED_SCHEDULED_JOB_IDENTITIES).map(([job, schedules]) => [job, sorted(schedules)]),
      ),
    );
  });
});
