import { answerCallbackQuery } from "../lib/telegram";
import { getCachedChatMember } from "../lib/telegram-chat-member";
import { timingSafeCompare } from "../lib/auth";
import { logTelegramInvalidSecretAttempt } from "../lib/telegram-log";

export function isGroupChatType(chatType: string | null | undefined): boolean {
  return chatType === "group" || chatType === "supergroup";
}

export type TelegramWebhookSecretAuthResult = "missing" | "valid" | "invalid";

export async function validateTelegramWebhookSecret(
  request: Request,
  webhookSecret?: string,
  previousWebhookSecret?: string,
): Promise<TelegramWebhookSecretAuthResult> {
  const providedSecret =
    request.headers.get("X-Telegram-Bot-Api-Secret-Token")?.trim() ?? "";
  if (!providedSecret) {
    return "missing";
  }

  const expectedSecrets = [
    webhookSecret?.trim(),
    previousWebhookSecret?.trim(),
  ].filter((secret): secret is string => Boolean(secret));
  const uniqueSecrets = Array.from(new Set(expectedSecrets));

  for (const secret of uniqueSecrets) {
    if (await timingSafeCompare(providedSecret, secret)) {
      return "valid";
    }
  }

  logTelegramInvalidSecretAttempt({
    hasCurrentSecret: Boolean(webhookSecret?.trim()),
    hasPreviousSecret: Boolean(previousWebhookSecret?.trim()),
    presentedLength: providedSecret.length,
  });
  return "invalid";
}

export async function isGroupAdminActor(
  db: D1Database,
  botToken: string,
  chatId: string,
  actorUserId: string | null,
): Promise<boolean> {
  if (!actorUserId) return false;
  const member = await getCachedChatMember(db, botToken, chatId, actorUserId);
  return member?.status === "creator" || member?.status === "administrator";
}

export async function requireGroupAdminForCallback(
  db: D1Database,
  botToken: string,
  callbackQueryId: string,
  chatId: string,
  chatType: string | null | undefined,
  actorUserId: string | null,
  denialText: string,
): Promise<boolean> {
  if (!isGroupChatType(chatType)) return true;
  if (await isGroupAdminActor(db, botToken, chatId, actorUserId)) return true;
  await answerCallbackQuery(callbackQueryId, botToken, { text: denialText });
  return false;
}
