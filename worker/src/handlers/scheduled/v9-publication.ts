import { runV9AfterCoreWithinWindow } from "../../lib/v9-slot-window";
import { logWorkerEvent } from "../../lib/structured-log";
import { parseObjectMetadata } from "../../lib/json-metadata";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

// The publication runner has its own two-minute end-to-end timeout. Give that
// controlled timeout room to settle while v9-slot-window still clamps the
// outer memory lane to the next quarter-hour boundary.
const V9_PUBLICATION_WINDOW_MS = 3 * 60_000;
const V9_PUBLICATION_MINIMUM_REMAINING_MS = 10_000;

export function safetyScoreV9WorkflowInstanceId(
  slotStartedAt: number,
): string {
  return `v9-publication-${slotStartedAt}`;
}

async function triggerSafetyScoreV9ShadowWorkflow(
  runtime: ScheduledRuntimeContext,
): Promise<void> {
  const id = safetyScoreV9WorkflowInstanceId(runtime.slotStartedAt);
  const workflow = (
    runtime.env as typeof runtime.env & {
      SAFETY_SCORE_V9_WORKFLOW: Workflow;
    }
  ).SAFETY_SCORE_V9_WORKFLOW;
  try {
    // `params` is the documented input channel. The instance id carries the
    // same slot for human/idempotency use, but the Workflow must not depend on
    // reading its own id back out of the runtime event.
    await workflow.create({ id, params: { slotStartedAt: runtime.slotStartedAt } });
  } catch (error) {
    try {
      const existing = await workflow.get(id);
      const status = await existing.status();
      if (status.status !== "unknown") return;
    } catch {
      // The structured warning below owns non-authoritative trigger failures.
    }
    logWorkerEvent({
      scope: "handler",
      level: "warn",
      event: "safety_score_v9_shadow_workflow_trigger_failed",
      job: "compute-safety-score-v9-workflow",
      message: "Safety Score V9 shadow Workflow could not be created",
      error,
      metadata: {
        instanceId: id,
        slotStartedAt: runtime.slotStartedAt,
        errorName: error instanceof Error ? error.name : "Error",
      },
    });
  }
}

export async function runV9PublicationSlot(
  runtime: ScheduledRuntimeContext,
) {
  let hasCompilerIdentity = false;
  const result = await runSingleScheduledJob(
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
              async ({ computeSafetyScoreV9 }) => {
                const compiled = await computeSafetyScoreV9(
                  runtime.db,
                  windowSignal,
                  reportProgress,
                );
                const metadata = parseObjectMetadata(compiled.metadata);
                hasCompilerIdentity =
                  typeof metadata?.sourceGenerationId === "string" &&
                  typeof metadata.baseInputGenerationId === "string";
                return compiled;
              },
            ),
        ),
    },
  );
  if (
    hasCompilerIdentity &&
    result.jobsSucceeded + result.jobsDegraded > 0 &&
    runtime.env.WORKER_V9_WORKFLOW_MODE === "shadow"
  ) {
    await triggerSafetyScoreV9ShadowWorkflow(runtime);
  }
  return result;
}
