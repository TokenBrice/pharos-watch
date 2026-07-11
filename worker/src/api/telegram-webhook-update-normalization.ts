import type { TelegramWebhookUpdate } from "./telegram-webhook-shared";
import type { TelegramChatMemberUpdated } from "./telegram-webhook-group-welcome";

/**
 * Pure update-shape normalization for webhook ingress: classify the raw
 * Telegram update payload and extract claim/routing identifiers without
 * touching D1 or the Bot API.
 */

export type TelegramWebhookUpdateWithChatMember = TelegramWebhookUpdate & {
  my_chat_member?: TelegramChatMemberUpdated;
};

export function resolveUpdateType(update: TelegramWebhookUpdateWithChatMember): string {
  if (update.inline_query) return "inline_query";
  if (update.chosen_inline_result) return "chosen_inline_result";
  if (update.callback_query) return "callback_query";
  if (update.message) return "message";
  if (update.my_chat_member) return "my_chat_member";
  return "unknown";
}

export function resolveUpdateChatId(update: TelegramWebhookUpdateWithChatMember): string | null {
  const messageChatId = update.message?.chat?.id;
  if (typeof messageChatId === "number" && Number.isFinite(messageChatId)) {
    return String(messageChatId);
  }
  const callbackChatId = update.callback_query?.message?.chat?.id;
  if (typeof callbackChatId === "number" && Number.isFinite(callbackChatId)) {
    return String(callbackChatId);
  }
  const memberChatId = update.my_chat_member?.chat?.id;
  if (typeof memberChatId === "number" && Number.isFinite(memberChatId)) {
    return String(memberChatId);
  }
  return null;
}

export function resolveChatMigration(message: TelegramWebhookUpdate["message"] | undefined): {
  oldChatId: string;
  newChatId: string;
} | null {
  const currentChatId = message?.chat?.id;
  if (typeof currentChatId !== "number" || !Number.isFinite(currentChatId)) {
    return null;
  }
  const migrateToChatId = message?.migrate_to_chat_id;
  if (typeof migrateToChatId === "number" && Number.isFinite(migrateToChatId)) {
    return {
      oldChatId: String(currentChatId),
      newChatId: String(migrateToChatId),
    };
  }
  const migrateFromChatId = message?.migrate_from_chat_id;
  if (typeof migrateFromChatId === "number" && Number.isFinite(migrateFromChatId)) {
    return {
      oldChatId: String(migrateFromChatId),
      newChatId: String(currentChatId),
    };
  }
  return null;
}
