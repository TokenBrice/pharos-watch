import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CRON_CONNECTION_BUDGET_ENTRIES, CRON_JOB_DEFINITIONS, CRON_SCHEDULES } from "../../shared/lib/cron-jobs";
import { SCHEDULED_SLOT_PLANS } from "../../shared/lib/scheduled-runner-registry";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SOURCE_OWNER = {
  wrangler: "worker/wrangler.toml [triggers.crons]",
  schedules: "shared/lib/cron-jobs.ts [CRON_SCHEDULES]",
  jobDefinitions: "shared/lib/cron-jobs.ts [CRON_JOB_DEFINITIONS]",
  budgetDefinitions: "shared/lib/cron-jobs.ts [CRON_CONNECTION_BUDGET_ENTRIES]",
  slotPlans: "shared/lib/scheduled-runner-registry.ts [SCHEDULED_SLOT_PLANS]",
} as const;

interface CronJobDefinitionForCheck {
  job: string;
}

interface CronConnectionBudgetEntryForCheck {
  job: string;
}

interface ScheduledSlotPlanForCheck {
  schedule?: string;
  jobChains: readonly (readonly string[])[];
  budgetOnlyJobs?: readonly string[];
}

export interface CronScheduleSyncReport {
  extraPlanKeys: string[];
  failed: boolean;
  missingBudgetJobs: string[];
  missingPlanKeys: string[];
  missingRuntimeJobs: string[];
  missingSlotPlanSchedules: string[];
  onlyInSharedSchedules: string[];
  onlyInSlotPlanSchedules: string[];
  onlyInWranglerSchedules: string[];
  scheduleKeyByExpression: Map<string, string>;
  slotPlanKeyByExpression: Map<string, string>;
  slotPlanTriggerCount: number;
  unknownBudgetJobs: string[];
  unknownRuntimeJobs: string[];
  wranglerTriggerCount: number;
}

export function parseWranglerCronTriggers(wranglerToml: string): string[] {
  const cronMatches = wranglerToml.match(/crons\s*=\s*\[([\s\S]*?)\]/);
  if (!cronMatches) {
    throw new Error("Could not find crons array in wrangler.toml");
  }

  return cronMatches[1].match(/"([^"]+)"/g)?.map((s) => s.replace(/"/g, "")) ?? [];
}

function keyByExpression(entries: Iterable<readonly [string, string]>): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, schedule] of entries) {
    if (!result.has(schedule)) {
      result.set(schedule, key);
    }
  }
  return result;
}

function formatSchedule(schedule: string, keyBySchedule: Map<string, string>): string {
  const key = keyBySchedule.get(schedule);
  return key ? `${key}: "${schedule}"` : `"${schedule}"`;
}

function formatList(values: readonly string[], format: (value: string) => string = (value) => value): string[] {
  return values.map((value) => `  - ${format(value)}`);
}

function flattenScheduledJobs(plan: ScheduledSlotPlanForCheck): string[] {
  return plan.jobChains.flatMap((chain) => chain);
}

function getScheduledBudgetEntries(plan: ScheduledSlotPlanForCheck): string[] {
  return [...flattenScheduledJobs(plan), ...(plan.budgetOnlyJobs ?? [])];
}

function getCronScheduleByKey(cronSchedules: Readonly<Record<string, string>>, key: string): string | undefined {
  return cronSchedules[key];
}

