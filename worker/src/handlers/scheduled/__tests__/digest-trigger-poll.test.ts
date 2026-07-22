import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ScheduledRuntimeContext } from "../context";

vi.mock("../../../cron/daily-digest", () => ({
  generateDailyDigest: vi.fn(),
}));
vi.mock("../../../lib/runtime-credentials", () => ({
  buildTwitterCreds: vi.fn(() => null),
  buildTelegramCreds: vi.fn(() => null),
}));
vi.mock("../../../lib/db-cache", () => ({
  getCache: vi.fn(),
  setCache: vi.fn(async () => {}),
  deleteCache: vi.fn(async () => {}),
}));
vi.mock("../../../lib/budget-surface-telemetry", () => ({
  recordBudgetSurfaceTelemetry: vi.fn(async () => {}),
}));
vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcomeSafe: vi.fn(async () => {}),
}));
vi.mock("../../../lib/telegram-digest-outbox", () => ({
  drainTelegramDigestOutbox: vi.fn(),
}));

import { generateDailyDigest } from "../../../cron/daily-digest";
import { deleteCache, getCache, setCache } from "../../../lib/db-cache";
import { recordBudgetSurfaceTelemetry } from "../../../lib/budget-surface-telemetry";
import { buildTelegramCreds, buildTwitterCreds } from "../../../lib/runtime-credentials";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../../lib/circuit-breaker";
import { drainTelegramDigestOutbox } from "../../../lib/telegram-digest-outbox";
import { runDigestTriggerPollSlot, DIGEST_LAST_TRIGGER_RESULT_CACHE_KEY } from "../digest-trigger-poll";
import { DIGEST_FORCE_RUN_CACHE_KEY } from "../../../api/admin-actions";

type CronResult = { status?: string; metadata?: string; itemCount?: number };

