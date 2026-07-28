import { runV9AfterCoreWithinWindow } from "../../lib/v9-slot-window";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

const V9_PUBLICATION_WINDOW_MS = 60_000;
const V9_PUBLICATION_MINIMUM_REMAINING_MS = 10_000;

export async function runV9PublicationSlot(
  runtime: ScheduledRuntimeContext,
) {
  return runSingleScheduledJob(
    runtime,
    "fenced V9 publication slot",
    {
      job: "compute-safety-score-v9",
      run: (signal, reportProgress) =>
        runV9AfterCoreWithinWindow(
          {
            db: runtime.db,
            scheduledTimeMs: runtime.scheduledTimeMs,
            slotStartedAt: runtime.slotStartedAt,
            workerVersion: runtime.workerVersion ?? null,
            signal,
            deadlineOffsetMs: V9_PUBLICATION_WINDOW_MS,
            minimumRemainingMs:
              V9_PUBLICATION_MINIMUM_REMAINING_MS,
            lane: "compute-safety-score-v9",
            currentSlotKey: runtime.scheduleKey,
          },
          (windowSignal) =>
            import("../../cron/compute-safety-score-v9").then(
              ({ computeSafetyScoreV9 }) =>
                computeSafetyScoreV9(
                  runtime.db,
                  windowSignal,
                  reportProgress,
                ),
            ),
        ),
    },
  );
}
