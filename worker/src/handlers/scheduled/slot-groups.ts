import type { ScheduledRuntimeContext } from "./context";
import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
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

export type ScheduledSlotGroupMode = "serial" | "parallel";

export interface ScheduledSlotTask {
  job: string;
  errorMessage?: string;
  run: Parameters<ScheduledRuntimeContext["runLeasedCron"]>[1];
}

export interface ScheduledSlotGroup {
  mode: ScheduledSlotGroupMode;
  label: string;
  tasks: readonly ScheduledSlotTask[];
  stopOnFailure?: boolean;
  stopOnNonNeutralSkip?: boolean;
}

export interface ScheduledSlotTaskChain {
  label: string;
  tasks: readonly ScheduledSlotTask[];
  stopOnFailure?: boolean;
  stopOnNonNeutralSkip?: boolean;
}

export interface ScheduledSlotParallelSerialGroup {
  mode: "parallel-serial";
  label: string;
  chains: readonly ScheduledSlotTaskChain[];
}

export type ScheduledSlotGroupDefinition = ScheduledSlotGroup | ScheduledSlotParallelSerialGroup;

interface ScheduledSlotPlanBindingOptions {
  mode: ScheduledSlotGroupMode | "parallel-serial";
  label: string;
  implementations: Readonly<Record<string, ScheduledSlotTask["run"]>>;
  chainLabels?: readonly string[];
  stopOnFailure?: boolean;
  stopOnNonNeutralSkip?: boolean;
}

export function bindScheduledSlotPlan(
  scheduleKey: CronScheduleKey,
  options: ScheduledSlotPlanBindingOptions,
): ScheduledSlotGroupDefinition[] {
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

  if (options.mode === "serial") {
    if (chains.length !== 1) {
      throw new Error(`Serial scheduled slot ${scheduleKey} must have exactly one canonical chain`);
    }
    const [chain] = chains;
    return [{
      mode: "serial",
      label: options.label,
      tasks: chain.tasks,
      stopOnFailure: chain.stopOnFailure,
      stopOnNonNeutralSkip: chain.stopOnNonNeutralSkip,
    }];
  }
  if (options.mode === "parallel-serial") {
    return [{ mode: "parallel-serial", label: options.label, chains }];
  }
  throw new Error(`Unsupported scheduled slot mode for ${scheduleKey}`);
}

export async function runSingleScheduledJob(
  runtime: ScheduledRuntimeContext,
  slotLabel: string,
  task: ScheduledSlotTask,
): Promise<ScheduledSlotSummary> {
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

export function flattenScheduledSlotGroupTasks(
  groups: readonly ScheduledSlotGroupDefinition[],
): ScheduledSlotTask[] {
  return groups.flatMap((group) => (
    group.mode === "parallel-serial"
      ? group.chains.flatMap((chain) => [...chain.tasks])
      : [...group.tasks]
  ));
}

export async function runScheduledSlotGroups(
  runtime: ScheduledRuntimeContext,
  slotLabel: string,
  groups: readonly ScheduledSlotGroupDefinition[],
): Promise<ScheduledSlotSummary> {
  const outcomes: ScheduledSlotJobSummary[] = [];
  for (const group of groups) {
    if (group.mode === "parallel-serial") {
      const chainOutcomes = await Promise.all(
        group.chains.map((chain) =>
          runSerialScheduledJobs(runtime, slotLabel, chain.tasks, {
            stopOnFailure: chain.stopOnFailure,
            stopOnNonNeutralSkip: chain.stopOnNonNeutralSkip,
          }),
        ),
      );
      outcomes.push(...chainOutcomes.flat());
      continue;
    }

    if (group.mode === "parallel") {
      const taskOutcomes = await Promise.all(
        group.tasks.map((task) => runSingleScheduledJobWithOutcome(runtime, slotLabel, task)),
      );
      outcomes.push(...taskOutcomes.map((outcome) => outcome.summary));
      continue;
    }

    outcomes.push(...(await runSerialScheduledJobs(runtime, slotLabel, group.tasks, {
      stopOnFailure: group.stopOnFailure,
      stopOnNonNeutralSkip: group.stopOnNonNeutralSkip,
    })));
  }
  return buildScheduledSlotSummary(outcomes);
}
