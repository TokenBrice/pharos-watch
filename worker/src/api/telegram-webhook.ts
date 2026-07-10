import { TELEGRAM_BOT_USERNAME } from "@shared/lib/telegram-bot-registration";
import { answerCallbackQuery, escapeHtml } from "../lib/telegram";
import {
  formatAdministratorMentions,
  getCachedChatAdministrators,
} from "../lib/telegram-chat-member";
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
  handleMyChatMember,
  isBotRemovedTransition,
  type TelegramChatMemberUpdated,
} from "./telegram-webhook-group-welcome";
import {
  acquireTelegramCommandCooldown,
  claimTelegramProcessedUpdate,
  loadPendingDisambiguation,
  migrateTelegramChatId,
  recordTelegramChatCommandFlood,
  releaseTelegramCommandCooldown,
  unixNow,
  type TelegramChatCommandFloodResult,
} from "./telegram-webhook-store";
import { withErrorHandler } from "../lib/api-utils";
import { classifyTelegramLogError, logTelegramEvent } from "../lib/telegram-log";
import { handleCallbackQuery } from "./telegram-webhook-callbacks";
import { COMMAND_HANDLERS, type WebhookCommandContext } from "./webhook-commands";
import {
  isChannelChatType,
  isGroupAdminActor,
  isGroupChatType,
  validateTelegramWebhookSecret,
} from "./telegram-webhook-auth";
import {
  UNKNOWN_COMMAND_ACTION_DETAIL,
  recordTelegramUsageEvent,
} from "../lib/telegram-usage-analytics";
import { sendAuditedTelegramReply } from "./telegram-webhook-replies";
import {
  CHAT_COMMAND_FLOOD_LIMIT,
  CHAT_COMMAND_FLOOD_WINDOW_SEC,
  GROUP_ADMIN_DIAGNOSTIC_COOLDOWN_SEC,
  GROUP_CHAT_COMMAND_FLOOD_LIMIT,
} from "../lib/telegram-constants";
import {
  TelegramWebhookEffectFence,
  createTelegramWebhookIntent,
} from "./telegram-webhook-effect-fence";
import {
  executeNormalizedPendingSelection,
  parseStoredCommandSelectionIntent,
} from "./telegram-webhook-disambiguation-selection";

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
  "/pause",
  "/forget",
  "/unmutehours",
  "/unsnooze",
  "/import",
]);

// `botMention` is lowercased at parse time (telegram-webhook-parsing.ts), so
// compare against the lowercased canonical handle.
const PHAROS_BOT_USERNAMES = new Set([TELEGRAM_BOT_USERNAME.toLowerCase()]);

function logWarn(message: string, action: string, err: unknown): void {
  logTelegramEvent({
    level: "warn",
    message,
    action,
    errorClass: classifyTelegramLogError(err),
  });
}

type TelegramWebhookUpdateWithChatMember = TelegramWebhookUpdate & {
  my_chat_member?: TelegramChatMemberUpdated;
};

type FinishOk = (errorClass?: string | null) => Promise<Response>;
type ReplyWithMarkupFn = (message: string, options: { replyMarkup?: unknown }) => Promise<void>;
type FloodScope = "actor" | "chat";

const COMMAND_COOLDOWNS_SEC: Record<string, number> = {
  "/brief": 30,
  "/top": 20,
  "/why": 20,
  "/status": 20,
  "/coverage": 20,
};

const CANONICAL_COMMAND_KEYS: Record<string, string> = {
  "/market": "/brief",
};

