import { runV9AfterCoreWithinWindow } from "../../lib/v9-slot-window";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups } from "./slot-groups";

const V9_SUPPLY_WINDOW_MS = 3 * 60_000;
const V9_SUPPLY_MINIMUM_REMAINING_MS = 60_000;

export async function runV9SupplyAttributionSlot(
  runtime: ScheduledRuntimeContext,
) {
  return runScheduledSlotGroups(runtime, "fenced V9 supply-attribution slot", [
    {
      mode: "serial",
      label: "v9-supply-attribution",
      tasks: [
        {
          job: "sync-v9-supply-attribution",
          run: (signal) =>
            runV9AfterCoreWithinWindow(
              {
                db: runtime.db,
                scheduledTimeMs: runtime.scheduledTimeMs,
                slotStartedAt: runtime.slotStartedAt,
                workerVersion: runtime.workerVersion ?? null,
                signal,
                deadlineOffsetMs: V9_SUPPLY_WINDOW_MS,
                minimumRemainingMs:
                  V9_SUPPLY_MINIMUM_REMAINING_MS,
                lane: "sync-v9-supply-attribution",
                currentSlotKey: runtime.scheduleKey,
              },
              (windowSignal) =>
                import("../../cron/sync-v9-supply-attribution").then(
                  ({ syncSafetyScoreV9SupplyAttribution }) =>
                    syncSafetyScoreV9SupplyAttribution(
                      runtime.db,
                      runtime.chainRpcs,
                      windowSignal,
                    ),
                ),
            ),
        },
      ],
    },
  ]);
}
