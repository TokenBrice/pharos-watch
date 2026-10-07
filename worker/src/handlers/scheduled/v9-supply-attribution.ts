import { runV9AfterCoreWithinWindow, V9_EXECUTION_WINDOW_POLICY } from "../../lib/v9-slot-window";
import type { ScheduledRuntimeContext } from "./context";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";


export function buildV9SupplyAttributionSlotGroups(runtime: ScheduledRuntimeContext) {
  return bindScheduledSlotPlan("v9SupplyAttributionOffset", {
    mode: "serial",
    label: "v9-supply-attribution",
    implementations: {
      "sync-v9-supply-attribution": (signal) =>
        runV9AfterCoreWithinWindow(
          {
            db: runtime.db,
            scheduledTimeMs: runtime.scheduledTimeMs,
            slotStartedAt: runtime.slotStartedAt,
            workerVersion: runtime.workerVersion ?? null,
            signal,
            ...V9_EXECUTION_WINDOW_POLICY.supplyAttribution,
            lane: "sync-v9-supply-attribution",
            currentSlotKey: runtime.scheduleKey,
          },
          (windowSignal, window) =>
            import("../../cron/sync-v9-supply-attribution").then(
              ({ syncSafetyScoreV9SupplyAttribution }) =>
                syncSafetyScoreV9SupplyAttribution(
                  runtime.db,
                  runtime.chainRpcs,
                  windowSignal,
                  window,
                ),
            ),
        ),
    },
  });
}

export async function runV9SupplyAttributionSlot(
  runtime: ScheduledRuntimeContext,
) {
  return runScheduledSlotGroups(
    runtime,
    "fenced V9 supply-attribution slot",
    buildV9SupplyAttributionSlotGroups(runtime),
  );
}
