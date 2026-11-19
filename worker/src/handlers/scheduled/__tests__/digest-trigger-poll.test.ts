import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

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
vi.mock("../../../lib/db-cache", async (importOriginal) => {
  const cache = await importOriginal<typeof import("../../../lib/db-cache")>();
  return { ...cache, getCache: vi.fn(cache.getCache) };
});
vi.mock("../../../lib/budget-surface-telemetry", () => ({
  recordBudgetSurfaceTelemetry: vi.fn(async () => {}),
}));
vi.mock("../../../telegram/outbox/digest-outbox", () => ({
  drainTelegramDigestOutbox: vi.fn(),
}));

import { generateDailyDigest, resumeDailyDigestDelivery } from "../../../cron/daily-digest";
import { resolveDigestSafetyMap } from "../../../lib/digest-safety-map";
import { getCache } from "../../../lib/db-cache";
import { recordBudgetSurfaceTelemetry } from "../../../lib/budget-surface-telemetry";
import { buildTelegramCreds, buildTwitterCreds } from "../../../lib/runtime-credentials";
import { drainTelegramDigestOutbox } from "../../../telegram/outbox/digest-outbox";
import { runDigestTriggerPollSlot } from "../digest-trigger-poll";
import { generateWeeklyRecap } from "../../../cron/weekly-recap";

const INTENT_KEY = "digest:force-run-request";
const RESULT_KEY = "digest:last-trigger-result";
const CLEARED_INTENT_KEY = "test:cleared-digest-intent";
const MAX_ATTEMPTS = 3;

