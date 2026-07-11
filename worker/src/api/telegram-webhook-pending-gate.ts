import { escapeHtml } from "../lib/telegram";
import {
  formatDisambiguation,
  findInvalidDisambiguationToken,
  parseDisambiguationReply,
} from "../lib/telegram-alerts";
import {
  canActOnPendingOwner,
  SETUP_PENDING_ACTION_TYPE,
  type PendingAction,
} from "./telegram-webhook-shared";
import { handleSetupTickerInput, parseSetupState } from "./telegram-webhook-setup";
import { parseCommand, parsePendingDisambiguation } from "./telegram-webhook-parsing";
import {
  clearPendingDisambiguation,
  loadPendingDisambiguation,
  PENDING_OWNERSHIP_CONFLICT_MESSAGE,
} from "./telegram-webhook-store";
import {
  executePendingDisambiguationSelection,
  type PendingSelectionOperationContext,
} from "./telegram-webhook-disambiguation-selection";
import { isGroupChatType } from "./telegram-webhook-auth";
import { sendAuditedTelegramReply } from "./telegram-webhook-replies";
import { createTelegramWebhookIntent } from "./telegram-webhook-effect-fence";
import type { TelegramWebhookOperationIntent } from "./telegram-webhook-store";

export type ParsedTelegramCommand = NonNullable<ReturnType<typeof parseCommand>>;
export type ReplyFn = (message: string) => Promise<void>;

type PendingDisambiguationRow = Awaited<ReturnType<typeof loadPendingDisambiguation>>;
type PendingFlowResult = "continue" | "continue-clear-pending" | "finished";

const MUTATING_PENDING_REPLACEMENT_COMMANDS = new Set([
  "/forget",
  "/mute",
  "/set",
  "/subscribe",
  "/unmutehours",
  "/unsnooze",
  "/unsubscribe",
]);

function mutatesAfterPendingClear(command: ParsedTelegramCommand): boolean {
  return MUTATING_PENDING_REPLACEMENT_COMMANDS.has(command.command)
    || (command.command === "/timezone" && command.args.trim().length > 0)
    || (command.command === "/recap" && /^(?:on|off|time\s+(?:[0-9]|1[0-9]|2[0-3]))$/i.test(command.args.trim()));
}

function normalizedPendingActionType(value: string | null | undefined): string {
  return value && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : "unknown";
}

async function clearPendingWithIntent(
  db: D1Database,
  chatId: string,
  pendingRow: NonNullable<PendingDisambiguationRow>,
  reason: "cancel" | "invalid" | "expired" | "setup-cancel" | "clear-and-run",
  operation?: PendingSelectionOperationContext,
): Promise<void> {
  if (!operation?.planIntent) {
    // Compatibility for direct/unit invocations without a claimed update.
    // Authenticated Telegram updates always supply the atomic fence callbacks.
    await clearPendingDisambiguation(db, chatId);
    return;
  }
  const actionType = normalizedPendingActionType(pendingRow.action_type);
  await operation.planIntent(createTelegramWebhookIntent(`pending:${reason}`, {
    actionType,
    expiresAt: pendingRow.expires_at,
    reason,
  }, "required"));
  if (operation.wasMutationApplied) return;
  const operationStatements = operation.prepareMutationAppliedStatement
    ? [operation.prepareMutationAppliedStatement()]
    : undefined;
  await clearPendingDisambiguation(db, chatId, {
    expected: { actionType: pendingRow.action_type ?? "", expiresAt: pendingRow.expires_at },
    operationStatements,
  });
  if (operationStatements) operation.confirmAtomicMutationApplied?.();
  else await operation.markMutationApplied?.();
}

export async function resumeStoredPendingClearIntent(args: {
  db: D1Database;
  chatId: string;
  intent: TelegramWebhookOperationIntent | null | undefined;
  operation?: PendingSelectionOperationContext;
}): Promise<{ handled: boolean; reply: string | null; continueCommand: boolean }> {
  const { intent, operation } = args;
  const reason = intent?.payload.reason;
  if (
    !intent
    || intent.mutation !== "required"
    || !intent.kind.startsWith("pending:")
    || (reason !== "cancel" && reason !== "setup-cancel" && reason !== "invalid" && reason !== "expired" && reason !== "clear-and-run")
    || typeof intent.payload.actionType !== "string"
    || typeof intent.payload.expiresAt !== "number"
  ) {
    return { handled: false, reply: null, continueCommand: false };
  }
  if (!operation?.wasMutationApplied) {
    const operationStatements = operation?.prepareMutationAppliedStatement
      ? [operation.prepareMutationAppliedStatement()]
      : undefined;
    await clearPendingDisambiguation(args.db, args.chatId, {
      expected: {
        actionType: intent.payload.actionType,
        expiresAt: intent.payload.expiresAt,
      },
      operationStatements,
    });
    if (operationStatements) operation?.confirmAtomicMutationApplied?.();
    else await operation?.markMutationApplied?.();
  }
  const reply = reason === "cancel"
    ? "Pending selection cancelled."
    : reason === "setup-cancel"
      ? "Setup cancelled. Send /start to begin again or /list to view subscriptions."
      : reason === "invalid"
        ? "That pending selection could not be restored. Please rerun the command, or use /help for examples."
        : null;
  return { handled: true, reply, continueCommand: reason === "clear-and-run" };
}

