import {
  SETUP_PENDING_ACTION_TYPE,
  type TelegramWebhookUpdate,
} from "./telegram-webhook-shared";
import {
  parseCommand,
  parseStartPayload,
} from "./telegram-webhook-parsing";
import {
  handlePendingActionBeforeDispatch,
  handleSetupPendingBeforeDispatch,
  resumeStoredPendingClearIntent,
  type ParsedTelegramCommand,
  type ReplyFn,
} from "./telegram-webhook-pending-gate";
import {
  loadPendingDisambiguation,
  unixNow,
} from "./telegram-webhook-store";
import { classifyTelegramLogError, logTelegramEvent } from "../lib/telegram-log";
import { handleCallbackQuery } from "./telegram-webhook-callbacks";
import { COMMAND_HANDLERS, type WebhookCommandContext } from "./webhook-commands";
import {
  isChannelChatType,
  isGroupChatType,
} from "./telegram-webhook-auth";
import {
  UNKNOWN_COMMAND_ACTION_DETAIL,
  recordTelegramUsageEvent,
} from "../lib/telegram-usage-analytics";
import { sendAuditedTelegramReply } from "./telegram-webhook-replies";
import {
  createTelegramWebhookIntent,
  type TelegramWebhookEffectFence,
} from "./telegram-webhook-effect-fence";
import {
  executeNormalizedPendingSelection,
  parseStoredCommandSelectionIntent,
} from "./telegram-webhook-disambiguation-selection";
import {
  callbackActionDetail,
  callbackMutatesChatState,
  commandRequiresGroupAdmin,
  enforceCommandCooldown,
  enforceIngressFlood,
  isAddressedToPharosBot,
  logTelegramWebhookWarning,
  maybeGateNonAdminGroupActor,
  recordCommandUsage,
  releaseCommandCooldownBestEffort,
  resolveCallbackCooldownCommandKey,
} from "./telegram-webhook-ingress-policy";
import type { TelegramWebhookUpdateWithChatMember } from "./telegram-webhook-update-normalization";

/**
 * Intent dispatch for claimed webhook updates: route callback taps and message
 * commands through the ingress policy gates (flood, cooldown, channel/group
 * admin) and the pending-disambiguation gate into the registered handlers.
 */

function logWarn(message: string, action: string, err: unknown): void {
  logTelegramWebhookWarning(message, action, err);
}

export type FinishOk = (errorClass?: string | null) => Promise<Response>;
export type ReplyWithMarkupFn = (message: string, options: { replyMarkup?: unknown }) => Promise<void>;

const RESUMABLE_NORMALIZED_COMMANDS = new Set([
  "/mute",
  "/pause",
  "/set",
  "/subscribe",
  "/timezone",
  "/recap",
  "/unmutehours",
  "/unsnooze",
  "/unsubscribe",
]);

