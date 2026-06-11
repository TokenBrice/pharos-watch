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
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";

function buildDewsPsiSlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "dews-psi-tape",
      tasks: [
        {
          job: "compute-dews",
          run: (signal, reportProgress) => computeAndStoreDEWS(runtime.db, signal, reportProgress),
        },
        {
          job: "stability-index",
          run: (signal) => computeAndStoreStabilityIndex(runtime.db, signal),
        },
        {
          job: "project-tape",
          run: (signal, reportProgress) => projectTape(runtime.db, signal, reportProgress),
        },
      ],
    },
  ];
}

export async function runDewsPsiSlot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, "dews-psi slot", buildDewsPsiSlotGroups(runtime));
}
