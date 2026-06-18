import { TELEGRAM_BOT_USERNAME } from "@shared/lib/telegram-bot-registration";
import { answerCallbackQuery, escapeHtml } from "../lib/telegram";
import {
  formatAdministratorMentions,
  getCachedChatAdministrators,
} from "../lib/telegram-chat-member";
import { deleteCache, getCache, setCache } from "../lib/db-cache";
import {
  formatDisambiguation,
  findInvalidDisambiguationToken,
  parseDisambiguationReply,
} from "../lib/telegram-alerts";
import {
  SETUP_PENDING_ACTION_TYPE,
  type PendingAction,
  type TelegramWebhookUpdate,
} from "./telegram-webhook-shared";
import { handleSetupTickerInput, parseSetupState } from "./telegram-webhook-setup";
import {
  parseCommand,
  parsePendingDisambiguation,
  parseStartPayload,
} from "./telegram-webhook-parsing";
import {
  acquireTelegramCommandCooldown,
  claimTelegramProcessedUpdate,
  clearPendingDisambiguation,
  loadPendingDisambiguation,
  markTelegramProcessedUpdateFailed,
  markTelegramProcessedUpdateProcessed,
  migrateTelegramChatId,
  maybePruneTelegramProcessedUpdates,
  recordTelegramChatCommandFlood,
  releaseTelegramCommandCooldown,
  forgetSubscriber,
  PENDING_OWNERSHIP_CONFLICT_MESSAGE,
  unixNow,
  type TelegramChatCommandFloodResult,
} from "./telegram-webhook-store";
import { withErrorHandler } from "../lib/api-utils";
import { logTelegramEvent } from "../lib/telegram-log";
import { handleCallbackQuery } from "./telegram-webhook-callbacks";
import { COMMAND_HANDLERS, type WebhookCommandContext } from "./webhook-commands";
import { executePendingDisambiguationSelection } from "./telegram-webhook-disambiguation-selection";
import { isGroupAdminActor, isGroupChatType, validateTelegramWebhookSecret } from "./telegram-webhook-auth";
import {
  recordTelegramUsageEvent,
} from "../lib/telegram-usage-analytics";
import { sendAuditedTelegramReply } from "./telegram-webhook-replies";
import { toErrorMessage } from "../lib/error-utils";

/**
 * Group admin gating mode for group-wide mutating commands in
 * group/supergroup chats. "hard" refuses the command for non-admins (default).
 * "soft" is kept as an emergency rollback path for operators: it warns the
 * non-admin and still runs the command. The exported wrapper is mutable so
 * tests can flip the mode; production code should keep the default.
 */
export type TelegramGroupAdminGating = "soft" | "hard";
/** @internal Exported for tests only — do not mutate in production code. */
export const TELEGRAM_GROUP_ADMIN_GATING: { mode: TelegramGroupAdminGating } = {
  mode: "hard",
};

const GROUP_ADMIN_GATED_COMMANDS = new Set([
  "/subscribe",
  "/unsubscribe",
  "/set",
  "/mute",
  "/unmutehours",
  "/unsnooze",
]);

/**
 * Commands that, when issued while a pending disambiguation is active, clear
 * the pending state (after the permission check) and then run through the
 * normal dispatch. All other commands either run as-is or get the pending
 * reminder — see the dispatch loop below.
 */
const PENDING_CLEAR_AND_RUN_COMMANDS = new Set([
  "/subscribe",
  "/unsubscribe",
  "/set",
  "/settings",
  "/forget",
  "/mute",
  "/unmutehours",
  "/unsnooze",
  "/timezone",
]);

/**
 * Commands that may run even while a pending disambiguation is active, without
 * clearing it. These are read-only / informational commands.
 */
const PENDING_PASSTHROUGH_COMMANDS = new Set([
  "/presets",
  "/help",
  "/sample",
  "/list",
  "/status",
  "/brief",
  "/market",
  "/top",
  "/why",
  "/coverage",
  "/start",
  "/health",
]);

// `botMention` is lowercased at parse time (telegram-webhook-parsing.ts), so
// compare against the lowercased canonical handle.
const PHAROS_BOT_USERNAMES = new Set([TELEGRAM_BOT_USERNAME.toLowerCase()]);

/**
 * Local `my_chat_member` shape. Defined here rather than in
 * `telegram-webhook-shared.ts` because that module is owned by another wave;
 * the dispatch only needs to read the few fields it acts on.
 */
