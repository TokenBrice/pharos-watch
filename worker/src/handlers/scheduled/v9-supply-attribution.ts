import type { CronResult } from "../../lib/cron-logger";
import { parseJsonObject } from "../../lib/json-parse";
import { logWorkerEvent } from "../../lib/structured-log";
import {
  runV9AfterCoreWithinWindow,
  V9_EXECUTION_WINDOW_POLICY,
  type V9ExecutionWindow,
} from "../../lib/v9-slot-window";
import type { SafetyScoreV9LaneScreeningShadowReason } from "../../cron/sync-v9-supply-attribution";
import { isRecord } from "@shared/lib/type-guards";
import type { ScheduledRuntimeContext } from "./context";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";

const V9_PUBLIC_MATERIALIZATION_PIGGYBACK_MINUTE = 38;
const V9_PUBLIC_MATERIALIZATION_PIGGYBACK_MAX_BUDGET_MS = 60_000;
// Calibrated 45s materialization minimum plus 5s diagnostic/settlement reserve.
const V9_PUBLIC_MATERIALIZATION_PIGGYBACK_MIN_BUDGET_MS = 50_000;

type V9PublicMaterializationPiggybackOutcome = {
  status: NonNullable<CronResult["status"]> | "skipped" | "failed";
  reason: string;
  publicationGenerationId: string | null;
  budgetMs: number;
  /** Wall time the piggyback took from attribution's window; null when it did not run. */
  durationMs: number | null;
  /** Window left to attribution and its serialized shadow phases afterwards. */
  remainingMs: number;
};

function getScheduledUtcMinute(
  runtime: Pick<ScheduledRuntimeContext, "scheduledTimeMs" | "slotStartedAt">,
): number {
  return new Date(runtime.scheduledTimeMs ?? runtime.slotStartedAt * 1_000).getUTCMinutes();
}

/**
 * Opportunistic D1-only public materialization recovery on the :38 attribution
 * slot (zero external fetches, zero new triggers). Runs under the shared V9
 * memory lease before attribution loads its modules, and isolates any failure
 * so attribution always continues cleanly. Returns null off the :38 slot;
 * otherwise the outcome the attribution run persists in its cron metadata.
 */
async function maybeRecoverV9PublicMaterialization(
  runtime: ScheduledRuntimeContext,
  windowSignal: AbortSignal,
  window: V9ExecutionWindow,
): Promise<V9PublicMaterializationPiggybackOutcome | null> {
  if (getScheduledUtcMinute(runtime) !== V9_PUBLIC_MATERIALIZATION_PIGGYBACK_MINUTE) return null;
  const nowMs = Date.now();
  const recoveryDeadlineMs = Math.min(
    nowMs + V9_PUBLIC_MATERIALIZATION_PIGGYBACK_MAX_BUDGET_MS,
    window.deadlineMs - window.minimumRemainingMs,
  );
  const outcome = (
    status: V9PublicMaterializationPiggybackOutcome["status"],
    reason: string,
    publicationGenerationId: string | null = null,
    ran = true,
  ): V9PublicMaterializationPiggybackOutcome => ({
    status, reason, publicationGenerationId,
    budgetMs: Math.max(0, recoveryDeadlineMs - nowMs),
    durationMs: ran ? Date.now() - nowMs : null,
    remainingMs: Math.max(0, window.deadlineMs - Date.now()),
  });
  if (windowSignal.aborted) return outcome("skipped", "v9-public-materialization-piggyback-aborted", null, false);
  if (recoveryDeadlineMs - nowMs < V9_PUBLIC_MATERIALIZATION_PIGGYBACK_MIN_BUDGET_MS) {
    return outcome("skipped", "v9-public-materialization-piggyback-window-insufficient", null, false);
  }

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
    const metadata = parseJsonObject(result.metadata);
    const run = isRecord(metadata?.publicMaterialization) ? metadata.publicMaterialization : null;
    return outcome(
      result.status ?? "ok",
      typeof metadata?.reason === "string" ? metadata.reason : "v9-public-materialization-piggyback-reason-missing",
      typeof run?.publicationGenerationId === "string" ? run.publicationGenerationId : null,
    );
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
    return outcome("failed", "v9-public-materialization-piggyback-failed");
  }
}

/**
 * Persists the piggyback outcome on the attribution run (R4). A lane-screening
 * window skip that the recovery's elapsed time alone caused names that cause.
 */
function withPublicMaterializationRecovery(
  result: CronResult,
  recovery: V9PublicMaterializationPiggybackOutcome,
  laneScreeningMinimumRemainingMs: number,
): CronResult {
  const metadata = parseJsonObject(result.metadata) ?? {};
  const lane = metadata.laneScreening;
  if (isRecord(lane) && lane.reason === "lane-screening-window-insufficient" &&
    typeof lane.remainingMs === "number" && recovery.durationMs !== null &&
    lane.remainingMs + recovery.durationMs >= laneScreeningMinimumRemainingMs) {
    const reason: SafetyScoreV9LaneScreeningShadowReason = "lane-screening-window-consumed-by-materialization-recovery";
    metadata.laneScreening = { ...lane, reason };
  }
  return { ...result, metadata: JSON.stringify({ ...metadata, publicMaterializationRecovery: recovery }) };
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
            const recovery = await maybeRecoverV9PublicMaterialization(runtime, windowSignal, window);
            const attribution = await import("../../cron/sync-v9-supply-attribution");
            const result = await attribution.syncSafetyScoreV9SupplyAttribution(
              runtime.db,
              runtime.chainRpcs,
              windowSignal,
              window,
              runtime.dwellirNative,
            );
            return recovery === null
              ? result
              : withPublicMaterializationRecovery(result, recovery, attribution.LANE_SCREENING_MINIMUM_REMAINING_MS);
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
