import { describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { handleForget } from "../forget";
import type { WebhookCommandContext } from "../context";
import { makeCommandContext } from "./webhook-commands.test-support.ts";

function makeContext(overrides: Partial<WebhookCommandContext> = {}): WebhookCommandContext {
  return makeCommandContext(mockD1(), { actorUserId: "42", ...overrides });
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
});