interface TelegramChatMemberUpdated {
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

type TelegramWebhookUpdateWithChatMember = TelegramWebhookUpdate & {
  my_chat_member?: TelegramChatMemberUpdated;
};

type ParsedTelegramCommand = NonNullable<ReturnType<typeof parseCommand>>;
type PendingDisambiguationRow = Awaited<ReturnType<typeof loadPendingDisambiguation>>;
type FinishOk = (errorClass?: string | null) => Promise<Response>;
type ReplyFn = (message: string) => Promise<void>;
type ReplyWithMarkupFn = (message: string, options: { replyMarkup?: unknown }) => Promise<void>;
type FloodScope = "actor" | "chat";

/**
 * Cache TTL for the per-chat welcome-on-add idempotency marker. Telegram can
 * deliver `my_chat_member` repeatedly for the same chat (e.g. on re-promote
 * after the bot was demoted), so we suppress the welcome message for 24h once
 * sent.
 */
const TELEGRAM_GROUP_WELCOME_CACHE_TTL_SEC = 24 * 60 * 60;

const COMMAND_COOLDOWNS_SEC: Record<string, number> = {
  "/brief": 30,
  "/top": 20,
  "/why": 20,
  "/status": 20,
  "/coverage": 20,
};

// Generous per-chat cap across all commands (including light ones with no
// per-command cooldown) so a single chat cannot flood D1 reads and Telegram
// replies. Well above any human typing rate.
const CHAT_COMMAND_FLOOD_WINDOW_SEC = 60;
const CHAT_COMMAND_FLOOD_LIMIT = 20;
const GROUP_CHAT_COMMAND_FLOOD_LIMIT = CHAT_COMMAND_FLOOD_LIMIT * 4;

const GROUP_ADMIN_DIAGNOSTIC_COOLDOWN_SEC = 20;

const CANONICAL_COMMAND_KEYS: Record<string, string> = {
  "/market": "/brief",
};

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
    if (!botToken) return ok();

    let update: TelegramWebhookUpdateWithChatMember;
    try {
      update = await request.json();
    } catch {
      return ok();
    }

    const updateId = update.update_id;
    const claimedUpdateId =
      typeof updateId === "number" && Number.isFinite(updateId) ? updateId : null;
    const nowSec = unixNow();
    if (claimedUpdateId != null) {
      const claim = await claimTelegramProcessedUpdate(db, {
        updateId: claimedUpdateId,
        nowSec,
        updateType: resolveUpdateType(update),
        chatId: resolveUpdateChatId(update),
      });
      if (claim.status !== "claimed") {
        if (claim.status === "in_flight") {
          logTelegramEvent({
            level: "warn",
            message: "duplicate update still in flight",
            action: "processed-update-dedupe",
            updateId: claimedUpdateId,
            retryAfterSec: claim.retryAfterSec ?? null,
          });
          return new Response("retry", {
            status: 503,
            headers: {
              "Retry-After": String(Math.max(1, Math.ceil(claim.retryAfterSec ?? 1))),
            },
          });
        }
        return ok();
      }
      try {
        const pruned = await maybePruneTelegramProcessedUpdates(db, { nowSec });
        if (pruned != null) {
          logTelegramEvent({
            level: "info",
            message: "pruned processed webhook updates",
            action: "processed-update-prune",
            pruned,
          });
        }
      } catch (err) {
        logTelegramEvent({
          level: "warn",
          message: "processed webhook update prune failed",
          action: "processed-update-prune",
          err: toErrorMessage(err),
        });
      }
    }

    const finishOk = async (errorClass: string | null = null): Promise<Response> => {
      if (claimedUpdateId != null) {
        await markTelegramProcessedUpdateProcessed(db, {
          updateId: claimedUpdateId,
          nowSec: unixNow(),
          errorClass,
        });
      }
      return ok();
    };

