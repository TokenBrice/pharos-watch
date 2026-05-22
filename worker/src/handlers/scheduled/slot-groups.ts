import type { CronResult } from "../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

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
}

export interface ScheduledSlotTaskChain {
  label: string;
  tasks: readonly ScheduledSlotTask[];
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
): Promise<CronResult | null> {
  return runBestEffortScheduledJob(runtime, slotLabel, task.job, task.run, {
    errorMessage: task.errorMessage,
  });
}

async function runSerialScheduledJobs(
  runtime: ScheduledRuntimeContext,
  slotLabel: string,
  tasks: readonly ScheduledSlotTask[],
): Promise<void> {
  for (const task of tasks) {
    await runSingleScheduledJob(runtime, slotLabel, task);
  }
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
): Promise<void> {
  for (const group of groups) {
    if (group.mode === "parallel-serial") {
      await Promise.all(
        group.chains.map((chain) => runSerialScheduledJobs(runtime, slotLabel, chain.tasks)),
      );
      continue;
    }

    if (group.mode === "parallel") {
      await Promise.all(group.tasks.map((task) => runSingleScheduledJob(runtime, slotLabel, task)));
      continue;
    }

    await runSerialScheduledJobs(runtime, slotLabel, group.tasks);
  }
}
