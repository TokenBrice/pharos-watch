import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { logCronEvent, recordCronFailure, __resetCronFailureCountsForTests } from "../cron-logger";
import { mockD1 } from "@shared/test-utils/mock-d1";

describe("recordCronFailure", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetCronFailureCountsForTests();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("classifies Error instances and includes jobName, name, message, and count", () => {
    const result = recordCronFailure("snapshot-supply", new TypeError("bad thing"));

    expect(result).toMatchObject({
      job: "snapshot-supply",
      errorName: "TypeError",
      errorMessage: "bad thing",
      failureCount: 1,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const [prefix, payload] = errorSpy.mock.calls[0] as [string, string];
    expect(prefix).toContain("[cron-failure:snapshot-supply]");
    expect(prefix).toContain("TypeError");

    const parsed = JSON.parse(payload);
    expect(parsed).toMatchObject({
      event: "cron_failure",
      job: "snapshot-supply",
      errorName: "TypeError",
      errorMessage: "bad thing",
      failureCount: 1,
    });
  });

  it("classifies non-Error throwables (string, object) without throwing", () => {
    const stringResult = recordCronFailure("project-tape", "kaboom");
    expect(stringResult).toMatchObject({
      job: "project-tape",
      errorName: "NonError",
      errorMessage: "kaboom",
      failureCount: 1,
    });

    const objectResult = recordCronFailure("project-tape", { reason: "oops" });
    expect(objectResult.job).toBe("project-tape");
    expect(objectResult.errorName).toBe("NonError");
    expect(objectResult.failureCount).toBe(2);
  });

  it("increments the per-job counter across calls and keeps jobs independent", () => {
    const a1 = recordCronFailure("job-a", new Error("a1"));
    const a2 = recordCronFailure("job-a", new Error("a2"));
    const b1 = recordCronFailure("job-b", new Error("b1"));

    expect(a1.failureCount).toBe(1);
    expect(a2.failureCount).toBe(2);
    expect(b1.failureCount).toBe(1);
  });

  it("attaches caller-supplied metadata to the structured payload", () => {
    recordCronFailure("snapshot-chain-supply", new Error("write failed"), {
      metadata: { stage: "batchExecute", attempt: 3 },
    });

    const [, payload] = errorSpy.mock.calls[0] as [string, string];
    const parsed = JSON.parse(payload);
    expect(parsed.metadata).toEqual({ stage: "batchExecute", attempt: 3 });
  });

  it("redacts nested credential metadata before writing cron logs", () => {
    recordCronFailure("sync-live-reserves", new Error("provider failed"), {
      metadata: {
        provider: {
          url: "https://example.com/rpc?apiKey=url-secret",
          error: new Error("Authorization=header-secret Bearer bearer-secret"),
        },
        token: "token=metadata-secret",
      },
    });

    const [, payload] = errorSpy.mock.calls[0] as [string, string];
    expect(payload).not.toContain("url-secret");
    expect(payload).not.toContain("header-secret");
    expect(payload).not.toContain("bearer-secret");
    expect(payload).not.toContain("metadata-secret");
    expect(payload).toContain("[redacted]");
  });

  it("persists non-terminal cron events as latest-event cache records", async () => {
    const db = mockD1();

    const record = await logCronEvent(db, {
      job: "sync-fx-rates",
      eventType: "openexchange-rates-fetch-failed",
      severity: "warning",
      message: "Open Exchange Rates realtime fetch failed.",
      metadata: {
        error: "x".repeat(700),
        attempts: [1, 2, 3],
      },
    });

    expect(record).toMatchObject({
      event: "cron_event",
      job: "sync-fx-rates",
      eventType: "openexchange-rates-fetch-failed",
      severity: "warning",
    });
    expect(warnSpy).toHaveBeenCalled();

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
    expect(insert?.binds[0]).toBe("cron:event:sync-fx-rates:openexchange-rates-fetch-failed");
    const payload = JSON.parse(String(insert?.binds[1]));
    expect(payload.metadata.error.length).toBeLessThanOrEqual(503);
    expect(payload.metadata.attempts).toEqual([1, 2, 3]);
  });

  it("does not throw when durable cron event persistence fails", async () => {
    const db = mockD1([
      { match: "INSERT OR REPLACE INTO cache", rows: [], throwError: new Error("D1 unavailable") },
    ]);

    await expect(
      logCronEvent(db, {
        job: "sync-dex-liquidity",
        eventType: "fallback-budget-exhausted",
        message: "Fallback budget exhausted.",
      }),
    ).resolves.toMatchObject({ job: "sync-dex-liquidity" });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to persist fallback-budget-exhausted"),
    );
  });
});
