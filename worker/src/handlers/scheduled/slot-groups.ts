import type { CronResult } from "../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

export type ScheduledSlotGroupMode = "serial" | "parallel";
export type ScheduledSlotTaskKind = "job" | "db-only-sidecar";

export interface ScheduledSlotTask {
  job: string;
  kind?: ScheduledSlotTaskKind;
  errorMessage?: string;
  run: Parameters<ScheduledRuntimeContext["runLeasedCron"]>[1];
}

export interface ScheduledSlotGroup {
  mode: ScheduledSlotGroupMode;
  label: string;
  tasks: readonly ScheduledSlotTask[];
}

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

export async function runScheduledSlotGroups(
  runtime: ScheduledRuntimeContext,
  slotLabel: string,
  groups: readonly ScheduledSlotGroup[],
): Promise<void> {
  for (const group of groups) {
    if (group.mode === "parallel") {
      await Promise.all(group.tasks.map((task) => runSingleScheduledJob(runtime, slotLabel, task)));
      continue;
    }

    await runSerialScheduledJobs(runtime, slotLabel, group.tasks);
  }
}
