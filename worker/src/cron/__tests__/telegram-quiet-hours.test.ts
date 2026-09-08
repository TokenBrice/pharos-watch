import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISAMBIGUATION_TTL_SEC } from "../../api/telegram-webhook-shared";
import { cleanExpiredDisambiguations } from "../../api/telegram-store/disambiguation";
import {
  isQuietHoursActive,
  isValidIanaTimezone,
  resetQuietHoursFallbackTelemetryForTests,
} from "../../lib/telegram/quiet-hours";
import { createLatestSchemaFixtureTracker } from "../../test-helpers/latest-schema-sqlite";

const hour = (hourUtc: number) => hourUtc * 3600;
const { open, closeAll } = createLatestSchemaFixtureTracker();

afterEach(() => {
  resetQuietHoursFallbackTelemetryForTests();
  closeAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isQuietHoursActive", () => {
  it("returns false when disabled or invalid", () => {
    expect(isQuietHoursActive(hour(12), false, 9, 17)).toBe(false);
    expect(isQuietHoursActive(hour(12), true, null, 17)).toBe(false);
    expect(isQuietHoursActive(hour(12), true, 9, null)).toBe(false);
    expect(isQuietHoursActive(hour(12), true, -1, 17)).toBe(false);
    expect(isQuietHoursActive(hour(12), true, 9, 24)).toBe(false);
    expect(isQuietHoursActive(hour(12), true, 9, 9)).toBe(false);
  });

  it("handles same-day quiet windows", () => {
    expect(isQuietHoursActive(hour(10), true, 9, 17)).toBe(true);
    expect(isQuietHoursActive(hour(9), true, 9, 17)).toBe(true);
    expect(isQuietHoursActive(hour(17), true, 9, 17)).toBe(false);
    expect(isQuietHoursActive(hour(8), true, 9, 17)).toBe(false);
  });

  it("handles quiet windows that wrap midnight", () => {
    expect(isQuietHoursActive(hour(23), true, 22, 6)).toBe(true);
    expect(isQuietHoursActive(hour(2), true, 22, 6)).toBe(true);
    expect(isQuietHoursActive(hour(6), true, 22, 6)).toBe(false);
    expect(isQuietHoursActive(hour(12), true, 22, 6)).toBe(false);
  });

  it("resolves the local hour in the provided IANA timezone", () => {
    // 2026-01-15 12:00:00 UTC. In Europe/Paris (UTC+1 in winter) the local
    // hour is 13; in America/Los_Angeles (UTC-8) it is 04.
    const noonUtcWinter = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
    expect(isQuietHoursActive(noonUtcWinter, true, 13, 14, "Europe/Paris")).toBe(true);
    expect(isQuietHoursActive(noonUtcWinter, true, 4, 5, "America/Los_Angeles")).toBe(true);
    // Same instant, UTC interpretation only matches 12.
    expect(isQuietHoursActive(noonUtcWinter, true, 13, 14, null)).toBe(false);
    expect(isQuietHoursActive(noonUtcWinter, true, 12, 13, null)).toBe(true);
  });

  it("follows the spring-forward offset and both occurrences of the fall-back hour", () => {
    const active = (iso: string, start: number, end: number) =>
      isQuietHoursActive(Date.parse(iso) / 1000, true, start, end, "America/New_York");
    expect(active("2026-03-08T06:59:59Z", 3, 4)).toBe(false);
    expect(active("2026-03-08T07:00:00Z", 3, 4)).toBe(true);
    expect(active("2026-11-01T05:00:00Z", 1, 2)).toBe(true);
    expect(active("2026-11-01T06:00:00Z", 1, 2)).toBe(true);
    expect(active("2026-11-01T07:00:00Z", 1, 2)).toBe(false);
  });

  it("resumes fallback telemetry exactly one hour after the previous log", () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 0, 15, 12);
    vi.setSystemTime(start);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const evaluate = () => isQuietHoursActive(start / 1000, true, 12, 13, "Mars/Olympus_Mons");
    expect(evaluate()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 3_600_000 - 1);
    expect(evaluate()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 3_600_000);
    expect(evaluate()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("falls back to UTC when the timezone is rejected by ICU", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // 2026-01-15 12:00:00 UTC. Bogus zone -> falls back to UTC, so hour=12.
    const noonUtcWinter = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
    expect(isQuietHoursActive(noonUtcWinter, true, 12, 13, "Mars/Olympus_Mons")).toBe(true);
    expect(isQuietHoursActive(noonUtcWinter, true, 13, 14, "Mars/Olympus_Mons")).toBe(false);
  });

  it("logs timezone fallback once per zone within the rate-limit window", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const noonUtcWinter = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;

    isQuietHoursActive(noonUtcWinter, true, 12, 13, "Mars/Olympus_Mons");
    isQuietHoursActive(noonUtcWinter, true, 12, 13, "Mars/Olympus_Mons");
    isQuietHoursActive(noonUtcWinter, true, 12, 13, "Mars/Valles_Marineris");

    expect(warn).toHaveBeenCalledTimes(2);
    const firstRecord = JSON.parse(String(warn.mock.calls[0][0])) as Record<string, unknown>;
    expect(firstRecord).toMatchObject({
      scope: "telegram",
      level: "warn",
      message: "quiet-hours timezone fallback to UTC",
      action: "quiet-hours-timezone-fallback",
      timezone: "Mars/Olympus_Mons",
      quietHoursTzFallback: true,
    });
  });
});

