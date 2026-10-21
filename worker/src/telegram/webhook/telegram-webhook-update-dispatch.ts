import type { TelegramWebhookUpdate, TelegramWebhookUpdateWithChatMember } from "./telegram-webhook-shared";
import { parseCommand } from "./telegram-webhook-parsing";
import { classifyTelegramLogError, logTelegramEvent } from "../common/log";
import {
  CALLBACK_HANDLERS,
  type CallbackAction,
  type ParsedCallbackData,
  type TelegramCallbackQuery,
} from "../callbacks";
import { isKnownCallbackAction, parseCallbackData } from "../callbacks/_shared";
import { handleSetupCallback } from "../callbacks/setup";
import { handleSettingsInlineCallback } from "../callbacks/settings";
import { COMMAND_HANDLERS, replyToUnknownCommand, type WebhookCommandContext } from "../commands";
import {
  isChannelChatType,
  isGroupChatType,
} from "./telegram-webhook-auth";
import {
  UNKNOWN_COMMAND_ACTION_DETAIL,
  recordTelegramUsageEvent,
} from "../store/usage-analytics";
import { sendAuditedTelegramReply } from "./telegram-webhook-replies";
import { answerCallbackQuery } from "../delivery/telegram";
import {
  callbackActionDetail,
  callbackMutatesChatState,
  classifyTelegramCommand,
  enforceIngressFlood,
  isAddressedToPharosBot,
  logTelegramWebhookWarning,
  maybeGateNonAdminGroupActor,
  recordCommandUsage,
  type ReplyFn,
} from "./telegram-webhook-ingress-policy";

/**
 * Dispatch for claimed webhook updates: route callback taps and message
 * commands through the ingress gates (flood, channel/group admin) into the
 * registered handlers. Plain text is ignored: every multi-step flow uses
 * stateless buttons, so no chat text state is read here. Each handler
 * returns the error class recorded on the processed-update row (null on
 * success); a thrown error releases the claim so Telegram redelivers.
 */

export async function handleTelegramCallbackQueryUpdate(args: {
  db: D1Database;
  botToken: string;
  callbackQuery: NonNullable<TelegramWebhookUpdate["callback_query"]>;
  nowSec: number;
}): Promise<string | null> {
  const { db, botToken, callbackQuery, nowSec } = args;
  const answer = (options?: { text?: string }) => answerCallbackQuery(callbackQuery.id, botToken, options);
  const callbackChatId = callbackQuery.message?.chat?.id?.toString() ?? null;
  const callbackAction = callbackActionDetail(callbackQuery.data ?? "");
  try {
    if (callbackChatId) {
      const floodAllowed = await enforceIngressFlood(db, {
        chatId: callbackChatId,
        nowSec,
        actionDetail: callbackAction,
        noticeMessage: "Too many button taps at once — please slow down for a minute.",
        reply: async (message) => {
          await answer({ text: message });
        },
      });
      if (!floodAllowed) return null;
    }
    if (
      callbackChatId &&
      isChannelChatType(callbackQuery.message?.chat?.type) &&
      callbackMutatesChatState(callbackQuery.data ?? "")
    ) {
      await answer({ text: "Channel-originated actions are not supported." });
      await recordTelegramUsageEvent(db, {
        eventType: "command",
        actionDetail: callbackAction,
        outcome: "denied",
        failureClass: "channel_mutation",
      });
      return null;
    }
    await handleCallbackQuery(db, botToken, callbackQuery);
    return null;
  } catch (err) {
    try {
      await answer({ text: "Action failed. Try again." });
    } catch (ackErr) {
      logTelegramWebhookWarning("callback_query failure ack failed", "callback_query", ackErr);
    }
    logTelegramEvent({
      message: "callback_query failed",
      action: "callback_query",
      errorClass: classifyTelegramLogError(err),
    });
    return "callback_query";
  }
}

/**
 * callback_query router for inline-keyboard taps (`action:arg`, at most 64
 * bytes). Per-action handlers are registered in `../callbacks/index.ts`;
 * unknown actions get a visible ack and usage telemetry before any handler
 * touches D1.
 */
export async function handleCallbackQuery(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
): Promise<void> {
  const answer = async (options?: { text?: string }): Promise<void> => {
    await answerCallbackQuery(cb.id, botToken, options);
  };
  const chatId = cb.message?.chat?.id?.toString();
  if (!chatId) {
    await answer();
    return;
  }

  const parsed = parseCallbackData(cb.data ?? "");

  // `setup` and `settings` run through bespoke pre-dispatch paths that need
  // earlier access to D1 (loading pending-disambiguation state) than the
  // registry-driven path; keep them as direct calls so the registry stays a
  // pure lookup.
  if (parsed.action === "setup") {
    await handleSetupCallback(db, botToken, cb, chatId, parsed);
    return;
  }

  if (parsed.action === "settings") {
    await handleSettingsInlineCallback(db, botToken, cb, chatId, parsed);
    return;
  }

  // Reject unknown actions before any handler can touch D1. Per-action arg
  // validation (isSnoozeArg, isKnownStablecoinId, ...) still runs inside the
  // handler.
  const action = parsed.action;
  if (!isKnownCallbackAction(action)) {
    await recordTelegramUsageEvent(db, {
      eventType: "unknown_command",
      actionDetail: `callback:${action || "unknown"}`,
      outcome: "unknown",
    });
    await answer({ text: "Action not recognized." });
    return;
  }

  const knownParsed: ParsedCallbackData<CallbackAction> = { ...parsed, action };
  // The bespoke settings route returned before the action allowlist check.
  const handler = CALLBACK_HANDLERS[action as Exclude<CallbackAction, "settings">];
  await handler({
    db,
    botToken,
    cb,
    chatId,
    parsed: knownParsed,
    beforeIrreversibleEffect: async () => undefined,
    answerCallback: answer,
    markMutationApplied: async () => undefined,
  });
}

