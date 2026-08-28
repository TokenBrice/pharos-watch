import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";

const sendToChatMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram")>();
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
});
