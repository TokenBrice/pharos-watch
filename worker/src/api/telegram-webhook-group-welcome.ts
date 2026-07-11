import { TELEGRAM_BOT_USERNAME } from "@shared/lib/telegram-bot-registration";
import { escapeHtml } from "../lib/telegram";
import { deleteCache, getCache, setCache } from "../lib/db-cache";
import { logTelegramEvent } from "../lib/telegram-log";
import { isChannelChatType, isGroupChatType } from "./telegram-webhook-auth";
import { forgetSubscriber } from "./telegram-webhook-store";
import { sendAuditedTelegramReply } from "./telegram-webhook-replies";
import { TELEGRAM_GROUP_WELCOME_CACHE_TTL_SEC } from "../lib/telegram-constants";

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

export function isBotRemovedTransition(
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
    `<b>Thanks for adding Pharos Watch</b>${adderMention ? `, ${adderMention}` : ""}.`,
    "",
    "I send stablecoin alerts into this chat: DEWS stress, depeg events, safety grade changes, and launches.",
    "",
    `Group admins can run <code>/subscribe@${TELEGRAM_BOT_USERNAME} dews usd-top25</code> here. For your own watchlist and quiet hours, message me in DM.`,
  ].join("\n");
}

function buildGroupWelcomeReplyMarkup(): {
  inline_keyboard: { text: string; url: string }[][];
} {
  return {
    inline_keyboard: [
      [{ text: "Read the docs →", url: `https://pharos.watch/${TELEGRAM_BOT_USERNAME.toLowerCase()}/` }],
      [{ text: "Personal alerts in DM →", url: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=setup` }],
    ],
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

  // 24h idempotency marker per chat — Telegram may redeliver `my_chat_member`
  // when the bot is removed and re-added quickly; we never want two welcomes.
  const cacheKey = `telegram:group-welcome:${chatIdStr}`;
  const cached = await getCache(db, cacheKey);
  if (cached && Date.now() / 1000 - cached.updatedAt < TELEGRAM_GROUP_WELCOME_CACHE_TTL_SEC) {
    return;
  }

  const adderMention = formatAdderMention(payload.from);
  await options.beforeIrreversibleEffect?.("group-welcome");
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
  if (welcomeSend.ok) {
    await setCache(db, cacheKey, "1");
  }
}
