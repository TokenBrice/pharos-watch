import { logWorkerEvent } from "../../lib/structured-log";
import {
  runV9AfterCoreWithinWindow,
  V9_EXECUTION_WINDOW_POLICY,
  type V9ExecutionWindow,
} from "../../lib/v9-slot-window";
import type { ScheduledRuntimeContext } from "./context";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";

const V9_PUBLIC_MATERIALIZATION_PIGGYBACK_MINUTE = 38;
const V9_PUBLIC_MATERIALIZATION_PIGGYBACK_MAX_BUDGET_MS = 60_000;
// Calibrated 45s materialization minimum plus 5s diagnostic/settlement reserve.
const V9_PUBLIC_MATERIALIZATION_PIGGYBACK_MIN_BUDGET_MS = 50_000;

function getScheduledUtcMinute(
  runtime: Pick<ScheduledRuntimeContext, "scheduledTimeMs" | "slotStartedAt">,
): number {
  return new Date(runtime.scheduledTimeMs ?? runtime.slotStartedAt * 1_000).getUTCMinutes();
}

/**
 * Opportunistic D1-only public materialization recovery on the :38 attribution
 * slot (zero external fetches, zero new triggers). Runs under the shared V9
 * memory lease before attribution loads its modules, and isolates any failure
 * so attribution always continues cleanly.
 */
async function maybeRecoverV9PublicMaterialization(
  runtime: ScheduledRuntimeContext,
  windowSignal: AbortSignal,
  window: V9ExecutionWindow,
): Promise<void> {
  if (windowSignal.aborted) return;
  if (getScheduledUtcMinute(runtime) !== V9_PUBLIC_MATERIALIZATION_PIGGYBACK_MINUTE) return;
  const nowMs = Date.now();
  const recoveryDeadlineMs = Math.min(
    nowMs + V9_PUBLIC_MATERIALIZATION_PIGGYBACK_MAX_BUDGET_MS,
    window.deadlineMs - window.minimumRemainingMs,
  );
  if (recoveryDeadlineMs - nowMs < V9_PUBLIC_MATERIALIZATION_PIGGYBACK_MIN_BUDGET_MS) return;

  try {
    const { recoverSafetyScoreV9PublicMaterialization } = await import(
      "../../lib/safety-score-v9/publication-materialization"
    );
    const result = await recoverSafetyScoreV9PublicMaterialization(
      runtime.db,
      windowSignal,
      recoveryDeadlineMs,
      { skipPriorFailedGeneration: true },
    );
    if (result.status && result.status !== "skipped_neutral") {
      logWorkerEvent({
        scope: "handler",
        level: result.status === "ok" ? "info" : "warn",
        event: "safety_score_v9_public_materialization_piggyback",
        job: "sync-v9-supply-attribution",
        message:
          result.status === "ok"
            ? "Recovered deferred Safety Score V9 public materialization during :38 attribution slot"
            : "Safety Score V9 public materialization piggyback recovery degraded; continuing attribution",
        metadata: {
          scheduleKey: runtime.scheduleKey,
          slotStartedAt: runtime.slotStartedAt,
          status: result.status,
          itemCount: result.itemCount ?? 0,
          reason: result.productivity?.reason ?? null,
        },
      });
    }
  } catch (error) {
    logWorkerEvent({
      scope: "handler",
      level: "warn",
      event: "safety_score_v9_public_materialization_piggyback_failed",
      job: "sync-v9-supply-attribution",
      message: "Safety Score V9 public materialization piggyback recovery failed; continuing attribution",
      error,
      metadata: {
        scheduleKey: runtime.scheduleKey,
        slotStartedAt: runtime.slotStartedAt,
      },
    });
  }
}

export function buildV9SupplyAttributionSlotGroups(runtime: ScheduledRuntimeContext) {
  return bindScheduledSlotPlan("v9SupplyAttributionOffset", {
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
            yieldToV9Publication: true,
          },
          async (windowSignal, window) => {
            await maybeRecoverV9PublicMaterialization(runtime, windowSignal, window);
            const { syncSafetyScoreV9SupplyAttribution } = await import(
              "../../cron/sync-v9-supply-attribution"
            );
            return syncSafetyScoreV9SupplyAttribution(
              runtime.db,
              runtime.chainRpcs,
              windowSignal,
              window,
              runtime.dwellirNative,
            );
          },
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
