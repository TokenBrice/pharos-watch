import { timingSafeCompare } from "../lib/auth";
import { escapeHtml, sendToChat } from "../lib/telegram";
import {
  formatAdministratorMentions,
  getCachedChatAdministrators,
  getCachedChatMember,
} from "../lib/telegram-chat-member";
import {
  formatDisambiguation,
  splitMessage,
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
  clearPendingDisambiguation,
  unixNow,
} from "./telegram-webhook-store";
import { withErrorHandler } from "../lib/api-utils";
import { logTelegramEvent } from "../lib/telegram-log";
import { handleCallbackQuery } from "./telegram-webhook-callbacks";
import { COMMAND_HANDLERS, type WebhookCommandContext } from "./webhook-commands";
import { makeActionRunner } from "./webhook-commands/action-runner";
import { isGroupChatType } from "./telegram-webhook-auth";

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
]);

const PHAROS_BOT_USERNAMES = new Set(["pharoswatchbot"]);

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

    const providedSecret =
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (!providedSecret.trim()) {
      return ok();
    }
    const validCurrentSecret = webhookSecret
      ? await timingSafeCompare(providedSecret, webhookSecret)
      : false;
    const validPreviousSecret = previousWebhookSecret
      ? await timingSafeCompare(providedSecret, previousWebhookSecret)
      : false;
    if (!validCurrentSecret && !validPreviousSecret) {
      logTelegramEvent({
        level: "warn",
        message: "auth validation failed — returning 200 to prevent retry storm",
        action: "auth",
      });
      return ok();
    }
    if (!botToken) return ok();

    let update: TelegramWebhookUpdate;
    try {
      update = await request.json();
    } catch {
      return ok();
    }

    const updateId = update.update_id;
    if (typeof updateId === "number") {
      const dedup = await db
        .prepare(
          `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE CAST(cache.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
        )
        .bind("telegram:last-update-id", String(updateId), Math.floor(Date.now() / 1000))
        .run();
      if (dedup.meta.changes === 0) {
        return ok();
      }
    }

    if (update.callback_query) {
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
      }
      return ok();
    }

    const chatId = update.message?.chat?.id?.toString();
    const text = update.message?.text?.trim();
    const username = update.message?.chat?.username ?? null;
    const actorUserId = update.message?.from?.id != null ? String(update.message.from.id) : null;
    const chatType = update.message?.chat?.type ?? "private";
    if (!chatId || !text) return ok();

    const reply = async (message: string) => {
      await replyToChat(chatId, message, botToken);
    };
    const replyWithMarkup = async (
      message: string,
      options: { replyMarkup?: unknown },
    ) => {
      await replyToChat(chatId, message, botToken, options);
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
        return ok();
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
          return ok();
        }
        // A new slash command in setup state clears the wizard before running the command.
        if (parsedCommand) {
          await clearPendingDisambiguation(db, chatId);
        }
      }

      const pendingAction = !isSetupPending && pendingRow ? parsePendingDisambiguation(pendingRow) : null;
      const pendingActive = Boolean(!isSetupPending && pendingRow && pendingAction && pendingNotExpired);

      if (!isSetupPending && pendingRow && !pendingAction && pendingNotExpired) {
        await clearPendingDisambiguation(db, chatId);
        if (!parsedCommand) {
          await reply("That pending selection could not be restored. Please rerun the command, or use /help for examples.");
          return ok();
        }
      }

      if (!isSetupPending && pendingRow && !pendingActive) {
        await clearPendingDisambiguation(db, chatId);
      }

      if (pendingActive && pendingAction) {
        if (!parsedCommand) {
          if (pendingAction.actionType === "confirm-bulk") {
            // Bulk-confirm pending waits for an inline button tap, not a text reply.
            // Ignore plain text in groups; in private chats, nudge toward the buttons.
            if (isGroupChat(chatType)) return ok();
            await reply("Tap Confirm or Cancel on the previous message, or send /cancel to abort.");
            return ok();
          }
          if (!canActOnPending(pendingAction, actorUserId)) {
            if (isGroupChat(chatType) && !looksLikeDisambiguationSelection(text)) {
              return ok();
            }
            await reply("Only the user who started this pending selection can complete it.");
            return ok();
          }
          await handleDisambiguationReply(db, chatId, text, pendingAction, botToken, username);
          return ok();
        }

        const command = parsedCommand.command;
        if (command === "/cancel") {
          if (!canActOnPending(pendingAction, actorUserId)) {
            await reply("Only the user who started this pending selection can cancel it.");
            return ok();
          }
          await clearPendingDisambiguation(db, chatId);
          await reply("Pending selection cancelled.");
          return ok();
        }

        if (PENDING_PASSTHROUGH_COMMANDS.has(command)) {
          // Read-only commands run without disturbing the pending state.
          // Falls through to the gating + dispatch below.
        } else if (PENDING_CLEAR_AND_RUN_COMMANDS.has(command)) {
          if (!canActOnPending(pendingAction, actorUserId)) {
            await reply("Another user has a pending ticker selection in this chat. Ask them to finish or /cancel it first.");
            return ok();
          }
          await clearPendingDisambiguation(db, chatId);
          // Falls through to the gating + dispatch below.
        } else {
          if (pendingAction.actionType === "confirm-bulk") {
            await reply("You have a pending bulk confirmation. Tap Confirm or Cancel on the previous message, or send /cancel to abort.");
            return ok();
          }
          await reply(`You have a pending selection. Reply with the number(s) you want, or use /cancel.

${escapeHtml(formatDisambiguation(pendingAction.ambiguousTicker, pendingAction.candidates))}`);
          return ok();
        }
      }

      if (!parsedCommand) return ok();

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
        if (!proceed) return ok();
      }

      const handler = COMMAND_HANDLERS[parsedCommand.command];
      if (handler) {
        await handler(commandContext, parsedCommand.args);
      } else {
        await reply("Unknown command. Try /help");
      }
    } catch (err) {
      logTelegramEvent({
        message: "command handler failed",
        chatId,
        userId: actorUserId,
        action: "command-dispatch",
        err: err instanceof Error ? err.message : String(err),
      });
      await reply("Something went wrong, please try again.");
    }

    return ok();
  },
);

function isGroupChat(chatType: string): boolean {
  return isGroupChatType(chatType);
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
    const member = await getCachedChatMember(db, botToken, chatId, actorUserId);
    if (member && (member.status === "creator" || member.status === "administrator")) {
      return true;
    }
  }

  const admins = await getCachedChatAdministrators(db, botToken, chatId);
  const mentions = admins ? formatAdministratorMentions(admins) : "";
  const adminLine = mentions ? ` Admins here: ${mentions}.` : "";
  await reply(
    escapeHtml(
      `Only group admins can change alert settings (${command}).${adminLine}`,
    ),
  );
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
  return pending.initiatorUserId == null || pending.initiatorUserId === actorUserId;
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
  if (pending.actionType === "confirm-bulk") {
    // confirm-bulk uses inline buttons; plain text replies are handled upstream.
    return;
  }
  const selectedIndices = parseDisambiguationReply(text, pending.candidates.length);
  if (!selectedIndices) {
    const reminder = [
      'Reply with the number(s) you want, e.g. "1" or "1,2".',
      "Use /cancel to abandon this selection.",
      formatDisambiguation(pending.ambiguousTicker, pending.candidates),
    ].join("\n\n");
    await replyToChat(chatId, escapeHtml(reminder), botToken);
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
  chatId: string,
  message: string,
  botToken: string,
  options: { replyMarkup?: unknown } = {},
): Promise<void> {
  const chunks = splitMessage(message);
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    // Only attach the reply markup to the last chunk so a multi-part message
    // does not produce multiple inline keyboards.
    const isLastChunk = i === chunks.length - 1;
    const result = await sendToChat(chatId, chunk, botToken, {
      disableWebPagePreview: true,
      ...(isLastChunk && options.replyMarkup != null ? { replyMarkup: options.replyMarkup } : {}),
    });
    if (!result.ok) {
      logTelegramEvent({
        level: "warn",
        message: "reply send failed",
        chatId,
        action: "reply",
        errorClass: result.errorClass ?? "unknown",
        statusCode: result.statusCode,
      });
      if (result.errorClass === "rate_limit") return;
    }
  }
}
