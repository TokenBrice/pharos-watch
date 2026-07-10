import type { ScheduledRuntimeContext } from "./context";
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
}

export interface ScheduledSlotTaskChain {
  label: string;
  tasks: readonly ScheduledSlotTask[];
  stopOnFailure?: boolean;
}

export interface ScheduledSlotParallelSerialGroup {
  mode: "parallel-serial";
  label: string;
  chains: readonly ScheduledSlotTaskChain[];
}

export type ScheduledSlotGroupDefinition = ScheduledSlotGroup | ScheduledSlotParallelSerialGroup;

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
  options: { stopOnFailure?: boolean } = {},
): Promise<ScheduledSlotJobSummary[]> {
  const outcomes: ScheduledSlotJobSummary[] = [];
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index];
    const summary = (await runSingleScheduledJobWithOutcome(runtime, slotLabel, task)).summary;
    outcomes.push(summary);
    if (options.stopOnFailure && summary.outcome === "error") {
      const skippedTasks = tasks.slice(index + 1);
      for (const skippedTask of skippedTasks) {
        await logSkippedCronRun(runtime, {
          job: skippedTask.job,
          reason: `upstream-failure:${task.job}`,
          message: `${skippedTask.job} did not start because ${task.job} failed`,
        });
      }
      outcomes.push(
        ...skippedTasks.map((skippedTask) =>
          summarizeSkippedScheduledJob(skippedTask.job, `upstream-failure:${task.job}`),
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
    })));
  }
  return buildScheduledSlotSummary(outcomes);
}
