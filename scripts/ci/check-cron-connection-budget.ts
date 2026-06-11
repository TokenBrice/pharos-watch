import { pathToFileURL } from "url";
import { CRON_CONNECTION_BUDGET, CRON_CONNECTION_BUDGET_ENTRIES, CRON_SCHEDULES } from "../../shared/lib/cron-jobs";

interface CronConnectionBudgetEntryForCheck {
  job: string;
  maxConnections: number;
  connectionGroup?: string;
  scheduleKey: string;
  statusTracked: boolean;
}

interface CronConnectionBudgetConfigForCheck {
  maxPerTrigger: number;
  failAt: number;
  fullForNewFetchHeavyWorkAt: number;
}

export interface CronConnectionGroupReport {
  peak: number;
  jobs: string[];
}

export interface CronConnectionTriggerReport {
  groups: Map<string, CronConnectionGroupReport>;
  jobs: CronConnectionBudgetEntryForCheck[];
  scheduleKey: string;
  totalConnections: number;
}

export interface CronConnectionBudgetReport {
  budgetOnlyCount: number;
  failed: boolean;
  headroomFullTriggers: CronConnectionTriggerReport[];
  missingBudgetScheduleKeys: string[];
  triggerReports: CronConnectionTriggerReport[];
}

function pluralize(count: number, singular: string): string {
  if (count === 1) return `${count} ${singular}`;
  if (singular.endsWith("y")) return `${count} ${singular.slice(0, -1)}ies`;
  return `${count} ${singular}s`;
}

function formatJob(job: { job: string; statusTracked: boolean }): string {
  return job.statusTracked ? job.job : `${job.job} [budget-only]`;
}

export function evaluateCronConnectionBudget(input: {
  budget?: CronConnectionBudgetConfigForCheck;
  entries?: readonly CronConnectionBudgetEntryForCheck[];
  schedules?: Record<string, string>;
} = {}): CronConnectionBudgetReport {
  const budget = input.budget ?? CRON_CONNECTION_BUDGET;
  const entries = input.entries ?? CRON_CONNECTION_BUDGET_ENTRIES;
  const schedules = input.schedules ?? CRON_SCHEDULES;

  const jobsByTrigger = new Map<string, CronConnectionBudgetEntryForCheck[]>();
  for (const def of entries) {
    const key = def.scheduleKey;
    if (!jobsByTrigger.has(key)) jobsByTrigger.set(key, []);
    jobsByTrigger.get(key)!.push({
      job: def.job,
      maxConnections: def.maxConnections,
      connectionGroup: def.connectionGroup ?? def.job,
      scheduleKey: def.scheduleKey,
      statusTracked: def.statusTracked,
    });
  }

  const missingBudgetScheduleKeys = Object.keys(schedules).filter((scheduleKey) => !jobsByTrigger.has(scheduleKey));
  const triggerReports: CronConnectionTriggerReport[] = [];
  const headroomFullTriggers: CronConnectionTriggerReport[] = [];
  let failed = missingBudgetScheduleKeys.length > 0;

  for (const [scheduleKey, jobs] of jobsByTrigger) {
    const groups = new Map<string, CronConnectionGroupReport>();
    for (const job of jobs) {
      const groupKey = job.connectionGroup ?? job.job;
      const group = groups.get(groupKey) ?? { peak: 0, jobs: [] };
      group.peak = Math.max(group.peak, job.maxConnections);
      group.jobs.push(formatJob(job));
      groups.set(groupKey, group);
    }
    const totalConnections = Array.from(groups.values()).reduce((sum, group) => sum + group.peak, 0);
    const triggerReport = { scheduleKey, jobs, groups, totalConnections };
    triggerReports.push(triggerReport);

    if (totalConnections >= budget.failAt) {
      failed = true;
    } else if (totalConnections >= budget.fullForNewFetchHeavyWorkAt) {
      headroomFullTriggers.push(triggerReport);
    }
  }

  return {
    budgetOnlyCount: entries.filter((entry) => !entry.statusTracked).length,
    failed,
    headroomFullTriggers,
    missingBudgetScheduleKeys,
    triggerReports,
  };
}

function printReport(report: CronConnectionBudgetReport): void {
  if (report.missingBudgetScheduleKeys.length > 0) {
    console.error(
      `FAIL: ${pluralize(report.missingBudgetScheduleKeys.length, "cron schedule")} missing from CRON_CONNECTION_BUDGET_ENTRIES: ${report.missingBudgetScheduleKeys.join(", ")}`,
    );
  }

  for (const trigger of report.triggerReports) {
    if (trigger.totalConnections >= CRON_CONNECTION_BUDGET.failAt) {
      console.error(
        `FAIL: Trigger "${trigger.scheduleKey}" uses ${trigger.totalConnections}/${CRON_CONNECTION_BUDGET.maxPerTrigger} connections:`,
      );
      for (const [groupKey, group] of trigger.groups) {
        console.error(`  - ${groupKey}: ${group.peak} connections (${group.jobs.join(" -> ")})`);
      }
      continue;
    }
    // Per-trigger success lines are intentionally silent; headroom-full
    // triggers are detailed in the dedicated section below.
  }

  if (report.failed) {
    console.error("\nConnection budget exceeded. Rebalance jobs across triggers.");
    return;
  }

  if (report.headroomFullTriggers.length > 0) {
    console.log(
      `\nConnection headroom policy: ${CRON_CONNECTION_BUDGET.fullForNewFetchHeavyWorkAt}/${CRON_CONNECTION_BUDGET.maxPerTrigger} connections is full for new fetch-heavy work.`,
    );
    for (const trigger of report.headroomFullTriggers) {
      console.log(`  - ${trigger.scheduleKey}: ${trigger.totalConnections}/${CRON_CONNECTION_BUDGET.maxPerTrigger}`);
      for (const [groupKey, group] of trigger.groups) {
        console.log(`    * ${groupKey}: ${pluralize(group.peak, "connection")} (${group.jobs.join(" -> ")})`);
      }
    }
  }

  console.log(
    `\nAll ${report.triggerReports.length} triggers within connection budget (${pluralize(report.budgetOnlyCount, "budget-only entry")} included).`,
  );
}

function isMainModule(): boolean {
  const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
  return import.meta.url === entry;
}

if (isMainModule()) {
  const report = evaluateCronConnectionBudget();
  printReport(report);
  if (report.failed) {
    process.exit(1);
  }
}
