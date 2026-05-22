import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";

vi.mock("../../../cron/dispatch-telegram-alerts", () => ({
  dispatchTelegramAlerts: vi.fn(),
}));
vi.mock("../../../api/telegram-pulse", () => ({
  publishTelegramPulseSnapshot: vi.fn(),
}));
vi.mock("../../../cron/telegram-degradation-watchdog", () => ({
  runTelegramDegradationWatchdog: vi.fn(),
}));
vi.mock("../../../cron/telegram-quiet-hours", () => ({
  cleanExpiredDisambiguations: vi.fn(),
}));
vi.mock("../../../lib/telegram-webhook-registration", () => ({
  reconcileTelegramCommandRegistration: vi.fn(),
  reconcileTelegramMenuButton: vi.fn(),
  reconcileTelegramProfileRegistration: vi.fn(),
  reconcileTelegramWebhookRegistration: vi.fn(),
}));
vi.mock("../preflight-skip", () => ({
  logSkippedCronRun: vi.fn(async () => undefined),
}));

import { logSkippedCronRun } from "../preflight-skip";
import { runFiveMinuteTelegramSlot } from "../five-minute-telegram";

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
  });
});
