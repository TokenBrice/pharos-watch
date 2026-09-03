import { answerCallbackQuery, postTelegramBotApi } from "../lib/telegram";
import { timingSafeCompare } from "../lib/auth";
import {
  logTelegramInvalidSecretAttempt,
  logTelegramMissingSecretAttempt,
} from "../lib/telegram/log";
import { drainResponseBody } from "../lib/response-body";

export function isGroupChatType(chatType: string | null | undefined): boolean {
  return chatType === "group" || chatType === "supergroup";
}

export function isChannelChatType(chatType: string | null | undefined): boolean {
  return chatType === "channel";
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
    logTelegramMissingSecretAttempt({
      hasCurrentSecret: Boolean(webhookSecret?.trim()),
      hasPreviousSecret: Boolean(previousWebhookSecret?.trim()),
    });
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
  botToken: string,
  chatId: string,
  actorUserId: string | null,
): Promise<boolean> {
  if (!actorUserId) return false;
  const member = await getFreshChatMemberForAuthorization(botToken, chatId, actorUserId);
  if (!member) return false;
  return member?.status === "creator" || member?.status === "administrator";
}

async function getFreshChatMemberForAuthorization(
  botToken: string,
  chatId: string,
  actorUserId: string,
): Promise<{ status?: string } | null> {
  let response: Response;
  try {
    response = await postTelegramBotApi(botToken, "getChatMember", {
      chat_id: chatId,
      user_id: Number(actorUserId),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await drainResponseBody(response);
    return null;
  }
  try {
    const body = (await response.json()) as { ok?: boolean; result?: { status?: string } };
    return body.ok && body.result ? body.result : null;
  } catch {
    return null;
  }
}

export async function requireGroupAdminForCallback(
  botToken: string,
  callbackQueryId: string,
  chatId: string,
  chatType: string | null | undefined,
  actorUserId: string | null,
  denialText: string,
  beforeIrreversibleEffect: (kind: string) => Promise<void> = async () => undefined,
): Promise<boolean> {
  if (isChannelChatType(chatType)) {
    await beforeIrreversibleEffect("callback-ack");
    await answerCallbackQuery(callbackQueryId, botToken, {
      text: "Channel-originated actions are not supported.",
    });
    return false;
  }
  if (!isGroupChatType(chatType)) return true;
  if (await isGroupAdminActor(botToken, chatId, actorUserId)) return true;
  await beforeIrreversibleEffect("callback-ack");
  await answerCallbackQuery(callbackQueryId, botToken, { text: denialText });
  return false;
}