/**
 * Commands that, when issued while a pending disambiguation is active, clear
 * the pending state (after the permission check) and then run through the
 * normal dispatch. All other commands either run as-is or get the pending
 * reminder — see the dispatch loop in `telegram-webhook.ts`.
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
  "/recap",
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

const SETUP_SLASH_TICKER_REPLY_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SETUP_TICKER_COMMAND_ESCAPES = new Set(["/cancel", "/start"]);

export async function handleSetupPendingBeforeDispatch(args: {
  db: D1Database;
  botToken: string;
  chatId: string;
  actorUserId: string | null;
  username: string | null;
  text: string;
  pendingRow: NonNullable<PendingDisambiguationRow>;
  parsedCommand: ParsedTelegramCommand | null;
  reply: ReplyFn;
  operation?: PendingSelectionOperationContext;
}): Promise<PendingFlowResult> {
  const { db, botToken, chatId, actorUserId, username, text, pendingRow, parsedCommand, reply, operation } = args;
  const setupState = parseSetupState(pendingRow.action_payload, pendingRow.initiator_user_id ?? null);
  const setupTickerInput = setupState?.step === "awaiting-ticker"
    ? normalizeSetupTickerInput(text, parsedCommand)
    : null;
  if (setupState && setupState.step === "awaiting-ticker" && setupTickerInput != null) {
    await handleSetupTickerInput(
      {
        db,
        botToken,
        chatId,
        actorUserId,
        username,
        beforeIrreversibleEffect: operation?.beforeIrreversibleEffect,
        planIntent: operation?.planIntent,
        prepareMutationAppliedStatement: operation?.prepareMutationAppliedStatement,
        confirmAtomicMutationApplied: operation?.confirmAtomicMutationApplied,
        storedIntent: operation?.storedIntent,
        wasMutationApplied: operation?.wasMutationApplied,
      },
      setupTickerInput,
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
        await clearPendingWithIntent(db, chatId, pendingRow, "setup-cancel", operation);
        await reply("Setup cancelled. Send /start to begin again or /list to view subscriptions.");
        return "finished";
      }
      if (mutatesAfterPendingClear(parsedCommand)) return "continue-clear-pending";
      await clearPendingWithIntent(db, chatId, pendingRow, "clear-and-run", operation);
      return "continue";
    } else if (!PENDING_PASSTHROUGH_COMMANDS.has(parsedCommand.command)) {
      await reply(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
      return "finished";
    }
  }
  return "continue";
}

function normalizeSetupTickerInput(
  text: string,
  parsedCommand: ParsedTelegramCommand | null,
): string | null {
  if (!parsedCommand) return text;
  if (SETUP_TICKER_COMMAND_ESCAPES.has(parsedCommand.command)) return null;
  const trimmed = text.trim();
  if (!SETUP_SLASH_TICKER_REPLY_PATTERN.test(trimmed)) return null;
  return trimmed.slice(1);
}

export async function handlePendingActionBeforeDispatch(args: {
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
  operation?: PendingSelectionOperationContext;
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
    operation,
  } = args;
  const parsedPending = pendingRow ? parsePendingDisambiguation(pendingRow) : null;
  // This path only runs when the row is not a setup step (see isSetupPending in
  // the caller), so a setup sentinel here means the row was mis-routed; treat it
  // as unrecoverable rather than a live disambiguation action.
  const pendingAction =
    parsedPending && parsedPending.actionType !== SETUP_PENDING_ACTION_TYPE ? parsedPending : null;
  const pendingActive = Boolean(pendingRow && pendingAction && pendingNotExpired);

  if (pendingRow && !pendingAction && pendingNotExpired) {
    if (!parsedCommand) {
      await clearPendingWithIntent(db, chatId, pendingRow, "invalid", operation);
      await reply("That pending selection could not be restored. Please rerun the command, or use /help for examples.");
      return "finished";
    }
  }

  if (pendingRow && !pendingActive) {
    if (!parsedCommand) {
      await clearPendingWithIntent(db, chatId, pendingRow, "expired", operation);
      return "finished";
    }
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
    await handleDisambiguationReply(db, chatId, text, pendingAction, botToken, username, operation);
    return "finished";
  }

  const command = parsedCommand.command;
  if (command === "/cancel") {
    if (!canActOnPending(pendingAction, actorUserId)) {
      await reply("Only the user who started this pending selection can cancel it.");
      return "finished";
    }
    await clearPendingWithIntent(db, chatId, pendingRow!, "cancel", operation);
    await reply("Pending selection cancelled.");
    return "finished";
  }

  if (PENDING_PASSTHROUGH_COMMANDS.has(command) || (command === "/recap" && parsedCommand.args.trim().length === 0)) {
    return "continue";
  }
  if (PENDING_CLEAR_AND_RUN_COMMANDS.has(command)) {
    if (!canActOnPending(pendingAction, actorUserId)) {
      await reply(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
      return "finished";
    }
    if (mutatesAfterPendingClear(parsedCommand)) return "continue-clear-pending";
    await clearPendingWithIntent(db, chatId, pendingRow!, "clear-and-run", operation);
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

function canActOnPending(pending: PendingAction, actorUserId: string | null): boolean {
  return canActOnPendingOwner(pending.initiatorUserId, actorUserId);
}

export { canActOnPendingOwner };

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
  operation?: PendingSelectionOperationContext,
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
  await executePendingDisambiguationSelection(
    db,
    botToken,
    chatId,
    username,
    pending,
    selectedIndices,
    operation,
  );
}
