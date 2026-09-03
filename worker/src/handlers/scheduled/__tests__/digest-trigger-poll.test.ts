import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

vi.mock("../../../cron/daily-digest", () => ({
  generateDailyDigest: vi.fn(),
  resumeDailyDigestDelivery: vi.fn(),
}));
vi.mock("../../../cron/weekly-recap", () => ({
  generateWeeklyRecap: vi.fn(),
}));
vi.mock("../../../lib/digest-safety-map", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/digest-safety-map")>()),
  resolveDigestSafetyMap: vi.fn(),
}));
vi.mock("../../../lib/runtime-credentials", () => ({
  buildTwitterCreds: vi.fn(() => null),
  buildTelegramCreds: vi.fn(() => null),
  missingTwitterCredentialNames: vi.fn(() => ["TWITTER_API_KEY"]),
  missingTelegramCredentialNames: vi.fn(() => ["TELEGRAM_BOT_TOKEN"]),
}));
vi.mock("../../../lib/db-cache", () => ({
  getCache: vi.fn(),
  setCache: vi.fn(async () => {}),
  deleteCache: vi.fn(async () => {}),
}));
vi.mock("../../../lib/budget-surface-telemetry", () => ({
  recordBudgetSurfaceTelemetry: vi.fn(async () => {}),
}));
vi.mock("../../../lib/telegram-digest-outbox", () => ({
  drainTelegramDigestOutbox: vi.fn(),
}));

import { generateDailyDigest, resumeDailyDigestDelivery } from "../../../cron/daily-digest";
import { resolveDigestSafetyMap } from "../../../lib/digest-safety-map";
import { deleteCache, getCache, setCache } from "../../../lib/db-cache";
import { recordBudgetSurfaceTelemetry } from "../../../lib/budget-surface-telemetry";
import { buildTelegramCreds, buildTwitterCreds } from "../../../lib/runtime-credentials";
import { drainTelegramDigestOutbox } from "../../../lib/telegram-digest-outbox";
import {
  DIGEST_LAST_TRIGGER_RESULT_CACHE_KEY,
  DIGEST_TRIGGER_POLL_INTERVAL_SECONDS,
  MAX_ATTEMPTS,
  runDigestTriggerPollSlot,
} from "../digest-trigger-poll";
import { DIGEST_FORCE_RUN_CACHE_KEY } from "../../../api/admin-actions";
import { generateWeeklyRecap } from "../../../cron/weekly-recap";

type CronResult = { status?: string; metadata?: string; itemCount?: number };
type DigestForceRunIntent = {
  requestedAt: number;
  requestId: string;
  attempts: number;
  nextAttemptAt: number;
  state: "pending" | "running" | "succeeded" | "failed_transient" | "dead_letter";
  lastError: string | null;
};

function buildIntent(
  requestId: string,
  overrides: Partial<DigestForceRunIntent> = {},
): DigestForceRunIntent {
  return {
    requestedAt: 1_700_000_000,
    requestId,
    attempts: 0,
    nextAttemptAt: 1_700_000_000,
    state: "pending",
    lastError: null,
    ...overrides,
  };
}

