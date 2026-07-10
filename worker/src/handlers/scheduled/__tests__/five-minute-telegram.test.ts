import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";

vi.mock("../../../cron/dispatch-telegram-alerts", () => ({
  dispatchTelegramAlerts: vi.fn(),
}));
vi.mock("../../../api/telegram-pulse", () => ({
  publishTelegramPulseSnapshotWithOutcome: vi.fn(),
}));
vi.mock("../../../cron/telegram-degradation-watchdog", () => ({
  runTelegramDegradationWatchdog: vi.fn(),
}));
vi.mock("../../../api/telegram-store/disambiguation", () => ({
  cleanExpiredDisambiguations: vi.fn(),
}));
vi.mock("../../../lib/telegram-webhook-registration", () => ({
  reconcileTelegramCommandRegistration: vi.fn(),
  reconcileTelegramMenuButton: vi.fn(),
  reconcileTelegramProfileRegistration: vi.fn(),
  reconcileTelegramWebhookRegistration: vi.fn(),
}));
vi.mock("../../../lib/budget-surface-telemetry", () => ({
  recordBudgetSurfaceTelemetry: vi.fn(async () => {}),
}));
vi.mock("../preflight-skip", () => ({
  logSkippedCronRun: vi.fn(async () => undefined),
}));

import { logSkippedCronRun } from "../preflight-skip";
import { runFiveMinuteTelegramSlot } from "../five-minute-telegram";
import { recordBudgetSurfaceTelemetry } from "../../../lib/budget-surface-telemetry";
import { dispatchTelegramAlerts } from "../../../cron/dispatch-telegram-alerts";
import { publishTelegramPulseSnapshotWithOutcome } from "../../../api/telegram-pulse";
import { runTelegramDegradationWatchdog } from "../../../cron/telegram-degradation-watchdog";
import { cleanExpiredDisambiguations } from "../../../api/telegram-store/disambiguation";
import {
  reconcileTelegramCommandRegistration,
  reconcileTelegramMenuButton,
  reconcileTelegramProfileRegistration,
  reconcileTelegramWebhookRegistration,
} from "../../../lib/telegram-webhook-registration";

function buildRuntime(): ScheduledRuntimeContext {
  return {
    db: {} as D1Database,
    env: {} as ScheduledRuntimeContext["env"],
    ctx: {} as ExecutionContext,
    cron: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
    scheduleKey: "fiveMinuteTelegramAlerts",
    scheduledTimeMs: null,
    slotStartedAt: 1_772_000_000,
    mintBurnDisabledIds: [],
    mintBurnDisabledSymbols: [],
    mintBurnFreshnessConfig: {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
    coingeckoApiKey: null,
    alertWebhookUrl: null,
    chainRpcs: new Map(),
    runLeasedCron: vi.fn(),
  };
}

describe("runFiveMinuteTelegramSlot", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("records intentional preflight skips when the bot token is missing", async () => {
    await runFiveMinuteTelegramSlot(buildRuntime());

    expect(logSkippedCronRun).toHaveBeenCalledTimes(4);
    expect(vi.mocked(logSkippedCronRun).mock.calls.map(([, options]) => options.job)).toEqual([
      "dispatch-telegram-alerts",
      "telegram-degradation-watchdog",
      "telegram-disambiguation-cleanup",
      "telegram-pulse-snapshot",
    ]);
    expect(vi.mocked(logSkippedCronRun).mock.calls[0][1]).toMatchObject({
      reason: "missing-telegram-bot-token",
    });
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "telegram-registration-reconciliation",
      dueCount: 1,
      processedCount: 0,
      outcome: "skipped",
      skippedReason: "missing-telegram-bot-token",
    }));
  });

  it("runs reconciliation in order and still runs slot groups after a reconciliation failure", async () => {
    const order: string[] = [];
    vi.mocked(reconcileTelegramCommandRegistration).mockImplementation(async () => {
      order.push("reconcile-commands");
      return { attempted: true, skipped: false };
    });
    vi.mocked(reconcileTelegramProfileRegistration).mockImplementation(async () => {
      order.push("reconcile-profile");
      throw new Error("profile failed");
    });
    vi.mocked(reconcileTelegramMenuButton).mockImplementation(async () => {
      order.push("reconcile-menu");
      return { attempted: true, skipped: false, miniAppUrl: "https://pharos.watch/pharoswatchbot/app/" };
    });
    vi.mocked(reconcileTelegramWebhookRegistration).mockImplementation(async () => {
      order.push("reconcile-webhook");
      return { attempted: true, skipped: false, expectedUrl: "https://api.pharos.watch/api/telegram-webhook" };
    });
    vi.mocked(dispatchTelegramAlerts).mockImplementation(async () => {
      order.push("dispatch");
      return { itemCount: 1, metadata: "{}" };
    });
    vi.mocked(runTelegramDegradationWatchdog).mockImplementation(async () => {
      order.push("watchdog");
      return { itemCount: 0, metadata: "{}" };
    });
    vi.mocked(cleanExpiredDisambiguations).mockImplementation(async () => {
      order.push("cleanup");
      return { status: "ok", itemCount: 0 };
    });
    vi.mocked(publishTelegramPulseSnapshotWithOutcome).mockImplementation(async () => {
      order.push("pulse");
      return {
        pulse: { quality: { status: "complete", unavailableFields: [] } },
        status: "ok",
        snapshotPublished: true,
        heavySectionsRecomputed: false,
        heavyMarkerAdvanced: true,
        error: null,
      } as unknown as Awaited<ReturnType<typeof publishTelegramPulseSnapshotWithOutcome>>;
    });

    const runtime = buildRuntime();
    runtime.env = {
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      SELF_URL: "https://api.pharos.watch",
    } as ScheduledRuntimeContext["env"];
    const controller = new AbortController();
    runtime.slotSignal = controller.signal;
    runtime.runLeasedCron = vi.fn(async (_job, fn) =>
      fn(new AbortController().signal, vi.fn()),
    );

    const summary = await runFiveMinuteTelegramSlot(runtime);

    expect(order).toEqual([
      "reconcile-commands",
      "reconcile-profile",
      "reconcile-menu",
      "reconcile-webhook",
      "dispatch",
      "watchdog",
      "cleanup",
      "pulse",
    ]);
    expect(vi.mocked(runtime.runLeasedCron).mock.calls.map(([job]) => job)).toEqual([
      "dispatch-telegram-alerts",
      "telegram-degradation-watchdog",
      "telegram-disambiguation-cleanup",
      "telegram-pulse-snapshot",
    ]);
    expect(reconcileTelegramCommandRegistration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      botToken: "bot-token",
      signal: controller.signal,
    }));
    expect(reconcileTelegramProfileRegistration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      botToken: "bot-token",
      signal: controller.signal,
    }));
    expect(reconcileTelegramMenuButton).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      botToken: "bot-token",
      signal: controller.signal,
    }));
    expect(reconcileTelegramWebhookRegistration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      botToken: "bot-token",
      signal: controller.signal,
    }));
    expect(summary.jobs.map((job) => job.job)).toEqual([
      "dispatch-telegram-alerts",
      "telegram-degradation-watchdog",
      "telegram-disambiguation-cleanup",
      "telegram-pulse-snapshot",
    ]);
    expect(summary.jobsErrored).toBe(0);
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "telegram-registration-reconciliation",
      dueCount: 4,
      processedCount: 3,
      outcome: "error",
      metadata: expect.objectContaining({
        attemptedCount: 4,
        failedActions: ["reconcile-profile"],
      }),
    }));
  });
});
