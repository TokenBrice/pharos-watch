import { isV9PublicationSecondChanceTrigger } from "@shared/lib/cron-jobs";
import type { V9ContinuationMessage } from "@shared/types/v9-continuation";
import { runV9AfterCoreWithinWindow, V9_EXECUTION_WINDOW_POLICY } from "../../lib/v9-slot-window";
import type { ScheduledRuntimeContext } from "./context";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";

export function buildV9PublicationSlotGroups(
  runtime: ScheduledRuntimeContext,
  onContinuation?: (message: V9ContinuationMessage) => void,
) {
  const isSecondChance = isV9PublicationSecondChanceTrigger(runtime.cron);
  const queueMode = runtime.env.WORKER_V9_QUEUE_MODE === "on" ? "on" as const : "off" as const;
  return bindScheduledSlotPlan("v9PublicationOffset", {
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
            v9PublicationSecondChance: isSecondChance,
            onV9PublicationAlreadyAccepted: async (windowSignal, executionWindow) => {
              const { recoverSafetyScoreV9PublicMaterialization } = await import(
                "../../lib/safety-score-v9/publication-materialization"
              );
              const recovered = await recoverSafetyScoreV9PublicMaterialization(
                runtime.db,
                windowSignal,
                executionWindow.deadlineMs,
              );
              if (queueMode === "on" && (recovered.status === "ok" || recovered.status === "skipped_neutral")) {
                const parsedMeta = recovered.metadata ? (JSON.parse(recovered.metadata) as {
                  publicMaterialization?: { publicationGenerationId?: string | null } | null;
                }) : null;
                const genId = parsedMeta?.publicMaterialization?.publicationGenerationId ?? null;
                if (genId) {
                  const { completeActiveV9EvalRunsForAcceptedGeneration } = await import(
                    "../../lib/safety-score-v9/chunked-eval-store"
                  );
                  await completeActiveV9EvalRunsForAcceptedGeneration(
                    runtime.db,
                    genId,
                    Math.floor(Date.now() / 1_000),
                    windowSignal,
                  ).catch(() => undefined);
                }
              }
              return recovered;
            },
          },
          (windowSignal, executionWindow) =>
            import("../../cron/compute-safety-score-v9").then(
              ({ computeSafetyScoreV9 }) =>
                computeSafetyScoreV9(
                  runtime.db,
                  windowSignal,
                  reportProgress,
                  {
                    workerMetadata: runtime.env.CF_VERSION_METADATA,
                    executionWindow,
                    captureArchiveBucket: runtime.env.SAFETY_CAPTURE_ARCHIVE,
                    captureArchiveContext: runtime.ctx,
                    // Phase 2 of the persist split; only literal "on" defers.
                    deferPublicMaterialization: runtime.env.SAFETY_V9_DEFERRED_MATERIALIZATION === "on",
                    ...(queueMode === "on"
                      ? {
                          queueMode,
                          isSecondChance,
                          slotStartedAt: runtime.slotStartedAt,
                          sourceInvocationId: runtime.invocationId,
                          onContinuation,
                        }
                      : {}),
                  },
                ),
            ),
        ),
    },
  });
}

export async function runV9PublicationSlot(
  runtime: ScheduledRuntimeContext,
) {
  let pendingV9Continuation: V9ContinuationMessage | undefined;
  const result = await runScheduledSlotGroups(
    runtime,
    "fenced V9 publication slot",
    buildV9PublicationSlotGroups(runtime, (message) => {
      pendingV9Continuation = message;
    }),
  );
  if (pendingV9Continuation) {
    return { ...result, v9Continuation: pendingV9Continuation };
  }
  return result;
}
