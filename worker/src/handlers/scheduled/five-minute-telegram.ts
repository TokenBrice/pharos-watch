import { classifyTelegramLogError, logTelegramEvent } from "../../lib/telegram/log";
/**
 * Five-minute Telegram trigger (2,7,12,... * * * *):
 *   serial: dispatch (when token configured) -> watchdog -> cleanup -> pulse
 *   budget-only, after critical lane: one rotating registration unit
 *
 * Subscriber alerts use a dedicated isolated Telegram lane.
 * Connection budget: 4/6 peak
 */
// The five job graphs (alert dispatch, recap planner/store, pulse snapshot,
// degradation watchdog, disambiguation cleanup) are loaded via dynamic
// import() at dispatch time — mirroring SLOT_RUNNER_LOADER_BY_KEY in ../scheduled.ts —
// so their module graphs never sit on the heap of isolates that only run the
// heavy data lanes. Only types may be imported statically from them.
import type { TelegramDispatchSharedState } from "../../cron/dispatch-telegram-alerts";
import type { TelegramRecapRolloutCleanupResult } from "../../lib/telegram/recap-store";
import { resolveTelegramRecapRolloutPolicy } from "@shared/lib/telegram-recap-rollout";
import {
  TELEGRAM_RECAP_PLANNER_SOFT_DEADLINE_MS,
  TELEGRAM_RECAP_SHARED_SLOT_BUDGET_MS,
  TELEGRAM_RECAP_SLOT_RESERVE_MS,
} from "@shared/lib/telegram-recap-policy";
import { recordBudgetSurfaceTelemetry } from "../../lib/budget-surface-telemetry";
import { parseJsonObject } from "../../lib/json-parse";
import {
  getRuntimeProducerIdentity,
  runRuntimeBudgetOnlyTask,
  type ScheduledRuntimeContext,
} from "./context";
import { logSkippedCronRun } from "./preflight-skip";
import {
  runScheduledSlotGroups,
  type ScheduledSlotGroup,
  type ScheduledSlotTask,
} from "./slot-groups";
import {
  buildScheduledSlotSummary,
  mergeScheduledSlotSummaries,
  summarizeSkippedScheduledJob,
} from "./slot-summary";

const TELEGRAM_REGISTRATION_ACTIONS = [
  "reconcile-commands",
  "reconcile-profile",
  "reconcile-menu",
  "reconcile-webhook",
] as const;

function logReconciliationSuccess(action: string): void {
  logTelegramEvent({
    level: "info",
    message: "Telegram reconciliation succeeded",
    action,
    module: "five-minute-telegram",
  });
}

interface TelegramReconciliationTelemetry {
  action: string;
  attempted: boolean;
  skipped: boolean;
  reason: string | null;
  outcome: "skipped" | "succeeded" | "failed";
  error: string | null;
}

async function runTelegramReconciliation<T extends { attempted: boolean }>(
  action: string,
  fn: () => Promise<T>,
): Promise<TelegramReconciliationTelemetry> {
  try {
    const result = await fn();
    if (result.attempted) {
      logReconciliationSuccess(action);
    }
    const resultRecord = result as T & { skipped?: boolean; reason?: string };
    return {
      action,
      attempted: result.attempted,
      skipped: resultRecord.skipped === true,
      reason: typeof resultRecord.reason === "string" ? resultRecord.reason : null,
      outcome: result.attempted ? "succeeded" : "skipped",
      error: null,
    };
  } catch (err) {
    const error = classifyTelegramLogError(err);
    logTelegramEvent({
      message: "registration reconciliation failed",
      action,
      module: "five-minute-telegram",
      errorClass: error,
    });
    return {
      action,
      attempted: true,
      skipped: false,
      reason: null,
      outcome: "failed",
      error,
    };
  }
}

