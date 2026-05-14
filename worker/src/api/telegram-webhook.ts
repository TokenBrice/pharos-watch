import { escapeHtml } from "../lib/telegram";
import {
  formatAdministratorMentions,
  getCachedChatAdministrators,
} from "../lib/telegram-chat-member";
import { getCache, setCache } from "../lib/db-cache";
import {
  formatDisambiguation,
  parseDisambiguationReply,
  type ResolvedCoin,
} from "../lib/telegram-alerts";
import {
  SETUP_PENDING_ACTION_TYPE,
  type PendingAction,
  type PendingDisambiguationRow,
  type TelegramWebhookUpdate,
} from "./telegram-webhook-shared";
import { handleSetupTickerInput, parseSetupState } from "./telegram-webhook-setup";
import {
  dedupeCoins,
  parseCommand,
  parsePendingDisambiguation,
} from "./telegram-webhook-parsing";
import {
  acquireTelegramCommandCooldown,
  claimTelegramProcessedUpdate,
  clearPendingDisambiguation,
  markTelegramProcessedUpdateFailed,
  markTelegramProcessedUpdateProcessed,
  migrateTelegramChatId,
  maybePruneTelegramProcessedUpdates,
  PENDING_OWNERSHIP_CONFLICT_MESSAGE,
  unixNow,
} from "./telegram-webhook-store";
import { withErrorHandler } from "../lib/api-utils";
import { logTelegramEvent } from "../lib/telegram-log";
import { handleCallbackQuery } from "./telegram-webhook-callbacks";
import { COMMAND_HANDLERS, type WebhookCommandContext } from "./webhook-commands";
import { makeActionRunner } from "./webhook-commands/action-runner";
import { isGroupAdminActor, isGroupChatType, validateTelegramWebhookSecret } from "./telegram-webhook-auth";
import {
  recordTelegramUsageEvent,
} from "../lib/telegram-usage-analytics";
import { sendAuditedTelegramReply } from "./telegram-webhook-replies";

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

