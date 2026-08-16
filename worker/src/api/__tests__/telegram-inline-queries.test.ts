import { beforeEach, describe, expect, it } from "vitest";
import { mockD1 as baseMockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  createTelegramFetchSpy,
  makeTelegramUpdateRequest,
  telegramApiCallBody,
} from "../../test-helpers/__shared/telegram";

const { fetchSpy, reset: resetTelegramFetchSpy } = createTelegramFetchSpy();

const { handleTelegramWebhook } = await import("../telegram-webhook");
const { TELEGRAM_INLINE_STATUS_POLICY } = await import("../telegram-inline-queries");

function mockD1(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
) {
  return baseMockD1([
    ...tables,
    { match: "FROM dex_liquidity", rows: [], first: null },
    { match: "FROM yield_data", rows: [], first: null },
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "INSERT OR IGNORE INTO telegram_processed_updates", rows: [], runMeta: { changes: 1 } },
    { match: "UPDATE telegram_processed_updates", rows: [], runMeta: { changes: 1 } },
    { match: "INSERT INTO telegram_usage_daily", rows: [] },
    { match: "FROM stress_signals_latest", rows: [], first: null },
    { match: "FROM stress_signals s", rows: [], first: null },
    { match: "FROM stress_signal_publication_rows", rows: [], first: null },
    { match: "stress_signals", rows: [], first: null },
  ], options);
}

function makeInlineQueryRequest(query: string, updateId?: number): Request {
  return makeTelegramUpdateRequest(
    {
      inline_query: {
        id: "inline-query-id",
        query,
        from: { id: 123456, username: "not-retained" },
      },
    },
    { updateId },
  );
}

function makeChosenInlineResultRequest(): Request {
  return makeTelegramUpdateRequest(
    {
      chosen_inline_result: {
        result_id: "status:usdc-circle",
        from: { id: 123456, username: "not-retained" },
      },
    },
    { updateId: 81 },
  );
}

function inlineReadLimitRows() {
  return [{ match: "INSERT INTO cache", rows: [{ value: "1" }] }];
}

function inlineAnswerBody(): {
  inline_query_id: string;
  results: Array<{
    type: string;
    id: string;
    title: string;
    input_message_content: {
      message_text: string;
      parse_mode: string;
      link_preview_options?: { is_disabled: boolean };
    };
  }>;
  cache_time: number;
  is_personal: boolean;
} {
  return telegramApiCallBody(fetchSpy, "answerInlineQuery");
}

describe("Telegram inline status cards", () => {
  beforeEach(() => {
    resetTelegramFetchSpy();
  });

  it("serves one source-attributed status card through the existing status loader", async () => {
    const db = mockD1([
      ...inlineReadLimitRows(),
      { match: "FROM price_cache WHERE asset_id = ?", rows: [{ price: 0.9997, updated_at: 1_700_000_000 }] },
      { match: "FROM safety_grade_history", rows: [{ grade: "A", score: 88, recorded_at: 1_700_000_000 }] },
      { match: "FROM stress_signals", rows: [{ band: "CALM", score: 5, computed_at: 1_700_000_000 }] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
    ]);

    const response = await handleTelegramWebhook(db, makeInlineQueryRequest("USDC"), "test-secret", "bot-token");

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/answerInlineQuery");
    expect(inlineAnswerBody()).toMatchObject({
      inline_query_id: "inline-query-id",
      cache_time: TELEGRAM_INLINE_STATUS_POLICY.resultCacheTimeSec,
      is_personal: false,
      results: [
        {
          type: "article",
          id: "status:usdc-circle",
          title: "USDC status",
          input_message_content: {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          },
        },
      ],
    });
    expect(inlineAnswerBody().results[0]?.input_message_content.message_text).toContain(
      "Source: Pharos cached market and risk data",
    );
    expect(new TextEncoder().encode(inlineAnswerBody().results[0]?.id ?? "").length).toBeLessThanOrEqual(64);

    const usageRows = db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO telegram_usage_daily"));
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]?.binds).toContain("inline_query");
    expect(usageRows[0]?.binds).toContain("served");
    expect(usageRows[0]?.binds).not.toContain("USDC");
    expect(usageRows[0]?.binds).not.toContain("inline-query-id");
    expect(usageRows[0]?.binds).not.toContain(123456);
  });

  it.each([
    ["", "empty"],
    ["unknowncoin", "unknown"],
    ["USDC now", "invalid"],
  ])("answers %s safely with no card", async (query, outcome) => {
    const db = mockD1([]);

    const response = await handleTelegramWebhook(db, makeInlineQueryRequest(query), "test-secret", "bot-token");

    expect(response.status).toBe(200);
    expect(inlineAnswerBody()).toMatchObject({
      results: [],
      cache_time: TELEGRAM_INLINE_STATUS_POLICY.emptyResultCacheTimeSec,
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM price_cache"))).toBe(false);
    const usageRow = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_usage_daily"));
    expect(usageRow?.binds).toContain(outcome);
    if (query) expect(usageRow?.binds).not.toContain(query);
  });

  it("rate-limits repeated equivalent status card reads before loading status rows", async () => {
    const db = mockD1([
      { match: "INSERT INTO cache", rows: [{ value: "1" }], runMeta: { changes: 0 } },
      {
        match: "SELECT updated_at FROM cache WHERE key = ?",
        rows: [
          {
            key: "telegram:command-cooldown:inline:123456:/status:usdc-circle",
            updated_at: Math.floor(Date.now() / 1000),
          },
        ],
      },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [{ price: 1, updated_at: 1_700_000_000 }] },
    ]);

    const response = await handleTelegramWebhook(db, makeInlineQueryRequest("  usdc  "), "test-secret", "bot-token");

    expect(response.status).toBe(200);
    expect(inlineAnswerBody()).toMatchObject({
      results: [],
      cache_time: TELEGRAM_INLINE_STATUS_POLICY.emptyResultCacheTimeSec,
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM price_cache"))).toBe(false);
    const usageRow = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_usage_daily"));
    expect(usageRow?.binds).toContain("inline_query");
    expect(usageRow?.binds).toContain("rate_limited");
    expect(usageRow?.binds).not.toContain("usdc");
    expect(usageRow?.binds).not.toContain(123456);
  });

  it("records chosen cards as an aggregate only and makes no Bot API request", async () => {
    const db = mockD1([]);

    const response = await handleTelegramWebhook(db, makeChosenInlineResultRequest(), "test-secret", "bot-token");

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const usageRows = db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO telegram_usage_daily"));
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]?.binds).toContain("inline_result_chosen");
    expect(usageRows[0]?.binds).toContain("chosen");
    expect(usageRows[0]?.binds).not.toContain("status:usdc-circle");
    expect(usageRows[0]?.binds).not.toContain(123456);
  });

  it("records a failed inline answer as a bounded aggregate", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const db = mockD1([
      ...inlineReadLimitRows(),
      { match: "FROM price_cache WHERE asset_id = ?", rows: [{ price: 1, updated_at: 1_700_000_000 }] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
    ]);

    const response = await handleTelegramWebhook(db, makeInlineQueryRequest("USDC"), "test-secret", "bot-token");

    expect(response.status).toBe(200);
    const usageRow = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_usage_daily"));
    expect(usageRow?.binds).toContain("inline_query");
    expect(usageRow?.binds).toContain("answer_failed");
    expect(usageRow?.binds).not.toContain("USDC");
    expect(usageRow?.binds).not.toContain("inline-query-id");
  });
});
