import { answerCallbackQuery } from "../lib/telegram";
import { getCachedChatMember } from "../lib/telegram-chat-member";

export function isGroupChatType(chatType: string | null | undefined): boolean {
  return chatType === "group" || chatType === "supergroup";
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