const PHAROS_BOT_USERNAMES = new Set(["pharoswatchbot"]);

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
  "/coverage": 20,
};

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
          err: err instanceof Error ? err.message : String(err),
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
        try {
          await handleCallbackQuery(db, botToken, update.callback_query);
        } catch (err) {
          logTelegramEvent({
            message: "callback_query failed",
            chatId: update.callback_query.message?.chat?.id ?? null,
            userId: update.callback_query.from?.id ?? null,
            action: "callback_query",
            err: err instanceof Error ? err.message : String(err),
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
            err: err instanceof Error ? err.message : String(err),
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
            err: err instanceof Error ? err.message : String(err),
          });
          migrationErrorClass = "chat-migration";
        }
        return finishOk(migrationErrorClass);
      }

      const chatId = update.message?.chat?.id?.toString();
      const text = update.message?.text?.trim();
      const username = update.message?.chat?.username ?? null;
      const actorUserId = update.message?.from?.id != null ? String(update.message.from.id) : null;
      const chatType = update.message?.chat?.type ?? "private";
    if (!chatId || !text) return finishOk();

    const reply = async (message: string) => {
      await replyToChat(db, chatId, message, botToken);
    };
    const replyWithMarkup = async (
      message: string,
      options: { replyMarkup?: unknown },
    ) => {
      await replyToChat(db, chatId, message, botToken, options);
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

    try {
      const parsedCommand = text.startsWith("/") ? parseCommand(text) : null;
      if (parsedCommand && isGroupChat(chatType) && !isAddressedToPharosBot(parsedCommand.botMention)) {
        return finishOk();
      }

      const pendingRow = await db
        .prepare(
          "SELECT action_type, action_payload, alert_types, resolved_ids, ambiguous_ticker, candidates, remaining_tickers, expires_at, initiator_user_id FROM telegram_pending_disambiguation WHERE chat_id = ?",
        )
        .bind(chatId)
        .first<PendingDisambiguationRow>();

      const pendingNotExpired = Boolean(pendingRow && unixNow() < pendingRow.expires_at);
      const isSetupPending =
        Boolean(pendingRow && pendingNotExpired && pendingRow.action_type === SETUP_PENDING_ACTION_TYPE);

      if (isSetupPending && pendingRow) {
        const setupState = parseSetupState(pendingRow.action_payload, pendingRow.initiator_user_id ?? null);
        if (setupState && setupState.step === "awaiting-ticker" && !parsedCommand) {
          await handleSetupTickerInput(
            { db, botToken, chatId, actorUserId, username },
            text,
            setupState,
          );
          return finishOk();
        }
        // Plain text at a non-ticker wizard step (e.g. typing "recommended" instead of tapping a button)
        // would otherwise fall through silently — nudge the owner toward the inline keyboard.
        if (!parsedCommand && canActOnPendingOwner(setupState?.initiatorUserId ?? null, actorUserId)) {
          await reply("Tap one of the buttons above, or send /cancel to abort.");
          return finishOk();
        }
        // A new slash command in setup state clears the wizard before running the command.
        if (parsedCommand) {
          if (!setupState || canActOnPendingOwner(setupState.initiatorUserId, actorUserId)) {
            // `/cancel` mid-wizard should confirm the cancellation rather than fall through to
            // the global cancel handler, which would lie with "No pending selection to cancel."
            if (parsedCommand.command === "/cancel") {
              await clearPendingDisambiguation(db, chatId);
              await reply("Setup cancelled. Send /start to begin again or /list to view subscriptions.");
              return finishOk();
            }
            await clearPendingDisambiguation(db, chatId);
          } else if (!PENDING_PASSTHROUGH_COMMANDS.has(parsedCommand.command)) {
            await reply(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
            return finishOk();
          }
        }
      }

      const pendingAction = !isSetupPending && pendingRow ? parsePendingDisambiguation(pendingRow) : null;
      const pendingActive = Boolean(!isSetupPending && pendingRow && pendingAction && pendingNotExpired);

      if (!isSetupPending && pendingRow && !pendingAction && pendingNotExpired) {
        await clearPendingDisambiguation(db, chatId);
        if (!parsedCommand) {
          await reply("That pending selection could not be restored. Please rerun the command, or use /help for examples.");
          return finishOk();
        }
      }

      if (!isSetupPending && pendingRow && !pendingActive) {
        await clearPendingDisambiguation(db, chatId);
      }

      if (pendingActive && pendingAction) {
        if (!parsedCommand) {
          if (pendingAction.actionType === "confirm-bulk" || pendingAction.actionType === "forget-confirm") {
            // Bulk-confirm and forget-confirm pendings wait for an inline button tap, not a text reply.
            // Ignore plain text in groups; in private chats, nudge toward the buttons.
            if (isGroupChat(chatType)) return finishOk();
            await reply("Tap Confirm or Cancel on the previous message, or send /cancel to abort.");
            return finishOk();
          }
          if (!canActOnPending(pendingAction, actorUserId)) {
            if (isGroupChat(chatType) && !looksLikeDisambiguationSelection(text)) {
              return finishOk();
            }
            await reply("Only the user who started this pending selection can complete it.");
            return finishOk();
          }
          await handleDisambiguationReply(db, chatId, text, pendingAction, botToken, username);
          return finishOk();
        }

        const command = parsedCommand.command;
        if (command === "/cancel") {
          if (!canActOnPending(pendingAction, actorUserId)) {
            await reply("Only the user who started this pending selection can cancel it.");
            return finishOk();
          }
          await clearPendingDisambiguation(db, chatId);
          await reply("Pending selection cancelled.");
          return finishOk();
        }

        if (PENDING_PASSTHROUGH_COMMANDS.has(command)) {
          // Read-only commands run without disturbing the pending state.
          // Falls through to the gating + dispatch below.
        } else if (PENDING_CLEAR_AND_RUN_COMMANDS.has(command)) {
          if (!canActOnPending(pendingAction, actorUserId)) {
            await reply("Another user has a pending ticker selection in this chat. Ask them to finish or /cancel it first.");
            return finishOk();
          }
          await clearPendingDisambiguation(db, chatId);
          // Falls through to the gating + dispatch below.
        } else {
          if (pendingAction.actionType === "confirm-bulk" || pendingAction.actionType === "forget-confirm") {
            await reply("You have a pending confirmation. Tap Confirm or Cancel on the previous message, or send /cancel to abort.");
            return finishOk();
          }
          await reply(`You have a pending selection. Reply with the number(s) you want, or use /cancel.

${escapeHtml(formatDisambiguation(pendingAction.ambiguousTicker, pendingAction.candidates))}`);
          return finishOk();
        }
      }

      if (!parsedCommand) return finishOk();
      const commandStartedAtMs = Date.now();

      if (
        isGroupChat(chatType) &&
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
          return finishOk();
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
        if (!cooldown) {
          await recordCommandUsage(db, parsedCommand.command, commandStartedAtMs, "rate_limited");
          return finishOk();
        }
        await handler(commandContext, parsedCommand.args);
        await recordCommandUsage(db, parsedCommand.command, commandStartedAtMs, "ok");
      } else {
        await reply("Unknown command. Try /help");
        await recordTelegramUsageEvent(db, {
          eventType: "unknown_command",
          actionDetail: parsedCommand.command,
          outcome: "unknown",
        });
        await recordCommandUsage(db, parsedCommand.command, commandStartedAtMs, "unknown_command");
      }
      return finishOk();
    } catch (err) {
      const parsedCommand = text.startsWith("/") ? parseCommand(text) : null;
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
        err: err instanceof Error ? err.message : String(err),
      });
      await reply("Something went wrong, please try again.");
      return finishOk("command-dispatch");
    }
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

