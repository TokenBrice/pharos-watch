/**
 * Half-hourly trigger (0,30 * * * *):
 *   sync-cl-exit-depth (3)
 *
 * Isolated score-bearing measured-execution lane. The lane's flat metadata
 * (including the durable `mxLedger*` evidence-ledger scalars, Liquidity Score
 * v6 Phase 0.4) is returned directly so producer history persists it.
 */
import { syncDexMeasuredExecution } from "../../cron/measured-execution/sync";
import type { CronResult } from "../../lib/cron-logger";
import { toErrorMessage } from "../../lib/error-utils";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

export async function settleMeasuredExecutionLane(name: string, run: Promise<CronResult>): Promise<CronResult> {
  try {
    return await run;
  } catch (error) {
    return {
      status: "error",
      itemCount: 0,
      metadata: JSON.stringify({ lane: name, error: toErrorMessage(error).slice(0, 500) }),
      productivity: { productive: false, reason: `${name}-measured-execution-failed` },
    };
  }
}

export async function runHalfHourlyMeasuredExecutionSlot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "half-hour measured execution slot", {
    job: "sync-cl-exit-depth",
    run: (signal, reportProgress) =>
      settleMeasuredExecutionLane(
        "evm",
        syncDexMeasuredExecution(runtime.db, runtime.chainRpcs, signal, reportProgress),
      ),
  });
}
