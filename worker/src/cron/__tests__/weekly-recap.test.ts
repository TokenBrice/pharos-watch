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

const VALID_WEEKLY_EXTENDED = [
  "PSI opened the trailing edition window at 90 and closed at 86, never leaving BEDROCK but losing four points across five daily notes. USDT stayed near 1.00 in every fixture row, which makes the week's story less about a broken peg and more about calm data refusing to become a headline. The recap should notice the drift without inventing a crisis.",
  "The active depeg observations rose from 0 to 4 as the week progressed, but the recap input separates those observations from unique signals. That distinction matters because one persistent condition should not masquerade as five independent events just because it survived five daily snapshots. It is burden, not necessarily breadth.",
  "Blacklist activity accumulated 10 fixture events while grade transitions appeared on alternating days, giving the model enough secondary texture without overwhelming the market-cap arc. The Bank Run Gauge climbed from 10 to 14, a mild range that supports watchfulness rather than panic. Weekly structure should tie those pieces together instead of stapling them into a list.",
  "The weekly note should therefore synthesize the slow drift: PSI softened, enforcement kept tapping the glass, and supply rose by $4M from the first daily edition to the last. That is a complete recap, but it is still restrained enough for a market that mostly held together. A reader should leave with a coherent week, not seven smaller mornings, and should understand which signals were excluded because they were too small or too stale for a serious lead in public without drama today. Next week will decide whether the 10 observations consolidate into a durable trend or fade; if the gauge crosses 20, the recap flips from restrained to sharper.",
].join("\n\n");

function weeklyClaudeResponse(overrides: Partial<{
  title: string;
  text: string;
  extended: string;
  meta: Record<string, unknown>;
}> = {}): Response {
  return new Response(JSON.stringify({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          title: overrides.title ?? "Weekly Calm",
          text: overrides.text ?? "PSI softened by 4 points while USDT stayed near peg and blacklist activity kept tapping the glass.",
          extended: overrides.extended ?? VALID_WEEKLY_EXTENDED,
          meta: overrides.meta ?? {
            leadSignalId: "weekly:psi",
            lead: "psi-regime",
            tone: "dry",
            coins: ["USDT", "USDC"],
            usedCandidateIds: ["weekly:psi"],
          },
        }),
      },
    ],
  }), { status: 200 });
}

