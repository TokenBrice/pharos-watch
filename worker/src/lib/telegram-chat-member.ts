import { getCache, setCache } from "./db-cache";
import { drainResponseBody } from "./response-body";
import { postTelegramBotApi } from "./telegram";
import { toErrorMessage } from "./error-utils";

const CHAT_MEMBER_CACHE_TTL_SEC = 5 * 60;

export type TelegramChatMemberStatus =
  | "creator"
  | "administrator"
  | "member"
  | "restricted"
  | "left"
  | "kicked";

export interface TelegramChatMember {
  status: TelegramChatMemberStatus;
  userId: string;
  username: string | null;
  firstName: string | null;
}

interface TelegramApiUser {
  id?: number;
  username?: string;
  first_name?: string;
}

interface TelegramChatMemberResult {
  status?: string;
  user?: TelegramApiUser;
}

interface TelegramApiResponse<T> {
  ok?: boolean;
  result?: T;
}

function chatMemberCacheKey(chatId: string, userId: string): string {
  return `telegram:chat-member:${chatId}:${userId}`;
}

function chatAdminsCacheKey(chatId: string): string {
  return `telegram:chat-admins:${chatId}`;
}

function isFresh(updatedAt: number): boolean {
  return Math.floor(Date.now() / 1000) - updatedAt < CHAT_MEMBER_CACHE_TTL_SEC;
}

function normalizeStatus(status: string | undefined): TelegramChatMemberStatus | null {
  switch (status) {
    case "creator":
    case "administrator":
    case "member":
    case "restricted":
    case "left":
    case "kicked":
      return status;
    default:
      return null;
  }
}

function normalizeMember(raw: TelegramChatMemberResult, fallbackUserId: string): TelegramChatMember | null {
  const status = normalizeStatus(raw.status);
  if (!status) return null;
  const userId = raw.user?.id != null ? String(raw.user.id) : fallbackUserId;
  return {
    status,
    userId,
    username: raw.user?.username ?? null,
    firstName: raw.user?.first_name ?? null,
  };
}

export async function getCachedChatMember(
  db: D1Database,
  botToken: string,
  chatId: string,
  userId: string,
): Promise<TelegramChatMember | null> {
  const cacheKey = chatMemberCacheKey(chatId, userId);
  const cached = await getCache(db, cacheKey);
  if (cached && isFresh(cached.updatedAt)) {
    try {
      const parsed = JSON.parse(cached.value) as TelegramChatMember;
      if (parsed && normalizeStatus(parsed.status)) {
        return parsed;
      }
    } catch {
      /* fall through to refresh */
    }
  }

  let response: Response;
  try {
    response = await postTelegramBotApi(botToken, "getChatMember", {
      chat_id: chatId,
      user_id: Number(userId),
    });
  } catch (err) {
    console.warn(
      `[telegram-chat-member] getChatMember fetch failed for chat ${chatId} user ${userId}:`,
      toErrorMessage(err),
    );
    return null;
  }

  if (!response.ok) {
    await drainResponseBody(response);
    console.warn(
      `[telegram-chat-member] getChatMember returned ${response.status} for chat ${chatId} user ${userId}`,
    );
    return null;
  }

  let body: TelegramApiResponse<TelegramChatMemberResult>;
  try {
    body = (await response.json()) as TelegramApiResponse<TelegramChatMemberResult>;
  } catch {
    return null;
  }

  if (!body.ok || !body.result) return null;
  const member = normalizeMember(body.result, userId);
  if (!member) return null;

  await setCache(db, cacheKey, JSON.stringify(member));
  return member;
}

export async function getCachedChatAdministrators(
  db: D1Database,
  botToken: string,
  chatId: string,
): Promise<TelegramChatMember[] | null> {
  const cacheKey = chatAdminsCacheKey(chatId);
  const cached = await getCache(db, cacheKey);
  if (cached && isFresh(cached.updatedAt)) {
    try {
      const parsed = JSON.parse(cached.value) as TelegramChatMember[];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through to refresh */
    }
  }

  let response: Response;
  try {
    response = await postTelegramBotApi(botToken, "getChatAdministrators", { chat_id: chatId });
  } catch (err) {
    console.warn(
      `[telegram-chat-member] getChatAdministrators fetch failed for chat ${chatId}:`,
      toErrorMessage(err),
    );
    return null;
  }

  if (!response.ok) {
    await drainResponseBody(response);
    console.warn(
      `[telegram-chat-member] getChatAdministrators returned ${response.status} for chat ${chatId}`,
    );
    return null;
  }

  let body: TelegramApiResponse<TelegramChatMemberResult[]>;
  try {
    body = (await response.json()) as TelegramApiResponse<TelegramChatMemberResult[]>;
  } catch {
    return null;
  }

  if (!body.ok || !Array.isArray(body.result)) return null;

  const admins = body.result
    .map((entry) => normalizeMember(entry, entry.user?.id != null ? String(entry.user.id) : ""))
    .filter((member): member is TelegramChatMember => member != null);

  await setCache(db, cacheKey, JSON.stringify(admins));
  return admins;
}

export function formatAdministratorMentions(admins: TelegramChatMember[]): string {
  const labels: string[] = [];
  for (const admin of admins) {
    if (admin.status !== "creator" && admin.status !== "administrator") continue;
    if (admin.username) {
      labels.push(`@${admin.username}`);
    } else if (admin.firstName) {
      labels.push(admin.firstName);
    }
  }
  return labels.join(", ");
}