const RESUMABLE_NORMALIZED_COMMANDS = new Set([
  "/mute",
  "/pause",
  "/set",
  "/subscribe",
  "/timezone",
  "/unmutehours",
  "/unsnooze",
  "/unsubscribe",
]);

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
    let effectFence: TelegramWebhookEffectFence | null = null;
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
            retryAfterSec: claim.retryAfterSec ?? null,
          });
          return new Response("retry", {
            status: 503,
            headers: {
              "Retry-After": String(Math.max(1, Math.ceil(claim.retryAfterSec ?? 1))),
            },
          });
        }
        if (claim.status === "effect_unknown") {
          logTelegramEvent({
            level: "warn",
            message: "duplicate update suppressed after effect execution started",
            action: "processed-update-effect-unknown",
          });
        }
        return ok();
      }
      if (!claim.claimOwner || claim.claimGeneration == null) {
        throw new Error("Telegram update claim token is missing");
      }
      const processedUpdateClaim = {
        owner: claim.claimOwner,
        generation: claim.claimGeneration,
      };
      effectFence = new TelegramWebhookEffectFence(
        db,
        claimedUpdateId,
        processedUpdateClaim,
        claim.storedIntent,
        claim.mutationAppliedAt,
      );
    }

    const finishOk = async (errorClass: string | null = null): Promise<Response> => {
      await effectFence?.finish(errorClass);
      return ok();
    };

    const beforeIrreversibleEffect = async (kind: string): Promise<void> => {
      await effectFence?.beforeIrreversibleEffect(kind);
    };

    const answerWebhookCallback = async (
      callbackQueryId: string,
      options?: { text?: string },
    ): Promise<void> => {
      await beforeIrreversibleEffect("callback-ack");
      await answerCallbackQuery(callbackQueryId, botToken, options);
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
                await answerWebhookCallback(update.callback_query!.id, { text: message });
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
                  await answerWebhookCallback(update.callback_query!.id, { text: message });
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
            isChannelChatType(update.callback_query.message?.chat?.type) &&
            callbackMutatesChatState(update.callback_query.data ?? "")
          ) {
            await answerWebhookCallback(update.callback_query.id, {
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
          await handleCallbackQuery(db, botToken, update.callback_query, {
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
            await answerWebhookCallback(update.callback_query.id, {
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

      if (update.my_chat_member) {
        const lifecycleRemoval = isBotRemovedTransition(
          update.my_chat_member.old_chat_member?.status,
          update.my_chat_member.new_chat_member?.status,
        );
        await effectFence?.plan(createTelegramWebhookIntent("member:lifecycle", {
          oldStatus: update.my_chat_member.old_chat_member?.status ?? null,
          newStatus: update.my_chat_member.new_chat_member?.status ?? null,
          chatType: update.my_chat_member.chat?.type ?? null,
          transition: lifecycleRemoval ? "removal" : "other",
        }, lifecycleRemoval ? "required" : "none"));
        let myChatMemberErrorClass: string | null = null;
        try {
          await handleMyChatMember(db, botToken, update.my_chat_member, {
            beforeIrreversibleEffect,
            prepareMutationAppliedStatement: effectFence
              ? () => effectFence.prepareMutationAppliedStatement()
              : undefined,
            confirmAtomicMutationApplied: () => effectFence?.confirmAtomicMutationApplied(),
            wasMutationApplied: effectFence?.wasMutationApplied,
          });
        } catch (err) {
          logTelegramEvent({
            message: "my_chat_member failed",
            action: "my_chat_member",
            errorClass: classifyTelegramLogError(err),
          });
          if (effectFence?.hasStartedEffect) throw err;
          myChatMemberErrorClass = "my_chat_member";
        }
        return finishOk(myChatMemberErrorClass);
      }

      const migration = resolveChatMigration(update.message);
      if (migration) {
        await effectFence?.plan(createTelegramWebhookIntent("chat:migration", migration, "required"));
        let migrationErrorClass: string | null = null;
        try {
          if (!effectFence?.wasMutationApplied) {
            const operationStatements = effectFence
              ? [effectFence.prepareMutationAppliedStatement()]
              : [];
            await migrateTelegramChatId(db, migration.oldChatId, migration.newChatId, { operationStatements });
            effectFence?.confirmAtomicMutationApplied();
          }
          logTelegramEvent({
            level: "info",
            message: "telegram chat id migrated",
            action: "chat-migration",
          });
        } catch (err) {
          logTelegramEvent({
            message: "telegram chat migration failed",
            action: "chat-migration",
            errorClass: classifyTelegramLogError(err),
          });
          migrationErrorClass = "chat-migration";
        }
        return finishOk(migrationErrorClass);
      }

      return await handleTelegramMessageUpdate({
        db,
        update,
        botToken,
        finishOk,
        effectFence,
        beforeIrreversibleEffect,
        operationNowSec: nowSec,
      });
    } catch (err) {
      await effectFence?.fail(classifyWebhookError(err));
      throw err;
    }
  },
);

async function handleTelegramMessageUpdate(args: {
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

function resolveUpdateType(update: TelegramWebhookUpdateWithChatMember): string {
  if (update.callback_query) return "callback_query";
  if (update.message) return "message";
  if (update.my_chat_member) return "my_chat_member";
  return "unknown";
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

async function createCallbackIntent(data: string) {
  const rawAction = data.split(":", 1)[0] ?? "";
  const action = /^[a-z]{1,32}$/.test(rawAction) ? rawAction : "unknown";
  return createTelegramWebhookIntent(`callback:${action}`, {
    action,
    dataDigest: await digestWebhookIntentInput(data),
    partCount: data.split(":").length,
  }, callbackMutatesChatState(data) ? "required" : "none");
}

async function createPendingIntent(
  pending: NonNullable<Awaited<ReturnType<typeof loadPendingDisambiguation>>>,
) {
  const actionType = pending.action_type && /^[a-z0-9][a-z0-9-]{0,63}$/.test(pending.action_type)
    ? pending.action_type
    : "unknown";
  return createTelegramWebhookIntent(`pending:${actionType}`, {
    actionType,
    actionPayloadDigest: await digestWebhookIntentInput(pending.action_payload ?? ""),
    expiresAt: pending.expires_at,
  }, "required");
}

function commandMutatesLocalState(command: string, args: string): boolean {
  return commandRequiresGroupAdmin(command, args)
    || command === "/forget"
    || command === "/cancel"
    || (command === "/start" && (
      parseStartPayload(args).kind === "setup" || parseStartPayload(args).kind === "none"
    ));
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
      // Availability-first by design: a D1 failure disables only this advisory
      // ingress guard for the current update, not the bot action itself.
      logWarn("chat command flood check failed", "command-flood", err);
    }
  }

  if (!blocked) return true;

  if (blocked.flood.firstExceeded) {
    try {
      await input.reply(input.noticeMessage);
    } catch (err) {
      logWarn("chat command flood notice reply failed", "command-flood", err);
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
    logWarn("chat command flood usage record failed", "command-flood", err);
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
    logWarn("command cooldown release failed", input.action, err);
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
    logWarn("command cooldown check failed", "command-cooldown", err);
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

function callbackMutatesChatState(data: string): boolean {
  const [action, subAction] = data.split(":");
  if (action === "status" || action === "why" || action === "coverage" || action === "help") {
    return false;
  }
  if (action === "settings" && (subAction === "home" || subAction === "o")) {
    return false;
  }
  if (action === "manage") return false;
  return true;
}

function resolveCommandCooldownSec(command: string, args: string): number | null {
  const cooldownSec = COMMAND_COOLDOWNS_SEC[command];
  if (cooldownSec == null) return null;
  if ((command === "/top" || command === "/why" || command === "/coverage" || command === "/status") && !args.trim()) {
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
    logWarn("group admin diagnostic cooldown check failed", "group-admin-diagnostics", err);
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
