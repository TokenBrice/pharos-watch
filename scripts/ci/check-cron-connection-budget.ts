import { CRON_CONNECTION_BUDGET, CRON_CONNECTION_BUDGET_ENTRIES, CRON_SCHEDULES } from "../../shared/lib/cron-jobs";
import { SCHEDULED_SLOT_PLANS } from "../../shared/lib/scheduled-runner-registry";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

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

export interface CronConnectionChainReport {
  chainKey: string;
  peak: number;
  jobs: string[];
}

export interface CronConnectionTriggerReport {
  budgetOnlyChain: CronConnectionChainReport | null;
  chains: CronConnectionChainReport[];
  groups: Map<string, CronConnectionGroupReport>;
  jobs: CronConnectionBudgetEntryForCheck[];
  parallelConnections: number;
  scheduleKey: string;
  totalConnections: number;
}

export interface CronConnectionBudgetReport {
  budget: CronConnectionBudgetConfigForCheck;
  budgetOnlyCount: number;
  failed: boolean;
  headroomFullTriggers: CronConnectionTriggerReport[];
  missingBudgetJobs: string[];
  missingBudgetScheduleKeys: string[];
  triggerReports: CronConnectionTriggerReport[];
}

interface ScheduledSlotPlanForCheck {
  jobChains: readonly (readonly string[])[];
  budgetOnlyJobs?: readonly string[];
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
  slotPlans?: Readonly<Record<string, ScheduledSlotPlanForCheck>>;
} = {}): CronConnectionBudgetReport {
  const budget = input.budget ?? CRON_CONNECTION_BUDGET;
  const entries = input.entries ?? CRON_CONNECTION_BUDGET_ENTRIES;
  const schedules = input.schedules ?? CRON_SCHEDULES;
  const slotPlans: Readonly<Record<string, ScheduledSlotPlanForCheck>> = input.slotPlans ?? SCHEDULED_SLOT_PLANS;

  const entriesByJob = new Map<string, CronConnectionBudgetEntryForCheck[]>();
  for (const def of entries) {
    const normalized = {
      job: def.job,
      maxConnections: def.maxConnections,
      connectionGroup: def.connectionGroup ?? def.job,
      scheduleKey: def.scheduleKey,
      statusTracked: def.statusTracked,
    };
    const jobEntries = entriesByJob.get(def.job) ?? [];
    jobEntries.push(normalized);
    entriesByJob.set(def.job, jobEntries);
  }

  const missingBudgetJobs: string[] = [];
  const missingBudgetScheduleKeys = Object.keys(schedules).filter((scheduleKey) => !slotPlans[scheduleKey]);
  const triggerReports: CronConnectionTriggerReport[] = [];
  const headroomFullTriggers: CronConnectionTriggerReport[] = [];
  let failed = missingBudgetScheduleKeys.length > 0;

  function resolveEntry(scheduleKey: string, job: string): CronConnectionBudgetEntryForCheck | null {
    const matches = entriesByJob.get(job) ?? [];
    if (matches.length === 0) {
      missingBudgetJobs.push(`${scheduleKey}:${job}`);
      return null;
    }

    const sameSchedule = matches.find((entry) => entry.scheduleKey === scheduleKey);
    if (sameSchedule) {
      return sameSchedule;
    }

    if (matches.length === 1) {
      return matches[0];
    }

    missingBudgetJobs.push(`${scheduleKey}:${job} (ambiguous budget entry)`);
    return null;
  }

  function evaluateChain(scheduleKey: string, chainKey: string, jobs: readonly string[]): {
    chain: CronConnectionChainReport;
    entries: CronConnectionBudgetEntryForCheck[];
  } {
    const chainEntries = jobs
      .map((job) => resolveEntry(scheduleKey, job))
      .filter((entry): entry is CronConnectionBudgetEntryForCheck => entry != null);
    return {
      chain: {
        chainKey,
        jobs: chainEntries.map(formatJob),
        peak: chainEntries.reduce((peak, job) => Math.max(peak, job.maxConnections), 0),
      },
      entries: chainEntries,
    };
  }

  for (const [scheduleKey, plan] of Object.entries(slotPlans)) {
    const chainResults = plan.jobChains.map((chain, index) =>
      evaluateChain(scheduleKey, `chain-${index + 1}`, chain),
    );
    const budgetOnlyResult = plan.budgetOnlyJobs && plan.budgetOnlyJobs.length > 0
      ? evaluateChain(scheduleKey, "budget-only", plan.budgetOnlyJobs)
      : null;
    const jobs = [
      ...chainResults.flatMap((result) => result.entries),
      ...(budgetOnlyResult?.entries ?? []),
    ];
    const groups = new Map<string, CronConnectionGroupReport>();
    for (const job of jobs) {
      const groupKey = job.connectionGroup ?? job.job;
      const group = groups.get(groupKey) ?? { peak: 0, jobs: [] };
      group.peak = Math.max(group.peak, job.maxConnections);
      group.jobs.push(formatJob(job));
      groups.set(groupKey, group);
    }
    const chains = chainResults.map((result) => result.chain);
    const budgetOnlyChain = budgetOnlyResult?.chain ?? null;
    const parallelConnections = chains.reduce((sum, chain) => sum + chain.peak, 0);
    const totalConnections = Math.max(parallelConnections, budgetOnlyChain?.peak ?? 0);
    const triggerReport = {
      budgetOnlyChain,
      chains,
      groups,
      jobs,
      parallelConnections,
      scheduleKey,
      totalConnections,
    };
    triggerReports.push(triggerReport);

    if (totalConnections >= budget.failAt) {
      failed = true;
    } else if (totalConnections >= budget.fullForNewFetchHeavyWorkAt) {
      headroomFullTriggers.push(triggerReport);
    }
  }

  return {
    budget,
    budgetOnlyCount: entries.filter((entry) => !entry.statusTracked).length,
    failed: failed || missingBudgetJobs.length > 0,
    headroomFullTriggers,
    missingBudgetJobs,
    missingBudgetScheduleKeys,
    triggerReports,
  };
}

