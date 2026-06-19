import { toErrorMessage } from "../../lib/error-utils";
/**
 * Five-minute Telegram trigger (2,7,12,... * * * *):
 *   serial:
 *     dispatch-telegram-alerts (4) -> telegram-degradation-watchdog (0) -> telegram-disambiguation-cleanup (0) -> telegram-pulse-snapshot (0)
 *
 * Subscriber alerts use a dedicated isolated Telegram lane.
 * Connection budget: 4/6 peak
 */
import { dispatchTelegramAlerts } from "../../cron/dispatch-telegram-alerts";
import type { TelegramDispatchSharedState } from "../../cron/dispatch-telegram-alerts";
import { publishTelegramPulseSnapshot } from "../../api/telegram-pulse";
import { runTelegramDegradationWatchdog } from "../../cron/telegram-degradation-watchdog";
import { cleanExpiredDisambiguations } from "../../api/telegram-store/disambiguation";
import { logTelegramEvent } from "../../lib/telegram-log";
import {
  reconcileTelegramCommandRegistration,
  reconcileTelegramMenuButton,
  reconcileTelegramProfileRegistration,
  reconcileTelegramWebhookRegistration,
} from "../../lib/telegram-webhook-registration";
import type { ScheduledRuntimeContext } from "./context";
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

function logReconciliationSuccess(
  action: string,
  details: Record<string, unknown> = {},
): void {
  logTelegramEvent({
    level: "info",
    message: "Telegram reconciliation succeeded",
    action,
    module: "five-minute-telegram",
    ...details,
  });
}

async function runTelegramReconciliation<T extends { attempted: boolean }>(
  action: string,
  fn: () => Promise<T>,
  onSuccessDetails?: (result: T) => Record<string, unknown>,
): Promise<void> {
  try {
    const result = await fn();
    if (result.attempted) {
      logReconciliationSuccess(action, onSuccessDetails ? onSuccessDetails(result) : undefined);
    }
  } catch (err) {
    logTelegramEvent({
      message: "registration reconciliation failed",
      action,
      module: "five-minute-telegram",
      err: toErrorMessage(err),
    });
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
          run: () =>
            publishTelegramPulseSnapshot(runtime.db, undefined, {
              pendingCapacitySnapshot: sharedTelegramState.pendingCapacitySnapshot,
            }).then(() => undefined),
        },
      ],
    },
  ];
}

export async function runFiveMinuteTelegramSlot(runtime: ScheduledRuntimeContext) {
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
    return buildScheduledSlotSummary(skippedJobs, { budgetOnlyJobs: 1 });
  }

  await runTelegramReconciliation("reconcile-commands", () =>
    reconcileTelegramCommandRegistration(runtime.db, {
      botToken: runtime.env.TELEGRAM_BOT_TOKEN,
    }),
  );

  await runTelegramReconciliation("reconcile-profile", () =>
    reconcileTelegramProfileRegistration(runtime.db, {
      botToken: runtime.env.TELEGRAM_BOT_TOKEN,
    }),
  );

  await runTelegramReconciliation(
    "reconcile-menu",
    () =>
      reconcileTelegramMenuButton(runtime.db, {
        botToken: runtime.env.TELEGRAM_BOT_TOKEN,
      }),
    (menuResult) => ({ miniAppUrl: menuResult.miniAppUrl }),
  );

  await runTelegramReconciliation(
    "reconcile-webhook",
    () =>
      reconcileTelegramWebhookRegistration(runtime.db, {
        botToken: runtime.env.TELEGRAM_BOT_TOKEN,
        webhookSecret: runtime.env.TELEGRAM_WEBHOOK_SECRET,
        selfUrl: runtime.env.SELF_URL,
      }),
    (result) => ({ expectedUrl: result.expectedUrl }),
  );

  const summary = await runScheduledSlotGroups(
    runtime,
    "five-minute telegram slot",
    buildTelegramSlotGroups(runtime, runtime.env.TELEGRAM_BOT_TOKEN),
  );
  return mergeScheduledSlotSummaries([summary], { budgetOnlyJobs: 1 });
}
