import {
  mapCronStatusToCircuitOutcome,
  recordOutcomeDecision,
  shouldAttemptFetch,
} from "../../lib/circuit-breaker";
import type { CronResult } from "../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "./context";
import { logSkippedCronRun } from "./preflight-skip";

interface CircuitGatedScheduledJobOptions {
  circuitSource: string;
  outcomeLabel: string;
  skipMessage: string;
  job: string;
  fn: Parameters<ScheduledRuntimeContext["runLeasedCron"]>[1];
  /** @deprecated Keep follow-up publication inside `fn` so it shares job ownership. */
  onSettledSuccess?: (runtime: ScheduledRuntimeContext, result: CronResult | void) => Promise<void>;
}

export async function runCircuitGatedLeasedScheduledJob(
  runtime: ScheduledRuntimeContext,
  options: CircuitGatedScheduledJobOptions,
): Promise<CronResult | null> {
  const allowed = await shouldAttemptFetch(runtime.db, options.circuitSource);
  if (!allowed) {
    console.warn(options.skipMessage);
    await logSkippedCronRun(runtime, {
      job: options.job,
      reason: "circuit-open",
      message: options.skipMessage,
      metadata: {
        circuitSource: options.circuitSource,
      },
    });
    return null;
  }

  try {
    const result = await runtime.runLeasedCron(options.job, options.fn);
    await recordOutcomeDecision(
      runtime.db,
      options.circuitSource,
      mapCronStatusToCircuitOutcome(result?.status),
    ).catch((err) => {
      console.error(`[cron] Failed to record ${options.outcomeLabel} success outcome:`, err);
    });
    if (options.onSettledSuccess) {
      await options.onSettledSuccess(runtime, result);
    }
    return result ?? null;
  } catch (err) {
    await recordOutcomeDecision(runtime.db, options.circuitSource, "failure").catch((outcomeErr) => {
      console.error(`[cron] Failed to record ${options.outcomeLabel} failure outcome:`, outcomeErr);
    });
    throw err;
  }
}