export function evaluateCronScheduleSync(input: {
  cronConnectionBudgetEntries?: readonly CronConnectionBudgetEntryForCheck[];
  cronJobDefinitions?: readonly CronJobDefinitionForCheck[];
  cronSchedules?: Record<string, string>;
  scheduledSlotPlans?: Readonly<Record<string, ScheduledSlotPlanForCheck>>;
  wranglerCronTriggers: Iterable<string>;
}): CronScheduleSyncReport {
  const cronSchedules = input.cronSchedules ?? CRON_SCHEDULES;
  const scheduledSlotPlans = input.scheduledSlotPlans ?? SCHEDULED_SLOT_PLANS;
  const cronJobDefinitions = input.cronJobDefinitions ?? CRON_JOB_DEFINITIONS;
  const cronConnectionBudgetEntries = input.cronConnectionBudgetEntries ?? CRON_CONNECTION_BUDGET_ENTRIES;

  const wranglerCrons = new Set(input.wranglerCronTriggers);
  const sharedCrons = new Set<string>(Object.values(cronSchedules));
  const scheduleKeyByExpression = keyByExpression(Object.entries(cronSchedules));
  const slotPlanScheduleEntries = Object.entries(scheduledSlotPlans)
    .map(([key, plan]) => [key, plan.schedule ?? getCronScheduleByKey(cronSchedules, key) ?? ""] as const)
    .filter(([, schedule]) => schedule.length > 0);
  const slotPlanKeyByExpression = keyByExpression(slotPlanScheduleEntries);
  const slotPlanCrons = new Set<string>(slotPlanScheduleEntries.map(([, schedule]) => schedule));

  const onlyInWranglerSchedules = [...wranglerCrons].filter((schedule) => !sharedCrons.has(schedule));
  const onlyInSharedSchedules = [...sharedCrons].filter((schedule) => !wranglerCrons.has(schedule));
  const onlyInSlotPlanSchedules = [...slotPlanCrons].filter((schedule) => !sharedCrons.has(schedule));
  const missingSlotPlanSchedules = [...sharedCrons].filter((schedule) => !slotPlanCrons.has(schedule));

  const planKeys = new Set(Object.keys(scheduledSlotPlans));
  const missingPlanKeys = Object.keys(cronSchedules).filter((key) => !planKeys.has(key));
  const extraPlanKeys = [...planKeys].filter((key) => !(key in cronSchedules));

  const runtimeJobs = new Set(Object.values(scheduledSlotPlans).flatMap(flattenScheduledJobs));
  const expectedCronJobs = new Set(cronJobDefinitions.map((definition) => definition.job));
  const missingRuntimeJobs = [...expectedCronJobs].filter((job) => !runtimeJobs.has(job));
  const unknownRuntimeJobs = [...runtimeJobs].filter((job) => !expectedCronJobs.has(job));

  const scheduledBudgetJobs = new Set(Object.values(scheduledSlotPlans).flatMap(getScheduledBudgetEntries));
  const expectedBudgetJobs = new Set(cronConnectionBudgetEntries.map((definition) => definition.job));
  const missingBudgetJobs = [...expectedBudgetJobs].filter((job) => !scheduledBudgetJobs.has(job));
  const unknownBudgetJobs = [...scheduledBudgetJobs].filter((job) => !expectedBudgetJobs.has(job));

  const failed = Boolean(
    onlyInWranglerSchedules.length ||
    onlyInSharedSchedules.length ||
    onlyInSlotPlanSchedules.length ||
    missingSlotPlanSchedules.length ||
    missingPlanKeys.length ||
    extraPlanKeys.length ||
    missingRuntimeJobs.length ||
    unknownRuntimeJobs.length ||
    missingBudgetJobs.length ||
    unknownBudgetJobs.length,
  );

  return {
    extraPlanKeys,
    failed,
    missingBudgetJobs,
    missingPlanKeys,
    missingRuntimeJobs,
    missingSlotPlanSchedules,
    onlyInSharedSchedules,
    onlyInSlotPlanSchedules,
    onlyInWranglerSchedules,
    scheduleKeyByExpression,
    slotPlanKeyByExpression,
    slotPlanTriggerCount: slotPlanCrons.size,
    unknownBudgetJobs,
    unknownRuntimeJobs,
    wranglerTriggerCount: wranglerCrons.size,
  };
}

