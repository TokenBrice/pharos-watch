import { describe, expect, it, vi } from "vitest";
import { handleRecap } from "../webhook-commands/recap";
import type { WebhookCommandContext } from "../webhook-commands/context";
import { handleRecapCallback } from "../webhook-callbacks/recap";
import type { CallbackContext } from "../webhook-callbacks/_shared";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import type { TelegramRecapRolloutPolicy } from "@shared/lib/telegram-recap-rollout";

function commandContext(policy: TelegramRecapRolloutPolicy): WebhookCommandContext {
  return {
    db: mockD1(),
    chatId: "42",
    chatType: "private",
    username: "watcher",
    actorUserId: "42",
    botToken: "token",
    recapRollout: policy,
    replyToChat: vi.fn(async () => undefined),
    replyToChatWithMarkup: vi.fn(async () => undefined),
  };
}

function callbackContext(policy: TelegramRecapRolloutPolicy): CallbackContext {
  return {
    db: mockD1(),
    botToken: "token",
    chatId: "42",
    recapRollout: policy,
    cb: {
      id: "callback",
      data: "recap:invalid",
      from: { id: 42 },
      message: { chat: { id: 42, type: "private" } },
    },
    parsed: { action: "recap", arg: "invalid", parts: ["recap", "invalid"] },
    beforeIrreversibleEffect: async () => undefined,
    answerCallback: vi.fn(async () => undefined),
    markMutationApplied: async () => undefined,
  };
}

const deniedPolicies: readonly TelegramRecapRolloutPolicy[] = [
  { mode: "off", allowedChatIds: new Set() },
  { mode: "dark", allowedChatIds: new Set() },
  { mode: "canary", allowedChatIds: new Set(["0042"]) },
];

describe("Telegram recap rollout ingress gates", () => {
  it.each(deniedPolicies)("denies /recap before preference reads in %s mode", async (policy) => {
    const ctx = commandContext(policy);

    await handleRecap(ctx, "");

    expect(ctx.replyToChat).toHaveBeenCalledWith("Daily watchlist recaps are not available for this chat.");
    expect((ctx.db as ReturnType<typeof mockD1>).getHistory()).toHaveLength(0);
  });

  it.each(deniedPolicies)("denies recap callbacks before preference reads in %s mode", async (policy) => {
    const ctx = callbackContext(policy);

    await handleRecapCallback(ctx);

    expect(ctx.answerCallback).toHaveBeenCalledWith({ text: "Daily recaps are not available for this chat." });
    expect((ctx.db as ReturnType<typeof mockD1>).getHistory()).toHaveLength(0);
  });

  it("allows exact canary IDs and public users through both ingress gates", async () => {
    for (const policy of [
      { mode: "canary" as const, allowedChatIds: new Set(["42"]) },
      { mode: "public" as const, allowedChatIds: new Set<string>() },
    ]) {
      const command = commandContext(policy);
      await handleRecap(command, "invalid");
      expect(command.replyToChat).toHaveBeenCalledWith(expect.stringContaining("Usage:"));

      const callback = callbackContext(policy);
      await handleRecapCallback(callback);
      expect(callback.answerCallback).toHaveBeenCalledWith({ text: "Action not recognized." });
    }
  });
});