    try {
      if (update.callback_query) {
        let callbackErrorClass: string | null = null;
        let callbackCooldownKey: string | null = null;
        const callbackChatId = update.callback_query.message?.chat?.id?.toString() ?? null;
        const callbackAction = callbackActionDetail(update.callback_query.data ?? "");
        try {
          if (callbackChatId) {
            const floodAllowed = await enforceIngressFlood(db, {
              chatId: callbackChatId,
              chatType: update.callback_query.message?.chat?.type ?? "private",
              actorUserId: update.callback_query.from?.id != null ? String(update.callback_query.from.id) : null,
              nowSec,
              actionDetail: callbackAction,
              noticeMessage: "Too many button taps at once — please slow down for a minute.",
              reply: async (message) => {
                await answerCallbackQuery(update.callback_query!.id, botToken, { text: message });
              },
            });
            if (!floodAllowed) return finishOk();

            const callbackCooldownCommand = resolveCallbackCooldownCommandKey(update.callback_query.data ?? "");
            if (callbackCooldownCommand) {
              const cooldown = await enforceCommandCooldown(
                db,
                callbackChatId,
                callbackCooldownCommand,
                "callback",
                async (message) => {
                  await answerCallbackQuery(update.callback_query!.id, botToken, { text: message });
                },
              );
              if (!cooldown.allowed) {
                await recordTelegramUsageEvent(db, {
                  eventType: "command",
                  actionDetail: callbackAction,
                  outcome: cooldown.outcome,
                  failureClass: cooldown.failureClass,
                });
                return finishOk();
              }
              callbackCooldownKey = cooldown.commandKey;
            }
          }
          await handleCallbackQuery(db, botToken, update.callback_query);
        } catch (err) {
          if (callbackChatId && callbackCooldownKey) {
            await releaseCommandCooldownBestEffort(db, {
              chatId: callbackChatId,
              commandKey: callbackCooldownKey,
              action: "callback-cooldown-release",
              command: callbackAction,
            });
          }
          logTelegramEvent({
            message: "callback_query failed",
            chatId: update.callback_query.message?.chat?.id ?? null,
            userId: update.callback_query.from?.id ?? null,
            action: "callback_query",
            err: toErrorMessage(err),
          });
          callbackErrorClass = "callback_query";
        }
        return finishOk(callbackErrorClass);
      }

      if (update.my_chat_member) {
        let myChatMemberErrorClass: string | null = null;
        try {
          await handleMyChatMember(db, botToken, update.my_chat_member);
        } catch (err) {
          logTelegramEvent({
            message: "my_chat_member failed",
            chatId: update.my_chat_member.chat?.id ?? null,
            userId: update.my_chat_member.from?.id ?? null,
            action: "my_chat_member",
            err: toErrorMessage(err),
          });
          myChatMemberErrorClass = "my_chat_member";
        }
        return finishOk(myChatMemberErrorClass);
      }

      const migration = resolveChatMigration(update.message);
      if (migration) {
        let migrationErrorClass: string | null = null;
        try {
          await migrateTelegramChatId(db, migration.oldChatId, migration.newChatId);
          logTelegramEvent({
            level: "info",
            message: "telegram chat id migrated",
            chatId: migration.newChatId,
            oldChatId: migration.oldChatId,
            action: "chat-migration",
          });
        } catch (err) {
          logTelegramEvent({
            message: "telegram chat migration failed",
            chatId: migration.newChatId,
            oldChatId: migration.oldChatId,
            action: "chat-migration",
            err: toErrorMessage(err),
          });
          migrationErrorClass = "chat-migration";
        }
        return finishOk(migrationErrorClass);
      }

      return await handleTelegramMessageUpdate({ db, update, botToken, finishOk });
    } catch (err) {
      if (claimedUpdateId != null) {
        await markTelegramProcessedUpdateFailed(db, {
          updateId: claimedUpdateId,
          errorClass: classifyWebhookError(err),
        });
      }
      throw err;
    }
  },
);

type PendingFlowResult = "continue" | "finished";