export function printCronScheduleSyncReport(report: CronScheduleSyncReport): void {
  if (!report.failed) {
    console.log(
      `Cron schedule check passed (${report.wranglerTriggerCount} triggers match, ${report.slotPlanTriggerCount} slot plans mapped).`,
    );
    return;
  }

  console.error("Cron schedule mismatch detected!");

  if (report.onlyInWranglerSchedules.length || report.onlyInSharedSchedules.length) {
    console.error(`\nConfigured trigger drift (${SOURCE_OWNER.wrangler} <-> ${SOURCE_OWNER.schedules}):`);
    if (report.onlyInWranglerSchedules.length) {
      console.error(`Extra in ${SOURCE_OWNER.wrangler}; no owner in ${SOURCE_OWNER.schedules}:`);
      console.error(formatList(report.onlyInWranglerSchedules).join("\n"));
    }
    if (report.onlyInSharedSchedules.length) {
      console.error(`Missing from ${SOURCE_OWNER.wrangler}; owned by ${SOURCE_OWNER.schedules}:`);
      console.error(
        formatList(report.onlyInSharedSchedules, (schedule) =>
          formatSchedule(schedule, report.scheduleKeyByExpression),
        ).join("\n"),
      );
    }
  }

  if (
    report.onlyInSlotPlanSchedules.length ||
    report.missingSlotPlanSchedules.length ||
    report.missingPlanKeys.length ||
    report.extraPlanKeys.length
  ) {
    console.error(`\nSlot plan drift (${SOURCE_OWNER.slotPlans} <-> ${SOURCE_OWNER.schedules}):`);
    if (report.onlyInSlotPlanSchedules.length) {
      console.error(`Extra schedule in ${SOURCE_OWNER.slotPlans}; no owner in ${SOURCE_OWNER.schedules}:`);
      console.error(
        formatList(report.onlyInSlotPlanSchedules, (schedule) =>
          formatSchedule(schedule, report.slotPlanKeyByExpression),
        ).join("\n"),
      );
    }
    if (report.missingSlotPlanSchedules.length) {
      console.error(`Missing schedule in ${SOURCE_OWNER.slotPlans}; owned by ${SOURCE_OWNER.schedules}:`);
      console.error(
        formatList(report.missingSlotPlanSchedules, (schedule) =>
          formatSchedule(schedule, report.scheduleKeyByExpression),
        ).join("\n"),
      );
    }
    if (report.missingPlanKeys.length) {
      console.error(`Missing key in ${SOURCE_OWNER.slotPlans}; owned by ${SOURCE_OWNER.schedules}:`);
      console.error(formatList(report.missingPlanKeys).join("\n"));
    }
    if (report.extraPlanKeys.length) {
      console.error(`Extra key in ${SOURCE_OWNER.slotPlans}; no owner in ${SOURCE_OWNER.schedules}:`);
      console.error(formatList(report.extraPlanKeys).join("\n"));
    }
  }

  if (report.missingRuntimeJobs.length || report.unknownRuntimeJobs.length) {
    console.error(`\nRuntime job drift (${SOURCE_OWNER.slotPlans} jobChains <-> ${SOURCE_OWNER.jobDefinitions}):`);
    if (report.missingRuntimeJobs.length) {
      console.error(`Missing from ${SOURCE_OWNER.slotPlans} jobChains; owned by ${SOURCE_OWNER.jobDefinitions}:`);
      console.error(formatList(report.missingRuntimeJobs).join("\n"));
    }
    if (report.unknownRuntimeJobs.length) {
      console.error(`Unknown job in ${SOURCE_OWNER.slotPlans} jobChains; no owner in ${SOURCE_OWNER.jobDefinitions}:`);
      console.error(formatList(report.unknownRuntimeJobs).join("\n"));
    }
  }

  if (report.missingBudgetJobs.length || report.unknownBudgetJobs.length) {
    console.error(
      `\nConnection-budget drift (${SOURCE_OWNER.slotPlans} jobChains/budgetOnlyJobs <-> ${SOURCE_OWNER.budgetDefinitions}):`,
    );
    if (report.missingBudgetJobs.length) {
      console.error(
        `Missing from ${SOURCE_OWNER.slotPlans} jobChains/budgetOnlyJobs; owned by ${SOURCE_OWNER.budgetDefinitions}:`,
      );
      console.error(formatList(report.missingBudgetJobs).join("\n"));
    }
    if (report.unknownBudgetJobs.length) {
      console.error(
        `Unknown budget entry in ${SOURCE_OWNER.slotPlans} jobChains/budgetOnlyJobs; no owner in ${SOURCE_OWNER.budgetDefinitions}:`,
      );
      console.error(formatList(report.unknownBudgetJobs).join("\n"));
    }
  }
}

function isMainModule(): boolean {
  return isDirectRun(import.meta.url, process.argv[1]);
}

if (isMainModule()) {
  try {
    const wranglerToml = readFileSync(join(ROOT, "worker/wrangler.toml"), "utf-8");
    const report = evaluateCronScheduleSync({
      wranglerCronTriggers: parseWranglerCronTriggers(wranglerToml),
    });
    printCronScheduleSyncReport(report);
    if (report.failed) {
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
