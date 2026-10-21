import { answerCallbackQuery, postTelegramBotApi } from "../delivery/telegram";
import { timingSafeCompare } from "../../lib/auth";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { getCache, setCache } from "../../lib/db-cache";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  logTelegramInvalidSecretAttempt,
  logTelegramMissingSecretAttempt,
} from "../common/log";
import { cancelResponseBodyQuietly, readResponseJsonWithinLimitWithSignal } from "../../lib/response-body";
import { DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES } from "../../lib/fetch-retry";

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

/**
 * `unknown` means the Bot API lookup itself failed (network, 429, 5xx), which
 * says nothing about the actor; callers must not treat it as "not an admin".
 */
export type TelegramGroupAdminStatus = "admin" | "not_admin" | "unknown";

export const GROUP_ADMIN_UNVERIFIED_MESSAGE = "Couldn't verify admin status. Please try again.";

export async function resolveGroupAdminStatus(
  botToken: string,
  chatId: string,
  actorUserId: string | null,
): Promise<TelegramGroupAdminStatus> {
  if (!actorUserId) return "not_admin";
  let response: Response;
  try {
    response = await postTelegramBotApi(botToken, "getChatMember", {
      chat_id: chatId,
      user_id: Number(actorUserId),
    });
  } catch {
    return "unknown";
  }
  if (!response.ok) {
    await cancelResponseBodyQuietly(response);
    // A definitive Bot API refusal (e.g. the user is not a member) is a real
    // answer; throttling and server errors are not.
    return response.status === 429 || response.status >= 500 ? "unknown" : "not_admin";
  }
  try {
    const body = await readResponseJsonWithinLimitWithSignal<{ ok?: boolean; result?: { status?: string } }>(
      response, DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES,
    );
    if (!body.ok || !body.result) return "unknown";
    const status = body.result.status;
    return status === "creator" || status === "administrator" ? "admin" : "not_admin";
  } catch {
    return "unknown";
  }
}

export async function isGroupAdminActor(
  botToken: string,
  chatId: string,
  actorUserId: string | null,
): Promise<boolean> {
  return await resolveGroupAdminStatus(botToken, chatId, actorUserId) === "admin";
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
  const status = await resolveGroupAdminStatus(botToken, chatId, actorUserId);
  if (status === "admin") return true;
  await beforeIrreversibleEffect("callback-ack");
  await answerCallbackQuery(callbackQueryId, botToken, {
    text: status === "unknown" ? GROUP_ADMIN_UNVERIFIED_MESSAGE : denialText,
  });
  return false;
}

// ---------- Cached chat administrators (denial hints only, never authorization) ----------

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
  if (!status) {
    logWorkerEventArgs(
      "lib",
      "warn",
      "[telegram-chat-member] ignored malformed administrator status:",
      String(raw.status),
    );
    return null;
  }
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
    await cancelResponseBodyQuietly(response);
    logWorkerEventArgs("lib", "warn", `[telegram-chat-member] getChatAdministrators returned ${response.status} for chat ${chatId}`);
    return null;
  }

  let body: TelegramApiResponse<TelegramChatMemberResult[]>;
  try {
    body = await readResponseJsonWithinLimitWithSignal(response, DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES);
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
