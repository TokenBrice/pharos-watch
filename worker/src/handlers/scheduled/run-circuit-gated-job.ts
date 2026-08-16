import {
  mapCronStatusToCircuitOutcome,
  recordOutcomeDecision,
  shouldAttemptFetch,
} from "../../lib/circuit-breaker";
import type { CronResult } from "../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "./context";
import { logSkippedCronRun } from "./preflight-skip";
import { logWorkerEvent } from "../../lib/structured-log";

interface CircuitGatedScheduledJobOptions {
  circuitSource: string;
  outcomeLabel: string;
  skipMessage: string;
  job: string;
  fn: Parameters<ScheduledRuntimeContext["runLeasedCron"]>[1];
}

export async function runCircuitGatedLeasedScheduledJob(
  runtime: ScheduledRuntimeContext,
  options: CircuitGatedScheduledJobOptions,
): Promise<CronResult | null> {
  const allowed = await shouldAttemptFetch(runtime.db, options.circuitSource);
  if (!allowed) {
    logWorkerEvent({ scope: "handler", level: "warn", event: "scheduled_job_circuit_open", message: options.skipMessage, job: options.job, provider: options.circuitSource });
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
      logWorkerEvent({ scope: "handler", level: "error", event: "scheduled_job_circuit_success_write_failed", message: `Failed to record ${options.outcomeLabel} success outcome`, job: options.job, provider: options.circuitSource, error: err });
    });
    return result ?? null;
  } catch (err) {
    await recordOutcomeDecision(runtime.db, options.circuitSource, "failure").catch((outcomeErr) => {
      logWorkerEvent({ scope: "handler", level: "error", event: "scheduled_job_circuit_failure_write_failed", message: `Failed to record ${options.outcomeLabel} failure outcome`, job: options.job, provider: options.circuitSource, error: outcomeErr });
    });
    throw err;
  }
}
