import {
  SAFETY_SCORE_V9_WORKFLOW_JOB,
  recordSkippedSafetyScoreV9WorkflowRun,
  safetyScoreV9WorkflowInstanceId,
} from "../../workflows/safety-score-v9-publication";
import { runV9AfterCoreWithinWindow, V9_EXECUTION_WINDOW_POLICY } from "../../lib/v9-slot-window";
import { logWorkerEvent } from "../../lib/structured-log";
import { parseObjectMetadata } from "../../lib/json-metadata";
import type { CronResult } from "../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "./context";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";


async function triggerSafetyScoreV9ShadowWorkflow(
  runtime: ScheduledRuntimeContext,
): Promise<void> {
  const id = safetyScoreV9WorkflowInstanceId(runtime.slotStartedAt);
  const workflow = runtime.env.SAFETY_SCORE_V9_WORKFLOW;
  try {
    if (!workflow) throw new Error("safety-score-v9-workflow-binding-unavailable");
    // `params` is the documented input channel. The instance id carries the
    // same slot for human/idempotency use, but the Workflow must not depend on
    // reading its own id back out of the runtime event.
    await workflow.create({ id, params: { slotStartedAt: runtime.slotStartedAt } });
  } catch (error) {
    try {
      const existing = await workflow?.get(id);
      const status = await existing?.status();
      if (status && status.status !== "unknown") return;
    } catch {
      // The structured warning below owns non-authoritative trigger failures.
    }
    logWorkerEvent({
      scope: "handler",
      level: "warn",
      event: "safety_score_v9_shadow_workflow_trigger_failed",
      job: SAFETY_SCORE_V9_WORKFLOW_JOB,
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

export function buildV9PublicationSlotGroups(
  runtime: ScheduledRuntimeContext,
  recordComputeResult: (result: CronResult) => void = () => undefined,
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
              async ({ computeSafetyScoreV9 }) => {
                const compiled = await computeSafetyScoreV9(
                  runtime.db,
                  windowSignal,
                  reportProgress,
                  { workerMetadata: runtime.env.CF_VERSION_METADATA, executionWindow },
                );
                recordComputeResult(compiled);
                return compiled;
              },
            ),
        ),
    },
  });
}

/** Neutral-skip reasons that mean another invocation may still publish this slot. */
const WORKFLOW_UPSTREAM_STILL_IN_FLIGHT_REASONS = new Set([
  "v9-memory-lane-active",
  "v9-competing-slot-active",
]);

/**
 * When the shadow Workflow was not created because the compiler produced no
 * publication, record a neutral workflow row naming the upstream reason —
 * otherwise the job surfaces as bare `unavailable`. Slots where a competing
 * invocation still owns the lane stay silent: that invocation will write the
 * real terminal row for this slot.
 */
async function recordUpstreamAbsentWorkflowRun(
  runtime: ScheduledRuntimeContext,
  computeResult: CronResult,
): Promise<void> {
  const metadata = parseObjectMetadata(computeResult.metadata);
  const upstreamReason =
    typeof metadata?.reason === "string" ? metadata.reason : null;
  if (
    upstreamReason !== null &&
    WORKFLOW_UPSTREAM_STILL_IN_FLIGHT_REASONS.has(upstreamReason)
  ) {
    return;
  }
  try {
    await recordSkippedSafetyScoreV9WorkflowRun(
      runtime.db,
      safetyScoreV9WorkflowInstanceId(runtime.slotStartedAt),
      runtime.slotStartedAt,
      {
        status: computeResult.status ?? "ok",
        reason: upstreamReason,
        stage:
          typeof metadata?.stage === "string" ? metadata.stage : null,
      },
      runtime.workerVersion ?? null,
    );
  } catch (error) {
    logWorkerEvent({
      scope: "handler",
      level: "warn",
      event: "safety_score_v9_shadow_workflow_skip_row_failed",
      job: SAFETY_SCORE_V9_WORKFLOW_JOB,
      message: "Safety Score V9 shadow Workflow neutral row could not be recorded",
      error,
      metadata: {
        slotStartedAt: runtime.slotStartedAt,
        errorName: error instanceof Error ? error.name : "Error",
      },
    });
  }
}

export async function runV9PublicationSlot(
  runtime: ScheduledRuntimeContext,
) {
  const computeOutcome: { result: CronResult | null } = { result: null };
  const result = await runScheduledSlotGroups(
    runtime,
    "fenced V9 publication slot",
    buildV9PublicationSlotGroups(runtime, (compiled) => {
      computeOutcome.result = compiled;
    }),
  );
  if (runtime.env.WORKER_V9_WORKFLOW_MODE !== "shadow") {
    return result;
  }
  const computeResult = computeOutcome.result;
  if (computeResult !== null) {
    const metadata = parseObjectMetadata(computeResult.metadata);
    const hasCompilerIdentity =
      typeof metadata?.sourceGenerationId === "string"
      && typeof metadata?.baseInputGenerationId === "string";
    if (
      hasCompilerIdentity &&
      result.jobsSucceeded + result.jobsDegraded > 0
    ) {
      await triggerSafetyScoreV9ShadowWorkflow(runtime);
      return result;
    }
    await recordUpstreamAbsentWorkflowRun(runtime, computeResult);
  }
  return result;
}
