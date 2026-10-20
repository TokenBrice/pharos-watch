import type { ScheduledRuntimeContext } from "./context";
import {
  flattenScheduledSlotPlanJobs,
  SCHEDULED_SLOT_PLANS,
} from "@shared/lib/scheduled-runner-registry";
import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import {
  runBestEffortScheduledJobWithOutcome,
  type BestEffortScheduledJobOutcome,
} from "./run-best-effort-job";
import {
  buildScheduledSlotSummary,
  summarizeSkippedScheduledJob,
  type ScheduledSlotJobSummary,
  type ScheduledSlotSummary,
} from "./slot-summary";
import { logSkippedCronRun } from "./preflight-skip";

export interface ScheduledSlotTask {
  job: string;
  errorMessage?: string;
  run: Parameters<ScheduledRuntimeContext["runLeasedCron"]>[1];
}

export interface ScheduledSlotTaskChain {
  label: string;
  tasks: readonly ScheduledSlotTask[];
  stopOnFailure?: boolean;
  stopOnNonNeutralSkip?: boolean;
}

interface ScheduledSlotPlanBindingOptions {
  implementations: Readonly<Record<string, ScheduledSlotTask["run"]>>;
  chainLabels?: readonly string[];
  stopOnFailure?: boolean;
  stopOnNonNeutralSkip?: boolean;
}

export function bindScheduledSlotPlan(
  scheduleKey: CronScheduleKey,
  options: ScheduledSlotPlanBindingOptions,
): ScheduledSlotTaskChain[][] {
  const plan = SCHEDULED_SLOT_PLANS[scheduleKey];
  const chains = plan.jobChains.map((jobs, chainIndex) => ({
    label: options.chainLabels?.[chainIndex] ?? jobs.join(" → "),
    tasks: jobs.map((job) => {
      const run = options.implementations[job];
      if (!run) throw new Error(`Missing scheduled implementation for ${scheduleKey}/${job}`);
      return { job, run };
    }),
    stopOnFailure: options.stopOnFailure,
    stopOnNonNeutralSkip: options.stopOnNonNeutralSkip,
  }));

  return [chains];
}

/**
 * Runs a slot whose plan is a single one-job chain. The plan check is the
 * single-job counterpart of `bindScheduledSlotPlan`: without it, adding a job
 * to such a chain compiles and silently never runs.
 */
export async function runSingleScheduledJob(
  runtime: ScheduledRuntimeContext,
  slotLabel: string,
  task: ScheduledSlotTask,
): Promise<ScheduledSlotSummary> {
  const plannedJobs = flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS[runtime.scheduleKey]);
  if (plannedJobs.length !== 1 || plannedJobs[0] !== task.job) {
    throw new Error(
      `Scheduled slot ${runtime.scheduleKey} plans [${plannedJobs.join(", ")}] but runs only ${task.job}`,
    );
  }
  const outcome = await runSingleScheduledJobWithOutcome(runtime, slotLabel, task);
  return buildScheduledSlotSummary([outcome.summary]);
}

async function runSingleScheduledJobWithOutcome(
  runtime: ScheduledRuntimeContext,
  slotLabel: string,
  task: ScheduledSlotTask,
): Promise<BestEffortScheduledJobOutcome> {
  return runBestEffortScheduledJobWithOutcome(runtime, slotLabel, task.job, task.run, {
    errorMessage: task.errorMessage,
  });
}

async function runSerialScheduledJobs(
  runtime: ScheduledRuntimeContext,
  slotLabel: string,
  tasks: readonly ScheduledSlotTask[],
  options: { stopOnFailure?: boolean; stopOnNonNeutralSkip?: boolean } = {},
): Promise<ScheduledSlotJobSummary[]> {
  const outcomes: ScheduledSlotJobSummary[] = [];
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index];
    const summary = (await runSingleScheduledJobWithOutcome(runtime, slotLabel, task)).summary;
    outcomes.push(summary);
    const terminalChainFailure = options.stopOnFailure && summary.outcome === "error";
    const terminalChainSkip =
      options.stopOnNonNeutralSkip
      && summary.outcome === "skipped"
      && summary.neutral !== true;
    if (terminalChainFailure || terminalChainSkip) {
      const skippedTasks = tasks.slice(index + 1);
      const reason = terminalChainFailure
        ? `upstream-failure:${task.job}`
        : `upstream-blocked:${task.job}`;
      for (const skippedTask of skippedTasks) {
        await logSkippedCronRun(runtime, {
          job: skippedTask.job,
          reason,
          message: `${skippedTask.job} did not start because ${task.job} did not complete`,
          metadata: { childDisposition: "not_started" },
        });
      }
      outcomes.push(
        ...skippedTasks.map((skippedTask) =>
          summarizeSkippedScheduledJob(skippedTask.job, reason),
        ),
      );
      break;
    }
  }
  return outcomes;
}

/**
 * Stages run in order; each stage runs its serial chains concurrently.
 */
export async function runScheduledSlotGroups(
  runtime: ScheduledRuntimeContext,
  slotLabel: string,
  stages: readonly (readonly ScheduledSlotTaskChain[])[],
): Promise<ScheduledSlotSummary> {
  const outcomes: ScheduledSlotJobSummary[] = [];
  for (const chains of stages) {
    const chainOutcomes = await Promise.all(
      chains.map((chain) =>
        runSerialScheduledJobs(runtime, slotLabel, chain.tasks, {
          stopOnFailure: chain.stopOnFailure,
          stopOnNonNeutralSkip: chain.stopOnNonNeutralSkip,
        }),
      ),
    );
    outcomes.push(...chainOutcomes.flat());
  }
  return buildScheduledSlotSummary(outcomes);
}
