import { runV9AfterCoreWithinWindow } from "../../lib/v9-slot-window";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

const V9_SUPPLY_WINDOW_MS = 3 * 60_000;
const V9_SUPPLY_MINIMUM_REMAINING_MS = 60_000;

export async function runV9SupplyAttributionSlot(
  runtime: ScheduledRuntimeContext,
) {
  return runSingleScheduledJob(
    runtime,
    "fenced V9 supply-attribution slot",
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
  );
}
