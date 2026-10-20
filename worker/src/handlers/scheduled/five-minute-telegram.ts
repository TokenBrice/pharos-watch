import { classifyTelegramLogError, logTelegramEvent } from "../../telegram/common/log";
/**
 * Five-minute Telegram trigger (2,7,12,... * * * *):
 *   serial: dispatch (with token) -> watchdog -> cleanup -> pulse
 *   budget-only, after critical lane: all four cached registration checks
 *
 * Subscriber alerts use a dedicated isolated Telegram lane.
 * Connection budget: 4/6 peak
 */
// The four job graphs (alert dispatch, pulse snapshot, degradation watchdog,
// disambiguation cleanup) are loaded via dynamic
// import() at dispatch time, like the compile-time public-runners map.
// Heavy entrypoints cannot reach this lane; public isolates still defer its
// job initialization until dispatch. Only types may be imported statically.
import type { TelegramDispatchSharedState } from "../../cron/telegram/dispatch/dispatch-telegram-alerts";
import type * as TelegramRegistrationModule from "../../telegram/webhook/webhook-registration";
import { recordBudgetSurfaceTelemetry } from "../../lib/budget-surface-telemetry";
import { createD1CostTracker } from "../../lib/d1-cost";
import {
  getRuntimeProducerIdentity,
  runRuntimeBudgetOnlyTask,
  type ScheduledRuntimeContext,
} from "./context";
import { logSkippedCronRun } from "./preflight-skip";
import {
  runScheduledSlotGroups,
  type ScheduledSlotTaskChain,
  type ScheduledSlotTask,
} from "./slot-groups";
import {
  buildScheduledSlotSummary,
  mergeScheduledSlotSummaries,
  summarizeSkippedScheduledJob,
} from "./slot-summary";

type TelegramRegistrationModuleType = typeof TelegramRegistrationModule;
interface TelegramRegistration {
  action: string;
  run: (
    registration: TelegramRegistrationModuleType,
    runtime: ScheduledRuntimeContext,
    botToken: string,
    signal?: AbortSignal,
  ) => Promise<{ attempted: boolean }>;
}

const TELEGRAM_REGISTRATIONS: readonly TelegramRegistration[] = [
  {
    action: "reconcile-commands",
    run: (
      registration: TelegramRegistrationModuleType,
      runtime: ScheduledRuntimeContext,
      botToken: string,
      signal?: AbortSignal,
    ) => registration.reconcileTelegramCommandRegistration(runtime.db, {
      botToken,
      signal,
    }),
  },
  {
    action: "reconcile-profile",
    run: (
      registration: TelegramRegistrationModuleType,
      runtime: ScheduledRuntimeContext,
      botToken: string,
      signal?: AbortSignal,
    ) => registration.reconcileTelegramProfileRegistration(runtime.db, {
      botToken,
      signal,
    }),
  },
  {
    action: "reconcile-menu",
    run: (
      registration: TelegramRegistrationModuleType,
      runtime: ScheduledRuntimeContext,
      botToken: string,
      signal?: AbortSignal,
    ) => registration.reconcileTelegramMenuButton(runtime.db, {
      botToken,
      signal,
    }),
  },
  {
    action: "reconcile-webhook",
    run: (
      registration: TelegramRegistrationModuleType,
      runtime: ScheduledRuntimeContext,
      botToken: string,
      signal?: AbortSignal,
    ) => registration.reconcileTelegramWebhookRegistration(runtime.db, {
      botToken,
      webhookSecret: runtime.env.TELEGRAM_WEBHOOK_SECRET,
      selfUrl: runtime.env.SELF_URL,
      signal,
    }),
  },
] as const;

const TELEGRAM_REGISTRATION_ACTIONS =
  TELEGRAM_REGISTRATIONS.map(({ action }) => action);

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
): ScheduledSlotTaskChain[][] {
  const sharedTelegramState: TelegramDispatchSharedState = {};
  const tasks: ScheduledSlotTask[] = [];
  if (botToken) {
    tasks.push({
      job: "dispatch-telegram-alerts",
      errorMessage: "[cron] dispatch-telegram-alerts failed:",
      run: async (signal, reportProgress) => {
        const { dispatchTelegramAlerts } = await import("../../cron/telegram/dispatch/dispatch-telegram-alerts");
        return dispatchTelegramAlerts(
          runtime.db,
          botToken,
          signal,
          sharedTelegramState,
          reportProgress,
        );
      },
    });
  }
  tasks.push(
    {
      job: "telegram-degradation-watchdog",
      errorMessage: "[cron] telegram-degradation-watchdog failed:",
      run: async (signal) => {
        const { runTelegramDegradationWatchdog } = await import("../../cron/telegram/maintenance/telegram-degradation-watchdog");
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
        const { cleanExpiredDisambiguations } = await import("../../telegram/store/disambiguation");
        return cleanExpiredDisambiguations(runtime.db, signal);
      },
    },
    {
      job: "telegram-pulse-snapshot",
      errorMessage: "[cron] telegram-pulse-snapshot failed:",
      run: async (signal) => {
        const d1Cost = createD1CostTracker(runtime.db, ["outer-cron-lifecycle-excluded"]);
        const { publishTelegramPulseSnapshotWithOutcome } = await import("../../telegram/webhook/telegram-pulse");
        const outcome = await publishTelegramPulseSnapshotWithOutcome(d1Cost.db, undefined, {
          pendingCapacitySnapshot: sharedTelegramState.pendingCapacitySnapshot,
          signal,
        });
        return {
          status: outcome.status,
          itemCount: outcome.snapshotPublished ? 1 : 0,
          error: outcome.error ?? undefined,
          metadata: JSON.stringify({
            d1Cost: d1Cost.snapshot(),
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
  return [[
    {
      label: "telegram-alerts-and-sidecars",
      tasks,
    },
  ]];
}

export async function runFiveMinuteTelegramSlot(runtime: ScheduledRuntimeContext) {
  if (!runtime.env.TELEGRAM_BOT_TOKEN) {
    const reconciliationStartedMs = Date.now();
    const message = "TELEGRAM_BOT_TOKEN missing; skipping Telegram transport work";
    const skippedJobs = [
      {
        job: "telegram-registration-reconciliation",
        outcome: "error" as const,
        error: "missing-telegram-bot-token",
      },
      summarizeSkippedScheduledJob("dispatch-telegram-alerts", "missing-telegram-bot-token"),
    ];
    await logSkippedCronRun(runtime, {
      job: "dispatch-telegram-alerts",
      reason: "missing-telegram-bot-token",
      message,
    });
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

  const reconciliationStartedMs = Date.now();
  const reconciliationResults = await runRuntimeBudgetOnlyTask(
    runtime,
    "telegram-registration-reconciliation",
    async (signal) => {
      const registration = await import("../../telegram/webhook/webhook-registration");
      const results: TelegramReconciliationTelemetry[] = [];
      for (const entry of TELEGRAM_REGISTRATIONS) {
        results.push(await runTelegramReconciliation(
          entry.action,
          () => entry.run(
            registration,
            runtime,
            runtime.env.TELEGRAM_BOT_TOKEN!,
            signal,
          ),
        ));
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
