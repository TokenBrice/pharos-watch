import { handleMyChatMember } from "./telegram-webhook-group-welcome";
import {
  claimTelegramProcessedUpdate,
  markTelegramProcessedUpdateProcessed,
  releaseTelegramProcessedUpdate,
} from "../store/processed-updates";
import { unixNow } from "../store/subscribers";
import { migrateTelegramChatId } from "../store/subscriber-lifecycle";
import { withErrorHandler } from "../../lib/api-response";
import { classifyTelegramLogError, logTelegramEvent } from "../common/log";
import { isRetriableD1OverloadError } from "../../lib/d1-overload-retry";
import { validateTelegramWebhookSecret } from "./telegram-webhook-auth";
import type { TelegramWebhookUpdate, TelegramWebhookUpdateWithChatMember } from "./telegram-webhook-shared";
import {
  handleTelegramCallbackQueryUpdate,
  handleTelegramMessageUpdate,
} from "./telegram-webhook-update-dispatch";

const MISSING_BOT_TOKEN_WARN_INTERVAL_MS = 60_000;
let lastMissingBotTokenWarnAtMs: number | null = null;

function logMissingBotTokenWarning(): void {
  const nowMs = Date.now();
  if (
    lastMissingBotTokenWarnAtMs != null &&
    nowMs - lastMissingBotTokenWarnAtMs < MISSING_BOT_TOKEN_WARN_INTERVAL_MS
  ) {
    return;
  }
  lastMissingBotTokenWarnAtMs = nowMs;
  logTelegramEvent({
    level: "warn",
    message: "telegram webhook bot token is missing; authenticated updates are being acknowledged without dispatch",
    action: "webhook-missing-bot-token",
    signal: "missing_bot_token",
  });
}

/**
 * Group admin gating mode for group-wide mutating commands in
 * group/supergroup chats. "hard" refuses the command for non-admins (default).
 * "soft" is kept as an emergency rollback path for operators: it warns the
 * non-admin and still runs the command. The exported wrapper is mutable so
 * tests can flip the mode; production code should keep the default.
 */
export { TELEGRAM_GROUP_ADMIN_GATING, type TelegramGroupAdminGating } from "./telegram-webhook-ingress-policy";

export function resolveUpdateType(update: TelegramWebhookUpdateWithChatMember): string {
  if (update.callback_query) return "callback_query";
  if (update.message) return "message";
  if (update.my_chat_member) return "my_chat_member";
  return "unknown";
}

export function resolveUpdateChatId(update: TelegramWebhookUpdateWithChatMember): string | null {
  const chatId = update.message?.chat?.id
    ?? update.callback_query?.message?.chat?.id
    ?? update.my_chat_member?.chat?.id;
  return typeof chatId === "number" && Number.isFinite(chatId) ? String(chatId) : null;
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

/** Routes one authenticated update; returns the processed-row error class, or throws to request redelivery. */
async function dispatchTelegramUpdate(
  db: D1Database,
  botToken: string,
  update: TelegramWebhookUpdateWithChatMember,
  nowSec: number,
): Promise<string | null> {
  if (update.callback_query) {
    return handleTelegramCallbackQueryUpdate({ db, botToken, callbackQuery: update.callback_query, nowSec });
  }

  if (update.my_chat_member) {
    try {
      await handleMyChatMember(db, botToken, update.my_chat_member);
      return null;
    } catch (err) {
      logTelegramEvent({
        message: "my_chat_member failed",
        action: "my_chat_member",
        errorClass: classifyTelegramLogError(err),
      });
      return "my_chat_member";
    }
  }

  const migration = resolveChatMigration(update.message);
  if (migration) {
    try {
      await migrateTelegramChatId(db, migration.oldChatId, migration.newChatId);
    } catch (err) {
      logTelegramEvent({
        message: "telegram chat migration failed",
        action: "chat-migration",
        errorClass: classifyTelegramLogError(err),
      });
      // The migration batch is idempotent: a transient D1 failure gets a non-2xx
      // so Telegram redelivers it. A deterministic failure (e.g. a constraint
      // conflict) would fail forever and hold back later updates, so it is
      // recorded and acked; the delivery path migrates on `migrate_to_chat_id`.
      if (isRetriableD1OverloadError(err)) throw err;
      return "chat-migration";
    }
    logTelegramEvent({
      level: "info",
      message: "telegram chat id migrated",
      action: "chat-migration",
    });
    return null;
  }

  return handleTelegramMessageUpdate({ db, update, botToken, nowSec });
}

/**
 * Update-id dedupe: a processed update is acked and skipped; a thrown error
 * releases the claim so Telegram's retry is processed. Replies are not fenced,
 * so a crash after a reply but before the processed marker can repeat that
 * reply once on redelivery (accepted at this traffic level).
 */
export const handleTelegramWebhook = withErrorHandler(
  "telegram-webhook",
  async (
    db: D1Database,
    request: Request,
    webhookSecret?: string,
    botToken?: string,
    previousWebhookSecret?: string,
  ): Promise<Response> => {
    const ok = () => new Response("ok", { status: 200 });

    const authResult = await validateTelegramWebhookSecret(
      request,
      webhookSecret,
      previousWebhookSecret,
    );
    if (authResult !== "valid") {
      return ok();
    }
    if (!botToken) {
      logMissingBotTokenWarning();
      return ok();
    }

    let update: TelegramWebhookUpdateWithChatMember;
    try {
      update = await request.json();
    } catch {
      return ok();
    }

    const updateType = resolveUpdateType(update);
    // Unsupported updates have no work to claim.
    if (updateType === "unknown") return ok();

    const nowSec = unixNow();
    const updateId = Number.isSafeInteger(update.update_id) ? update.update_id as number : null;
    if (updateId != null) {
      const claim = await claimTelegramProcessedUpdate(db, {
        updateId,
        nowSec,
        updateType,
        chatId: resolveUpdateChatId(update),
      });
      if (claim.status === "duplicate") return ok();
      if (claim.status === "in_flight") {
        logTelegramEvent({
          level: "warn",
          message: "duplicate update still in flight",
          action: "processed-update-dedupe",
          retryAfterSec: claim.retryAfterSec,
        });
        return new Response("retry", {
          status: 503,
          headers: { "Retry-After": String(claim.retryAfterSec) },
        });
      }
    }

    try {
      const errorClass = await dispatchTelegramUpdate(db, botToken, update, nowSec);
      if (updateId != null) {
        await markTelegramProcessedUpdateProcessed(db, { updateId, claimedAt: nowSec, nowSec: unixNow(), errorClass });
      }
    } catch (err) {
      if (updateId != null) {
        try {
          await releaseTelegramProcessedUpdate(db, { updateId, claimedAt: nowSec });
        } catch (releaseErr) {
          logTelegramEvent({
            message: "telegram processed-update release failed",
            action: "processed-update-release",
            errorClass: classifyTelegramLogError(releaseErr),
          });
        }
      }
      throw err;
    }
    return ok();
  },
);
