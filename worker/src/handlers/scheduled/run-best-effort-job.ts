import type { CronResult } from "../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "./context";

interface RunBestEffortScheduledJobOptions {
  errorMessage?: string;
}

export async function runBestEffortScheduledJob(
  runtime: ScheduledRuntimeContext,
  slotLabel: string,
  job: string,
  fn: Parameters<ScheduledRuntimeContext["runLeasedCron"]>[1],
  options: RunBestEffortScheduledJobOptions = {},
): Promise<CronResult | null> {
  try {
    return (await runtime.runLeasedCron(job, fn)) ?? null;
  } catch (err) {
    console.error(options.errorMessage ?? `[cron] ${job} failed in ${slotLabel}:`, err);
    return null;
  }
}
