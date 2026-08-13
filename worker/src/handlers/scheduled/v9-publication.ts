import { runV9AfterCoreWithinWindow } from "../../lib/v9-slot-window";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

// The publication runner has its own two-minute end-to-end timeout. Give that
// controlled timeout room to settle while v9-slot-window still clamps the
// outer memory lane to the next quarter-hour boundary.
const V9_PUBLICATION_WINDOW_MS = 3 * 60_000;
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
