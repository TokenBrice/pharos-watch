import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";

vi.mock("../../../cron/dispatch-telegram-alerts", () => ({ dispatchTelegramAlerts: vi.fn() }));
vi.mock("../../../api/telegram-pulse", () => ({ publishTelegramPulseSnapshotWithOutcome: vi.fn() }));
vi.mock("../../../cron/telegram-degradation-watchdog", () => ({ runTelegramDegradationWatchdog: vi.fn() }));
vi.mock("../../../api/telegram-store/disambiguation", () => ({ cleanExpiredDisambiguations: vi.fn() }));
vi.mock("../../../lib/telegram-webhook-registration", () => ({
  reconcileTelegramCommandRegistration: vi.fn(),
  reconcileTelegramMenuButton: vi.fn(),
  reconcileTelegramProfileRegistration: vi.fn(),
  reconcileTelegramWebhookRegistration: vi.fn(),
}));
vi.mock("../../../lib/budget-surface-telemetry", () => ({ recordBudgetSurfaceTelemetry: vi.fn(async () => {}) }));
vi.mock("../../../lib/alert-broker", () => ({
  dispatchPendingAlertBrokerDeliveries: vi.fn(async () => ({ due: 0, delivered: 0, failed: 0, missingTarget: 0 })),
}));
vi.mock("../preflight-skip", () => ({ logSkippedCronRun: vi.fn(async () => undefined) }));

import { runFiveMinuteTelegramSlot } from "../five-minute-telegram";
import { logSkippedCronRun } from "../preflight-skip";
import { recordBudgetSurfaceTelemetry } from "../../../lib/budget-surface-telemetry";
import { dispatchPendingAlertBrokerDeliveries } from "../../../lib/alert-broker";
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

function buildRuntime(token?: string): ScheduledRuntimeContext {
  return {
    db: {} as D1Database,
    env: (token ? { TELEGRAM_BOT_TOKEN: token } : {}) as ScheduledRuntimeContext["env"],
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
    runLeasedCron: vi.fn(async (_job, fn) => fn(new AbortController().signal, vi.fn())),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(0);
  vi.mocked(dispatchTelegramAlerts).mockResolvedValue({ itemCount: 1, metadata: "{}" } as never);
  vi.mocked(runTelegramDegradationWatchdog).mockResolvedValue({ itemCount: 0, metadata: "{}" } as never);
  vi.mocked(cleanExpiredDisambiguations).mockResolvedValue({ status: "ok", itemCount: 0 } as never);
  vi.mocked(publishTelegramPulseSnapshotWithOutcome).mockResolvedValue({
    pulse: { quality: { status: "complete", unavailableFields: [] } },
    status: "ok",
    snapshotPublished: true,
    heavySectionsRecomputed: false,
    heavyMarkerAdvanced: true,
    error: null,
  } as never);
  vi.mocked(reconcileTelegramCommandRegistration).mockResolvedValue({ attempted: true, skipped: false });
  vi.mocked(reconcileTelegramProfileRegistration).mockResolvedValue({ attempted: true, skipped: false });
  vi.mocked(reconcileTelegramMenuButton).mockResolvedValue({ attempted: true, skipped: false, miniAppUrl: "https://pharos.watch" });
  vi.mocked(reconcileTelegramWebhookRegistration).mockResolvedValue({ attempted: true, skipped: false, expectedUrl: "https://api.pharos.watch" });
});

afterEach(() => vi.restoreAllMocks());

