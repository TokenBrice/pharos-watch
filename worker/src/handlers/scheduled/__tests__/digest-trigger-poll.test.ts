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

import { generateDailyDigest } from "../../../cron/daily-digest";
import { deleteCache, getCache, setCache } from "../../../lib/db-cache";
import { buildTwitterCreds } from "../../../lib/runtime-credentials";
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
      alertWebhookUrl: null,
      chainRpcs: new Map(),
      runLeasedCron: runLeasedCron as unknown as ScheduledRuntimeContext["runLeasedCron"],
    };
  }

  it("is a no-op when the force-run cache key is absent", async () => {
    vi.mocked(getCache).mockResolvedValueOnce(null);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(runLeasedCron).not.toHaveBeenCalled();
    expect(deleteCache).not.toHaveBeenCalled();
    expect(setCache).not.toHaveBeenCalled();
  });

  it("clears a malformed payload without running the digest", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({ value: "not-json", updatedAt: 0 });

    await runDigestTriggerPollSlot(buildRuntime());

    expect(runLeasedCron).not.toHaveBeenCalled();
    expect(deleteCache).toHaveBeenCalledWith(expect.anything(), DIGEST_FORCE_RUN_CACHE_KEY);
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
    const lastResult = JSON.parse(vi.mocked(setCache).mock.calls[0][2]) as {
      outcome: string;
      requestId: string;
    };
    expect(lastResult.outcome).toBe("ok");
    expect(lastResult.requestId).toBe("manual-digest-abc");
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

    const lastResult = JSON.parse(vi.mocked(setCache).mock.calls[0][2]) as { outcome: string };
    expect(lastResult.outcome).toBe("skipped_locked");
  });

  it("records the error outcome and still clears the flag when the digest throws", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify({ requestedAt: 1_700_000_000, requestId: "manual-digest-err" }),
      updatedAt: 1_700_000_000,
    });
    runLeasedCron.mockRejectedValueOnce(new Error("upstream blew up"));

    await runDigestTriggerPollSlot(buildRuntime());

    expect(deleteCache).toHaveBeenCalledWith(expect.anything(), DIGEST_FORCE_RUN_CACHE_KEY);
    const lastResult = JSON.parse(vi.mocked(setCache).mock.calls[0][2]) as {
      outcome: string;
      error: string | null;
    };
    expect(lastResult.outcome).toBe("error");
    expect(lastResult.error).toContain("upstream blew up");
  });

  it("reports degraded outcome when digest returned status=degraded", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify({ requestedAt: 1_700_000_000, requestId: "manual-digest-deg" }),
      updatedAt: 1_700_000_000,
    });
    runLeasedCron.mockResolvedValueOnce({ status: "degraded", itemCount: 1, metadata: "" } as CronResult);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(deleteCache).toHaveBeenCalled();
    const lastResult = JSON.parse(vi.mocked(setCache).mock.calls[0][2]) as { outcome: string };
    expect(lastResult.outcome).toBe("degraded");
  });
});
