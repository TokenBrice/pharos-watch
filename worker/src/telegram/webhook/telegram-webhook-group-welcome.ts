import { TELEGRAM_BOT_URL, TELEGRAM_BOT_USERNAME } from "@shared/lib/telegram-bot-registration";
import { escapeHtml } from "../delivery/telegram";
import { deleteCache, getCache } from "../../lib/db-cache";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { classifyTelegramLogError, logTelegramEvent } from "../common/log";
import { isChannelChatType, isGroupChatType } from "./telegram-webhook-auth";
import { forgetSubscriber, telegramGroupWelcomeDeadlineSql } from "../store/subscriber-lifecycle";
import { sendAuditedTelegramReply } from "./telegram-webhook-replies";
import {
  TELEGRAM_GROUP_WELCOME_CACHE_TTL_SEC,
  TELEGRAM_GROUP_WELCOME_PENDING_PREFIX,
  TELEGRAM_PROCESSING_STALE_SEC,
} from "../common/constants";

export class TelegramGroupWelcomeBusyError extends Error {
  constructor(readonly retryAfterSec = TELEGRAM_PROCESSING_STALE_SEC) {
    super("telegram group welcome is still pending");
  }
}

/**
 * Local `my_chat_member` shape. Lives in the group-welcome module (the Ingress
 * sub-seam that owns the group lifecycle) rather than in
 * `telegram-webhook-shared.ts`, which is owned by another wave; the dispatch
 * only needs to read the few fields it acts on. Exported so the dispatcher loop
 * in `telegram-webhook.ts` (`resolveUpdateType`/`resolveUpdateChatId`) can type
 * the `my_chat_member` field without re-declaring the shape.
 */
export interface TelegramChatMemberUpdated {
  chat?: {
    id?: number;
    type?: "private" | "group" | "supergroup" | "channel" | "sender" | string;
    title?: string;
  };
  from?: {
    id?: number;
    username?: string;
    first_name?: string;
  };
  old_chat_member?: { status?: string };
  new_chat_member?: { status?: string };
}

function isBotAddedTransition(
  oldStatus: string | undefined,
  newStatus: string | undefined,
): boolean {
  const wasAbsent = oldStatus === "left" || oldStatus === "kicked";
  const isPresent = newStatus === "member" || newStatus === "administrator";
  return wasAbsent && isPresent;
}

function isBotRemovedTransition(
  oldStatus: string | undefined,
  newStatus: string | undefined,
): boolean {
  const wasPresent = Boolean(oldStatus && oldStatus !== "left" && oldStatus !== "kicked");
  const isAbsent = newStatus === "left" || newStatus === "kicked";
  return wasPresent && isAbsent;
}

async function clearGroupLifecycleCache(db: D1Database, chatId: string): Promise<void> {
  await deleteCache(db, `telegram:group-welcome:${chatId}`);
  await deleteCache(db, `telegram:chat-admins:${chatId}`);
}

function buildGroupWelcomeMessage(adderMention: string): string {
  return [
    `<b>Pharos Watch is in this group</b>${adderMention ? `. Thanks, ${adderMention}` : ""}.`,
    `Admins can turn on alerts here, e.g. /subscribe@${TELEGRAM_BOT_USERNAME} usd-top25`,
    "For your own alerts and quiet hours, message me privately.",
  ].join("\n");
}

function buildGroupWelcomeReplyMarkup(): {
  inline_keyboard: { text: string; url: string }[][];
} {
  return {
    inline_keyboard: [[
      { text: "Personal alerts", url: `${TELEGRAM_BOT_URL}?start=setup` },
      { text: "How it works", url: `https://pharos.watch/${TELEGRAM_BOT_USERNAME.toLowerCase()}/` },
    ]],
  };
}

function formatAdderMention(from: TelegramChatMemberUpdated["from"]): string {
  if (!from) return "";
  if (from.username) return `@${from.username}`;
  if (from.first_name) return escapeHtml(from.first_name);
  return "";
}