describe("runDigestTriggerPollSlot", () => {
  let runLeasedCron: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    runLeasedCron = vi.fn();
    vi.mocked(buildTelegramCreds).mockReturnValue(null);
    vi.mocked(resumeDailyDigestDelivery).mockResolvedValue({ kind: "no-publishable-digest" });
    vi.mocked(resolveDigestSafetyMap).mockResolvedValue({ kind: "unavailable", reason: "manifest-http-404" });
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
    vi.useRealTimers();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function latestIntentWrite(): DigestForceRunIntent | null {
    const calls = vi.mocked(setCache).mock.calls.filter(([, key]) => key === DIGEST_FORCE_RUN_CACHE_KEY);
    const value = calls[calls.length - 1]?.[2];
    return value ? JSON.parse(value) as DigestForceRunIntent : null;
  }

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

  it("surfaces retained terminal rows from the authoritative outbox drain", async () => {
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
  });

  it("does not attribute a drain infrastructure exception to the Telegram provider", async () => {
    vi.mocked(buildTelegramCreds).mockReturnValue({ botToken: "bot", chatId: "channel" });
    vi.mocked(drainTelegramDigestOutbox).mockRejectedValueOnce(new Error("D1 unavailable"));
    vi.mocked(getCache).mockResolvedValueOnce(null);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        surface: "telegram-digest-outbox-drain",
        outcome: "error",
        error: "D1 unavailable",
      }),
    );
  });

  it("dead-letters a malformed payload without running the digest", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({ value: "not-json", updatedAt: 0 });

    const summary = await runDigestTriggerPollSlot(buildRuntime());

    expect(runLeasedCron).not.toHaveBeenCalled();
    expect(deleteCache).not.toHaveBeenCalled();
    expect(latestIntentWrite()).toMatchObject({
      state: "dead_letter",
      attempts: 0,
      lastError: "malformed-payload",
    });
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "digest-trigger-poll",
      dueCount: 1,
      processedCount: 1,
      outcome: "error",
      error: "malformed-payload",
      metadata: expect.objectContaining({ deadLettered: true }),
    }));
    expect(summary.jobsSkipped).toBe(1);
    expect(summary.jobsNeutralSkipped).toBe(0);
  });

  it("runs daily-digest with force=true and clears the intent on success", async () => {
    vi.mocked(buildTwitterCreds).mockReturnValueOnce({
      apiKey: "tw-key",
      apiSecret: "tw-secret",
      accessToken: "tw-token",
      accessTokenSecret: "tw-token-secret",
    });
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify(buildIntent("manual-digest-abc")),
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
    expect(latestIntentWrite()).toMatchObject({
      requestId: "manual-digest-abc",
      state: "succeeded",
      attempts: 0,
      lastError: null,
    });
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
        intentCleared: true,
      }),
    }));
  });

  it("preserves the intent when the daily-digest lease is skipped_locked", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify(buildIntent("manual-digest-locked")),
      updatedAt: 1_700_000_000,
    });
    runLeasedCron.mockResolvedValueOnce({ status: "skipped_locked", metadata: "" } as CronResult);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(runLeasedCron).toHaveBeenCalledTimes(1);
    expect(deleteCache).not.toHaveBeenCalled();
    expect(latestIntentWrite()).toBeNull();

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

  it("retries transient failures with backoff then dead-letters after MAX_ATTEMPTS", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_800_000_000 * 1000));
    const firstIntent = buildIntent("manual-digest-transient");
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify(firstIntent),
      updatedAt: firstIntent.requestedAt,
    });
    runLeasedCron.mockRejectedValueOnce(new Error("network timeout"));

    await runDigestTriggerPollSlot(buildRuntime());

    const retryOne = latestIntentWrite();
    expect(retryOne).toMatchObject({
      requestId: firstIntent.requestId,
      attempts: 1,
      state: "failed_transient",
      lastError: "network timeout",
    });
    expect(retryOne?.nextAttemptAt).toBe(
      1_800_000_000 + 2 * DIGEST_TRIGGER_POLL_INTERVAL_SECONDS,
    );
    expect(deleteCache).not.toHaveBeenCalled();

    vi.setSystemTime(new Date((retryOne?.nextAttemptAt ?? 0) * 1000));
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify(retryOne),
      updatedAt: retryOne?.nextAttemptAt ?? 0,
    });
    runLeasedCron.mockRejectedValueOnce(new Error("D1 unavailable"));

    await runDigestTriggerPollSlot(buildRuntime());

    const retryTwo = latestIntentWrite();
    expect(retryTwo).toMatchObject({
      attempts: 2,
      state: "failed_transient",
      lastError: "D1 unavailable",
    });
    expect(retryTwo?.nextAttemptAt).toBe(
      1_800_000_000 + 2 * DIGEST_TRIGGER_POLL_INTERVAL_SECONDS * 3,
    );

    vi.setSystemTime(new Date((retryTwo?.nextAttemptAt ?? 0) * 1000));
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify(retryTwo),
      updatedAt: retryTwo?.nextAttemptAt ?? 0,
    });
    runLeasedCron.mockRejectedValueOnce(new Error("Anthropic 503"));

    await runDigestTriggerPollSlot(buildRuntime());

    expect(latestIntentWrite()).toMatchObject({
      attempts: MAX_ATTEMPTS,
      state: "dead_letter",
      lastError: "Anthropic 503",
    });
    expect(deleteCache).not.toHaveBeenCalled();
  });

  it("dead-letters a permanent failure immediately", async () => {
    const intent = buildIntent("manual-digest-permanent");
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify(intent),
      updatedAt: intent.requestedAt,
    });
    runLeasedCron.mockRejectedValueOnce(new Error("validation failed: invalid prompt"));

    await runDigestTriggerPollSlot(buildRuntime());

    expect(latestIntentWrite()).toMatchObject({
      requestId: intent.requestId,
      attempts: 1,
      state: "dead_letter",
      lastError: "validation failed: invalid prompt",
    });
    expect(deleteCache).not.toHaveBeenCalled();
  });

  it("reports degraded outcome when digest returned status=degraded", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify(buildIntent("manual-digest-deg")),
      updatedAt: 1_700_000_000,
    });
    runLeasedCron.mockResolvedValueOnce({ status: "degraded", itemCount: 1, metadata: "" } as CronResult);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(deleteCache).not.toHaveBeenCalled();
    expect(latestIntentWrite()).toMatchObject({
      state: "failed_transient",
      attempts: 1,
      lastError: "daily-digest returned status degraded",
    });
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

  it("resumes a missing weekly recap on Monday after 08:10", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T09:00:00Z"));
    vi.mocked(getCache).mockResolvedValueOnce(null);
    vi.mocked(generateWeeklyRecap).mockResolvedValueOnce({ itemCount: 1, metadata: "weekly ok" });
    const db = makeNoopD1({
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ first: vi.fn(async () => null) })),
      })),
    });
    runLeasedCron.mockImplementationOnce(async (_job, fn) => {
      await fn(new AbortController().signal, async () => {});
      return { itemCount: 1, metadata: "weekly ok" } as CronResult;
    });
    const runtime = buildRuntime();
    runtime.db = db;
    runtime.slotStartedAt = Math.floor(Date.parse("2026-08-31T09:00:00Z") / 1000);

    const summary = await runDigestTriggerPollSlot(runtime);

    expect(runLeasedCron).toHaveBeenCalledWith("weekly-recap", expect.any(Function));
    expect(generateWeeklyRecap).toHaveBeenCalledWith(
      db,
      "anthropic-key",
      null,
      null,
      expect.any(AbortSignal),
      expect.any(Function),
      runtime.slotStartedAt,
      expect.objectContaining({
        twitterMissing: expect.any(Array),
        telegramMissing: expect.any(Array),
      }),
      // Weekly LLM config resolved from runtime env, then the recap rollout
      // policy that gates the private /recap CTA.
      expect.any(Object),
      expect.any(Object),
    );
    expect(summary.jobs).toEqual([
      expect.objectContaining({ job: "weekly-recap", outcome: "ok" }),
    ]);
  });

});
