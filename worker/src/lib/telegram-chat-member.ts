import { logWorkerEventArgs } from "./structured-log";
import { getCache, setCache } from "./db-cache";
import { drainResponseBody } from "./response-body";
import { postTelegramBotApi } from "./telegram";
import { toErrorMessage } from "./error-utils";

const CHAT_MEMBER_CACHE_TTL_SEC = 5 * 60;

export type TelegramChatMemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";

export interface TelegramChatMember {
  status: TelegramChatMemberStatus;
  userId: string;
  username: string | null;
  firstName: string | null;
  isAnonymous: boolean;
}

interface TelegramApiUser {
  id?: number;
  username?: string;
  first_name?: string;
}

interface TelegramChatMemberResult {
  status?: string;
  user?: TelegramApiUser;
  is_anonymous?: boolean;
}

interface TelegramApiResponse<T> {
  ok?: boolean;
  result?: T;
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
    isAnonymous: raw.is_anonymous === true,
  };
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
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry?.isAnonymous === "boolean")) {
        return parsed;
      }
    } catch {
      /* fall through to refresh */
    }
  }

  let response: Response;
  try {
    response = await postTelegramBotApi(botToken, "getChatAdministrators", { chat_id: chatId });
  } catch (err) {
    logWorkerEventArgs("lib", "warn", `[telegram-chat-member] getChatAdministrators fetch failed for chat ${chatId}:`, toErrorMessage(err));
    return null;
  }

  if (!response.ok) {
    await drainResponseBody(response);
    logWorkerEventArgs("lib", "warn", `[telegram-chat-member] getChatAdministrators returned ${response.status} for chat ${chatId}`);
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
    if (admin.isAnonymous) continue;
    if (admin.username) {
      labels.push(`@${admin.username}`);
    } else if (admin.firstName) {
      labels.push(admin.firstName);
    }
  }
  return labels.join(", ");
}
