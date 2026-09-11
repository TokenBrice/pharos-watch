import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const sendToChatMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram")>();
  return {
    ...actual,
    sendToChat: sendToChatMock,
  };
});

const { sendAuditedTelegramReply } = await import("../telegram-webhook-replies");
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("sendAuditedTelegramReply", () => {
  beforeEach(() => {
    sendToChatMock.mockReset();
  });

  it("stops sending chunks after a terminal failure", async () => {
    sendToChatMock.mockResolvedValue({
      ok: false,
      blocked: false,
      retryable: false,
      permanentFailure: true,
      statusCode: 400,
      errorClass: "bad_request",
      delivery: "permanent_failure",
      retryAfterSec: null,
    });
    const db = mockD1();
    const longReply = `${"terminal failure chunk ".repeat(260)}done`;

    const result = await sendAuditedTelegramReply(db, "12345", longReply, "bot-token", {
      actionDetail: "terminal-test",
    });

    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, errorClass: "bad_request" });
    const replyFailures = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT INTO telegram_usage_daily"));
    expect(replyFailures).toHaveLength(1);
    expect(replyFailures[0]?.binds).toContain("reply_failure");
    expect(replyFailures[0]?.binds).toContain("bad_request");
  });

  it("stops after a retryable rate limit rather than flooding remaining chunks", async () => {
    sendToChatMock.mockResolvedValue({ ok: false, retryable: true, errorClass: "rate_limit", statusCode: 429 });
    const { db, sqlite } = fixtures.open();
    expect(await sendAuditedTelegramReply(db, "12345", "chunk ".repeat(1400), "bot-token"))
      .toEqual({ ok: false, errorClass: "rate_limit" });
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT event_type, failure_class, count FROM telegram_usage_daily").all())
      .toEqual([{ event_type: "reply_failure", failure_class: "rate_limit", count: 1 }]);
  });

  it("continues after transient failure, keeps failed aggregate, and attaches markup only to the last chunk", async () => {
    sendToChatMock.mockResolvedValueOnce({ ok: false, retryable: true, errorClass: "network", statusCode: null })
      .mockResolvedValue({ ok: true, errorClass: null });
    const { db } = fixtures.open();
    const replyMarkup = { inline_keyboard: [[{ text: "Open", callback_data: "settings:home" }]] };
    expect(await sendAuditedTelegramReply(db, "12345", "chunk ".repeat(1400), "bot-token", { replyMarkup }))
      .toEqual({ ok: false, errorClass: "network" });
    const calls = sendToChatMock.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.slice(0, -1).map((call) => call[3].replyMarkup)).toEqual([undefined, undefined]);
    expect(calls[2][3].replyMarkup).toEqual(replyMarkup);
  });

  it("can disable reply diagnostics without suppressing failure analytics", async () => {
    sendToChatMock.mockResolvedValue({ ok: false, retryable: false, errorClass: "blocked", statusCode: 403 });
    const { db, sqlite } = fixtures.open();
    expect(await sendAuditedTelegramReply(db, "12345", "reply", "bot-token", { recordReplyOutcome: false }))
      .toEqual({ ok: false, errorClass: "blocked" });
    expect(sqlite.prepare("SELECT event_type, failure_class, count FROM telegram_usage_daily").all())
      .toEqual([{ event_type: "reply_failure", failure_class: "blocked", count: 1 }]);
    expect(sqlite.prepare("SELECT * FROM telegram_chat_delivery_diagnostics").all()).toEqual([]);
  });
});
