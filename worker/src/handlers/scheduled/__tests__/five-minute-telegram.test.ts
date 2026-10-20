import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { observeMockD1Cost } from "../../../lib/__tests__/d1-cost.test-support";
import type { CronResult } from "../../../lib/cron-logger";

vi.mock("../../../cron/telegram/dispatch/dispatch-telegram-alerts", () => ({ dispatchTelegramAlerts: vi.fn() }));
vi.mock("../../../telegram/webhook/telegram-pulse", () => ({ publishTelegramPulseSnapshotWithOutcome: vi.fn() }));
vi.mock("../../../cron/telegram/maintenance/telegram-degradation-watchdog", () => ({ runTelegramDegradationWatchdog: vi.fn() }));
vi.mock("../../../telegram/store/disambiguation", () => ({ cleanExpiredDisambiguations: vi.fn() }));
vi.mock("../../../telegram/webhook/webhook-registration", () => ({
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
import { dispatchTelegramAlerts } from "../../../cron/telegram/dispatch/dispatch-telegram-alerts";
import { publishTelegramPulseSnapshotWithOutcome } from "../../../telegram/webhook/telegram-pulse";
import { runTelegramDegradationWatchdog } from "../../../cron/telegram/maintenance/telegram-degradation-watchdog";
import { cleanExpiredDisambiguations } from "../../../telegram/store/disambiguation";
import {
  reconcileTelegramCommandRegistration,
  reconcileTelegramMenuButton,
  reconcileTelegramProfileRegistration,
  reconcileTelegramWebhookRegistration,
} from "../../../telegram/webhook/webhook-registration";

function buildRuntime(token?: string): ScheduledRuntimeContext {
  return makeScheduledRuntime({
    db: {} as D1Database,
    env: (token ? { TELEGRAM_BOT_TOKEN: token } : {}) as ScheduledRuntimeContext["env"],
    cron: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
    scheduleKey: "fiveMinuteTelegramAlerts",
    scheduledTimeMs: null,
    slotStartedAt: 1_772_000_000,
  });
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

  it("emits pulse D1 costs while retaining publication results and SQL errors", async () => {
    const rows = [{ id: "pulse-evidence" }];
    const failure = new Error("original pulse SQL failure");
    const db = mockD1([
      { match: "SELECT pulse_evidence", rows },
      { match: "UPDATE pulse_cache", rows: [] },
      { match: "SELECT failed_pulse", rows: [], throwError: failure },
    ]);
    const assertCost = observeMockD1Cost(db);
    const runtime = buildRuntime();
    runtime.db = db;
    const published = {
      pulse: { quality: { status: "complete", unavailableFields: [] } },
      status: "ok", snapshotPublished: true, heavySectionsRecomputed: false,
      heavyMarkerAdvanced: true, error: null,
    };
    vi.mocked(publishTelegramPulseSnapshotWithOutcome).mockImplementationOnce(async (trackedDb) => {
      expect((await trackedDb.prepare("SELECT pulse_evidence").all()).results).toBe(rows);
      await trackedDb.batch([trackedDb.prepare("UPDATE pulse_cache"), trackedDb.prepare("UPDATE pulse_cache")]);
      await expect(trackedDb.prepare("SELECT failed_pulse").all()).rejects.toBe(failure);
      return published as never;
    });
    let pulseResult: CronResult | undefined;
    const runLeasedCron = runtime.runLeasedCron;
    runtime.runLeasedCron = vi.fn(async (job, run) => {
      const result = await runLeasedCron(job, run);
      if (job === "telegram-pulse-snapshot" && result) pulseResult = result;
      return result;
    });
    const summary = await runFiveMinuteTelegramSlot(runtime);
    expect(summary.jobs.find((job) => job.job === "telegram-pulse-snapshot")).toMatchObject({ outcome: "ok", itemCount: 1 });
    expect(pulseResult).toBeDefined();
    expect(assertCost(pulseResult!)).toMatchObject({ queries: 4, bindingCalls: 3, batchCalls: 1 });
    expect(JSON.parse(pulseResult!.metadata!)).toMatchObject({
      snapshotPublished: true, heavySectionsRecomputed: false, heavyMarkerAdvanced: true, qualityStatus: "complete",
    });
  });

  it("measures registration duration without the preceding critical lane", async () => {
    let now = 0;
    vi.mocked(Date.now).mockImplementation(() => now);
    vi.mocked(dispatchTelegramAlerts).mockImplementation(async () => {
      now += 40_000;
      return { itemCount: 1, metadata: "{}" };
    });
    vi.mocked(runTelegramDegradationWatchdog).mockImplementation(async () => {
      now += 5_000;
      return { itemCount: 0, metadata: "{}" };
    });
    const complete = () => { now += 125; return { attempted: true, skipped: false }; };
    vi.mocked(reconcileTelegramCommandRegistration).mockImplementation(async () => complete());
    vi.mocked(reconcileTelegramProfileRegistration).mockImplementation(async () => complete());
    vi.mocked(reconcileTelegramMenuButton).mockImplementation(async () => ({ ...complete(), miniAppUrl: "https://pharos.watch" }));
    vi.mocked(reconcileTelegramWebhookRegistration).mockImplementation(async () => ({ ...complete(), expectedUrl: "https://api.pharos.watch" }));

    await runFiveMinuteTelegramSlot(buildRuntime("token"));

    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      durationMs: 500, dueCount: 4, processedCount: 4, outcome: "ok",
    }));
  });

  it("measures cached registration checks independently of critical-lane duration", async () => {
    let now = 0;
    vi.mocked(Date.now).mockImplementation(() => now);
    vi.mocked(dispatchTelegramAlerts).mockImplementation(async () => {
      now += 40_000;
      return { itemCount: 1, metadata: "{}" };
    });
    const skip = () => { now += 10; return { attempted: false, skipped: true, reason: "fresh-cache" as const }; };
    vi.mocked(reconcileTelegramCommandRegistration).mockImplementation(async () => skip());
    vi.mocked(reconcileTelegramProfileRegistration).mockImplementation(async () => skip());
    vi.mocked(reconcileTelegramMenuButton).mockImplementation(async () => ({ ...skip(), miniAppUrl: "https://pharos.watch" }));
    vi.mocked(reconcileTelegramWebhookRegistration).mockImplementation(async () => ({ ...skip(), expectedUrl: "https://api.pharos.watch" }));

    await runFiveMinuteTelegramSlot(buildRuntime("token"));

    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      durationMs: 40, processedCount: 0, outcome: "skipped", skippedReason: "fresh-cache",
      metadata: expect.objectContaining({ skippedCount: 4, lastSuccessAt: null }),
    }));
  });

  it("retains missing-token timing before token-independent sidecars", async () => {
    let now = 0;
    vi.mocked(Date.now).mockImplementation(() => now);
    vi.mocked(logSkippedCronRun)
      .mockImplementationOnce(async () => { now += 25; });
    vi.mocked(runTelegramDegradationWatchdog).mockImplementation(async () => {
      now += 10_000;
      return { itemCount: 0, metadata: "{}" };
    });

    await runFiveMinuteTelegramSlot(buildRuntime());

    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      durationMs: 25, outcome: "error", metadata: expect.objectContaining({ failedCount: 4 }),
    }));
    expect(reconcileTelegramCommandRegistration).not.toHaveBeenCalled();
    expect(reconcileTelegramProfileRegistration).not.toHaveBeenCalled();
    expect(reconcileTelegramMenuButton).not.toHaveBeenCalled();
    expect(reconcileTelegramWebhookRegistration).not.toHaveBeenCalled();
    expect(runTelegramDegradationWatchdog).toHaveBeenCalledOnce();
    expect(publishTelegramPulseSnapshotWithOutcome).toHaveBeenCalledOnce();
  });

  it("runs token-independent D1 sidecars when the bot token is absent", async () => {
    const runtime = buildRuntime();
    const summary = await runFiveMinuteTelegramSlot(runtime);

    expect(dispatchTelegramAlerts).not.toHaveBeenCalled();
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
    const summary = await runFiveMinuteTelegramSlot(buildRuntime("token"));

    expect(summary.budgetOnlyJobs).toBe(1);
    expect(order).toEqual(["dispatch", "watchdog", "cleanup", "pulse", "commands", "profile", "menu", "webhook"]);
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
