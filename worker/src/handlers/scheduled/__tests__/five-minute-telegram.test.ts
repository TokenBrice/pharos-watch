import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";

vi.mock("../../../cron/dispatch-telegram-alerts", () => ({ dispatchTelegramAlerts: vi.fn() }));
vi.mock("../../../cron/telegram-recap-planner", () => ({ planTelegramPersonalizedRecaps: vi.fn() }));
vi.mock("../../../cron/telegram-recap-store", () => ({ cancelQueuedTelegramRecapsForRollout: vi.fn() }));
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
vi.mock("../preflight-skip", () => ({ logSkippedCronRun: vi.fn(async () => undefined) }));

import { runFiveMinuteTelegramSlot } from "../five-minute-telegram";
import { logSkippedCronRun } from "../preflight-skip";
import { recordBudgetSurfaceTelemetry } from "../../../lib/budget-surface-telemetry";
import { dispatchTelegramAlerts } from "../../../cron/dispatch-telegram-alerts";
import { planTelegramPersonalizedRecaps } from "../../../cron/telegram-recap-planner";
import { cancelQueuedTelegramRecapsForRollout } from "../../../cron/telegram-recap-store";
import { publishTelegramPulseSnapshotWithOutcome } from "../../../api/telegram-pulse";
import { runTelegramDegradationWatchdog } from "../../../cron/telegram-degradation-watchdog";
import { cleanExpiredDisambiguations } from "../../../api/telegram-store/disambiguation";
import {
  reconcileTelegramCommandRegistration,
  reconcileTelegramMenuButton,
  reconcileTelegramProfileRegistration,
  reconcileTelegramWebhookRegistration,
} from "../../../lib/telegram-webhook-registration";