async function handleTelegramMessageUpdate(args: {
  db: D1Database;
  update: TelegramWebhookUpdateWithChatMember;
  botToken: string;
  finishOk: FinishOk;
}): Promise<Response> {
  const { db, update, botToken, finishOk } = args;
  const chatId = update.message?.chat?.id?.toString();
  const text = update.message?.text?.trim();
  const username = update.message?.chat?.username ?? null;
  const actorUserId = update.message?.from?.id != null ? String(update.message.from.id) : null;
  const chatType = update.message?.chat?.type ?? "private";
  if (!chatId || !text) return finishOk();

  const reply: ReplyFn = async (message) => {
    await sendAuditedTelegramReply(db, chatId, message, botToken);
  };
  const replyWithMarkup: ReplyWithMarkupFn = async (message, options) => {
    await sendAuditedTelegramReply(db, chatId, message, botToken, options);
  };
  const commandContext: WebhookCommandContext = {
    db,
    chatId,
    chatType,
    username,
    actorUserId,
    botToken,
    replyToChat: reply,
    replyToChatWithMarkup: replyWithMarkup,
  };

  let parsedCommand: ParsedTelegramCommand | null = null;
  try {
    parsedCommand = text.startsWith("/") ? parseCommand(text) : null;
    if (parsedCommand && isGroupChatType(chatType) && !isAddressedToPharosBot(parsedCommand.botMention)) {
      return finishOk();
    }

    const pendingRow = await loadPendingDisambiguation(db, chatId);
    const pendingNotExpired = Boolean(pendingRow && unixNow() < pendingRow.expires_at);
    const isSetupPending =
      Boolean(pendingRow && pendingNotExpired && pendingRow.action_type === SETUP_PENDING_ACTION_TYPE);
    let ingressFloodApplied = false;

    if (pendingRow && pendingNotExpired) {
      const floodAllowed = await enforceIngressFlood(db, {
        chatId,
        chatType,
        actorUserId,
        nowSec: Math.floor(Date.now() / 1000),
        actionDetail: parsedCommand?.command ?? "pending-reply",
        noticeMessage: "Too many Telegram actions at once — please slow down for a minute.",
        reply,
      });
      ingressFloodApplied = floodAllowed;
      if (!floodAllowed) return finishOk();
    }

    if (isSetupPending && pendingRow) {
      const setupResult = await handleSetupPendingBeforeDispatch({
        db,
        botToken,
        chatId,
        actorUserId,
        username,
        text,
        pendingRow,
        parsedCommand,
        reply,
      });
      if (setupResult === "finished") return finishOk();
    }

    if (!isSetupPending) {
      const pendingResult = await handlePendingActionBeforeDispatch({
        db,
        botToken,
        chatId,
        chatType,
        actorUserId,
        username,
        text,
        pendingRow,
        pendingNotExpired,
        parsedCommand,
        reply,
      });
      if (pendingResult === "finished") return finishOk();
    }

    if (!parsedCommand) return finishOk();
    await dispatchParsedTelegramCommand({
      db,
      botToken,
      chatId,
      chatType,
      actorUserId,
      parsedCommand,
      commandContext,
      reply,
      replyWithMarkup,
      skipFlood: ingressFloodApplied,
    });
    return finishOk();
  } catch (err) {
    if (parsedCommand) {
      await recordCommandUsage(
        db,
        parsedCommand.command,
        Date.now(),
        "error",
        err instanceof Error ? err.name : "unknown",
      );
    }
    logTelegramEvent({
      message: "command handler failed",
      chatId,
      userId: actorUserId,
      action: "command-dispatch",
      err: toErrorMessage(err),
    });
    await reply("Something went wrong, please try again.");
    return finishOk("command-dispatch");
  }
}

