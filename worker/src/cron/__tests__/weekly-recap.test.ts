import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockTableConfig } from "../../api/__tests__/helpers/mock-d1";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../../lib/telegram", () => ({
  postDigestToTelegram: vi.fn(),
}));

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcomeSafe: vi.fn(async () => {}),
}));

import { generateWeeklyRecap } from "../weekly-recap";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { postDigestToTelegram } from "../../lib/telegram";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";

function buildDailyRows() {
  const baseTs = Math.floor(Date.UTC(2026, 2, 23, 12, 0, 0) / 1000);
  return Array.from({ length: 5 }).map((_, index) => ({
    generated_at: baseTs + index * 86_400,
    digest_title: `Day ${index + 1}`,
    digest_text: `USDT held near 1.00 on day ${index + 1}.`,
    digest_extended: null,
    input_data: JSON.stringify({
      totalMcapUsd: 100_000_000 + index * 1_000_000,
      activeDepegCount: index,
      stabilityIndex: {
        score: 90 - index,
        band: "BEDROCK",
      },
      blacklistActivity: {
        eventCount: index,
      },
      gradeTransitions: index % 2 === 0 ? [{ stablecoinId: "usdt-tether" }] : [],
      mintBurnFlows: {
        gaugeScore: 10 + index,
      },
    }),
  }));
}

function makeTables(overrides: Partial<{
  existingWeekly: Record<string, unknown> | null;
  dailyRows: ReturnType<typeof buildDailyRows>;
}> = {}): MockTableConfig[] {
  return [
    {
      match: "SELECT id FROM daily_digest WHERE generated_at >= ? AND json_extract(digest_meta, '$.type') = 'weekly'",
      rows: [],
      first: overrides.existingWeekly ?? null,
    },
    {
      match: "WHERE generated_at >= ? AND (digest_meta IS NULL OR json_extract(digest_meta, '$.type') IS NULL OR json_extract(digest_meta, '$.type') != 'weekly')",
      rows: overrides.dailyRows ?? buildDailyRows(),
    },
    {
      match: "INSERT INTO daily_digest",
      rows: [],
      runMeta: { changes: 1 },
    },
  ];
}

describe("generateWeeklyRecap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores a weekly digest and posts to Telegram when generation succeeds", async () => {
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockResolvedValue(
      new Response(JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              title: "Weekly Calm",
              text: "USDT and USDC ended the week near peg.",
              extended: "USDT held 1.00 for most of the week.\n\nUSDC matched the tone into Friday.",
              meta: { lead: "USDT", tone: "dry", coins: ["USDT", "USDC"] },
            }),
          },
        ],
      }), { status: 200 }),
    );

    const result = await generateWeeklyRecap(
      db,
      "anthropic-key",
      { botToken: "bot", chatId: "chat" },
    );

    expect(result.itemCount).toBe(1);
    expect(result.status).toBeUndefined();
    expect(result.metadata).toContain("telegram: ok");
    expect(postDigestToTelegram).toHaveBeenCalledTimes(1);
    expect(postDigestToTelegram).toHaveBeenCalledWith(
      "Weekly Recap: Weekly Calm",
      "USDT held 1.00 for most of the week.\n\nUSDC matched the tone into Friday.",
      "2026-03-30",
      { botToken: "bot", chatId: "chat" },
    );

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO daily_digest"));
    expect(insert).toBeTruthy();
    expect(insert?.binds[1]).toBe("USDT and USDC ended the week near peg.");
    expect(insert?.binds[2]).toBe("Weekly Calm");
    expect(JSON.parse(String(insert?.binds[5]))).toEqual({
      lead: "USDT",
      tone: "dry",
      coins: ["USDT", "USDC"],
      type: "weekly",
      weekStart: "2026-03-23",
      weekEnd: "2026-03-27",
    });
  });

  it("marks the run degraded and persists fallback metadata when the LLM returns non-JSON", async () => {
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockResolvedValue(
      new Response(JSON.stringify({
        content: [
          {
            type: "text",
            text: "USDT stayed at 1.00 all week, blacklist pressure faded, and weekly flows stayed calm.",
          },
        ],
      }), { status: 200 }),
    );

    const result = await generateWeeklyRecap(db, "anthropic-key", null);

    expect(result.itemCount).toBe(1);
    expect(result.status).toBe("degraded");
    expect(result.metadata).toContain("degraded: raw-text-fallback");

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO daily_digest"));
    expect(insert).toBeTruthy();
    expect(insert?.binds[1]).toBe("USDT stayed at 1.00 all week, blacklist pressure faded, and weekly flows stayed calm.");
    expect(insert?.binds[2]).toBeNull();
    expect(JSON.parse(String(insert?.binds[5]))).toEqual({
      type: "weekly",
      weekStart: "2026-03-23",
      weekEnd: "2026-03-27",
      degraded: "raw-text-fallback",
    });
  });

  it("skips generation cleanly when the Anthropic circuit is open", async () => {
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);

    const result = await generateWeeklyRecap(db, "anthropic-key", null);

    expect(result).toEqual({ metadata: "skipped: anthropic circuit open" });
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(postDigestToTelegram).not.toHaveBeenCalled();
  });
});
