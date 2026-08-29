import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ScheduledRuntimeContext } from "../context";

vi.mock("../../../cron/daily-digest", () => ({
  generateDailyDigest: vi.fn(),
  resumeDailyDigestDelivery: vi.fn(),
}));
vi.mock("../../../lib/digest-safety-map", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/digest-safety-map")>()),
  resolveDigestSafetyMap: vi.fn(),
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
vi.mock("../../../lib/telegram-digest-outbox", () => ({
  drainTelegramDigestOutbox: vi.fn(),
}));

import { generateDailyDigest, resumeDailyDigestDelivery } from "../../../cron/daily-digest";
import {
  DIGEST_SAFETY_MAP_DEFERRAL_CACHE_KEY,
  resolveDigestSafetyMap,
} from "../../../lib/digest-safety-map";
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
    // Default: the shared leased path re-resolves the map; unavailable keeps
    // force-run tests on the plain generation branch.
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

  describe("safety-map deferral retries", () => {
    const AVAILABLE_MAP = {
      kind: "available" as const,
      imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-08-29",
      manifest: {
        date: "2026-08-29",
        asOfSec: 1_787_990_000,
        renderedAtSec: 1_787_991_000,
        edition: "daily" as const,
        bytes: { png: 1_000_000 },
      },
    };

    function mockCaches(values: Record<string, string>) {
      vi.mocked(getCache).mockImplementation(async (_db, key) => {
        const value = values[String(key)];
        return value ? { value, updatedAt: 0 } : null;
      });
    }

    function deferralPayload(overrides: Partial<{ date: string; reason: string; firstDeferredAtSec: number; attempts: number }> = {}): string {
      return JSON.stringify({
        date: "2026-08-29",
        reason: "manifest-not-today",
        firstDeferredAtSec: 1_787_990_000,
        attempts: 1,
        ...overrides,
      });
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-29T09:00:00Z"));
    });

    it("keeps waiting while today's map is still unavailable", async () => {
      mockCaches({ [DIGEST_SAFETY_MAP_DEFERRAL_CACHE_KEY]: deferralPayload() });
      vi.mocked(resolveDigestSafetyMap).mockResolvedValueOnce({ kind: "unavailable", reason: "manifest-not-today" });

      await runDigestTriggerPollSlot(buildRuntime());

      expect(runLeasedCron).not.toHaveBeenCalled();
      expect(deleteCache).not.toHaveBeenCalled();
      expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        skippedReason: "safety-map-still-unavailable",
      }));
    });

    it("retires a rolled-over deferral as a deliberately unsent day", async () => {
      mockCaches({ [DIGEST_SAFETY_MAP_DEFERRAL_CACHE_KEY]: deferralPayload({ date: "2026-08-28" }) });

      await runDigestTriggerPollSlot(buildRuntime());

      expect(resolveDigestSafetyMap).not.toHaveBeenCalled();
      expect(runLeasedCron).not.toHaveBeenCalled();
      expect(deleteCache).toHaveBeenCalledWith(expect.anything(), DIGEST_SAFETY_MAP_DEFERRAL_CACHE_KEY);
      expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        outcome: "error",
        error: "daily-digest-unsent:safety-map-never-published",
      }));
    });

    it("generates the digest once the map publishes and no row exists yet", async () => {
      mockCaches({ [DIGEST_SAFETY_MAP_DEFERRAL_CACHE_KEY]: deferralPayload() });
      vi.mocked(resolveDigestSafetyMap).mockResolvedValue(AVAILABLE_MAP);
      vi.mocked(resumeDailyDigestDelivery).mockResolvedValueOnce({ kind: "no-publishable-digest" });
      vi.mocked(generateDailyDigest).mockResolvedValueOnce({ itemCount: 1, metadata: "ok" });
      runLeasedCron.mockImplementation(async (_name: string, fn: (signal?: AbortSignal) => Promise<CronResult>) => fn());

      await runDigestTriggerPollSlot(buildRuntime());

      expect(resumeDailyDigestDelivery).toHaveBeenCalledWith(
        expect.anything(),
        null,
        null,
        AVAILABLE_MAP,
        undefined,
        undefined,
      );
      // force=false: the recency guard still applies to the deferred rerun.
      expect(vi.mocked(generateDailyDigest).mock.calls[0]?.[3]).toBe(false);
    });

    it("resumes stored-edition delivery instead of regenerating when a row exists", async () => {
      mockCaches({ [DIGEST_SAFETY_MAP_DEFERRAL_CACHE_KEY]: deferralPayload() });
      vi.mocked(resolveDigestSafetyMap).mockResolvedValue(AVAILABLE_MAP);
      vi.mocked(resumeDailyDigestDelivery).mockResolvedValueOnce({
        kind: "resumed",
        tweetStatus: "ok",
        telegramStatus: "outbox-drain",
        deliveryComplete: true,
      });
      runLeasedCron.mockImplementation(async (_name: string, fn: (signal?: AbortSignal) => Promise<CronResult>) => fn());

      await runDigestTriggerPollSlot(buildRuntime());

      expect(generateDailyDigest).not.toHaveBeenCalled();
      expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        outcome: "ok",
        metadata: expect.objectContaining({ deferralPending: true }),
      }));
    });
  });
});