function buildRuntime(token?: string, recapRolloutMode: string = "public"): ScheduledRuntimeContext {
  return {
    db: {} as D1Database,
    env: (token
      ? { TELEGRAM_BOT_TOKEN: token, TELEGRAM_RECAP_ROLLOUT_MODE: recapRolloutMode }
      : { TELEGRAM_RECAP_ROLLOUT_MODE: recapRolloutMode }) as ScheduledRuntimeContext["env"],
    ctx: {} as ExecutionContext,
    cron: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
    scheduleKey: "fiveMinuteTelegramAlerts",
    scheduledTimeMs: null,
    slotStartedAt: 1_772_000_000,
    mintBurnDisabledIds: [],
    mintBurnDisabledSymbols: [],
    mintBurnFreshnessConfig: {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
    coingeckoApiKey: null,
    chainRpcs: new Map(),
    runLeasedCron: vi.fn(async (_job, fn) => fn(new AbortController().signal, vi.fn())),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(0);
  vi.mocked(dispatchTelegramAlerts).mockResolvedValue({ itemCount: 1, metadata: "{}" } as never);
  vi.mocked(planTelegramPersonalizedRecaps).mockResolvedValue({ itemCount: 0, metadata: "{}", status: "ok" } as never);
  vi.mocked(cancelQueuedTelegramRecapsForRollout).mockResolvedValue({ targetRowsCancelled: 0, pendingRowsDeleted: 0 });
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
  it("runs token-independent D1 sidecars when the bot token is absent", async () => {
    const runtime = buildRuntime();
    const summary = await runFiveMinuteTelegramSlot(runtime);

    expect(dispatchTelegramAlerts).not.toHaveBeenCalled();
    expect(planTelegramPersonalizedRecaps).not.toHaveBeenCalled();
    expect(runTelegramDegradationWatchdog).toHaveBeenCalledOnce();
    expect(cleanExpiredDisambiguations).toHaveBeenCalledOnce();
    expect(publishTelegramPulseSnapshotWithOutcome).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.runLeasedCron).mock.calls.map(([job]) => job)).toEqual([
      "telegram-degradation-watchdog",
      "telegram-disambiguation-cleanup",
      "telegram-pulse-snapshot",
    ]);
    expect(vi.mocked(logSkippedCronRun).mock.calls.map(([, options]) => options.job)).toEqual([
      "dispatch-telegram-alerts",
      "telegram-personalized-recap-planner",
    ]);
    expect(summary.jobs.map((job) => job.job)).toContain("dispatch-telegram-alerts");
    expect(summary.budgetOnlyJobs).toBe(1);
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "telegram-registration-reconciliation",
      dueCount: 4,
      outcome: "error",
      processedCount: 0,
      metadata: expect.objectContaining({ failedCount: 4, lastSuccessAt: null }),
    }));
  });

  it("runs the off-mode recap cleanup without a bot token and does not double-report it as skipped", async () => {
    const runtime = buildRuntime(undefined, "off");

    const summary = await runFiveMinuteTelegramSlot(runtime);

    expect(cancelQueuedTelegramRecapsForRollout).toHaveBeenCalledWith(
      runtime.db,
      expect.objectContaining({ mode: "off" }),
      0,
    );
    expect(planTelegramPersonalizedRecaps).not.toHaveBeenCalled();
    expect(vi.mocked(logSkippedCronRun).mock.calls.map(([, options]) => options.job)).toEqual([
      "dispatch-telegram-alerts",
    ]);
    expect(summary.jobs.filter((job) => job.job === "telegram-personalized-recap-planner")).toHaveLength(1);
  });

  it("runs dark recap projection without a bot token and does not report a token skip", async () => {
    const runtime = buildRuntime(undefined, "dark");

    await runFiveMinuteTelegramSlot(runtime);

    expect(planTelegramPersonalizedRecaps).toHaveBeenCalledWith(
      runtime.db,
      expect.any(AbortSignal),
      expect.objectContaining({ rolloutPolicy: expect.objectContaining({ mode: "dark" }) }),
    );
    expect(vi.mocked(logSkippedCronRun).mock.calls.map(([, options]) => options.job)).toEqual([
      "dispatch-telegram-alerts",
    ]);
  });

  it.each(["off", "canary"])(
    "cleans queued recaps before pending dispatch in %s mode",
    async (mode) => {
      const order: string[] = [];
      vi.mocked(cancelQueuedTelegramRecapsForRollout).mockImplementation(async () => {
        order.push("recap-cleanup");
        return { targetRowsCancelled: 1, pendingRowsDeleted: 1 };
      });
      vi.mocked(dispatchTelegramAlerts).mockImplementation(async () => {
        order.push("dispatch");
        return { itemCount: 1, metadata: "{}" } as never;
      });
      vi.mocked(planTelegramPersonalizedRecaps).mockImplementation(async () => {
        order.push("recap-plan");
        return { itemCount: 0, metadata: "{}", status: "ok" } as never;
      });

      await runFiveMinuteTelegramSlot(buildRuntime("token", mode));

      expect(order[0]).toBe("recap-cleanup");
      expect(order.indexOf("recap-cleanup")).toBeLessThan(order.indexOf("dispatch"));
      expect(cancelQueuedTelegramRecapsForRollout).toHaveBeenCalledOnce();
      expect(dispatchTelegramAlerts).toHaveBeenCalledOnce();
    },
  );

  it("fails pending dispatch closed when non-public recap cleanup fails", async () => {
    vi.mocked(cancelQueuedTelegramRecapsForRollout).mockRejectedValue(new Error("cleanup failed"));

    const summary = await runFiveMinuteTelegramSlot(buildRuntime("token", "off"));

    expect(dispatchTelegramAlerts).not.toHaveBeenCalled();
    expect(summary.jobs.find((job) => job.job === "dispatch-telegram-alerts")?.outcome).toBe("error");
    expect(runTelegramDegradationWatchdog).toHaveBeenCalledOnce();
    expect(cleanExpiredDisambiguations).toHaveBeenCalledOnce();
    expect(publishTelegramPulseSnapshotWithOutcome).toHaveBeenCalledOnce();
  });

  it("runs critical dispatch and sidecars before all registration units", async () => {
    const order: string[] = [];
    vi.mocked(dispatchTelegramAlerts).mockImplementation(async () => { order.push("dispatch"); return { itemCount: 1, metadata: "{}" } as never; });
    vi.mocked(planTelegramPersonalizedRecaps).mockImplementation(async () => { order.push("recap"); return { itemCount: 0, metadata: "{}", status: "ok" } as never; });
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
    const summary = await runFiveMinuteTelegramSlot(buildRuntime("token"));

    expect(summary.budgetOnlyJobs).toBe(1);
    expect(order).toEqual(["dispatch", "recap", "watchdog", "cleanup", "pulse", "commands", "profile", "menu", "webhook"]);
    expect(cancelQueuedTelegramRecapsForRollout).not.toHaveBeenCalled();
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

  it("defers recap planning when the risk-dispatch lease is locked", async () => {
    const runtime = buildRuntime("token");
    vi.mocked(runtime.runLeasedCron).mockImplementation(async (job, fn) => {
      if (job === "dispatch-telegram-alerts") return { status: "skipped_locked" } as never;
      return fn(new AbortController().signal, vi.fn());
    });

    const summary = await runFiveMinuteTelegramSlot(runtime);

    expect(dispatchTelegramAlerts).not.toHaveBeenCalled();
    expect(planTelegramPersonalizedRecaps).not.toHaveBeenCalled();
    expect(summary.jobs.find((job) => job.job === "telegram-personalized-recap-planner")).toMatchObject({
      outcome: "skipped",
      reason: "risk-dispatch-locked-or-incomplete",
      neutral: true,
    });
  });

  it("defers recap planning when risk dispatch consumes the shared slot budget", async () => {
    vi.mocked(Date.now)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(280_000)
      .mockReturnValue(280_000);

    const summary = await runFiveMinuteTelegramSlot(buildRuntime("token"));

    expect(dispatchTelegramAlerts).toHaveBeenCalledOnce();
    expect(planTelegramPersonalizedRecaps).not.toHaveBeenCalled();
    expect(summary.jobs.find((job) => job.job === "telegram-personalized-recap-planner")).toMatchObject({
      outcome: "skipped",
      reason: "risk-dispatch-consumed-slot-budget",
      neutral: true,
    });
  });

  it("defers recap planning after a risk-dispatch failure", async () => {
    vi.mocked(dispatchTelegramAlerts).mockRejectedValue(new Error("dispatch failed"));

    const summary = await runFiveMinuteTelegramSlot(buildRuntime("token"));

    expect(planTelegramPersonalizedRecaps).not.toHaveBeenCalled();
    expect(summary.jobs.find((job) => job.job === "dispatch-telegram-alerts")?.outcome).toBe("error");
    expect(summary.jobs.find((job) => job.job === "telegram-personalized-recap-planner")).toMatchObject({
      outcome: "skipped",
      reason: "risk-dispatch-failed",
      neutral: true,
    });
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

  it("degrades the telegram-pulse-snapshot sidecar when the snapshot write fails", async () => {
    vi.mocked(publishTelegramPulseSnapshotWithOutcome).mockResolvedValue({
      pulse: { quality: { status: "partial", unavailableFields: ["watcherHistory"] } },
      status: "error",
      snapshotPublished: false,
      heavySectionsRecomputed: true,
      heavyMarkerAdvanced: false,
      error: "simulated D1 cache write failure",
    } as never);

    const summary = await runFiveMinuteTelegramSlot(buildRuntime("token"));

    const pulseJob = summary.jobs.find((job) => job.job === "telegram-pulse-snapshot");
    expect(pulseJob?.outcome).toBe("error");
    expect(pulseJob?.itemCount).toBe(0);
    expect(pulseJob?.error).toContain("simulated D1 cache write failure");
    expect(summary.jobsErrored).toBeGreaterThanOrEqual(1);
  });

  it("records a failed registration unit without blocking the remaining units", async () => {
    vi.mocked(reconcileTelegramCommandRegistration).mockRejectedValue(new Error("registration failed"));
    await runFiveMinuteTelegramSlot(buildRuntime("token"));
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