describe("runDigestTriggerPollSlot", () => {
  let runLeasedCron: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    runLeasedCron = vi.fn();
    vi.mocked(buildTelegramCreds).mockReturnValue(null);
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    vi.mocked(drainTelegramDigestOutbox).mockResolvedValue({
      due: 0,
      attempted: 0,
      sent: 0,
      pending: 0,
      executionUnknown: 0,
      failedPermanent: 0,
      skipped: 0,
      staleSendingReconciled: 0,
      retainedExecutionUnknown: 0,
      retainedFailedPermanent: 0,
      prunedSent: 0,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function buildRuntime(): ScheduledRuntimeContext {
    return {
      db: {} as D1Database,
      env: { ANTHROPIC_API_KEY: "anthropic-key" } as ScheduledRuntimeContext["env"],
      ctx: {} as ExecutionContext,
      cron: "*/5 * * * *",
      scheduleKey: "digestTriggerPoll" as ScheduledRuntimeContext["scheduleKey"],
      scheduledTimeMs: null,
      slotStartedAt: 0,
      mintBurnDisabledIds: [],
      mintBurnDisabledSymbols: [],
      mintBurnFreshnessConfig: {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
      coingeckoApiKey: null,
      chainRpcs: new Map(),
      runLeasedCron: runLeasedCron as unknown as ScheduledRuntimeContext["runLeasedCron"],
    };
  }

  it("is a no-op when the force-run cache key is absent", async () => {
    vi.mocked(getCache).mockResolvedValueOnce(null);

    const summary = await runDigestTriggerPollSlot(buildRuntime());

    expect(runLeasedCron).not.toHaveBeenCalled();
    expect(deleteCache).not.toHaveBeenCalled();
    expect(setCache).not.toHaveBeenCalled();
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "digest-trigger-poll",
      dueCount: 0,
      processedCount: 0,
      outcome: "skipped",
      skippedReason: "no-pending-request",
    }));
    expect(summary).toMatchObject({
      jobsAttempted: 0,
      jobsSucceeded: 0,
      jobsSkipped: 0,
      jobsNeutralSkipped: 1,
      jobsDegraded: 0,
      jobsErrored: 0,
      budgetOnlyJobs: 2,
      jobs: [
        {
          job: "digest-trigger-poll",
          outcome: "skipped",
          reason: "no-pending-request",
          neutral: true,
        },
      ],
    });
  });

  it("surfaces retained terminal rows without feeding a no-attempt failure into the circuit", async () => {
    vi.mocked(buildTelegramCreds).mockReturnValue({ botToken: "bot", chatId: "channel" });
    vi.mocked(drainTelegramDigestOutbox).mockResolvedValueOnce({
      due: 0,
      attempted: 0,
      sent: 0,
      pending: 0,
      executionUnknown: 0,
      failedPermanent: 0,
      skipped: 0,
      staleSendingReconciled: 0,
      retainedExecutionUnknown: 1,
      retainedFailedPermanent: 2,
      prunedSent: 0,
    });
    vi.mocked(getCache).mockResolvedValueOnce(null);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(drainTelegramDigestOutbox).toHaveBeenCalledTimes(1);
    expect(recordOutcomeSafe).not.toHaveBeenCalled();
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        surface: "telegram-digest-outbox-drain",
        dueCount: 0,
        processedCount: 0,
        outcome: "degraded",
      }),
    );
  });

  it("drains a stored Telegram edition without invoking digest generation", async () => {
    vi.mocked(buildTelegramCreds).mockReturnValue({ botToken: "bot", chatId: "channel" });
    vi.mocked(drainTelegramDigestOutbox).mockResolvedValueOnce({
      due: 1,
      attempted: 1,
      sent: 1,
      pending: 0,
      executionUnknown: 0,
      failedPermanent: 0,
      skipped: 0,
      staleSendingReconciled: 0,
      retainedExecutionUnknown: 0,
      retainedFailedPermanent: 0,
      prunedSent: 0,
    });
    vi.mocked(getCache).mockResolvedValueOnce(null);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(drainTelegramDigestOutbox).toHaveBeenCalledTimes(1);
    expect(generateDailyDigest).not.toHaveBeenCalled();
    expect(runLeasedCron).not.toHaveBeenCalled();
    expect(recordOutcomeSafe).toHaveBeenCalledWith(expect.anything(), "telegram-api", true);
  });

  it("does not attribute a drain infrastructure exception to the Telegram provider", async () => {
    vi.mocked(buildTelegramCreds).mockReturnValue({ botToken: "bot", chatId: "channel" });
    vi.mocked(drainTelegramDigestOutbox).mockRejectedValueOnce(new Error("D1 unavailable"));
    vi.mocked(getCache).mockResolvedValueOnce(null);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(recordOutcomeSafe).not.toHaveBeenCalled();
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        surface: "telegram-digest-outbox-drain",
        outcome: "error",
        error: "D1 unavailable",
      }),
    );
  });

  it("clears a malformed payload without running the digest", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({ value: "not-json", updatedAt: 0 });

    const summary = await runDigestTriggerPollSlot(buildRuntime());

    expect(runLeasedCron).not.toHaveBeenCalled();
    expect(deleteCache).toHaveBeenCalledWith(expect.anything(), DIGEST_FORCE_RUN_CACHE_KEY);
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "digest-trigger-poll",
      dueCount: 1,
      processedCount: 1,
      outcome: "error",
      error: "malformed-payload",
    }));
    expect(summary.jobsSkipped).toBe(1);
    expect(summary.jobsNeutralSkipped).toBe(0);
  });

  it("runs daily-digest with force=true and clears the flag on success", async () => {
    vi.mocked(buildTwitterCreds).mockReturnValueOnce({
      apiKey: "tw-key",
      apiSecret: "tw-secret",
      accessToken: "tw-token",
      accessTokenSecret: "tw-token-secret",
    });
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify({ requestedAt: 1_700_000_000, requestId: "manual-digest-abc" }),
      updatedAt: 1_700_000_000,
    });
    runLeasedCron.mockImplementationOnce(async (_job, fn) => {
      await fn(new AbortController().signal, async () => {});
      return { status: "ok", itemCount: 1, metadata: "" } as CronResult;
    });

    await runDigestTriggerPollSlot(buildRuntime());

    expect(runLeasedCron).toHaveBeenCalledTimes(1);
    expect(runLeasedCron.mock.calls[0][0]).toBe("daily-digest");
    expect(generateDailyDigest).toHaveBeenCalledTimes(1);
    const digestArgs = vi.mocked(generateDailyDigest).mock.calls[0];
    // (db, anthropicApiKey, twitterCreds, force, telegramCreds, signal)
    expect(digestArgs[2]).toEqual({
      apiKey: "tw-key",
      apiSecret: "tw-secret",
      accessToken: "tw-token",
      accessTokenSecret: "tw-token-secret",
    });
    expect(digestArgs[3]).toBe(true);

    expect(deleteCache).toHaveBeenCalledWith(expect.anything(), DIGEST_FORCE_RUN_CACHE_KEY);
    expect(setCache).toHaveBeenCalledWith(
      expect.anything(),
      DIGEST_LAST_TRIGGER_RESULT_CACHE_KEY,
      expect.any(String),
    );
    const lastResultCall = vi.mocked(setCache).mock.calls.find(([, key]) =>
      key === DIGEST_LAST_TRIGGER_RESULT_CACHE_KEY
    );
    expect(lastResultCall).toBeTruthy();
    const lastResult = JSON.parse(lastResultCall?.[2] as string) as {
      outcome: string;
      requestId: string;
    };
    expect(lastResult.outcome).toBe("ok");
    expect(lastResult.requestId).toBe("manual-digest-abc");
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "digest-trigger-poll",
      dueCount: 1,
      processedCount: 1,
      outcome: "ok",
      metadata: expect.objectContaining({
        requestId: "manual-digest-abc",
        flagCleared: true,
      }),
    }));
  });

  it("preserves the flag when the daily-digest lease is skipped_locked", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify({ requestedAt: 1_700_000_000, requestId: "manual-digest-locked" }),
      updatedAt: 1_700_000_000,
    });
    runLeasedCron.mockResolvedValueOnce({ status: "skipped_locked", metadata: "" } as CronResult);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(runLeasedCron).toHaveBeenCalledTimes(1);
    expect(deleteCache).not.toHaveBeenCalled();

    const lastResultCall = vi.mocked(setCache).mock.calls.find(([, key]) =>
      key === DIGEST_LAST_TRIGGER_RESULT_CACHE_KEY
    );
    expect(lastResultCall).toBeTruthy();
    const lastResult = JSON.parse(lastResultCall?.[2] as string) as { outcome: string };
    expect(lastResult.outcome).toBe("skipped_locked");
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "digest-trigger-poll",
      dueCount: 1,
      processedCount: 0,
      outcome: "skipped",
      skippedReason: "daily-digest-lease-locked",
    }));
  });

  it("records the error outcome and still clears the flag when the digest throws", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify({ requestedAt: 1_700_000_000, requestId: "manual-digest-err" }),
      updatedAt: 1_700_000_000,
    });
    runLeasedCron.mockRejectedValueOnce(new Error("upstream blew up"));

    await runDigestTriggerPollSlot(buildRuntime());

    expect(deleteCache).toHaveBeenCalledWith(expect.anything(), DIGEST_FORCE_RUN_CACHE_KEY);
    const lastResultCall = vi.mocked(setCache).mock.calls.find(([, key]) =>
      key === DIGEST_LAST_TRIGGER_RESULT_CACHE_KEY
    );
    expect(lastResultCall).toBeTruthy();
    const lastResult = JSON.parse(lastResultCall?.[2] as string) as {
      outcome: string;
      error: string | null;
    };
    expect(lastResult.outcome).toBe("error");
    expect(lastResult.error).toContain("upstream blew up");
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "digest-trigger-poll",
      dueCount: 1,
      processedCount: 1,
      outcome: "error",
      error: "upstream blew up",
    }));
  });

  it("reports degraded outcome when digest returned status=degraded", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify({ requestedAt: 1_700_000_000, requestId: "manual-digest-deg" }),
      updatedAt: 1_700_000_000,
    });
    runLeasedCron.mockResolvedValueOnce({ status: "degraded", itemCount: 1, metadata: "" } as CronResult);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(deleteCache).toHaveBeenCalled();
    const lastResultCall = vi.mocked(setCache).mock.calls.find(([, key]) =>
      key === DIGEST_LAST_TRIGGER_RESULT_CACHE_KEY
    );
    expect(lastResultCall).toBeTruthy();
    const lastResult = JSON.parse(lastResultCall?.[2] as string) as { outcome: string };
    expect(lastResult.outcome).toBe("degraded");
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "digest-trigger-poll",
      outcome: "degraded",
    }));
  });
});
