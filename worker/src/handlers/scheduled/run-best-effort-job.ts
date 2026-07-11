import type { CronResult } from "../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "./context";
import {
  summarizeCronResult,
  summarizeThrownScheduledJob,
  type ScheduledSlotJobSummary,
} from "./slot-summary";
import { isReserveRecoveryFaultInjectionTermination } from "../../lib/reserve-recovery-fault-injection";

interface RunBestEffortScheduledJobOptions {
  errorMessage?: string;
}

export interface BestEffortScheduledJobOutcome {
  job: string;
  result: CronResult | null;
  summary: ScheduledSlotJobSummary;
}

export async function runBestEffortScheduledJobWithOutcome(
  runtime: ScheduledRuntimeContext,
  slotLabel: string,
  job: string,
  fn: Parameters<ScheduledRuntimeContext["runLeasedCron"]>[1],
  options: RunBestEffortScheduledJobOptions = {},
): Promise<BestEffortScheduledJobOutcome> {
  try {
    const result = (await runtime.runLeasedCron(job, fn)) ?? null;
    return {
      job,
      result,
      summary: summarizeCronResult(job, result),
    };
  } catch (err) {
    if (isReserveRecoveryFaultInjectionTermination(err)) throw err;
    console.error(options.errorMessage ?? `[cron] ${job} failed in ${slotLabel}:`, err);
    return {
      job,
      result: null,
      summary: summarizeThrownScheduledJob(job, err),
    };
  }
}
