/**
 * DEWS / PSI trigger (26,56 * * * *):
 *   compute-dews (0) → stability-index (0)
 *
 * This DB-only lane intentionally runs outside the DEX-liquidity invocation.
 * If DEX scoring exceeds the platform CPU budget, DEWS and PSI still publish
 * from the last available liquidity snapshot instead of aging into status
 * degradation.
 */
import { computeAndStoreDEWS } from "../../cron/compute-dews";
import { computeAndStoreStabilityIndex } from "../../cron/stability-index";
import type { ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

export async function runDewsPsiSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runBestEffortScheduledJob(runtime, "dews-psi slot", "compute-dews", (signal) =>
    computeAndStoreDEWS(runtime.db, signal),
  );
  await runBestEffortScheduledJob(runtime, "dews-psi slot", "stability-index", (signal) =>
    computeAndStoreStabilityIndex(runtime.db, signal),
  );
}