async function handleSetupPendingBeforeDispatch(args: {
  db: D1Database;
  botToken: string;
  chatId: string;
  actorUserId: string | null;
  username: string | null;
  text: string;
  pendingRow: NonNullable<PendingDisambiguationRow>;
  parsedCommand: ParsedTelegramCommand | null;
  reply: ReplyFn;
}): Promise<PendingFlowResult> {
  const { db, botToken, chatId, actorUserId, username, text, pendingRow, parsedCommand, reply } = args;
  const setupState = parseSetupState(pendingRow.action_payload, pendingRow.initiator_user_id ?? null);
  if (setupState && setupState.step === "awaiting-ticker" && !parsedCommand) {
    await handleSetupTickerInput(
      { db, botToken, chatId, actorUserId, username },
      text,
      setupState,
    );
    return "finished";
  }
  if (!parsedCommand && canActOnPendingOwner(setupState?.initiatorUserId ?? null, actorUserId)) {
    await reply("Tap one of the buttons above, or send /cancel to abort.");
    return "finished";
  }
  if (parsedCommand) {
    if (!setupState || canActOnPendingOwner(setupState.initiatorUserId, actorUserId)) {
      if (parsedCommand.command === "/cancel") {
        await clearPendingDisambiguation(db, chatId);
        await reply("Setup cancelled. Send /start to begin again or /list to view subscriptions.");
        return "finished";
      }
      await clearPendingDisambiguation(db, chatId);
    } else if (!PENDING_PASSTHROUGH_COMMANDS.has(parsedCommand.command)) {
      await reply(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
      return "finished";
    }
  }
  return "continue";
}

async function handlePendingActionBeforeDispatch(args: {
  db: D1Database;
  botToken: string;
  chatId: string;
  chatType: string;
  actorUserId: string | null;
  username: string | null;
  text: string;
  pendingRow: PendingDisambiguationRow;
  pendingNotExpired: boolean;
  parsedCommand: ParsedTelegramCommand | null;
  reply: ReplyFn;
}): Promise<PendingFlowResult> {
  const {
    db,
    botToken,
    chatId,
    chatType,
    actorUserId,
    username,
    text,
    pendingRow,
    pendingNotExpired,
    parsedCommand,
    reply,
  } = args;
  const parsedPending = pendingRow ? parsePendingDisambiguation(pendingRow) : null;
  // This path only runs when the row is not a setup step (see isSetupPending in
  // the caller), so a setup sentinel here means the row was mis-routed; treat it
  // as unrecoverable rather than a live disambiguation action.
  const pendingAction =
    parsedPending && parsedPending.actionType !== SETUP_PENDING_ACTION_TYPE ? parsedPending : null;
  const pendingActive = Boolean(pendingRow && pendingAction && pendingNotExpired);

  if (pendingRow && !pendingAction && pendingNotExpired) {
    await clearPendingDisambiguation(db, chatId);
    if (!parsedCommand) {
      await reply("That pending selection could not be restored. Please rerun the command, or use /help for examples.");
      return "finished";
    }
  }

  if (pendingRow && !pendingActive) {
    await clearPendingDisambiguation(db, chatId);
  }

  if (!pendingActive || !pendingAction) {
    return "continue";
  }

  if (!parsedCommand) {
    if (pendingAction.actionType === "confirm-bulk" || pendingAction.actionType === "forget-confirm") {
      if (isGroupChatType(chatType) && !canActOnPending(pendingAction, actorUserId)) return "finished";
      await reply("Tap Confirm or Cancel on the previous message, or send /cancel to abort.");
      return "finished";
    }
    if (!canActOnPending(pendingAction, actorUserId)) {
      if (isGroupChatType(chatType) && !looksLikeDisambiguationSelection(text)) {
        return "finished";
      }
      await reply("Only the user who started this pending selection can complete it.");
      return "finished";
    }
    await handleDisambiguationReply(db, chatId, text, pendingAction, botToken, username);
    return "finished";
  }

  const command = parsedCommand.command;
  if (command === "/cancel") {
    if (!canActOnPending(pendingAction, actorUserId)) {
      await reply("Only the user who started this pending selection can cancel it.");
      return "finished";
    }
    await clearPendingDisambiguation(db, chatId);
    await reply("Pending selection cancelled.");
    return "finished";
  }

  if (PENDING_PASSTHROUGH_COMMANDS.has(command)) {
    return "continue";
  }
  if (PENDING_CLEAR_AND_RUN_COMMANDS.has(command)) {
    if (!canActOnPending(pendingAction, actorUserId)) {
      await reply(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
      return "finished";
    }
    await clearPendingDisambiguation(db, chatId);
    return "continue";
  }
  if (pendingAction.actionType === "confirm-bulk" || pendingAction.actionType === "forget-confirm") {
    await reply("You have a pending confirmation. Tap Confirm or Cancel on the previous message, or send /cancel to abort.");
    return "finished";
  }
  await reply(`You have a pending selection. Reply with the number(s) you want, or use /cancel.

${escapeHtml(formatDisambiguation(pendingAction.ambiguousTicker, pendingAction.candidates))}`);
  return "finished";
}

async function dispatchParsedTelegramCommand(args: {
  db: D1Database;
  botToken: string;
  chatId: string;
  chatType: string;
  actorUserId: string | null;
  parsedCommand: ParsedTelegramCommand;
  commandContext: WebhookCommandContext;
  reply: ReplyFn;
  replyWithMarkup: ReplyWithMarkupFn;
  skipFlood?: boolean;
}): Promise<void> {
  const {
    db,
    botToken,
    chatId,
    chatType,
    actorUserId,
    parsedCommand,
    commandContext,
    reply,
    replyWithMarkup,
    skipFlood = false,
  } = args;
  const commandStartedAtMs = Date.now();

  if (!skipFlood) {
    const floodAllowed = await enforceIngressFlood(db, {
      chatId,
      chatType,
      actorUserId,
      nowSec: Math.floor(commandStartedAtMs / 1000),
      actionDetail: parsedCommand.command,
      noticeMessage: "Too many commands at once — please slow down for a minute.",
      reply,
    });
    if (!floodAllowed) return;
  }

  if (
    isGroupChatType(chatType) &&
    commandRequiresGroupAdmin(parsedCommand.command, parsedCommand.args)
  ) {
    const proceed = await maybeGateNonAdminGroupActor(
      db,
      botToken,
      chatId,
      actorUserId,
      parsedCommand.command,
      reply,
    );
    if (!proceed) {
      await recordCommandUsage(db, parsedCommand.command, commandStartedAtMs, "denied");
      return;
    }
  }

  const handler = COMMAND_HANDLERS[parsedCommand.command];
  if (handler) {
    const cooldown = await enforceCommandCooldown(
      db,
      chatId,
      parsedCommand.command,
      parsedCommand.args,
      reply,
    );
    if (!cooldown.allowed) {
      await recordCommandUsage(
        db,
        parsedCommand.command,
        commandStartedAtMs,
        cooldown.outcome,
        cooldown.failureClass,
      );
      return;
    }
    try {
      await handler(commandContext, parsedCommand.args);
    } catch (err) {
      if (cooldown.commandKey) {
        await releaseCommandCooldownBestEffort(db, {
          chatId,
          commandKey: cooldown.commandKey,
          action: "command-cooldown-release",
          command: parsedCommand.command,
        });
      }
      throw err;
    }
    await recordCommandUsage(db, parsedCommand.command, commandStartedAtMs, "ok");
    return;
  }

  await replyWithMarkup("Unknown command. Try /help", {
    replyMarkup: { inline_keyboard: [[{ text: "/help", callback_data: "help:commands" }]] },
  });
  await recordTelegramUsageEvent(db, {
    eventType: "unknown_command",
    actionDetail: parsedCommand.command,
    outcome: "unknown",
  });
  await recordCommandUsage(db, parsedCommand.command, commandStartedAtMs, "unknown_command");
}

function resolveUpdateType(update: TelegramWebhookUpdateWithChatMember): string {
  if (update.callback_query) return "callback_query";
  if (update.message) return "message";
  if (update.my_chat_member) return "my_chat_member";
  return "unknown";
}

function resolveUpdateChatId(update: TelegramWebhookUpdateWithChatMember): string | null {
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

function resolveChatMigration(message: TelegramWebhookUpdate["message"] | undefined): {
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

function classifyWebhookError(err: unknown): string {
  if (err instanceof Error && err.name) return err.name;
  return "unknown";
}

function floodScopesForUpdate(
  chatId: string,
  chatType: string,
  actorUserId: string | null,
): Array<{ key: string; scope: FloodScope; limit: number }> {
  if (isGroupChatType(chatType) && actorUserId) {
    return [
      { key: `${chatId}:actor:${actorUserId}`, scope: "actor", limit: CHAT_COMMAND_FLOOD_LIMIT },
      { key: chatId, scope: "chat", limit: GROUP_CHAT_COMMAND_FLOOD_LIMIT },
    ];
  }
  return [{ key: chatId, scope: "chat", limit: CHAT_COMMAND_FLOOD_LIMIT }];
}

async function enforceIngressFlood(
  db: D1Database,
  input: {
    chatId: string;
    chatType: string;
    actorUserId: string | null;
    nowSec: number;
    actionDetail: string;
    noticeMessage: string;
    reply: ReplyFn;
  },
): Promise<boolean> {
  let blocked:
    | { flood: TelegramChatCommandFloodResult; scope: FloodScope }
    | null = null;
  for (const floodScope of floodScopesForUpdate(input.chatId, input.chatType, input.actorUserId)) {
    try {
      const flood = await recordTelegramChatCommandFlood(db, {
        chatId: floodScope.key,
        nowSec: input.nowSec,
        windowSec: CHAT_COMMAND_FLOOD_WINDOW_SEC,
        limit: floodScope.limit,
      });
      if (!flood.allowed) {
        blocked = { flood, scope: floodScope.scope };
        break;
      }
    } catch (err) {
      logTelegramEvent({
        level: "warn",
        message: "chat command flood check failed",
        chatId: input.chatId,
        userId: input.actorUserId,
        action: "command-flood",
        command: input.actionDetail,
        err: toErrorMessage(err),
      });
    }
  }

  if (!blocked) return true;

  if (blocked.flood.firstExceeded) {
    try {
      await input.reply(input.noticeMessage);
    } catch (err) {
      logTelegramEvent({
        level: "warn",
        message: "chat command flood notice reply failed",
        chatId: input.chatId,
        userId: input.actorUserId,
        action: "command-flood",
        command: input.actionDetail,
        err: toErrorMessage(err),
      });
    }
  }

  try {
    await recordTelegramUsageEvent(db, {
      eventType: "command",
      actionDetail: input.actionDetail,
      outcome: "rate_limited",
      failureClass: blocked.scope === "actor" ? "actor-flood" : "chat-flood",
    });
  } catch (err) {
    logTelegramEvent({
      level: "warn",
      message: "chat command flood usage record failed",
      chatId: input.chatId,
      userId: input.actorUserId,
      action: "command-flood",
      command: input.actionDetail,
      err: toErrorMessage(err),
    });
  }

  return false;
}

async function releaseCommandCooldownBestEffort(
  db: D1Database,
  input: {
    chatId: string;
    commandKey: string;
    action: string;
    command: string;
  },
): Promise<void> {
  try {
    await releaseTelegramCommandCooldown(db, {
      chatId: input.chatId,
      commandKey: input.commandKey,
    });
  } catch (err) {
    logTelegramEvent({
      level: "warn",
      message: "command cooldown release failed",
      chatId: input.chatId,
      action: input.action,
      command: input.command,
      err: toErrorMessage(err),
    });
  }
}

async function enforceCommandCooldown(
  db: D1Database,
  chatId: string,
  command: string,
  args: string,
  reply: (message: string) => Promise<void>,
): Promise<
  | { allowed: true; commandKey: string | null }
  | { allowed: false; commandKey: string | null; outcome: "rate_limited" | "failure"; failureClass: string | null }
> {
  const commandKey = effectiveCooldownCommandKey(command, args);
  const cooldownSec = resolveCommandCooldownSec(commandKey, args);
  if (cooldownSec == null) return { allowed: true, commandKey: null };

  let cooldown;
  try {
    cooldown = await acquireTelegramCommandCooldown(db, {
      chatId,
      commandKey,
      nowSec: unixNow(),
      cooldownSec,
    });
  } catch (err) {
    logTelegramEvent({
      level: "warn",
      message: "command cooldown check failed",
      chatId,
      action: "command-cooldown",
      command,
      err: toErrorMessage(err),
    });
    await reply("Command traffic is busy. Please try again shortly.");
    return { allowed: false, commandKey, outcome: "failure", failureClass: "cooldown-store-error" };
  }

  if (cooldown.allowed) return { allowed: true, commandKey };
  await reply(formatCommandCooldownMessage(commandKey, cooldown.retryAfterSec));
  return { allowed: false, commandKey, outcome: "rate_limited", failureClass: null };
}

function canonicalCommandKey(command: string): string {
  return CANONICAL_COMMAND_KEYS[command] ?? command;
}

function effectiveCooldownCommandKey(command: string, args: string): string {
  const commandKey = canonicalCommandKey(command);
  if (commandKey !== "/start") return commandKey;
  const payload = parseStartPayload(args);
  if (payload.kind === "status") return "/status";
  if (payload.kind === "why") return "/why";
  if (payload.kind === "coverage") return "/coverage";
  return commandKey;
}

function resolveCallbackCooldownCommandKey(data: string): string | null {
  const action = data.split(":")[0] ?? "";
  if (action === "status") return "/status";
  if (action === "why") return "/why";
  if (action === "coverage") return "/coverage";
  return null;
}

function callbackActionDetail(data: string): string {
  const action = data.split(":")[0] || "unknown";
  return `callback:${action}`;
}

function resolveCommandCooldownSec(command: string, args: string): number | null {
  const cooldownSec = COMMAND_COOLDOWNS_SEC[command];
  if (cooldownSec == null) return null;
  if ((command === "/top" || command === "/why" || command === "/coverage") && !args.trim()) {
    return null;
  }
  return cooldownSec;
}

function formatCommandCooldownMessage(command: string, retryAfterSec: number): string {
  const retryAfter = Math.max(1, Math.ceil(retryAfterSec));
  const unit = retryAfter === 1 ? "second" : "seconds";
  return `That command is doing heavier Pharos reads. Please try ${escapeHtml(command)} again in ${retryAfter} ${unit}.`;
}

async function recordCommandUsage(
  db: D1Database,
  command: string,
  startedAtMs: number,
  outcome: string,
  failureClass: string | null = null,
): Promise<void> {
  await recordTelegramUsageEvent(db, {
    eventType: "command",
    actionDetail: command,
    outcome,
    latencyMs: Math.max(0, Date.now() - startedAtMs),
    failureClass,
  });
}

/**
 * Returns `true` when the command should proceed, `false` when it has been
 * refused (hard gate) and the caller must stop processing the update.
 */
async function maybeGateNonAdminGroupActor(
  db: D1Database,
  botToken: string,
  chatId: string,
  actorUserId: string | null,
  command: string,
  reply: (message: string) => Promise<void>,
): Promise<boolean> {
  if (actorUserId != null) {
    if (await isGroupAdminActor(botToken, chatId, actorUserId)) {
      return true;
    }
  }

  let cooldown;
  try {
    cooldown = await acquireTelegramCommandCooldown(db, {
      chatId,
      commandKey: "group-admin-diagnostics",
      nowSec: unixNow(),
      cooldownSec: GROUP_ADMIN_DIAGNOSTIC_COOLDOWN_SEC,
    });
  } catch (err) {
    logTelegramEvent({
      level: "warn",
      message: "group admin diagnostic cooldown check failed",
      chatId,
      userId: actorUserId,
      action: "group-admin-diagnostics",
      command,
      err: toErrorMessage(err),
    });
    await reply("Group permission checks are busy. Please try again shortly.");
    return false;
  }
  if (!cooldown.allowed) {
    await reply(
      `I just checked group permissions for this chat. Please try again in ${cooldown.retryAfterSec} seconds.`,
    );
    await recordTelegramUsageEvent(db, {
      eventType: "group_admin_denial",
      actionDetail: command,
      outcome: "rate_limited",
    });
    return false;
  }

  const admins = await getCachedChatAdministrators(db, botToken, chatId);
  const adminLine = admins ? formatAdminHint(admins) : "";
  await reply(
    escapeHtml(
      `Only group admins can ${command}.${adminLine}`,
    ),
  );
  await recordTelegramUsageEvent(db, {
    eventType: "group_admin_denial",
    actionDetail: command,
    outcome: TELEGRAM_GROUP_ADMIN_GATING.mode === "hard" ? "denied" : "warned",
  });
  return TELEGRAM_GROUP_ADMIN_GATING.mode !== "hard";
}

function commandRequiresGroupAdmin(command: string, args: string): boolean {
  if (GROUP_ADMIN_GATED_COMMANDS.has(command)) return true;
  if (command === "/timezone") return args.trim().length > 0;
  return false;
}

function formatAdminHint(admins: Awaited<ReturnType<typeof getCachedChatAdministrators>>): string {
  if (!admins || admins.length === 0) return "";
  const adminLabels = formatAdministratorMentions(admins).split(", ").filter(Boolean);
  if (adminLabels.length === 0) return "";
  const shown = adminLabels.slice(0, 3);
  const overflow = adminLabels.length > shown.length ? ` and ${adminLabels.length - shown.length} more` : "";
  return ` Ask ${shown.join(", ")}${overflow}.`;
}

function isAddressedToPharosBot(botMention: string | null): boolean {
  return botMention != null && PHAROS_BOT_USERNAMES.has(botMention);
}

function canActOnPending(pending: PendingAction, actorUserId: string | null): boolean {
  return canActOnPendingOwner(pending.initiatorUserId, actorUserId);
}

function canActOnPendingOwner(initiatorUserId: string | null, actorUserId: string | null): boolean {
  return initiatorUserId == null || initiatorUserId === actorUserId;
}

function looksLikeDisambiguationSelection(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  let hasDigit = false;
  let pendingSeparator = false;
  for (const char of trimmed) {
    if (char >= "0" && char <= "9") {
      hasDigit = true;
      pendingSeparator = false;
      continue;
    }
    if (char === "," || char.trim() === "") {
      if (!hasDigit) return false;
      pendingSeparator = true;
      continue;
    }
    return false;
  }

  return hasDigit && !pendingSeparator;
}

async function handleDisambiguationReply(
  db: D1Database,
  chatId: string,
  text: string,
  pending: PendingAction,
  botToken: string,
  username: string | null,
): Promise<void> {
  if (pending.actionType === "confirm-bulk" || pending.actionType === "forget-confirm") {
    // Bulk-confirm and forget-confirm use inline buttons; plain text replies are handled upstream.
    return;
  }
  const selectedIndices = parseDisambiguationReply(text, pending.candidates.length);
  if (!selectedIndices) {
    const invalidToken = findInvalidDisambiguationToken(text, pending.candidates.length);
    const reminder = [
      invalidToken
        ? `I could not parse "${invalidToken}" — reply with numbers only (1 to ${pending.candidates.length}).`
        : 'Reply with the number(s) you want, e.g. "1" or "1,2".',
      "Use /cancel to abandon this selection.",
      formatDisambiguation(pending.ambiguousTicker, pending.candidates),
    ].join("\n\n");
    await sendAuditedTelegramReply(db, chatId, escapeHtml(reminder), botToken);
    return;
  }
  await executePendingDisambiguationSelection(db, botToken, chatId, username, pending, selectedIndices);
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

async function handleMyChatMember(
  db: D1Database,
  botToken: string,
  payload: TelegramChatMemberUpdated,
): Promise<void> {
  const chatType = payload.chat?.type;
  // `my_chat_member` for private/sender chats is emitted on /start, on
  // block/unblock, and on other 1:1 status changes. Group/supergroup updates
  // drive lifecycle cleanup and welcome idempotency.
  if (chatType === "private" || chatType === "sender") return;
  const chatId = payload.chat?.id;
  if (typeof chatId !== "number" || !Number.isFinite(chatId)) return;
  const chatIdStr = String(chatId);
  if (
    isGroupChatType(chatType) &&
    isBotRemovedTransition(payload.old_chat_member?.status, payload.new_chat_member?.status)
  ) {
    await forgetSubscriber(db, chatIdStr);
    await clearGroupLifecycleCache(db, chatIdStr);
    logTelegramEvent({
      level: "info",
      message: "telegram group removed bot; subscriber state cleared",
      chatId: chatIdStr,
      action: "group-removal",
    });
    return;
  }
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