export async function handleMyChatMember(
  db: D1Database,
  botToken: string,
  payload: TelegramChatMemberUpdated,
  options: {
    beforeIrreversibleEffect?: (kind: string) => Promise<void>;
    prepareMutationAppliedStatement?: () => D1PreparedStatement;
    confirmAtomicMutationApplied?: () => void;
    wasMutationApplied?: boolean;
  } = {},
): Promise<void> {
  const chatType = payload.chat?.type;
  // `my_chat_member` for private/sender chats is emitted on /start, on
  // block/unblock, and on other 1:1 status changes. Group/supergroup updates
  // drive lifecycle cleanup and welcome idempotency.
  if (chatType === "private" || chatType === "sender") return;
  const chatId = payload.chat?.id;
  if (typeof chatId !== "number" || !Number.isFinite(chatId)) return;
  const chatIdStr = String(chatId);
  const botRemoved = isBotRemovedTransition(payload.old_chat_member?.status, payload.new_chat_member?.status);
  if ((isGroupChatType(chatType) || isChannelChatType(chatType)) && botRemoved) {
    if (!options.wasMutationApplied) {
      const operationStatements = options.prepareMutationAppliedStatement
        ? [options.prepareMutationAppliedStatement()]
        : undefined;
      await forgetSubscriber(db, chatIdStr, { operationStatements });
      if (operationStatements) options.confirmAtomicMutationApplied?.();
    }
    await clearGroupLifecycleCache(db, chatIdStr);
    logTelegramEvent({
      level: "info",
      message: `telegram ${isChannelChatType(chatType) ? "channel" : "group"} removed bot; subscriber state cleared`,
      action: isChannelChatType(chatType) ? "channel-removal" : "group-removal",
    });
    return;
  }
  if (isChannelChatType(chatType)) return;
  if (!isBotAddedTransition(payload.old_chat_member?.status, payload.new_chat_member?.status)) {
    return;
  }

  const cacheKey = `telegram:group-welcome:${chatIdStr}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = await getCache(db, cacheKey);
  if (cached) {
    const pending = cached.value.startsWith(TELEGRAM_GROUP_WELCOME_PENDING_PREFIX);
    const deadline = cached.updatedAt + (pending ? TELEGRAM_PROCESSING_STALE_SEC : TELEGRAM_GROUP_WELCOME_CACHE_TTL_SEC);
    if (deadline > nowSec) {
      if (pending) throw new TelegramGroupWelcomeBusyError(deadline - nowSec);
      return;
    }
  }
  const owner = `${TELEGRAM_GROUP_WELCOME_PENDING_PREFIX}${crypto.randomUUID()}`;
  // Exact-owner retries also succeed when D1 committed before losing the response.
  const claim = await runWithOverloadRetry(() => db.prepare(`
    INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE cache.value = excluded.value OR ${telegramGroupWelcomeDeadlineSql("cache")} <= ?
  `).bind(cacheKey, owner, nowSec, nowSec).run());
  if (!claim.meta.changes) throw new TelegramGroupWelcomeBusyError();
  const release = () => runWithOverloadRetry(() => db.prepare("DELETE FROM cache WHERE key = ? AND value = ?")
    .bind(cacheKey, owner).run());
  try {
    const adderMention = formatAdderMention(payload.from);
    await options.beforeIrreversibleEffect?.("group-welcome");
    const sendStart = Math.floor(Date.now() / 1000);
    const started = await runWithOverloadRetry(() => db.prepare(`
      UPDATE cache SET updated_at = ? WHERE key = ? AND value = ? AND updated_at > ?
    `).bind(sendStart, cacheKey, owner, sendStart - TELEGRAM_PROCESSING_STALE_SEC).run());
    if (!started.meta.changes) throw new TelegramGroupWelcomeBusyError();
    const welcomeSend = await sendAuditedTelegramReply(
      db,
      chatIdStr,
      buildGroupWelcomeMessage(adderMention),
      botToken,
      {
        actionDetail: "group-welcome",
        replyMarkup: buildGroupWelcomeReplyMarkup(),
      },
    );
    if (!welcomeSend.ok) {
      await release();
      return;
    }
  } catch (err) {
    await release();
    throw err;
  }
  // The welcome is out. A failed stamp must neither release the claim nor fail
  // the update into a redelivery, either of which would send a second welcome.
  await runWithOverloadRetry(() => db.prepare("UPDATE cache SET value = '1', updated_at = ? WHERE key = ? AND value = ?")
    .bind(Math.floor(Date.now() / 1000), cacheKey, owner).run()).catch((err: unknown) => {
    logTelegramEvent({ message: "group welcome sent stamp failed", action: "my_chat_member", errorClass: classifyTelegramLogError(err) });
  });
}
