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
import { cleanExpiredDisambiguations } from "../../cron/telegram-quiet-hours";
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

function buildTelegramSlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  const sharedTelegramState: TelegramDispatchSharedState = {};
  return [
    {
      mode: "serial",
      label: "telegram-alerts-and-sidecars",
      tasks: [
        {
          job: "dispatch-telegram-alerts",
          errorMessage: "[cron] dispatch-telegram-alerts failed:",
          run: (signal) =>
            dispatchTelegramAlerts(
              runtime.db,
              runtime.env.TELEGRAM_BOT_TOKEN!,
              signal,
              sharedTelegramState,
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

export async function runFiveMinuteTelegramSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  if (!runtime.env.TELEGRAM_BOT_TOKEN) {
    const message = "TELEGRAM_BOT_TOKEN missing; skipping Telegram scheduled lane";
    const groups = buildTelegramSlotGroups(runtime);
    for (const task of flattenScheduledSlotGroupTasks(groups)) {
      await logSkippedCronRun(runtime, {
        job: task.job,
        reason: "missing-telegram-bot-token",
        message,
      });
    }
    return;
  }

  try {
    const commandsResult = await reconcileTelegramCommandRegistration(runtime.db, {
      botToken: runtime.env.TELEGRAM_BOT_TOKEN,
    });
    if (commandsResult.attempted) {
      logReconciliationSuccess("reconcile-commands");
    }
  } catch (err) {
    logTelegramEvent({
      message: "registration reconciliation failed",
      action: "reconcile-commands",
      module: "five-minute-telegram",
      err: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const profileResult = await reconcileTelegramProfileRegistration(runtime.db, {
      botToken: runtime.env.TELEGRAM_BOT_TOKEN,
    });
    if (profileResult.attempted) {
      logReconciliationSuccess("reconcile-profile");
    }
  } catch (err) {
    logTelegramEvent({
      message: "registration reconciliation failed",
      action: "reconcile-profile",
      module: "five-minute-telegram",
      err: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const menuResult = await reconcileTelegramMenuButton(runtime.db, {
      botToken: runtime.env.TELEGRAM_BOT_TOKEN,
    });
    if (menuResult.attempted) {
      logReconciliationSuccess("reconcile-menu", { miniAppUrl: menuResult.miniAppUrl });
    }
  } catch (err) {
    logTelegramEvent({
      message: "registration reconciliation failed",
      action: "reconcile-menu",
      module: "five-minute-telegram",
      err: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const result = await reconcileTelegramWebhookRegistration(runtime.db, {
      botToken: runtime.env.TELEGRAM_BOT_TOKEN,
      webhookSecret: runtime.env.TELEGRAM_WEBHOOK_SECRET,
      selfUrl: runtime.env.SELF_URL,
    });
    if (result.attempted) {
      logReconciliationSuccess("reconcile-webhook", { expectedUrl: result.expectedUrl });
    }
  } catch (err) {
    logTelegramEvent({
      message: "registration reconciliation failed",
      action: "reconcile-webhook",
      module: "five-minute-telegram",
      err: err instanceof Error ? err.message : String(err),
    });
  }

  await runScheduledSlotGroups(runtime, "five-minute telegram slot", buildTelegramSlotGroups(runtime));
}