function isGroupChat(chatType: string): boolean {
  return isGroupChatType(chatType);
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

async function enforceCommandCooldown(
  db: D1Database,
  chatId: string,
  command: string,
  args: string,
  reply: (message: string) => Promise<void>,
): Promise<boolean> {
  const commandKey = canonicalCommandKey(command);
  const cooldownSec = resolveCommandCooldownSec(commandKey, args);
  if (cooldownSec == null) return true;

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
      err: err instanceof Error ? err.message : String(err),
    });
    await reply("Command traffic is busy. Please try again shortly.");
    return false;
  }

  if (cooldown.allowed) return true;
  await reply(formatCommandCooldownMessage(commandKey, cooldown.retryAfterSec));
  return false;
}

function canonicalCommandKey(command: string): string {
  return CANONICAL_COMMAND_KEYS[command] ?? command;
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
    if (await isGroupAdminActor(db, botToken, chatId, actorUserId)) {
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
      err: err instanceof Error ? err.message : String(err),
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
  const mentions = admins ? formatAdministratorMentions(admins) : "";
  const adminLine = mentions ? ` Admins here: ${mentions}.` : "";
  await reply(
    escapeHtml(
      `Only group admins can change alert settings (${command}).${adminLine}`,
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
    const reminder = [
      'Reply with the number(s) you want, e.g. "1" or "1,2".',
      "Use /cancel to abandon this selection.",
      formatDisambiguation(pending.ambiguousTicker, pending.candidates),
    ].join("\n\n");
    await sendAuditedTelegramReply(db, chatId, escapeHtml(reminder), botToken);
    return;
  }

  const selectedCoins = dedupeCoins(
    selectedIndices.map((index) => pending.candidates[index]).filter((coin): coin is ResolvedCoin => Boolean(coin)),
  );

  const initialCoins = dedupeCoins([...pending.resolvedCoins, ...selectedCoins]);
  const sharedOpts = { tickers: pending.remainingTickers, initialCoins, clearPendingOnTerminal: true as const };

  switch (pending.actionType) {
    case "subscribe": {
      const runAction = makeActionRunner(
        { db, chatId, username, initiatorUserId: pending.initiatorUserId },
        botToken,
        {
          kind: "subscribe",
          alertTypes: [...pending.alertTypes],
          presetIds: pending.presetIds,
          depegWorseningBpsStep: pending.depegWorseningBpsStep,
        },
      );
      await runAction({
        ...sharedOpts,
        actionType: "subscribe",
        actionPayload: {
          alertTypes: [...pending.alertTypes],
          presetIds: pending.presetIds,
          depegWorseningBpsStep: pending.depegWorseningBpsStep,
        },
        alertTypes: pending.alertTypes,
      });
      return;
    }
    case "unsubscribe": {
      const runAction = makeActionRunner(
        { db, chatId, username: null, initiatorUserId: pending.initiatorUserId },
        botToken,
        { kind: "unsubscribe", presetIds: pending.presetIds },
      );
      await runAction({
        ...sharedOpts,
        actionType: "unsubscribe",
        actionPayload: { presetIds: pending.presetIds },
        resolutionScope: "tracked",
      });
      return;
    }
    case "set": {
      const runAction = makeActionRunner({ db, chatId, username, initiatorUserId: pending.initiatorUserId }, botToken);
      await runAction({ ...sharedOpts, actionType: "set", actionPayload: pending.command });
      return;
    }
  }
}

async function replyToChat(
  db: D1Database,
  chatId: string,
  message: string,
  botToken: string,
  options: { replyMarkup?: unknown } = {},
): Promise<void> {
  await sendAuditedTelegramReply(db, chatId, message, botToken, options);
}

function isBotAddedTransition(
  oldStatus: string | undefined,
  newStatus: string | undefined,
): boolean {
  const wasAbsent = oldStatus === "left" || oldStatus === "kicked";
  const isPresent = newStatus === "member" || newStatus === "administrator";
  return wasAbsent && isPresent;
}

function buildGroupWelcomeMessage(adderMention: string): string {
  return [
    `<b>Thanks for adding Pharos Watch</b>${adderMention ? `, ${adderMention}` : ""}.`,
    "",
    "I send stablecoin alerts into this chat: DEWS stress, depeg events, safety grade changes, and launches.",
    "",
    "Group admins can run <code>/subscribe@PharosWatchBot dews usd-top25</code> here. For your own watchlist and quiet hours, message me in DM.",
  ].join("\n");
}

function buildGroupWelcomeReplyMarkup(): {
  inline_keyboard: { text: string; url: string }[][];
} {
  return {
    inline_keyboard: [
      [{ text: "Read the docs →", url: "https://pharos.watch/pharoswatchbot/" }],
      [{ text: "Personal alerts in DM →", url: "https://t.me/PharosWatchBot?start=setup" }],
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
  // block/unblock, and on other 1:1 status changes. We only welcome on a
  // bot-added-to-group transition.
  if (chatType === "private" || chatType === "sender") return;
  if (!isBotAddedTransition(payload.old_chat_member?.status, payload.new_chat_member?.status)) {
    return;
  }
  const chatId = payload.chat?.id;
  if (typeof chatId !== "number" || !Number.isFinite(chatId)) return;
  const chatIdStr = String(chatId);

  // 24h idempotency marker per chat — Telegram may redeliver `my_chat_member`
  // when the bot is removed and re-added quickly; we never want two welcomes.
  const cacheKey = `telegram:group-welcome:${chatIdStr}`;
  const cached = await getCache(db, cacheKey);
  if (cached && Date.now() / 1000 - cached.updatedAt < TELEGRAM_GROUP_WELCOME_CACHE_TTL_SEC) {
    return;
  }

  const adderMention = formatAdderMention(payload.from);
  await sendAuditedTelegramReply(
    db,
    chatIdStr,
    buildGroupWelcomeMessage(adderMention),
    botToken,
    {
      actionDetail: "group-welcome",
      replyMarkup: buildGroupWelcomeReplyMarkup(),
    },
  );
  await setCache(db, cacheKey, "1");
}
