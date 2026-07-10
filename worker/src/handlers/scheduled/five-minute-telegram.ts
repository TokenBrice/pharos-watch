import { classifyTelegramLogError, logTelegramEvent } from "../../lib/telegram-log";
/**
 * Five-minute Telegram trigger (2,7,12,... * * * *):
 *   serial:
 *     dispatch-telegram-alerts (4) -> telegram-degradation-watchdog (1) -> telegram-disambiguation-cleanup (0) -> telegram-pulse-snapshot (0)
 *   budget-only, serial: Telegram registration reconciliation (1), durable alert-broker delivery drain (1)
 *
 * Subscriber alerts use a dedicated isolated Telegram lane.
 * Connection budget: 4/6 peak
 */
import { dispatchTelegramAlerts } from "../../cron/dispatch-telegram-alerts";
import type { TelegramDispatchSharedState } from "../../cron/dispatch-telegram-alerts";
import { publishTelegramPulseSnapshotWithOutcome } from "../../api/telegram-pulse";
import { runTelegramDegradationWatchdog } from "../../cron/telegram-degradation-watchdog";
import { cleanExpiredDisambiguations } from "../../api/telegram-store/disambiguation";
import { recordBudgetSurfaceTelemetry } from "../../lib/budget-surface-telemetry";
import { dispatchPendingAlertBrokerDeliveries } from "../../lib/alert-broker";
import {
  reconcileTelegramCommandRegistration,
  reconcileTelegramMenuButton,
  reconcileTelegramProfileRegistration,
  reconcileTelegramWebhookRegistration,
} from "../../lib/telegram-webhook-registration";
import {
  getRuntimeProducerIdentity,
  runRuntimeBudgetOnlyTask,
  type ScheduledRuntimeContext,
} from "./context";
import { logSkippedCronRun } from "./preflight-skip";
import {
  flattenScheduledSlotGroupTasks,
  runScheduledSlotGroups,
  type ScheduledSlotGroup,
} from "./slot-groups";
import {
  buildScheduledSlotSummary,
  mergeScheduledSlotSummaries,
  summarizeSkippedScheduledJob,
} from "./slot-summary";

const ALERT_BROKER_DELIVERY_DRAIN_SURFACE = "alert-broker-delivery-drain";

async function runAlertBrokerDeliveryDrain(runtime: ScheduledRuntimeContext): Promise<void> {
  const startedMs = Date.now();
  try {
    const delivery = await runRuntimeBudgetOnlyTask(
      runtime,
      ALERT_BROKER_DELIVERY_DRAIN_SURFACE,
      () => dispatchPendingAlertBrokerDeliveries(runtime.db, {
        webhookUrl: runtime.alertWebhookUrl,
        limit: 25,
      }),
    );
    const unresolved = delivery.failed + delivery.missingTarget;
    await recordBudgetSurfaceTelemetry(runtime.db, {
      surface: ALERT_BROKER_DELIVERY_DRAIN_SURFACE,
      durationMs: Date.now() - startedMs,
      dueCount: delivery.due,
      processedCount: delivery.delivered,
      outcome: unresolved > 0 ? "degraded" : "ok",
      error: unresolved > 0
        ? `${delivery.failed} failed and ${delivery.missingTarget} missing-target deliveries remain retryable`
        : null,
      metadata: delivery,
      producer: getRuntimeProducerIdentity(runtime, ALERT_BROKER_DELIVERY_DRAIN_SURFACE),
    });
  } catch (err) {
    const error = classifyTelegramLogError(err);
    logTelegramEvent({
      message: "durable alert broker delivery drain failed",
      action: ALERT_BROKER_DELIVERY_DRAIN_SURFACE,
      module: "five-minute-telegram",
      errorClass: error,
    });
    await recordBudgetSurfaceTelemetry(runtime.db, {
      surface: ALERT_BROKER_DELIVERY_DRAIN_SURFACE,
      durationMs: Date.now() - startedMs,
      dueCount: 0,
      processedCount: 0,
      outcome: "error",
      error,
      producer: getRuntimeProducerIdentity(runtime, ALERT_BROKER_DELIVERY_DRAIN_SURFACE),
    });
  }
}

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
  success: boolean;
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
      success: true,
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
      success: false,
      error,
    };
  }
}

