import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";

const sendToChatMock = vi.hoisted(() => vi.fn());

vi.mock("../../delivery/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../delivery/telegram")>();
  return {
    ...actual,
    sendToChat: sendToChatMock,
  };
});

const { sendAuditedTelegramReply } = await import("../telegram-webhook-replies");

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
    const db = mockD1();
    expect(await sendAuditedTelegramReply(db, "12345", "chunk ".repeat(1400), "bot-token"))
      .toEqual({ ok: false, errorClass: "rate_limit" });
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    const failures = db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO telegram_usage_daily"));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.binds[1]).toBe("reply_failure");
    expect(failures[0]?.binds[6]).toBe("rate_limit");
  });

  it("continues after transient failure, keeps failed aggregate, and attaches markup only to the last chunk", async () => {
    sendToChatMock.mockResolvedValueOnce({ ok: false, retryable: true, errorClass: "network", statusCode: null })
      .mockResolvedValue({ ok: true, errorClass: null });
    const db = mockD1();
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
    const db = mockD1();
    expect(await sendAuditedTelegramReply(db, "12345", "reply", "bot-token", { recordReplyOutcome: false }))
      .toEqual({ ok: false, errorClass: "blocked" });
    const history = db.getHistory();
    const failures = history.filter((entry) => entry.sql.includes("INSERT INTO telegram_usage_daily"));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.binds[1]).toBe("reply_failure");
    expect(failures[0]?.binds[6]).toBe("blocked");
    expect(history.some((entry) => entry.sql.includes("telegram_chat_delivery_diagnostics"))).toBe(false);
  });
});