export async function handleTelegramMessageUpdate(args: {
  db: D1Database;
  update: TelegramWebhookUpdateWithChatMember;
  botToken: string;
  nowSec: number;
}): Promise<string | null> {
  const { db, update, botToken, nowSec } = args;
  const chatId = update.message?.chat?.id?.toString();
  const text = update.message?.text?.trim();
  const username = update.message?.chat?.username ?? null;
  const actorUserId = update.message?.from?.id != null ? String(update.message.from.id) : null;
  const chatType = update.message?.chat?.type ?? "private";
  // Anonymous group admins post as the group itself; only admins can do that.
  const postedAsGroup = update.message?.sender_chat?.id != null
    && update.message.sender_chat.id === update.message.chat?.id;
  if (!chatId || !text) return null;

  const reply: ReplyFn = async (message) => {
    await sendAuditedTelegramReply(db, chatId, message, botToken);
  };
  const replyWithMarkup: WebhookCommandContext["replyToChatWithMarkup"] = async (message, options) => {
    await sendAuditedTelegramReply(db, chatId, message, botToken, options);
  };
  const commandContext: WebhookCommandContext = {
    db,
    chatId,
    chatType,
    username,
    actorUserId,
    botToken,
    operationNowSec: nowSec,
    replyToChat: reply,
    replyToChatWithMarkup: replyWithMarkup,
  };

  let parsedCommand: ReturnType<typeof parseCommand> | null = null;
  try {
    parsedCommand = text.startsWith("/") ? parseCommand(text) : null;
    if (parsedCommand && isGroupChatType(chatType) && !isAddressedToPharosBot(parsedCommand.botMention)) {
      return null;
    }

    if (!parsedCommand) return null;
    await dispatchParsedTelegramCommand({
      db,
      botToken,
      chatId,
      chatType,
      actorUserId,
      postedAsGroup,
      parsedCommand,
      commandContext,
      reply,
    });
    return null;
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
      action: "command-dispatch",
      errorClass: classifyTelegramLogError(err),
    });
    await reply("Something went wrong, please try again.");
    return "command-dispatch";
  }
}

async function dispatchParsedTelegramCommand(args: {
  db: D1Database;
  botToken: string;
  chatId: string;
  chatType: string;
  actorUserId: string | null;
  postedAsGroup: boolean;
  parsedCommand: ReturnType<typeof parseCommand>;
  commandContext: WebhookCommandContext;
  reply: ReplyFn;
}): Promise<void> {
  const {
    db,
    botToken,
    chatId,
    chatType,
    actorUserId,
    postedAsGroup,
    parsedCommand,
    commandContext,
    reply,
  } = args;
  const commandStartedAtMs = Date.now();
  const policy = classifyTelegramCommand(parsedCommand.command, parsedCommand.args);

  const floodAllowed = await enforceIngressFlood(db, {
    chatId,
    nowSec: Math.floor(commandStartedAtMs / 1000),
    actionDetail: parsedCommand.command,
    noticeMessage: "Too many commands at once — please slow down for a minute.",
    reply,
  });
  if (!floodAllowed) return;

  if (isChannelChatType(chatType) && policy.requiresGroupAdmin) {
    await reply("Channel-originated mutations are not supported. Manage alerts from a private chat or group.");
    await recordCommandUsage(db, parsedCommand.command, commandStartedAtMs, "denied", "channel_mutation");
    return;
  }

  if (isGroupChatType(chatType) && policy.requiresGroupAdmin) {
    const proceed = await maybeGateNonAdminGroupActor(
      db,
      botToken,
      chatId,
      actorUserId,
      parsedCommand.command,
      reply,
      { postedAsGroup },
    );
    if (!proceed) {
      await recordCommandUsage(db, parsedCommand.command, commandStartedAtMs, "denied");
      return;
    }
  }

  const handler = COMMAND_HANDLERS[parsedCommand.command];
  if (handler) {
    await handler(commandContext, parsedCommand.args);
    await recordCommandUsage(db, parsedCommand.command, commandStartedAtMs, "ok");
    return;
  }

  await replyToUnknownCommand(commandContext, parsedCommand.command);
  await recordTelegramUsageEvent(db, {
    eventType: "unknown_command",
    actionDetail: UNKNOWN_COMMAND_ACTION_DETAIL,
    outcome: "unknown",
  });
  await recordCommandUsage(db, UNKNOWN_COMMAND_ACTION_DETAIL, commandStartedAtMs, "unknown_command");
}
