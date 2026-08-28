import { describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { handleForget } from "../forget";
import type { WebhookCommandContext } from "../context";

function makeContext(overrides: Partial<WebhookCommandContext> = {}): WebhookCommandContext {
  return {
    db: mockD1(),
    chatId: "42",
    chatType: "private",
    username: "alice",
    actorUserId: "42",
    botToken: "bot-token",
    replyToChat: vi.fn().mockResolvedValue(undefined),
    replyToChatWithMarkup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("handleForget", () => {
  it("rejects group chats with a private-chat-only message and records a not_private failure", async () => {
    const replyToChat = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ chatType: "group", replyToChat });

    await handleForget(ctx, "");

    expect(replyToChat).toHaveBeenCalledWith(
      expect.stringContaining("Open a private chat"),
    );
    expect((ctx.db as MockD1Database).getHistory().some((entry) =>
      entry.sql.includes("INSERT INTO telegram_pending_disambiguation"),
    )).toBe(false);
  });

  it("rejects supergroups with the private-chat-only message", async () => {
    const replyToChat = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ chatType: "supergroup", replyToChat });

    await handleForget(ctx, "");

    expect(replyToChat).toHaveBeenCalledTimes(1);
    expect((ctx.db as MockD1Database).getHistory().some((entry) =>
      entry.sql.includes("INSERT INTO telegram_pending_disambiguation"),
    )).toBe(false);
  });

  it("persists a forget-confirm pending row and offers an inline keyboard in private chats", async () => {
    const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
    const db = mockD1([{ match: "INSERT INTO telegram_pending_disambiguation", rows: [], runMeta: { changes: 1 } }]);
    const ctx = makeContext({ db, replyToChatWithMarkup });

    await handleForget(ctx, "");

    expect(replyToChatWithMarkup).toHaveBeenCalledTimes(1);
    const [message, options] = replyToChatWithMarkup.mock.calls[0];
    expect(message).toContain("delete your Pharos subscriber data");
    expect(message).toContain("Pharos will retain only");
    expect(message).toContain("acknowledged Telegram updates");
    expect(message).toContain("delivery audit manifests");
    expect(message).toContain("privacy-preserving aggregate counters");
    expect(options).toEqual({
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: "Open control panel",
              web_app: { url: "https://pharos.watch/pharoswatchbot/app/?startapp=forget" },
            },
          ],
          [
            { text: "Confirm", callback_data: "confirm:forget" },
            { text: "Cancel", callback_data: "cancel:forget" },
          ],
        ],
      },
    });
    const writes = db.getHistory().filter((entry) =>
      entry.sql.includes("INSERT INTO telegram_pending_disambiguation"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.binds).toContain("forget-confirm");
  });

  it("warns when another pending action already owns the chat", async () => {
    const replyToChat = vi.fn().mockResolvedValue(undefined);
    const db = mockD1([{ match: "INSERT INTO telegram_pending_disambiguation", rows: [], runMeta: { changes: 0 } }]);
    const ctx = makeContext({ db, replyToChat });

    await handleForget(ctx, "");

    expect(replyToChat).toHaveBeenCalledWith(
      expect.stringContaining("Another user has a pending"),
    );
  });
});
