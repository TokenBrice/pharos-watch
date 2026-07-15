/**
 * Half-hourly trigger (0,30 * * * *):
 *   sync-cl-exit-depth (3)
 *
 * Isolated measured-execution lane. Up to three chain lanes run concurrently;
 * each lane serializes its RPC requests under the producer's hard request and
 * runtime budgets.
 */
import { syncDexMeasuredExecution } from "../../cron/measured-execution/sync";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

export async function runHalfHourlyMeasuredExecutionSlot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "half-hour measured execution slot", {
    job: "sync-cl-exit-depth",
    run: (signal, reportProgress) => syncDexMeasuredExecution(runtime.db, runtime.chainRpcs, signal, reportProgress),
  });
}
