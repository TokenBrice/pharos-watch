/**
 * DEWS / PSI trigger (26,56 * * * *):
 *   compute-dews (0) → stability-index (0) → project-tape (0)
 *
 * This DB-only lane intentionally runs outside the DEX-liquidity invocation.
 * If DEX scoring exceeds the platform CPU budget, DEWS and PSI still publish
 * from the last available liquidity snapshot instead of aging into status
 * degradation. The tape projector piggy-backs on the same lane because it is
 * purely D1-bound (zero outbound connections).
 */
import { computeAndStoreDEWS } from "../../cron/compute-dews";
import { computeAndStoreStabilityIndex } from "../../cron/stability-index";
import { projectTape } from "../../cron/project-tape";
import type { ScheduledRuntimeContext } from "./context";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";

export function buildDewsPsiSlotGroups(runtime: ScheduledRuntimeContext) {
  return bindScheduledSlotPlan("dewsPsiOffset", {
    mode: "serial",
    label: "dews-psi-tape",
    implementations: {
      "compute-dews": (signal, reportProgress) => computeAndStoreDEWS(runtime.db, signal, reportProgress),
      "stability-index": (signal) => computeAndStoreStabilityIndex(runtime.db, signal),
      "project-tape": (signal, reportProgress) => projectTape(runtime.db, signal, reportProgress),
    },
  });
}

export async function runDewsPsiSlot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, "dews-psi slot", buildDewsPsiSlotGroups(runtime));
}
