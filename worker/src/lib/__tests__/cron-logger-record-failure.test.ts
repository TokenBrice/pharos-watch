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