function buildTelegramSlotGroups(
  runtime: ScheduledRuntimeContext,
  botToken: string,
): ScheduledSlotGroup[] {
  const sharedTelegramState: TelegramDispatchSharedState = {};
  return [
    {
      mode: "serial",
      label: "telegram-alerts-and-sidecars",
      tasks: [
        {
          job: "dispatch-telegram-alerts",
          errorMessage: "[cron] dispatch-telegram-alerts failed:",
          run: (signal, reportProgress) =>
            dispatchTelegramAlerts(
              runtime.db,
              botToken,
              signal,
              sharedTelegramState,
              reportProgress,
            ),
        },
        {
          job: "telegram-degradation-watchdog",
          errorMessage: "[cron] telegram-degradation-watchdog failed:",
          run: (signal) =>
            runTelegramDegradationWatchdog(runtime.db, runtime.alertWebhookUrl, signal, {
              pendingCapacitySnapshot: sharedTelegramState.pendingCapacitySnapshot,
              safetySourceAssessment: sharedTelegramState.safetySourceAssessment,
              alertBrokerMode: runtime.env.ALERT_BROKER_MODE,
            }),
        },
        {
          job: "telegram-disambiguation-cleanup",
          errorMessage: "[cron] telegram-disambiguation-cleanup failed:",
          run: (signal) => cleanExpiredDisambiguations(runtime.db, signal),
        },
        {
          job: "telegram-pulse-snapshot",
          errorMessage: "[cron] telegram-pulse-snapshot failed:",
          run: async (signal) => {
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
      ],
    },
  ];
}

export async function runFiveMinuteTelegramSlot(runtime: ScheduledRuntimeContext) {
  const reconciliationStartedMs = Date.now();
  if (!runtime.env.TELEGRAM_BOT_TOKEN) {
    const message = "TELEGRAM_BOT_TOKEN missing; skipping Telegram scheduled lane";
    // Token is absent: groups are only enumerated for skip-summaries; the task
    // closures are never invoked, so an empty token placeholder is unused.
    const groups = buildTelegramSlotGroups(runtime, "");
    const tasks = flattenScheduledSlotGroupTasks(groups);
    const skippedJobs = [
      summarizeSkippedScheduledJob("telegram-registration-reconciliation", "missing-telegram-bot-token"),
      ...tasks.map((task) =>
        summarizeSkippedScheduledJob(task.job, "missing-telegram-bot-token")
      ),
    ];
    for (const task of tasks) {
      await logSkippedCronRun(runtime, {
        job: task.job,
        reason: "missing-telegram-bot-token",
        message,
      });
    }
    await recordBudgetSurfaceTelemetry(runtime.db, {
      surface: "telegram-registration-reconciliation",
      durationMs: Date.now() - reconciliationStartedMs,
      dueCount: 1,
      processedCount: 0,
      outcome: "skipped",
      skippedReason: "missing-telegram-bot-token",
      metadata: { botTokenConfigured: false },
      producer: getRuntimeProducerIdentity(runtime, "telegram-registration-reconciliation"),
    });
    await runAlertBrokerDeliveryDrain(runtime);
    return buildScheduledSlotSummary(skippedJobs, { budgetOnlyJobs: 2 });
  }

  const reconciliationResults = await runRuntimeBudgetOnlyTask(
    runtime,
    "telegram-registration-reconciliation",
    async (signal) => [
      await runTelegramReconciliation("reconcile-commands", () =>
        reconcileTelegramCommandRegistration(runtime.db, {
          botToken: runtime.env.TELEGRAM_BOT_TOKEN,
          signal,
        }),
      ),
      await runTelegramReconciliation("reconcile-profile", () =>
        reconcileTelegramProfileRegistration(runtime.db, {
          botToken: runtime.env.TELEGRAM_BOT_TOKEN,
          signal,
        }),
      ),
      await runTelegramReconciliation("reconcile-menu", () =>
        reconcileTelegramMenuButton(runtime.db, {
          botToken: runtime.env.TELEGRAM_BOT_TOKEN,
          signal,
        }),
      ),
      await runTelegramReconciliation("reconcile-webhook", () =>
        reconcileTelegramWebhookRegistration(runtime.db, {
          botToken: runtime.env.TELEGRAM_BOT_TOKEN,
          webhookSecret: runtime.env.TELEGRAM_WEBHOOK_SECRET,
          selfUrl: runtime.env.SELF_URL,
          signal,
        }),
      ),
    ],
  );
  const failedReconciliations = reconciliationResults.filter((result) => !result.success);
  await recordBudgetSurfaceTelemetry(runtime.db, {
    surface: "telegram-registration-reconciliation",
    durationMs: Date.now() - reconciliationStartedMs,
    dueCount: reconciliationResults.length,
    processedCount: reconciliationResults.filter((result) => result.success).length,
    outcome: failedReconciliations.length > 0 ? "error" : "ok",
    error: failedReconciliations.length > 0
      ? failedReconciliations.map((result) => `${result.action}:${result.error ?? "failed"}`).join("; ")
      : null,
    metadata: {
      botTokenConfigured: true,
      attemptedCount: reconciliationResults.filter((result) => result.attempted).length,
      skippedCount: reconciliationResults.filter((result) => result.skipped).length,
      failedActions: failedReconciliations.map((result) => result.action),
      actions: reconciliationResults.map((result) => ({
        action: result.action,
        attempted: result.attempted,
        skipped: result.skipped,
        reason: result.reason,
        success: result.success,
      })),
    },
    producer: getRuntimeProducerIdentity(runtime, "telegram-registration-reconciliation"),
  });

  const summary = await runScheduledSlotGroups(
    runtime,
    "five-minute telegram slot",
    buildTelegramSlotGroups(runtime, runtime.env.TELEGRAM_BOT_TOKEN),
  );
  await runAlertBrokerDeliveryDrain(runtime);
  return mergeScheduledSlotSummaries([summary], { budgetOnlyJobs: 2 });
}