function buildTelegramSlotGroups(
  runtime: ScheduledRuntimeContext,
  botToken: string | null,
): ScheduledSlotGroup[] {
  const sharedTelegramState: TelegramDispatchSharedState = {};
  const tasks: ScheduledSlotTask[] = [];
  const recapRollout = resolveTelegramRecapRolloutPolicy(runtime.env);
  // The shared drain must not see recap rows disallowed by the current mode.
  // Reuse the result in the planner so cleanup is ordered once per slot.
  let recapRolloutCleanup: TelegramRecapRolloutCleanupResult | null = null;
  const ensureRecapRolloutCleanup = async (): Promise<TelegramRecapRolloutCleanupResult> => {
    if (recapRollout.mode === "public") {
      return { targetRowsCancelled: 0, pendingRowsDeleted: 0 };
    }
    if (recapRolloutCleanup == null) {
      const { cancelQueuedTelegramRecapsForRollout } = await import("../../lib/telegram/recap-store");
      recapRolloutCleanup = await cancelQueuedTelegramRecapsForRollout(
        runtime.db,
        recapRollout,
        Math.floor(Date.now() / 1000),
      );
    }
    return recapRolloutCleanup;
  };
  if (botToken) {
    tasks.push({
      job: "dispatch-telegram-alerts",
      errorMessage: "[cron] dispatch-telegram-alerts failed:",
      run: async (signal, reportProgress) => {
        const { dispatchTelegramAlerts } = await import("../../cron/dispatch-telegram-alerts");
        await ensureRecapRolloutCleanup();
        const startedAtMs = Date.now();
        Object.assign(sharedTelegramState, {
          dispatchStartedAtMs: startedAtMs,
          dispatchCompleted: false,
          dispatchFailed: false,
          dispatchDurationMs: 0,
        });
        try {
          return await dispatchTelegramAlerts(
            runtime.db,
            botToken,
            signal,
            sharedTelegramState,
            reportProgress,
          );
        } catch (error) {
          sharedTelegramState.dispatchFailed = true;
          throw error;
        } finally {
          sharedTelegramState.dispatchCompleted = true;
          sharedTelegramState.dispatchDurationMs = Math.max(0, Date.now() - startedAtMs);
        }
      },
    });
  }
  const shouldRunRecap = recapRollout.mode === "off" || recapRollout.mode === "dark" || Boolean(botToken);
  if (shouldRunRecap) {
    tasks.push({
      job: "telegram-personalized-recap-planner",
      errorMessage: "[cron] telegram-personalized-recap-planner failed:",
      run: async (signal) => {
        const cleanup = await ensureRecapRolloutCleanup();
        if (recapRollout.mode === "off") {
          return {
            status: "ok" as const,
            itemCount: cleanup.targetRowsCancelled + cleanup.pendingRowsDeleted,
            metadata: JSON.stringify({
              rollout: { mode: recapRollout.mode, pendingEffects: false },
              cleanup,
              skipped: "recap-rollout-off",
            }),
          };
        }
        if (!botToken && recapRollout.mode !== "dark") {
          return {
            status: "skipped_neutral" as const,
            metadata: JSON.stringify({
              rollout: { mode: recapRollout.mode, pendingEffects: true },
              cleanup,
              skipped: "missing-telegram-bot-token",
            }),
          };
        }
        if (botToken && (
          sharedTelegramState.dispatchStartedAtMs == null ||
          sharedTelegramState.dispatchCompleted !== true ||
          sharedTelegramState.dispatchFailed === true
        )) {
          return {
            status: "skipped_neutral" as const,
            metadata: JSON.stringify({
              rollout: { mode: recapRollout.mode, pendingEffects: true },
              cleanup,
              skipped: sharedTelegramState.dispatchFailed
                ? "risk-dispatch-failed"
                : "risk-dispatch-locked-or-incomplete",
            }),
          };
        }
        const riskDispatchDurationMs = botToken
          ? Math.max(0, sharedTelegramState.dispatchDurationMs ?? TELEGRAM_RECAP_SHARED_SLOT_BUDGET_MS)
          : 0;
        const recapBudgetMs = Math.min(
          TELEGRAM_RECAP_PLANNER_SOFT_DEADLINE_MS,
          TELEGRAM_RECAP_SHARED_SLOT_BUDGET_MS - riskDispatchDurationMs - TELEGRAM_RECAP_SLOT_RESERVE_MS,
        );
        if (recapBudgetMs <= 0) {
          return {
            status: "skipped_neutral" as const,
            metadata: JSON.stringify({
              rollout: { mode: recapRollout.mode, pendingEffects: true },
              cleanup,
              skipped: "risk-dispatch-consumed-slot-budget",
              riskDispatchDurationMs,
              sharedSlotBudgetMs: TELEGRAM_RECAP_SHARED_SLOT_BUDGET_MS,
              slotReserveMs: TELEGRAM_RECAP_SLOT_RESERVE_MS,
            }),
          };
        }
        const { planTelegramPersonalizedRecaps } = await import("../../cron/telegram-recap-planner");
        const planned = await planTelegramPersonalizedRecaps(runtime.db, signal, {
          rolloutPolicy: recapRollout,
          softDeadlineMs: recapBudgetMs,
        });
        return {
          ...planned,
          metadata: JSON.stringify({
            ...(parseJsonObject<Record<string, unknown>>(planned.metadata, "five-minute-telegram:recap-planner") ?? {}),
            cleanup,
            riskDispatchDurationMs,
            recapBudgetMs,
          }),
        };
      },
    });
  }
  tasks.push(
    {
      job: "telegram-degradation-watchdog",
      errorMessage: "[cron] telegram-degradation-watchdog failed:",
      run: async (signal) => {
        const { runTelegramDegradationWatchdog } = await import("../../cron/telegram-degradation-watchdog");
        return runTelegramDegradationWatchdog(runtime.db, signal, {
          pendingCapacitySnapshot: sharedTelegramState.pendingCapacitySnapshot,
          safetySourceAssessment: sharedTelegramState.safetySourceAssessment,
        });
      },
    },
    {
      job: "telegram-disambiguation-cleanup",
      errorMessage: "[cron] telegram-disambiguation-cleanup failed:",
      run: async (signal) => {
        const { cleanExpiredDisambiguations } = await import("../../api/telegram-store/disambiguation");
        return cleanExpiredDisambiguations(runtime.db, signal);
      },
    },
    {
      job: "telegram-pulse-snapshot",
      errorMessage: "[cron] telegram-pulse-snapshot failed:",
      run: async (signal) => {
        const { publishTelegramPulseSnapshotWithOutcome } = await import("../../api/telegram-pulse");
        const outcome = await publishTelegramPulseSnapshotWithOutcome(runtime.db, undefined, {
          pendingCapacitySnapshot: sharedTelegramState.pendingCapacitySnapshot,
          signal,
        });
        return {
          status: outcome.status,
          itemCount: outcome.snapshotPublished ? 1 : 0,
          error: outcome.error ?? undefined,
          metadata: JSON.stringify({
            sidecar: "telegram-pulse-snapshot",
            snapshotPublished: outcome.snapshotPublished,
            heavySectionsRecomputed: outcome.heavySectionsRecomputed,
            heavyMarkerAdvanced: outcome.heavyMarkerAdvanced,
            qualityStatus: outcome.pulse.quality.status,
            unavailableFields: outcome.pulse.quality.unavailableFields,
          }),
          productivity: {
            productive: outcome.snapshotPublished,
            reason: outcome.snapshotPublished ? "pulse-snapshot-published" : "pulse-snapshot-write-failed",
          },
        };
      },
    },
  );
  return [
    {
      mode: "serial",
      label: "telegram-alerts-and-sidecars",
      tasks,
    },
  ];
}

