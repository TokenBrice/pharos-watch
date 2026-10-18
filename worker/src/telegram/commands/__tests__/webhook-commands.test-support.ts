import { expect, vi } from "vitest";
import type { WebhookCommandContext } from "../context";

export type InlineButton = { text?: string; callback_data?: string; web_app?: { url?: string } };

export function makeCommandContext(db: D1Database, overrides: Partial<WebhookCommandContext> = {}): WebhookCommandContext {
  return {
    db, chatId: "42", chatType: "private", username: "alice", actorUserId: "99", botToken: "bot-token",
    replyToChat: vi.fn().mockResolvedValue(undefined),
    replyToChatWithMarkup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function buttonsFromMarkup(markup: unknown): InlineButton[] {
  const typed = markup as { inline_keyboard?: InlineButton[][] } | undefined;
  return (typed?.inline_keyboard ?? []).flat();
}

export function expectMiniAppButton(buttons: InlineButton[], text: string, startapp: string): void {
  expect(buttons.some((button) => button.text === text && button.web_app?.url?.includes(`startapp=${startapp}`))).toBe(true);
}
