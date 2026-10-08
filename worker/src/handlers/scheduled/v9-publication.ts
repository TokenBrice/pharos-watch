import { runV9AfterCoreWithinWindow, V9_EXECUTION_WINDOW_POLICY } from "../../lib/v9-slot-window";
import type { ScheduledRuntimeContext } from "./context";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";



export function buildV9PublicationSlotGroups(
  runtime: ScheduledRuntimeContext,
) {
  return bindScheduledSlotPlan("v9PublicationOffset", {
    mode: "serial",
    label: "v9-publication",
    implementations: {
      "compute-safety-score-v9": (signal, reportProgress) =>
        runV9AfterCoreWithinWindow(
          {
            db: runtime.db,
            scheduledTimeMs: runtime.scheduledTimeMs,
            slotStartedAt: runtime.slotStartedAt,
            workerVersion: runtime.workerVersion ?? null,
            signal,
            ...V9_EXECUTION_WINDOW_POLICY.publication,
            lane: "compute-safety-score-v9",
            currentSlotKey: runtime.scheduleKey,
          },
          (windowSignal, executionWindow) =>
            import("../../cron/compute-safety-score-v9").then(
              ({ computeSafetyScoreV9 }) =>
                computeSafetyScoreV9(
                  runtime.db,
                  windowSignal,
                  reportProgress,
                  { workerMetadata: runtime.env.CF_VERSION_METADATA, executionWindow },
                ),
            ),
        ),
    },
  });
}


export async function runV9PublicationSlot(
  runtime: ScheduledRuntimeContext,
) {
  const result = await runScheduledSlotGroups(
    runtime,
    "fenced V9 publication slot",
    buildV9PublicationSlotGroups(runtime),
  );
  return result;
}