export async function runFiveMinuteTelegramSlot(runtime: ScheduledRuntimeContext) {
  const reconciliationStartedMs = Date.now();
  if (!runtime.env.TELEGRAM_BOT_TOKEN) {
    const recapRollout = resolveTelegramRecapRolloutPolicy(runtime.env);
    const recapRequiresBotToken = recapRollout.mode === "canary" || recapRollout.mode === "public";
    const message = "TELEGRAM_BOT_TOKEN missing; skipping Telegram transport work";
    const skippedJobs = [
      {
        job: "telegram-registration-reconciliation",
        outcome: "error" as const,
        error: "missing-telegram-bot-token",
      },
      summarizeSkippedScheduledJob("dispatch-telegram-alerts", "missing-telegram-bot-token"),
      ...(recapRequiresBotToken
        ? [summarizeSkippedScheduledJob("telegram-personalized-recap-planner", "missing-telegram-bot-token")]
        : []),
    ];
    for (const job of [
      "dispatch-telegram-alerts",
      ...(recapRequiresBotToken ? ["telegram-personalized-recap-planner"] : []),
    ]) {
      await logSkippedCronRun(runtime, {
        job,
        reason: "missing-telegram-bot-token",
        message,
      });
    }
    await recordBudgetSurfaceTelemetry(runtime.db, {
      surface: "telegram-registration-reconciliation",
      durationMs: Date.now() - reconciliationStartedMs,
      dueCount: TELEGRAM_REGISTRATION_ACTIONS.length,
      processedCount: 0,
      outcome: "error",
      error: "missing-telegram-bot-token",
      metadata: {
        botTokenConfigured: false,
        attemptedCount: 0,
        skippedCount: 0,
        succeededCount: 0,
        failedCount: TELEGRAM_REGISTRATION_ACTIONS.length,
        lastSuccessAt: null,
        failedActions: TELEGRAM_REGISTRATION_ACTIONS,
        actions: TELEGRAM_REGISTRATION_ACTIONS.map((action) => ({
          action,
          attempted: false,
          skipped: false,
          reason: "missing-telegram-bot-token",
          outcome: "failed",
        })),
      },
      producer: getRuntimeProducerIdentity(runtime, "telegram-registration-reconciliation"),
    });
    const sidecarSummary = await runScheduledSlotGroups(
      runtime,
      "five-minute telegram token-independent sidecars",
      buildTelegramSlotGroups(runtime, null),
    );
    return mergeScheduledSlotSummaries([
      sidecarSummary,
      buildScheduledSlotSummary(skippedJobs),
    ], { budgetOnlyJobs: 1 });
  }

  const summary = await runScheduledSlotGroups(
    runtime,
    "five-minute telegram slot",
    buildTelegramSlotGroups(runtime, runtime.env.TELEGRAM_BOT_TOKEN),
  );

  const reconciliationResults = await runRuntimeBudgetOnlyTask(
    runtime,
    "telegram-registration-reconciliation",
    async (signal) => {
      const {
        reconcileTelegramCommandRegistration,
        reconcileTelegramMenuButton,
        reconcileTelegramProfileRegistration,
        reconcileTelegramWebhookRegistration,
      } = await import("../../lib/telegram/webhook-registration");
      const registrations: Array<{
        action: string;
        run: (signal?: AbortSignal) => Promise<{ attempted: boolean; skipped?: boolean; reason?: string }>;
      }> = [
        { action: "reconcile-commands", run: (signal) => reconcileTelegramCommandRegistration(runtime.db, {
          botToken: runtime.env.TELEGRAM_BOT_TOKEN,
          includeRecap: resolveTelegramRecapRolloutPolicy(runtime.env).mode === "public",
          signal,
        }) },
        { action: "reconcile-profile", run: (signal) => reconcileTelegramProfileRegistration(runtime.db, {
          botToken: runtime.env.TELEGRAM_BOT_TOKEN,
          signal,
        }) },
        { action: "reconcile-menu", run: (signal) => reconcileTelegramMenuButton(runtime.db, {
          botToken: runtime.env.TELEGRAM_BOT_TOKEN,
          signal,
        }) },
        { action: "reconcile-webhook", run: (signal) => reconcileTelegramWebhookRegistration(runtime.db, {
          botToken: runtime.env.TELEGRAM_BOT_TOKEN,
          webhookSecret: runtime.env.TELEGRAM_WEBHOOK_SECRET,
          selfUrl: runtime.env.SELF_URL,
          signal,
        }) },
      ];
      const results: TelegramReconciliationTelemetry[] = [];
      for (const registration of registrations) {
        results.push(await runTelegramReconciliation(registration.action, () => registration.run(signal)));
      }
      return results;
    },
  );
  const failedReconciliations = reconciliationResults.filter((result) => result.outcome === "failed");
  const succeededReconciliations = reconciliationResults.filter((result) => result.outcome === "succeeded");
  const skippedReconciliations = reconciliationResults.filter((result) => result.outcome === "skipped");
  await recordBudgetSurfaceTelemetry(runtime.db, {
    surface: "telegram-registration-reconciliation",
    durationMs: Date.now() - reconciliationStartedMs,
    dueCount: reconciliationResults.length,
    processedCount: succeededReconciliations.length,
    outcome: failedReconciliations.length > 0
      ? "error"
      : succeededReconciliations.length > 0 ? "ok" : "skipped",
    skippedReason: skippedReconciliations[0]?.reason ?? undefined,
    error: failedReconciliations.length > 0
      ? failedReconciliations.map((result) => `${result.action}:${result.error ?? "failed"}`).join("; ")
      : null,
    metadata: {
      botTokenConfigured: true,
      attemptedCount: reconciliationResults.filter((result) => result.attempted).length,
      skippedCount: skippedReconciliations.length,
      succeededCount: succeededReconciliations.length,
      failedCount: failedReconciliations.length,
      lastSuccessAt: succeededReconciliations.length > 0 ? Math.floor(Date.now() / 1000) : null,
      failedActions: failedReconciliations.map((result) => result.action),
      actions: reconciliationResults.map((result) => ({
        action: result.action,
        attempted: result.attempted,
        skipped: result.skipped,
        reason: result.reason,
        outcome: result.outcome,
      })),
    },
    producer: getRuntimeProducerIdentity(runtime, "telegram-registration-reconciliation"),
  });

  return mergeScheduledSlotSummaries([summary], { budgetOnlyJobs: 1 });
}
