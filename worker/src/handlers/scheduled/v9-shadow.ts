import { runV9AfterCoreWithinWindow } from "../../lib/v9-slot-window";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

const V9_SHADOW_WINDOW_MS = 30_000;
const V9_SHADOW_MINIMUM_REMAINING_MS = 10_000;

export async function runV9ShadowSlot(
  runtime: ScheduledRuntimeContext,
) {
  return runSingleScheduledJob(
    runtime,
    "fenced V9 shadow slot",
    {
      job: "compute-safety-score-v9-shadow",
      run: (signal, reportProgress) =>
        runV9AfterCoreWithinWindow(
          {
            db: runtime.db,
            scheduledTimeMs: runtime.scheduledTimeMs,
            slotStartedAt: runtime.slotStartedAt,
            workerVersion: runtime.workerVersion ?? null,
            signal,
            deadlineOffsetMs: V9_SHADOW_WINDOW_MS,
            minimumRemainingMs:
              V9_SHADOW_MINIMUM_REMAINING_MS,
            lane: "compute-safety-score-v9-shadow",
            currentSlotKey: runtime.scheduleKey,
          },
          (windowSignal) =>
            import("../../cron/compute-safety-score-v9-shadow").then(
              ({ computeSafetyScoreV9Shadow }) =>
                computeSafetyScoreV9Shadow(
                  runtime.db,
                  windowSignal,
                  reportProgress,
                ),
            ),
        ),
    },
  );
}
