import type { CronResult } from "../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "./context";

export async function runBestEffortScheduledJob(
  runtime: ScheduledRuntimeContext,
  slotLabel: string,
  job: string,
  fn: Parameters<ScheduledRuntimeContext["runLeasedCron"]>[1],
): Promise<CronResult | null> {
  try {
    return (await runtime.runLeasedCron(job, fn)) ?? null;
  } catch (err) {
    console.error(`[cron] ${job} failed in ${slotLabel}:`, err);
    return null;
  }
}