describe("isValidIanaTimezone", () => {
  it("accepts common IANA zones", () => {
    expect(isValidIanaTimezone("UTC")).toBe(true);
    expect(isValidIanaTimezone("Europe/Paris")).toBe(true);
    expect(isValidIanaTimezone("America/New_York")).toBe(true);
    expect(isValidIanaTimezone("Asia/Singapore")).toBe(true);
  });

  it("rejects empty, too-long, or unrecognized inputs", () => {
    expect(isValidIanaTimezone("")).toBe(false);
    expect(isValidIanaTimezone("not a zone")).toBe(false);
    expect(isValidIanaTimezone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidIanaTimezone("a".repeat(65))).toBe(false);
  });
});

interface DisambiguationRow {
  chat_id: string;
  expires_at: number;
}

function setupDisambiguations(rows: DisambiguationRow[]) {
  const { sqlite, db } = open();
  const insert = sqlite.prepare(`INSERT INTO telegram_pending_disambiguation
    (chat_id, alert_types, resolved_ids, ambiguous_ticker, candidates, remaining_tickers, expires_at)
    VALUES (?, '[]', '[]', 'USD', '[]', '[]', ?)`);
  for (const row of rows) insert.run(row.chat_id, row.expires_at);
  const remaining = () => sqlite.prepare(
    "SELECT chat_id FROM telegram_pending_disambiguation ORDER BY chat_id",
  ).all().map((row) => row.chat_id);
  return { db, remaining };
}

describe("cleanExpiredDisambiguations", () => {
  const NOW_SEC = 1_800_000_000;
  const GRACE_SEC = Math.max(2 * DISAMBIGUATION_TTL_SEC, 600);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws before any D1 work when the signal is already aborted", async () => {
    const rows: DisambiguationRow[] = [{ chat_id: "1", expires_at: NOW_SEC - GRACE_SEC - 60 }];
    const { db, remaining } = setupDisambiguations(rows);
    const controller = new AbortController();
    controller.abort(new Error("aborted"));

    await expect(cleanExpiredDisambiguations(db, controller.signal)).rejects.toThrow("aborted");
    expect(remaining()).toEqual(["1"]);
  });

  it("removes rows whose expires_at is older than the grace window", async () => {
    const rows: DisambiguationRow[] = [
      { chat_id: "old", expires_at: NOW_SEC - GRACE_SEC - 60 },
      { chat_id: "older", expires_at: NOW_SEC - GRACE_SEC - 3600 },
    ];
    const { db, remaining } = setupDisambiguations(rows);

    const result = await cleanExpiredDisambiguations(db);

    expect(remaining()).toEqual([]);
    expect(result.itemCount).toBe(2);
    expect(result.status).toBe("ok");
    const metadata = JSON.parse(result.metadata!) as {
      disambiguationRowsCleaned: number;
      cutoffSec: number;
    };
    expect(metadata.disambiguationRowsCleaned).toBe(2);
    expect(metadata.cutoffSec).toBe(NOW_SEC - GRACE_SEC);
  });

  it("preserves rows within the grace window (still inside active TTL or recently expired)", async () => {
    const rows: DisambiguationRow[] = [
      // Active selection — expires_at is in the future.
      { chat_id: "active", expires_at: NOW_SEC + 60 },
      // Just expired, well within the grace window.
      { chat_id: "fresh-expired", expires_at: NOW_SEC - 30 },
      // Expired exactly at the cutoff boundary — strict `<` keeps it.
      { chat_id: "boundary", expires_at: NOW_SEC - GRACE_SEC },
      { chat_id: "past-cutoff", expires_at: NOW_SEC - GRACE_SEC - 1 },
    ];
    const { db, remaining } = setupDisambiguations(rows);

    const result = await cleanExpiredDisambiguations(db);

    expect(remaining()).toEqual(["active", "boundary", "fresh-expired"]);
    expect(result.itemCount).toBe(1);
  });

  it("deletes expired rows in bounded batches", async () => {
    const rows: DisambiguationRow[] = Array.from({ length: 501 }, (_, index) => ({
      chat_id: `old-${index}`,
      expires_at: NOW_SEC - GRACE_SEC - 60 - index,
    }));
    const { db, remaining } = setupDisambiguations(rows);

    const result = await cleanExpiredDisambiguations(db);

    expect(remaining()).toEqual([]);
    expect(result.itemCount).toBe(501);
    const metadata = JSON.parse(result.metadata!) as {
      batches: number;
      disambiguationCleanupHasMore: boolean;
    };
    expect(metadata.batches).toBe(2);
    expect(metadata.disambiguationCleanupHasMore).toBe(false);
  });

  it("caps each cron pass to avoid monopolizing the Telegram slot", async () => {
    const rows: DisambiguationRow[] = Array.from({ length: 5_001 }, (_, index) => ({
      chat_id: `old-${index}`,
      expires_at: NOW_SEC - GRACE_SEC - 60 - index,
    }));
    const { db, remaining } = setupDisambiguations(rows);

    const result = await cleanExpiredDisambiguations(db);

    expect(remaining()).toEqual(["old-0"]);
    expect(result.itemCount).toBe(5_000);
    const metadata = JSON.parse(result.metadata!) as {
      batches: number;
      disambiguationCleanupHasMore: boolean;
    };
    expect(metadata.batches).toBe(10);
    expect(metadata.disambiguationCleanupHasMore).toBe(true);
  });

  it("reports zero cleaned when the table is empty", async () => {
    const { db } = setupDisambiguations([]);

    const result = await cleanExpiredDisambiguations(db);

    expect(result.itemCount).toBe(0);
    expect(result.status).toBe("ok");
    const metadata = JSON.parse(result.metadata!) as { disambiguationRowsCleaned: number };
    expect(metadata.disambiguationRowsCleaned).toBe(0);
  });
});
