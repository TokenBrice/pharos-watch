/**
 * DEWS / PSI trigger (26,56 * * * *):
 *   compute-dews (0) -> stability-index (0) -> project-tape (1 placed fetch, 0 rollback)
 *
 * This DB-only lane intentionally runs outside the DEX-liquidity invocation.
 * If DEX scoring exceeds the platform CPU budget, DEWS and PSI still publish
 * from the last available liquidity snapshot instead of aging into status
 * degradation. Only project-tape can use the private placed fetch executor;
 * its driver reserves one connection even though the projector is D1-only.
 */
import { computeAndStoreDEWS } from "../../lib/dews/service";
import { computeAndStoreStabilityIndex } from "../../cron/stability-index";
import { runProjectTapeCanary } from "./placed-executor";
import type { ScheduledRuntimeContext } from "./context";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";

export function buildDewsPsiSlotGroups(runtime: ScheduledRuntimeContext) {
  return bindScheduledSlotPlan("dewsPsiOffset", {
    mode: "serial",
    label: "dews-psi-tape",
    implementations: {
      "compute-dews": (signal, reportProgress) => computeAndStoreDEWS(runtime.db, signal, reportProgress),
      "stability-index": (signal) => computeAndStoreStabilityIndex(runtime.db, signal),
      "project-tape": (signal, reportProgress) => runProjectTapeCanary(runtime, signal, reportProgress),
    },
  });
}

export async function runDewsPsiSlot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, "dews-psi slot", buildDewsPsiSlotGroups(runtime));
}