describe("runFiveMinuteTelegramSlot", () => {
  it("runs token-independent D1 sidecars and broker drain when the bot token is absent", async () => {
    const runtime = buildRuntime();
    const summary = await runFiveMinuteTelegramSlot(runtime);

    expect(dispatchTelegramAlerts).not.toHaveBeenCalled();
    expect(runTelegramDegradationWatchdog).toHaveBeenCalledOnce();
    expect(cleanExpiredDisambiguations).toHaveBeenCalledOnce();
    expect(publishTelegramPulseSnapshotWithOutcome).toHaveBeenCalledOnce();
    expect(dispatchPendingAlertBrokerDeliveries).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.runLeasedCron).mock.calls.map(([job]) => job)).toEqual([
      "telegram-degradation-watchdog",
      "telegram-disambiguation-cleanup",
      "telegram-pulse-snapshot",
    ]);
    expect(vi.mocked(logSkippedCronRun).mock.calls.map(([, options]) => options.job)).toEqual([
      "dispatch-telegram-alerts",
    ]);
    expect(summary.jobs.map((job) => job.job)).toContain("dispatch-telegram-alerts");
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "telegram-registration-reconciliation",
      dueCount: 4,
      outcome: "error",
      processedCount: 0,
      metadata: expect.objectContaining({ failedCount: 4, lastSuccessAt: null }),
    }));
  });

  it("runs critical dispatch and sidecars before all registration units", async () => {
    const order: string[] = [];
    vi.mocked(dispatchTelegramAlerts).mockImplementation(async () => { order.push("dispatch"); return { itemCount: 1, metadata: "{}" } as never; });
    vi.mocked(runTelegramDegradationWatchdog).mockImplementation(async () => { order.push("watchdog"); return { itemCount: 0, metadata: "{}" } as never; });
    vi.mocked(cleanExpiredDisambiguations).mockImplementation(async () => { order.push("cleanup"); return { status: "ok", itemCount: 0 } as never; });
    vi.mocked(publishTelegramPulseSnapshotWithOutcome).mockImplementation(async () => {
      order.push("pulse");
      return { pulse: { quality: { status: "complete", unavailableFields: [] } }, status: "ok", snapshotPublished: true, heavySectionsRecomputed: false, heavyMarkerAdvanced: true, error: null } as never;
    });
    vi.mocked(reconcileTelegramCommandRegistration).mockImplementation(async () => {
      order.push("commands");
      return { attempted: true, skipped: false };
    });
    vi.mocked(reconcileTelegramProfileRegistration).mockImplementation(async () => {
      order.push("profile");
      return { attempted: true, skipped: false };
    });
    vi.mocked(reconcileTelegramMenuButton).mockImplementation(async () => {
      order.push("menu");
      return { attempted: true, skipped: false, miniAppUrl: "https://pharos.watch" };
    });
    vi.mocked(reconcileTelegramWebhookRegistration).mockImplementation(async () => {
      order.push("webhook");
      return { attempted: true, skipped: false, expectedUrl: "https://api.pharos.watch" };
    });
    vi.mocked(dispatchPendingAlertBrokerDeliveries).mockImplementation(async () => {
      order.push("broker");
      return { due: 0, delivered: 0, failed: 0, missingTarget: 0 };
    });

    await runFiveMinuteTelegramSlot(buildRuntime("token"));

    expect(order).toEqual(["dispatch", "watchdog", "cleanup", "pulse", "commands", "profile", "menu", "webhook", "broker"]);
    expect(reconcileTelegramCommandRegistration).toHaveBeenCalledOnce();
    expect(reconcileTelegramProfileRegistration).toHaveBeenCalledOnce();
    expect(reconcileTelegramMenuButton).toHaveBeenCalledOnce();
    expect(reconcileTelegramWebhookRegistration).toHaveBeenCalledOnce();
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "telegram-registration-reconciliation",
      dueCount: 4,
      processedCount: 4,
      outcome: "ok",
      metadata: expect.objectContaining({
        attemptedCount: 4,
        skippedCount: 0,
        succeededCount: 4,
        failedCount: 0,
        lastSuccessAt: 0,
      }),
    }));
  });

  it("does not refresh registration success when every unit is skipped", async () => {
    const skipped = {
      attempted: false,
      skipped: true,
      reason: "fresh-cache",
    } as const;
    vi.mocked(reconcileTelegramCommandRegistration).mockResolvedValue(skipped);
    vi.mocked(reconcileTelegramProfileRegistration).mockResolvedValue(skipped);
    vi.mocked(reconcileTelegramMenuButton).mockResolvedValue({ ...skipped, miniAppUrl: "https://pharos.watch" });
    vi.mocked(reconcileTelegramWebhookRegistration).mockResolvedValue({
      ...skipped,
      expectedUrl: "https://api.pharos.watch",
    });
    await runFiveMinuteTelegramSlot(buildRuntime("token"));
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "telegram-registration-reconciliation",
      processedCount: 0,
      outcome: "skipped",
      skippedReason: "fresh-cache",
      metadata: expect.objectContaining({
        attemptedCount: 0,
        skippedCount: 4,
        succeededCount: 0,
        failedCount: 0,
        lastSuccessAt: null,
      }),
    }));
  });

  it("records a failed registration unit without blocking the remaining units or broker drain", async () => {
    vi.mocked(reconcileTelegramCommandRegistration).mockRejectedValue(new Error("registration failed"));
    await runFiveMinuteTelegramSlot(buildRuntime("token"));
    expect(dispatchPendingAlertBrokerDeliveries).toHaveBeenCalledOnce();
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "telegram-registration-reconciliation",
      processedCount: 3,
      outcome: "error",
      metadata: expect.objectContaining({
        attemptedCount: 4,
        skippedCount: 0,
        succeededCount: 3,
        failedCount: 1,
        lastSuccessAt: 0,
      }),
    }));
  });
});