type CronResult = { status?: string; metadata?: string; itemCount?: number };
type DigestForceRunIntent = {
  kind?: "daily" | "weekly";
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
  const fixtures = createLatestSchemaFixtureTracker();
  let fixture: ReturnType<typeof fixtures.open>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    runLeasedCron = vi.fn();
    fixture = fixtures.open();
    // Keep the final intent available for inspection after the conditional delete.
    fixture.sqlite.exec(`
      CREATE TEMP TRIGGER capture_cleared_intent AFTER DELETE ON cache
      WHEN OLD.key = '${INTENT_KEY}'
      BEGIN
        INSERT OR REPLACE INTO cache (key, value, updated_at)
        VALUES ('${CLEARED_INTENT_KEY}', OLD.value, OLD.updated_at);
      END
    `);
    vi.mocked(buildTelegramCreds).mockReturnValue(null);
    vi.mocked(buildTwitterCreds).mockReturnValue(null);
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
      retainedExecutionUnknownTotal: 0,
      retainedFailedPermanentTotal: 0,
      prunedSent: 0,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCache).mockReset();
    vi.useRealTimers();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    vi.restoreAllMocks();
    fixtures.closeAll();
  });

  function readCache(key: string): unknown {
    const row = fixture.sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key);
    return row && JSON.parse(row.value as string) as unknown;
  }

  function readIntent(): DigestForceRunIntent | undefined {
    return readCache(INTENT_KEY) as DigestForceRunIntent | undefined;
  }

  function seedIntent(intent: DigestForceRunIntent): void {
    fixture.sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(INTENT_KEY, JSON.stringify(intent), intent.requestedAt);
  }

  function seedRun(slotStartedAt: number | null, startedAt: number, status = "error", job = "weekly-recap"): void {
    fixture.sqlite.prepare("INSERT INTO cron_runs (job, started_at, slot_started_at, status, duration_ms) VALUES (?, ?, ?, ?, 0)")
      .run(job, startedAt, slotStartedAt, status);
  }

  const runLeasedJob: ScheduledRuntimeContext["runLeasedCron"] = async (_job, fn) =>
    fn(new AbortController().signal, async () => {});

  function buildRuntime(): ScheduledRuntimeContext {
    return makeScheduledRuntime({
      db: fixture.db as D1Database,
      env: { ANTHROPIC_API_KEY: "anthropic-key" } as ScheduledRuntimeContext["env"],
      cron: "*/5 * * * *",
      scheduleKey: "digestTriggerPoll" as ScheduledRuntimeContext["scheduleKey"],
      scheduledTimeMs: null,
      slotStartedAt: 0,
      runLeasedCron: runLeasedCron as unknown as ScheduledRuntimeContext["runLeasedCron"],
    });
  }

  it("is a no-op when the force-run cache key is absent", async () => {
    const summary = await runDigestTriggerPollSlot(buildRuntime());

    expect(runLeasedCron).not.toHaveBeenCalled();
    expect(readIntent()).toBeUndefined();
    expect(readCache(RESULT_KEY)).toBeUndefined();
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
      budgetOnlyJobs: 3,
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

  it("runs the bounded global sweep on a poll with no digest demand", async () => {
    vi.useFakeTimers();
    const slot = Date.parse("2027-01-14T11:00:00Z") / 1_000;
    vi.setSystemTime((slot + 420) * 1_000);
    const insert = fixture.sqlite.prepare(`
      INSERT INTO cron_slot_executions
        (slot_key, slot_started_at, state, execution_owner, started_at, updated_at)
      VALUES (?, ?, 'running', 'abandoned', ?, ?)
    `);
    for (let i = 0; i < 9; i++) {
      const start = slot - i * 900;
      insert.run("quarterHourly", start, start, start);
    }
    const delayedSlot = Date.parse("2027-01-14T08:10:00Z") / 1_000;
    const previousDay = delayedSlot - 86_400;
    insert.run("daily0810Utc", previousDay, previousDay, previousDay);
    insert.run("daily0810Utc", delayedSlot, delayedSlot, slot + 1);
    const runtime = buildRuntime();
    const send = vi.fn();
    Object.assign(runtime.env, {
      DB: runtime.db, WORKER_SLOT_CATCH_UP_MODE: "on", RESERVE_CONTINUATION_QUEUE: { send },
    });

    await runDigestTriggerPollSlot(runtime);

    expect(runLeasedCron).not.toHaveBeenCalled();
    expect(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM cron_slot_executions WHERE state = 'finished' AND result_status = 'error'")
      .get()?.count).toBe(10);
    expect(fixture.sqlite.prepare("SELECT state FROM cron_slot_executions WHERE slot_key = 'daily0810Utc' AND slot_started_at = ?")
      .get(delayedSlot)?.state).toBe("running");
    expect(readCache("scheduled-catch-up:quarterHourly")).toMatchObject({
      slotStartedAt: slot, trigger: "abandoned",
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleKey: "quarterHourly", slotStartedAt: slot, trigger: "abandoned" }),
      expect.anything(),
    );
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
      retainedExecutionUnknownTotal: 1,
      retainedFailedPermanentTotal: 2,
      prunedSent: 0,
    });

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

  it("keeps the outbox drain surface ok when retained terminal rows are older than the review window", async () => {
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
      retainedExecutionUnknown: 0,
      retainedFailedPermanent: 0,
      retainedExecutionUnknownTotal: 0,
      retainedFailedPermanentTotal: 1,
      prunedSent: 0,
    });

    await runDigestTriggerPollSlot(buildRuntime());

    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        surface: "telegram-digest-outbox-drain",
        outcome: "ok",
        error: null,
        metadata: expect.objectContaining({ retainedFailedPermanentTotal: 1 }),
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
      retainedExecutionUnknownTotal: 0,
      retainedFailedPermanentTotal: 0,
      prunedSent: 0,
    });

    await runDigestTriggerPollSlot(buildRuntime());

    expect(drainTelegramDigestOutbox).toHaveBeenCalledTimes(1);
    expect(generateDailyDigest).not.toHaveBeenCalled();
    expect(runLeasedCron).not.toHaveBeenCalled();
  });

  it("does not attribute a drain infrastructure exception to the Telegram provider", async () => {
    vi.mocked(buildTelegramCreds).mockReturnValue({ botToken: "bot", chatId: "channel" });
    vi.mocked(drainTelegramDigestOutbox).mockRejectedValueOnce(new Error("D1 unavailable"));

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
    fixture.sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(INTENT_KEY, "not-json", 0);

    const summary = await runDigestTriggerPollSlot(buildRuntime());

    expect(runLeasedCron).not.toHaveBeenCalled();
    expect(readIntent()).toMatchObject({
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
    expect(readCache(RESULT_KEY)).toBeUndefined();
  });

  it("runs daily-digest with force=true and clears the intent on success", async () => {
    vi.mocked(buildTwitterCreds).mockReturnValue({
      apiKey: "tw-key",
      apiSecret: "tw-secret",
      accessToken: "tw-token",
      accessTokenSecret: "tw-token-secret",
    });
    seedIntent(buildIntent("manual-digest-abc"));
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

    expect(readIntent()).toBeUndefined();
    expect(readCache(CLEARED_INTENT_KEY)).toMatchObject({
      requestId: "manual-digest-abc", state: "succeeded", attempts: 1, lastError: null,
    });
    expect(readCache(RESULT_KEY)).toMatchObject({ requestId: "manual-digest-abc", outcome: "ok" });
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
    const intent = buildIntent("manual-digest-locked");
    seedIntent(intent);
    runLeasedCron.mockResolvedValueOnce({ status: "skipped_locked", metadata: "" } as CronResult);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(runLeasedCron).toHaveBeenCalledTimes(1);
    expect(readIntent()).toEqual(intent);
    expect(readCache(RESULT_KEY)).toMatchObject({ outcome: "skipped_locked" });
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
    seedIntent(firstIntent);
    vi.mocked(generateDailyDigest).mockRejectedValueOnce(new Error("network timeout"));
    runLeasedCron.mockImplementation(runLeasedJob);

    await runDigestTriggerPollSlot(buildRuntime());

    const retryOne = readIntent();
    expect(retryOne).toMatchObject({
      requestId: firstIntent.requestId,
      attempts: 1,
      state: "failed_transient",
      lastError: "network timeout",
    });
    expect(retryOne?.nextAttemptAt).toBe(1_800_000_600);

    vi.setSystemTime(new Date((retryOne?.nextAttemptAt ?? 0) * 1000));
    vi.mocked(generateDailyDigest).mockRejectedValueOnce(new Error("D1 unavailable"));

    await runDigestTriggerPollSlot(buildRuntime());

    const retryTwo = readIntent();
    expect(retryTwo).toMatchObject({
      attempts: 2,
      state: "failed_transient",
      lastError: "D1 unavailable",
    });
    expect(retryTwo?.nextAttemptAt).toBe(1_800_001_800);

    vi.setSystemTime(new Date((retryTwo?.nextAttemptAt ?? 0) * 1000));
    vi.mocked(generateDailyDigest).mockRejectedValueOnce(new Error("Anthropic 503"));

    await runDigestTriggerPollSlot(buildRuntime());

    expect(readIntent()).toMatchObject({
      attempts: MAX_ATTEMPTS,
      state: "dead_letter",
      lastError: "Anthropic 503",
    });
  });

  it("dead-letters a permanent failure immediately", async () => {
    const intent = buildIntent("manual-digest-permanent");
    seedIntent(intent);
    vi.mocked(generateDailyDigest).mockRejectedValueOnce(new Error("validation failed: invalid prompt"));
    runLeasedCron.mockImplementationOnce(runLeasedJob);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(readIntent()).toMatchObject({
      requestId: intent.requestId,
      attempts: 1,
      state: "dead_letter",
      lastError: "validation failed: invalid prompt",
    });
  });

  it("reports degraded outcome when digest returned status=degraded", async () => {
    seedIntent(buildIntent("manual-digest-deg"));
    vi.mocked(generateDailyDigest).mockResolvedValueOnce({ status: "degraded", itemCount: 1, metadata: "" });
    runLeasedCron.mockImplementationOnce(runLeasedJob);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(readIntent()).toMatchObject({
      state: "failed_transient",
      attempts: 1,
      lastError: "daily-digest returned status degraded",
    });
    expect(readCache(RESULT_KEY)).toMatchObject({ outcome: "degraded" });
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "digest-trigger-poll",
      outcome: "degraded",
    }));
  });

  it("durably consumes three terminated starts and dead-letters without a fourth generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000 * 1000);
    seedIntent(buildIntent("manual-digest-crashes"));
    runLeasedCron.mockImplementation(runLeasedJob);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let started!: () => void;
      const generationStarted = new Promise<void>((resolve) => { started = resolve; });
      vi.mocked(generateDailyDigest).mockImplementationOnce(() => {
        started();
        // Model isolate termination: no producer result or post-run settlement.
        return new Promise<never>(() => {});
      });
      void runDigestTriggerPollSlot(buildRuntime());
      await generationStarted;
      const intent = readIntent()!;
      expect(intent).toMatchObject({ state: "running", attempts: attempt });
      vi.setSystemTime(intent.nextAttemptAt * 1000);
    }

    await runDigestTriggerPollSlot(buildRuntime());
    expect(generateDailyDigest).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(readIntent()).toMatchObject({ state: "dead_letter", attempts: MAX_ATTEMPTS });
  });

  it("does not start or consume an attempt if the durable claim fails", async () => {
    const intent = buildIntent("manual-digest-write-failure");
    seedIntent(intent);
    fixture.sqlite.exec(`
      CREATE TEMP TRIGGER reject_intent_claim BEFORE UPDATE ON cache
      WHEN OLD.key = '${INTENT_KEY}'
      BEGIN
        SELECT RAISE(ABORT, 'D1 unavailable');
      END
    `);
    runLeasedCron.mockImplementationOnce(runLeasedJob);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(generateDailyDigest).not.toHaveBeenCalled();
    expect(resumeDailyDigestDelivery).not.toHaveBeenCalled();
    expect(readIntent()).toEqual(intent);
    expect(readCache(RESULT_KEY)).toMatchObject({
      requestId: intent.requestId, state: "pending", attempts: 0, outcome: "error",
    });
    expect(recordBudgetSurfaceTelemetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      surface: "digest-trigger-poll", outcome: "error", processedCount: 0,
    }));
  });

  it("does not start a replaced intent", async () => {
    const oldIntent = buildIntent("manual-digest-old");
    const newIntent = buildIntent("manual-digest-new");
    seedIntent(oldIntent);
    runLeasedCron.mockImplementationOnce(async (_job, fn) => {
      fixture.sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?")
        .run(JSON.stringify(newIntent), INTENT_KEY);
      return fn(new AbortController().signal, async () => {});
    });
    await runDigestTriggerPollSlot(buildRuntime());
    expect(generateDailyDigest).not.toHaveBeenCalled();
    expect(readIntent()).toEqual(newIntent);
  });

  it.each(["success", "failure"] as const)(
    "preserves and subsequently executes a newer request after an older %s",
    async (completion) => {
      const oldIntent = buildIntent("manual-digest-old");
      const newIntent = buildIntent("manual-digest-new");
      seedIntent(oldIntent);
      let release!: () => void;
      const paused = new Promise<void>((resolve) => { release = resolve; });
      let started!: () => void;
      const claimed = new Promise<void>((resolve) => { started = resolve; });
      vi.mocked(generateDailyDigest).mockImplementationOnce(async () => {
        started();
        await paused;
        if (completion === "failure") throw new Error("network timeout");
        return { status: "ok", itemCount: 1 };
      });
      runLeasedCron.mockImplementation(runLeasedJob);

      const oldRun = runDigestTriggerPollSlot(buildRuntime());
      await claimed;
      const running = readIntent();
      seedIntent(newIntent);
      release();
      await oldRun;

      expect(running).toMatchObject({ requestId: oldIntent.requestId, state: "running", attempts: 1 });
      expect(readIntent()).toEqual(newIntent);
      expect(readCache(RESULT_KEY)).toMatchObject({
        requestId: oldIntent.requestId,
        attempts: 1,
        state: completion === "success" ? "succeeded" : "failed_transient",
        outcome: completion === "success" ? "ok" : "error",
      });

      vi.mocked(generateDailyDigest).mockResolvedValueOnce({ status: "ok", itemCount: 1 });
      await runDigestTriggerPollSlot(buildRuntime());
      expect(generateDailyDigest).toHaveBeenCalledTimes(2);
      expect(readCache(CLEARED_INTENT_KEY)).toMatchObject({ requestId: newIntent.requestId, state: "succeeded" });
      expect(readIntent()).toBeUndefined();
      expect(readCache(RESULT_KEY)).toMatchObject({
        requestId: newIntent.requestId, state: "succeeded", attempts: 1, outcome: "ok",
      });
    },
  );

  it("does not dead-letter a newer intent after reading a replaced malformed payload", async () => {
    const newIntent = buildIntent("manual-digest-new");
    seedIntent(newIntent);
    vi.mocked(getCache).mockResolvedValueOnce({ value: "not-json", updatedAt: 0 });

    await runDigestTriggerPollSlot(buildRuntime());

    expect(readIntent()).toEqual(newIntent);
    expect(readCache(RESULT_KEY)).toBeUndefined();
    expect(runLeasedCron).not.toHaveBeenCalled();
  });

  it.each([
    ["2026-08-31T08:24:59Z", "2026-08-31T08:24:59Z", 0],
    ["2026-08-31T08:25:00Z", "2026-08-31T08:25:00Z", 1],
    ["2026-08-31T08:10:00Z", "2026-09-01T00:05:00Z", 0],
    ["2026-08-31T08:25:00Z", "2026-09-01T00:05:00Z", 1],
    ["2026-09-01T08:25:00Z", "2026-09-01T08:25:00Z", 0],
  ])("reserves the primary weekly budget by scheduled time (%s delivered %s -> %i resumes)", async (scheduledAt, deliveredAt, expectedResumes) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(deliveredAt));
    runLeasedCron.mockResolvedValue({ itemCount: 1, metadata: "weekly ok" });
    const runtime = buildRuntime();
    runtime.slotStartedAt = Date.parse(scheduledAt) / 1_000;

    await runDigestTriggerPollSlot(runtime);

    expect(runLeasedCron).toHaveBeenCalledTimes(expectedResumes);
    if (expectedResumes > 0) {
      expect(runLeasedCron).toHaveBeenCalledWith("weekly-recap", expect.any(Function));
    }
  });

  it("runs an explicit weekly request after the automatic cap without calling the daily generator", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T11:00:00Z"));
    const requestedAt = Date.now() / 1_000;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const slot = requestedAt - (attempt + 1) * 600;
      seedRun(slot, slot);
    }
    seedIntent(buildIntent("manual-weekly", { kind: "weekly", requestedAt, nextAttemptAt: requestedAt }));
    vi.mocked(generateWeeklyRecap).mockResolvedValueOnce({ status: "skipped_neutral", metadata: "weekly-recap-exists" });
    runLeasedCron.mockImplementation(runLeasedJob);
    const runtime = buildRuntime();
    runtime.slotStartedAt = requestedAt;

    const summary = await runDigestTriggerPollSlot(runtime);

    expect(runLeasedCron).toHaveBeenCalledWith("weekly-recap", expect.any(Function));
    expect(generateWeeklyRecap).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateWeeklyRecap).mock.calls[0]?.[6]).toBe(requestedAt);
    expect(generateDailyDigest).not.toHaveBeenCalled();
    expect(resumeDailyDigestDelivery).not.toHaveBeenCalled();
    expect(readCache(CLEARED_INTENT_KEY)).toMatchObject({ kind: "weekly", state: "succeeded", attempts: 1 });
    expect(readIntent()).toBeUndefined();
    expect(readCache(RESULT_KEY)).toMatchObject({
      requestId: "manual-weekly", kind: "weekly", state: "succeeded", attempts: 1, outcome: "skipped",
    });
    expect(summary.jobs[0]).toMatchObject({ job: "weekly-recap" });
  });

  it("retains weekly kind across bounded transient retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T11:00:00Z"));
    const requestedAt = Date.now() / 1_000;
    seedIntent(buildIntent("manual-weekly-retries", { kind: "weekly", requestedAt, nextAttemptAt: requestedAt }));
    let running: DigestForceRunIntent | undefined;
    vi.mocked(generateWeeklyRecap).mockImplementation(async () => {
      running = readIntent();
      throw new Error("network timeout");
    });
    runLeasedCron.mockImplementation(runLeasedJob);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const before = readIntent()!;
      vi.setSystemTime(before.nextAttemptAt * 1_000);
      const runtime = buildRuntime();
      runtime.slotStartedAt = Date.now() / 1_000;
      await runDigestTriggerPollSlot(runtime);
      expect(running).toMatchObject({ kind: "weekly", requestedAt, attempts: attempt, state: "running" });
      expect(readIntent()).toMatchObject({ kind: "weekly", requestedAt, attempts: attempt,
        state: attempt === MAX_ATTEMPTS ? "dead_letter" : "failed_transient" });
    }
    expect(generateWeeklyRecap).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(generateDailyDigest).not.toHaveBeenCalled();
  });

  it.each([
    ["2026-10-12T23:55:00Z", "2026-10-12T23:55:00Z", 1, 0],
    ["2026-10-12T23:55:00Z", "2026-10-13T00:05:00Z", 0, 0],
    ["2026-10-13T00:05:00Z", "2026-10-13T00:05:00Z", 0, 0],
    ["2026-10-12T23:55:00Z", "2026-10-13T00:05:00Z", 0, 1_800],
  ])("binds a weekly intent to its requested Monday (%s delivered %s -> %i runs, retry delay %i)", async (scheduledAt, deliveredAt, expectedRuns, retryDelaySec) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(deliveredAt));
    const requestedAt = Date.parse("2026-10-12T23:50:00Z") / 1_000;
    seedIntent(buildIntent("manual-weekly-late", { kind: "weekly", requestedAt, nextAttemptAt: requestedAt + retryDelaySec }));
    vi.mocked(generateWeeklyRecap).mockResolvedValueOnce({ itemCount: 1 });
    runLeasedCron.mockImplementation(runLeasedJob);
    const runtime = buildRuntime();
    runtime.slotStartedAt = Date.parse(scheduledAt) / 1_000;

    await runDigestTriggerPollSlot(runtime);

    expect(generateWeeklyRecap).toHaveBeenCalledTimes(expectedRuns);
    expect(generateDailyDigest).not.toHaveBeenCalled();
    if (expectedRuns) {
      expect(readIntent()).toBeUndefined();
      expect(readCache(CLEARED_INTENT_KEY)).toMatchObject({ kind: "weekly", state: "succeeded" });
      expect(readCache(RESULT_KEY)).toMatchObject({
        requestId: "manual-weekly-late", kind: "weekly", state: "succeeded", attempts: 1, outcome: "ok",
      });
    } else {
      expect(readIntent()).toMatchObject({
        kind: "weekly", state: "dead_letter", lastError: "weekly-edition-expired", attempts: 0,
      });
      expect(readCache(RESULT_KEY)).toBeUndefined();
    }
  });

  it.each([null, "monthly", 1])("dead-letters invalid persisted kind %j without generating", async (kind) => {
    const value = JSON.stringify({ ...buildIntent("malformed-kind"), kind });
    fixture.sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(INTENT_KEY, value, 0);

    await runDigestTriggerPollSlot(buildRuntime());

    expect(runLeasedCron).not.toHaveBeenCalled();
    expect(readIntent()).toMatchObject({ state: "dead_letter", lastError: "malformed-payload" });
  });

  it("resumes a missing weekly recap on Monday after the primary budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T09:00:00Z"));
    vi.mocked(generateWeeklyRecap).mockResolvedValueOnce({ itemCount: 1, metadata: "weekly ok" });
    runLeasedCron.mockImplementationOnce(async (_job, fn) => {
      await fn(new AbortController().signal, async () => {});
      return { itemCount: 1, metadata: "weekly ok" } as CronResult;
    });
    const runtime = buildRuntime();
    runtime.slotStartedAt = Math.floor(Date.parse("2026-08-31T09:00:00Z") / 1000);

    const summary = await runDigestTriggerPollSlot(runtime);

    expect(runLeasedCron).toHaveBeenCalledWith("weekly-recap", expect.any(Function));
    expect(generateWeeklyRecap).toHaveBeenCalledWith(
      runtime.db,
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
      // Editorial weekly LLM configuration; personalized-recap CTA policy is retired.
      expect.any(Object),
    );
    expect(summary.jobs).toEqual([
      expect.objectContaining({ job: "weekly-recap", outcome: "ok" }),
    ]);
  });

  it.each([
    [2, 1],
    [3, 0],
  ])("caps Monday weekly generations per edition day (%i prior runs -> %i resumes)", async (priorRuns, expectedResumes) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:05:00Z"));
    const slot = Date.parse("2026-08-31T09:00:00Z") / 1_000;
    const afterMidnight = Date.parse("2026-09-01T00:01:00Z") / 1_000;
    seedRun(null, slot - 3_000);
    for (let i = 1; i < priorRuns; i++) seedRun(slot - i * 600, afterMidnight);
    seedRun(slot - 86_400, slot - 86_400);
    seedRun(afterMidnight, afterMidnight);
    seedRun(slot, slot, "skipped_neutral");
    seedRun(slot, slot, "skipped_locked");
    seedRun(slot, slot, "error", "daily-digest");
    vi.mocked(generateWeeklyRecap).mockResolvedValueOnce({ itemCount: 1 });
    runLeasedCron.mockImplementation(runLeasedJob);
    const runtime = buildRuntime();
    runtime.slotStartedAt = slot;

    const summary = await runDigestTriggerPollSlot(runtime);

    expect(summary.jobsSucceeded).toBe(expectedResumes);
    expect(runLeasedCron).toHaveBeenCalledTimes(expectedResumes);
    expect(generateWeeklyRecap).toHaveBeenCalledTimes(expectedResumes);
  });

});