function buildDailyRows() {
  // Start at Tuesday 2026-03-24 12:00 UTC so all 5 rows fall within the
  // "current week" window (weekBoundary = todayTs - 6d = Tue 00:00 UTC
  // given the cron runs Monday 03-30 08:05 UTC).
  const baseTs = Math.floor(Date.UTC(2026, 2, 24, 12, 0, 0) / 1000);
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
      match: "SELECT digest_title, digest_text, digest_meta",
      rows: [],
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
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse());

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
      VALID_WEEKLY_EXTENDED,
      "2026-03-30-weekly",
      { botToken: "bot", chatId: "chat" },
    );

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO daily_digest"));
    expect(insert).toBeTruthy();
    expect(insert?.binds[1]).toBe("PSI softened by 4 points while USDT stayed near peg and blacklist activity kept tapping the glass.");
    expect(insert?.binds[2]).toBe("Weekly Calm");
    expect(JSON.parse(String(insert?.binds[5]))).toEqual({
      leadSignalId: "weekly:psi",
      lead: "psi-regime",
      tone: "dry",
      coins: ["USDT", "USDC"],
      usedCandidateIds: ["weekly:psi"],
      type: "weekly",
      periodType: "trailing-daily-editions",
      weekStart: "2026-03-24",
      weekEnd: "2026-03-28",
    });

    expect(fetchWithRetry).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.any(Object),
      2,
      { timeoutMs: 11 * 60_000 },
    );

    const weeklyBody = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      model: string;
      max_tokens: number;
      thinking?: { type: string };
      output_config?: { effort: string };
      system: string;
    };
    expect(weeklyBody.model).toBe("claude-opus-4-7");
    expect(weeklyBody.thinking).toEqual({ type: "adaptive" });
    expect(weeklyBody.output_config).toEqual({ effort: "max" });
    expect(weeklyBody.max_tokens).toBe(20000);

    const weeklySystem = weeklyBody.system as string;
    expect(weeklySystem).toContain("forward-look");
    expect(weeklySystem).toContain("plumbing");
    expect(weeklySystem).toContain("week-over-week");
    expect(weeklySystem).toContain("arc");
  });

  it("repairs non-JSON weekly output with a corrective retry", async () => {
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify({
        content: [
          {
            type: "text",
            text: "USDT stayed at 1.00 all week, blacklist pressure faded, and weekly flows stayed calm.",
          },
        ],
      }), { status: 200 }),
    );
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse());

    const result = await generateWeeklyRecap(db, "anthropic-key", null);

    expect(result.itemCount).toBe(1);
    expect(result.status).toBeUndefined();
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO daily_digest"));
    expect(insert).toBeTruthy();
    expect(insert?.binds[1]).toBe("PSI softened by 4 points while USDT stayed near peg and blacklist activity kept tapping the glass.");
    expect(insert?.binds[2]).toBe("Weekly Calm");
  });

  it("prints N/A for weekly market-cap change when the week starts from zero", async () => {
    const zeroStartRows = buildDailyRows();
    zeroStartRows[0] = {
      ...zeroStartRows[0]!,
      input_data: JSON.stringify({
        ...JSON.parse(zeroStartRows[0]!.input_data),
        totalMcapUsd: 0,
      }),
    };

    const db = mockD1(makeTables({ dailyRows: zeroStartRows }), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse({ title: "Zero Base Week" }));

    await generateWeeklyRecap(db, "anthropic-key", null);

    const anthropicRequest = vi.mocked(fetchWithRetry).mock.calls[0];
    const body = anthropicRequest?.[1]?.body;
    expect(typeof body).toBe("string");
    expect(body).toContain("(N/A)");
    expect(body).not.toContain("Infinity");
  });

  it("includes week-over-week deltas in prompt when prior week data exists", async () => {
    const current = buildDailyRows();
    const prior = buildDailyRows().map((row, i) => ({
      ...row,
      generated_at: row.generated_at - 7 * 86_400,
      input_data: JSON.stringify({
        ...(JSON.parse(row.input_data) as Record<string, unknown>),
        totalMcapUsd: 99_000_000 + i * 1_000_000,
        stabilityIndex: { score: 92 - i, band: "BEDROCK" },
      }),
    }));

    const db = mockD1([
      {
        match: "SELECT id FROM daily_digest WHERE generated_at >= ? AND json_extract(digest_meta, '$.type') = 'weekly'",
        first: null,
        rows: [],
      },
      { match: "SELECT digest_title, digest_text, digest_meta", rows: [] },
      {
        match: "WHERE generated_at >= ? AND (digest_meta IS NULL",
        rows: [...prior, ...current],
      },
      { match: "INSERT INTO daily_digest", rows: [] },
    ]);
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse());

    await generateWeeklyRecap(db, "anthropic-key", null);

    const body = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[0].content).toContain("Week-over-week deltas");
    expect(body.messages[0].content).toMatch(/mcap: current .+ prior .+ delta/i);
    expect(body.messages[0].content).toMatch(/PSI midpoint: current .+ prior .+/i);
  });

  it("normalizes weekly meta lead and tone through the allowlist", async () => {
    const db = mockD1(makeTables(), { requireMatch: true });
    vi.mocked(fetchWithRetry).mockImplementation(async () => weeklyClaudeResponse({
      meta: {
        leadSignalId: "wk:arc",
        lead: "Week narrative about USDC flow rotation accelerating mid-week",
        tone: "structurally-concerned-sardonic",
        coins: ["USDC"],
      },
    }));

    await generateWeeklyRecap(db, "anthropic-key", null);

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO daily_digest"));
    expect(insert).toBeTruthy();
    const metaStored = JSON.parse(String(insert?.binds[5])) as Record<string, unknown>;
    expect(metaStored.lead).toBe("other");
    expect(metaStored.tone).toBe("other");
    expect(metaStored.type).toBe("weekly");
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
