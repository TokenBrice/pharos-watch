/**
 * Shared context passed to every command handler in the Telegram webhook
 * dispatch table. Handlers receive the runtime dependencies they may need; not
 * every handler uses every field. Reply helpers are bound to the active chat
 * to keep call sites short.
 */
export interface WebhookCommandContext {
  db: D1Database;
  chatId: string;
  chatType: string;
  username: string | null;
  actorUserId: string | null;
  botToken: string;
  /** Sends a plain text message to the originating chat. */
  replyToChat: (message: string) => Promise<void>;
  /** Sends a message with an optional inline keyboard / reply markup. */
  replyToChatWithMarkup: (
    message: string,
    options: { replyMarkup?: unknown },
  ) => Promise<void>;
}

export type WebhookCommandHandler = (
  ctx: WebhookCommandContext,
  args: string,
) => Promise<void>;

/**
 * Sends `message`, attaching the mini-app `markup` only in private chats. In
 * group/supergroup chats the inline mini-app keyboard is omitted (Telegram
 * mini-apps are DM-only), so the plain reply is used instead.
 */
export async function replyWithOptionalMiniApp(
  ctx: WebhookCommandContext,
  message: string,
  markup: unknown,
): Promise<void> {
  if (ctx.chatType === "private") {
    await ctx.replyToChatWithMarkup(message, { replyMarkup: markup });
    return;
  }
  await ctx.replyToChat(message);
}