export function printReport(report: CronConnectionBudgetReport): void {
  const { budget } = report;
  if (report.missingBudgetScheduleKeys.length > 0) {
    console.error(
      `FAIL: ${pluralize(report.missingBudgetScheduleKeys.length, "cron schedule")} missing from SCHEDULED_SLOT_PLANS: ${report.missingBudgetScheduleKeys.join(", ")}`,
    );
  }

  if (report.missingBudgetJobs.length > 0) {
    console.error(
      `FAIL: ${pluralize(report.missingBudgetJobs.length, "scheduled job")} missing from CRON_CONNECTION_BUDGET_ENTRIES: ${report.missingBudgetJobs.join(", ")}`,
    );
  }

  for (const trigger of report.triggerReports) {
    if (trigger.totalConnections >= budget.failAt) {
      console.error(
        `FAIL: Trigger "${trigger.scheduleKey}" uses ${trigger.totalConnections}/${budget.maxPerTrigger} connections:`,
      );
      for (const chain of trigger.chains) {
        console.error(`  - ${chain.chainKey}: ${chain.peak} connections (${chain.jobs.join(" -> ")})`);
      }
      if (trigger.budgetOnlyChain) {
        console.error(
          `  - ${trigger.budgetOnlyChain.chainKey}: ${trigger.budgetOnlyChain.peak} connections (${trigger.budgetOnlyChain.jobs.join(" -> ")})`,
        );
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
      `\nConnection headroom policy: ${budget.fullForNewFetchHeavyWorkAt}/${budget.maxPerTrigger} connections is full for new fetch-heavy work.`,
    );
    for (const trigger of report.headroomFullTriggers) {
      console.log(`  - ${trigger.scheduleKey}: ${trigger.totalConnections}/${budget.maxPerTrigger}`);
      for (const chain of trigger.chains) {
        console.log(`    * ${chain.chainKey}: ${pluralize(chain.peak, "connection")} (${chain.jobs.join(" -> ")})`);
      }
      if (trigger.budgetOnlyChain) {
        console.log(
          `    * ${trigger.budgetOnlyChain.chainKey}: ${pluralize(trigger.budgetOnlyChain.peak, "connection")} (${trigger.budgetOnlyChain.jobs.join(" -> ")})`,
        );
      }
    }
  }

  console.log(
    `\nAll ${report.triggerReports.length} triggers within connection budget (${pluralize(report.budgetOnlyCount, "budget-only entry")} included).`,
  );
}

function isMainModule(): boolean {
  return isDirectRun(import.meta.url, process.argv[1]);
}

if (isMainModule()) {
  const report = evaluateCronConnectionBudget();
  printReport(report);
  if (report.failed) {
    process.exit(1);
  }
}