export async function handleTelegramCallbackQueryUpdate(args: {
  db: D1Database;
  botToken: string;
  callbackQuery: NonNullable<TelegramWebhookUpdate["callback_query"]>;
  nowSec: number;
  finishOk: FinishOk;
  effectFence: TelegramWebhookEffectFence | null;
  beforeIrreversibleEffect: (kind: string) => Promise<void>;
  answerWebhookCallback: (callbackQueryId: string, options?: { text?: string }) => Promise<void>;
}): Promise<Response> {
  const {
    db,
    botToken,
    callbackQuery,
    nowSec,
    finishOk,
    effectFence,
    beforeIrreversibleEffect,
    answerWebhookCallback,
  } = args;
  let callbackErrorClass: string | null = null;
  let callbackCooldownKey: string | null = null;
  const callbackChatId = callbackQuery.message?.chat?.id?.toString() ?? null;
  const callbackAction = callbackActionDetail(callbackQuery.data ?? "");
  try {
    if (callbackChatId) {
      const floodAllowed = await enforceIngressFlood(db, {
        chatId: callbackChatId,
        chatType: callbackQuery.message?.chat?.type ?? "private",
        actorUserId: callbackQuery.from?.id != null ? String(callbackQuery.from.id) : null,
        nowSec,
        actionDetail: callbackAction,
        noticeMessage: "Too many button taps at once — please slow down for a minute.",
        reply: async (message) => {
          await answerWebhookCallback(callbackQuery.id, { text: message });
        },
      });
      if (!floodAllowed) return finishOk();

      const callbackCooldownCommand = resolveCallbackCooldownCommandKey(callbackQuery.data ?? "");
      if (callbackCooldownCommand) {
        const cooldown = await enforceCommandCooldown(
          db,
          callbackChatId,
          callbackCooldownCommand,
          "callback",
          async (message) => {
            await answerWebhookCallback(callbackQuery.id, { text: message });
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
    if (
      callbackChatId &&
      isChannelChatType(callbackQuery.message?.chat?.type) &&
      callbackMutatesChatState(callbackQuery.data ?? "")
    ) {
      await answerWebhookCallback(callbackQuery.id, {
        text: "Channel-originated actions are not supported.",
      });
      await recordTelegramUsageEvent(db, {
        eventType: "command",
        actionDetail: callbackAction,
        outcome: "denied",
        failureClass: "channel_mutation",
      });
      return finishOk();
    }
    await handleCallbackQuery(db, botToken, callbackQuery, {
      beforeIrreversibleEffect,
      markMutationApplied: async () => effectFence?.markMutationApplied(),
      planIntent: async (intent) => effectFence?.plan(intent),
      prepareMutationAppliedStatement: effectFence
        ? () => effectFence.prepareMutationAppliedStatement()
        : undefined,
      confirmAtomicMutationApplied: () => effectFence?.confirmAtomicMutationApplied(),
      storedIntent: effectFence?.storedIntent ?? null,
      wasMutationApplied: effectFence?.wasMutationApplied ?? false,
    });
  } catch (err) {
    if (callbackChatId && callbackCooldownKey) {
      await releaseCommandCooldownBestEffort(db, {
        chatId: callbackChatId,
        commandKey: callbackCooldownKey,
        action: "callback-cooldown-release",
        command: callbackAction,
      });
    }
    if (effectFence?.hasStartedEffect) throw err;
    try {
      await answerWebhookCallback(callbackQuery.id, {
        text: "Action failed. Try again.",
      });
    } catch (ackErr) {
      logWarn("callback_query failure ack failed", "callback_query", ackErr);
    }
    logTelegramEvent({
      message: "callback_query failed",
      action: "callback_query",
      errorClass: classifyTelegramLogError(err),
    });
    callbackErrorClass = "callback_query";
  }
  return finishOk(callbackErrorClass);
}

export async function handleTelegramMessageUpdate(args: {
  db: D1Database;
  update: TelegramWebhookUpdateWithChatMember;
  botToken: string;
  finishOk: FinishOk;
  effectFence: TelegramWebhookEffectFence | null;
  beforeIrreversibleEffect: (kind: string) => Promise<void>;
  operationNowSec: number;
}): Promise<Response> {
  const { db, update, botToken, finishOk, effectFence, beforeIrreversibleEffect, operationNowSec } = args;
  const chatId = update.message?.chat?.id?.toString();
  const text = update.message?.text?.trim();
  const username = update.message?.chat?.username ?? null;
  const actorUserId = update.message?.from?.id != null ? String(update.message.from.id) : null;
  const chatType = update.message?.chat?.type ?? "private";
  if (!chatId || !text) return finishOk();

  const reply: ReplyFn = async (message) => {
    await beforeIrreversibleEffect("message-reply");
    await sendAuditedTelegramReply(db, chatId, message, botToken);
  };
  const replyWithMarkup: ReplyWithMarkupFn = async (message, options) => {
    await beforeIrreversibleEffect("message-reply");
    await sendAuditedTelegramReply(db, chatId, message, botToken, options);
  };
  const commandContext: WebhookCommandContext = {
    db,
    chatId,
    chatType,
    username,
    actorUserId,
    botToken,
    operationNowSec,
    beforeIrreversibleEffect,
    planIntent: async (intent) => effectFence?.plan(intent),
    prepareMutationAppliedStatement: effectFence
      ? () => effectFence.prepareMutationAppliedStatement()
      : undefined,
    prepareMutationOperationStatements: effectFence
      ? () => [
          ...(commandContext.clearPendingOnMutation
            ? [db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId)]
            : []),
          effectFence.prepareMutationAppliedStatement(),
        ]
      : undefined,
    preparePendingMutationAppliedStatement: effectFence
      ? (input) => effectFence.preparePendingMutationAppliedStatement(input)
      : undefined,
    confirmAtomicMutationApplied: () => effectFence?.confirmAtomicMutationApplied(),
    markMutationApplied: async () => effectFence?.markMutationApplied(),
    storedIntent: effectFence?.storedIntent ?? null,
    wasMutationApplied: effectFence?.wasMutationApplied ?? false,
    replyToChat: reply,
    replyToChatWithMarkup: replyWithMarkup,
  };

  let parsedCommand: ParsedTelegramCommand | null = null;
  try {
    parsedCommand = text.startsWith("/") ? parseCommand(text) : null;
    if (parsedCommand && isGroupChatType(chatType) && !isAddressedToPharosBot(parsedCommand.botMention)) {
      return finishOk();
    }

    const pendingClearResume = await resumeStoredPendingClearIntent({
      db,
      chatId,
      intent: effectFence?.storedIntent,
      operation: {
        beforeIrreversibleEffect,
        prepareMutationAppliedStatement: effectFence
          ? () => effectFence.prepareMutationAppliedStatement()
          : undefined,
        confirmAtomicMutationApplied: () => effectFence?.confirmAtomicMutationApplied(),
        markMutationApplied: async () => effectFence?.markMutationApplied(),
        storedIntent: effectFence?.storedIntent ?? null,
        wasMutationApplied: effectFence?.wasMutationApplied ?? false,
      },
    });
    if (pendingClearResume.handled) {
      if (pendingClearResume.reply) await reply(pendingClearResume.reply);
      if (pendingClearResume.continueCommand && parsedCommand) {
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
        });
      }
      return finishOk();
    }

    const storedSelection = parseStoredCommandSelectionIntent(effectFence?.storedIntent);
    const resumeStoredCommand = Boolean(
      parsedCommand
      && effectFence?.storedIntent
      && (
        storedSelection
        || effectFence.storedIntent.payload.stage === "bulk-confirm-prompt"
        || effectFence.storedIntent.payload.scope === "all"
        || (
          RESUMABLE_NORMALIZED_COMMANDS.has(parsedCommand.command)
          && effectFence.storedIntent.kind === `command:${parsedCommand.command.slice(1)}`
          && effectFence.storedIntent.mutation === "required"
        )
      ),
    );
    if (parsedCommand && resumeStoredCommand) {
      commandContext.clearPendingOnMutation = effectFence?.storedIntent?.payload.clearPending === true;
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
        storedSelection,
      });
      return finishOk();
    }

    const pendingRow = await loadPendingDisambiguation(db, chatId);
    const pendingNotExpired = Boolean(pendingRow && unixNow() < pendingRow.expires_at);
    const isSetupPending =
      Boolean(pendingRow && pendingNotExpired && pendingRow.action_type === SETUP_PENDING_ACTION_TYPE);
    let priorFloodCheckPassed = false;

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
      priorFloodCheckPassed = floodAllowed;
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
        operation: {
          beforeIrreversibleEffect,
          planIntent: async (intent) => effectFence?.plan(intent),
          prepareMutationAppliedStatement: effectFence
            ? () => effectFence.prepareMutationAppliedStatement()
            : undefined,
          preparePendingMutationAppliedStatement: effectFence
            ? (input) => effectFence.preparePendingMutationAppliedStatement(input)
            : undefined,
          confirmAtomicMutationApplied: () => effectFence?.confirmAtomicMutationApplied(),
          markMutationApplied: async () => effectFence?.markMutationApplied(),
          storedIntent: effectFence?.storedIntent ?? null,
          wasMutationApplied: effectFence?.wasMutationApplied ?? false,
          operationNowSec,
        },
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
        operation: {
          beforeIrreversibleEffect,
          planIntent: async (intent) => effectFence?.plan(intent),
          prepareMutationAppliedStatement: effectFence
            ? () => effectFence.prepareMutationAppliedStatement()
            : undefined,
          preparePendingMutationAppliedStatement: effectFence
            ? (input) => effectFence.preparePendingMutationAppliedStatement(input)
            : undefined,
          confirmAtomicMutationApplied: () => effectFence?.confirmAtomicMutationApplied(),
          markMutationApplied: async () => effectFence?.markMutationApplied(),
          storedIntent: effectFence?.storedIntent ?? null,
          wasMutationApplied: effectFence?.wasMutationApplied ?? false,
          operationNowSec,
        },
      });
      if (pendingResult === "finished") return finishOk();
      if (pendingResult === "continue-clear-pending") {
        commandContext.clearPendingOnMutation = true;
      }
    }

    if (!parsedCommand) return finishOk();
    if (!effectFence?.storedIntent && !commandMutatesLocalState(parsedCommand.command, parsedCommand.args)) {
      await effectFence?.plan(await createCommandIntent(parsedCommand));
    }
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
      skipFlood: priorFloodCheckPassed,
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
      action: "command-dispatch",
      errorClass: classifyTelegramLogError(err),
    });
    if (effectFence?.hasStartedEffect) throw err;
    await reply("Something went wrong, please try again.");
    return finishOk("command-dispatch");
  }
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
  storedSelection?: ReturnType<typeof parseStoredCommandSelectionIntent>;
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
    storedSelection,
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
    isChannelChatType(chatType) &&
    commandRequiresGroupAdmin(parsedCommand.command, parsedCommand.args)
  ) {
    await reply("Channel-originated mutations are not supported. Manage alerts from a private chat or group.");
    await recordCommandUsage(db, parsedCommand.command, commandStartedAtMs, "denied", "channel_mutation");
    return;
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

  if (storedSelection) {
    await executeNormalizedPendingSelection(
      db,
      botToken,
      chatId,
      commandContext.username,
      storedSelection,
      {
        beforeIrreversibleEffect: commandContext.beforeIrreversibleEffect,
        planIntent: commandContext.planIntent,
        prepareMutationAppliedStatement: commandContext.prepareMutationAppliedStatement,
        confirmAtomicMutationApplied: commandContext.confirmAtomicMutationApplied,
        markMutationApplied: commandContext.markMutationApplied,
        storedIntent: commandContext.storedIntent,
        wasMutationApplied: commandContext.wasMutationApplied,
      },
    );
    await recordCommandUsage(db, parsedCommand.command, commandStartedAtMs, "ok");
    return;
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
    actionDetail: UNKNOWN_COMMAND_ACTION_DETAIL,
    outcome: "unknown",
  });
  await recordCommandUsage(db, UNKNOWN_COMMAND_ACTION_DETAIL, commandStartedAtMs, "unknown_command");
}

async function digestWebhookIntentInput(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createCommandIntent(parsed: ParsedTelegramCommand) {
  const mutation = commandMutatesLocalState(parsed.command, parsed.args) ? "required" : "none";
  return createTelegramWebhookIntent(`command:${parsed.command}`, {
    command: parsed.command,
    argsDigest: await digestWebhookIntentInput(parsed.args),
    argsLength: parsed.args.length,
  }, mutation);
}

function commandMutatesLocalState(command: string, args: string): boolean {
  return commandRequiresGroupAdmin(command, args)
    || command === "/forget"
    || command === "/cancel"
    || (command === "/recap" && /^(?:on|off|time\s+(?:[0-9]|1[0-9]|2[0-3]))$/i.test(args.trim()))
    || (command === "/start" && (
      parseStartPayload(args).kind === "setup" || parseStartPayload(args).kind === "none"
    ));
}
