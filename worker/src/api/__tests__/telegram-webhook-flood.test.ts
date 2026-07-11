import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { makeTelegramUpdateRequest } from "../../test-helpers/__shared/telegram";

// The audited reply helper is mocked so the flood notice reply can throw;
// the production helper swallows Telegram/D1 failures internally.
const sendAuditedTelegramReplyMock = vi.hoisted(() =>
  vi.fn<(db: unknown, chatId: string, message: string, botToken: string, options?: unknown) => Promise<void>>(),
);
vi.mock("../telegram-webhook-replies", () => ({
  sendAuditedTelegramReply: sendAuditedTelegramReplyMock,
}));

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

const { handleTelegramWebhook } = await import("../telegram-webhook");

function makeWebhookRequest(chatId: number, text: string): Request {
  return makeTelegramUpdateRequest({
    message: {
      chat: { id: chatId, username: "testuser", type: "private" },
      from: { id: 999, username: "requester" },
      text,
    },
  });
}

describe("telegram webhook per-chat flood cap", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    sendAuditedTelegramReplyMock.mockReset();
  });

  it("does not process an over-limit command when the flood notice reply throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    sendAuditedTelegramReplyMock.mockRejectedValue(new Error("reply boom"));
    // 21st command inside the window: counter row already at the limit of 20.
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "RETURNING value",
        rows: [{ value: "21" }],
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    // Only the failed flood notice — the /help handler never produced a reply.
    expect(sendAuditedTelegramReplyMock).toHaveBeenCalledTimes(1);
    expect(String(sendAuditedTelegramReplyMock.mock.calls[0]?.[2])).toContain("Too many commands");
    const usageRow = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_usage_daily") &&
          entry.binds[1] === "command" &&
          entry.binds[3] === "/help",
      );
    expect(usageRow).toBeDefined();
    expect(usageRow!.binds[4]).toBe("rate_limited");
    expect(usageRow!.binds[6]).toBe("chat-flood");
    nowSpy.mockRestore();
    warn.mockRestore();
  });
});
