/**
 * callback_query router for inline-keyboard taps.
 *
 * Data format: `action:arg` (≤64 bytes per the Bot API limit).
 * Currently supported:
 *   - `snooze:1h | 4h | 24h` — sets alert_snooze_until_ts on telegram_subscribers
 *   - `coinsnooze:<stablecoinId>:1h | 4h | 24h` — sets alert_snooze_until_ts
 *     on the matching telegram_subscriptions row for per-coin snooze (P1-U10)
 *   - `status:<stablecoinId>` — sends the current one-coin status card
 *   - `depegstep:<stablecoinId>:250` — enables per-coin depeg worsening alerts
 *   - `safetydown:<stablecoinId>` — enables per-coin safety downgrade-only alerts
 *   - `why:<stablecoinId>` — sends the safety Why explainer (P1-U11)
 *   - `coverage:<stablecoinId>` — sends the coverage card (P1-U11)
 *   - `quicksub:<stablecoinId>` — enables DEWS+depeg for one coin (P1-U11)
 *   - `manage:page:N` — re-renders the /list management keyboard at page N (P1-U8)
 *   - `unsub:<stablecoinId>` — removes one coin from the chat's subscriptions (P1-U8)
 *   - `select:<N>` — completes a pending ticker disambiguation selection
 *   - `help:commands` — sends the command reference from a recovery button
 *
 * Unknown action codes receive a visible ack and usage telemetry so the bot
 * stays forward-compatible with future keyboard changes.
 */

import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { formatCoveragePayload, formatWhyPayload } from "@shared/lib/telegram-mini-app-payloads";
import { answerCallbackQuery, editMessage, escapeHtml } from "../lib/telegram";
import { batchExecute } from "../lib/db";
import {
  parseDisambiguationReply,
  type ResolvedCoin,
} from "../lib/telegram-alerts";
import {
  clearPendingDisambiguation,
  forgetSubscriber,
  loadPendingDisambiguation,
  removePresetSubscriptions,
  removeSubscriptions,
  setSubscriberSnooze,
  setSubscriptionSnooze,
  setSubscriberTimezone,
  unsubscribeAll,
  unixNow,
  upsertGlobalAlertTypes,
  upsertPresetSubscriptions,
  upsertSubscriberAndSubscriptions,
} from "./telegram-webhook-store";
import { isValidIanaTimezone } from "../cron/telegram-quiet-hours";
import { loadStatusForCoin } from "./telegram-webhook-status";
import {
  MANAGE_PAGE_SIZE,
  buildMiniAppOnlyKeyboard,
  buildManageWatchlistKeyboard,
  buildManageWatchlistMessage,
  buildStatusDiscoveryKeyboard,
  buildStatusMessage,
} from "./telegram-webhook-messages";
import type { SubscriptionRow } from "./telegram-webhook-shared";
import { buildCoverageMessage, buildWhyMessage } from "./telegram-webhook-insights";
import {
  handleSetupBranch,
  handleSetupCancel,
  handleSetupConfirm,
  handleSetupNext,
  handleSetupTarget,
  handleSetupTypeToggle,
  parseSetupState,
} from "./telegram-webhook-setup";
import { handleSettingsCallback } from "./telegram-webhook-settings";
import { prepareCoinSettingStatements } from "./telegram-webhook-settings-mutations";
import { dedupeCoins, parsePendingDisambiguation } from "./telegram-webhook-parsing";
import {
  HELP_MESSAGE,
  SETUP_PENDING_ACTION_TYPE,
  type ConfirmBulkPayload,
  type PendingAction,
} from "./telegram-webhook-shared";
import { SNOOZE_SECONDS, isDepegStepValue } from "../lib/telegram-constants";
import { logTelegramEvent } from "../lib/telegram-log";
import { recordTelegramUsageEvent } from "../lib/telegram-usage-analytics";
import { requireGroupAdminForCallback } from "./telegram-webhook-auth";
import { sendAuditedTelegramReply } from "./telegram-webhook-replies";
import { makeActionRunner } from "./webhook-commands/action-runner";

// Re-export so any caller importing `SNOOZE_SECONDS` from this module keeps working.
export { SNOOZE_SECONDS };

// Allowlist of known callback action codes. Validated at the top of the
// dispatcher so that an unknown action can never reach a D1 read/write.
// `setup` is handled separately above. `confirm`/`cancel` are used by the
// P0-C1 bulk-confirmation gate (action data `confirm:bulk` / `cancel:bulk`).
const CALLBACK_ACTIONS = [
  "snooze",
  "coinsnooze",
  "status",
  "depegstep",
  "safetydown",
  "why",
  "coverage",
  "quicksub",
  "confirm",
  "cancel",
  "manage",
  "unsub",
  "select",
  "help",
  "settings",
  "tz",
] as const;

type CallbackAction = (typeof CALLBACK_ACTIONS)[number];
type ParsedCallbackData<TAction extends string = string> = {
  action: TAction;
  arg: string | undefined;
  parts: string[];
};

const KNOWN_ACTIONS = new Set<string>(CALLBACK_ACTIONS);

type SnoozeArg = keyof typeof SNOOZE_SECONDS;

function isSnoozeArg(arg: string | undefined): arg is SnoozeArg {
  return arg === "1h" || arg === "4h" || arg === "24h";
}

function isKnownStablecoinId(id: string | undefined): id is string {
  return typeof id === "string" && TRACKED_META_BY_ID.has(id);
}

function parseCallbackData(data: string): ParsedCallbackData {
  const parts = data.split(":");
  return { action: parts[0] ?? "", arg: parts[1], parts };
}

function hasExactParts(parts: readonly string[], expected: number): boolean {
  return parts.length === expected && parts.every((part) => part.length > 0);
}

function callbackActorUserId(cb: TelegramCallbackQuery): string | null {
  return cb.from?.id != null ? String(cb.from.id) : null;
}

function callbackChatType(cb: TelegramCallbackQuery): string {
  return cb.message?.chat?.type ?? "private";
}

function callbackUsername(cb: TelegramCallbackQuery): string | null {
  const chatType = callbackChatType(cb);
  return chatType === "group" || chatType === "supergroup" ? null : cb.from?.username ?? null;
}

function isKnownCallbackAction(action: string): action is CallbackAction {
  return KNOWN_ACTIONS.has(action);
}

async function requireAdminForMutatingCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  denialText: string = "Only group admins can change alert settings.",
): Promise<boolean> {
  const allowed = await requireGroupAdminForCallback(
    db,
    botToken,
    cb.id,
    chatId,
    callbackChatType(cb),
    callbackActorUserId(cb),
    denialText,
  );
  if (!allowed) {
    await recordTelegramUsageEvent(db, {
      eventType: "group_admin_denial",
      actionDetail: cb.data?.split(":")[0] ?? "callback",
      outcome: "denied",
    });
  }
  return allowed;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from?: { id?: number; username?: string };
  message?: { chat?: { id?: number; type?: string }; message_id?: number };
}

export async function handleCallbackQuery(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
): Promise<void> {
  const chatId = cb.message?.chat?.id?.toString();
  if (!chatId) {
    await answerCallbackQuery(cb.id, botToken);
    return;
  }

  const parsed = parseCallbackData(cb.data ?? "");

  if (parsed.action === "setup") {
    await handleSetupCallback(db, botToken, cb, chatId, parsed);
    return;
  }

  if (parsed.action === "settings") {
    await handleSettingsInlineCallback(db, botToken, cb, chatId, parsed);
    return;
  }

  // Reject unknown actions before any handler can touch D1. Per-action arg
  // validation (isSnoozeArg, isKnownStablecoinId, ...) still runs below.
  const action = parsed.action;
  if (!isKnownCallbackAction(action)) {
    await recordTelegramUsageEvent(db, {
      eventType: "unknown_command",
      actionDetail: `callback:${action || "unknown"}`,
      outcome: "unknown",
    });
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }

  const knownParsed: ParsedCallbackData<CallbackAction> = { ...parsed, action };

  switch (knownParsed.action) {
    case "snooze":
      await handleChatSnoozeCallback(db, botToken, cb, chatId, knownParsed);
      return;
    case "coinsnooze":
      await handleCoinSnoozeCallback(db, botToken, cb, chatId, knownParsed);
      return;
    case "status":
      await handleStatusCallback(db, botToken, cb, chatId, knownParsed);
      return;
    case "why":
      await handleWhyCallback(db, botToken, cb, chatId, knownParsed);
      return;
    case "coverage":
      await handleCoverageCallback(db, botToken, cb, chatId, knownParsed);
      return;
    case "quicksub":
      await handleQuickSubCallback(db, botToken, cb, chatId, knownParsed);
      return;
    case "depegstep":
      await handleDepegStepCallback(db, botToken, cb, chatId, knownParsed);
      return;
    case "safetydown":
      await handleSafetyDownCallback(db, botToken, cb, chatId, knownParsed);
      return;
    case "confirm":
    case "cancel":
      await handleBulkActionCallback(db, botToken, cb, chatId, knownParsed);
      return;
    case "manage":
      await handleManageActionCallback(db, botToken, cb, knownParsed);
      return;
    case "unsub":
      await handleUnsubscribeActionCallback(db, botToken, cb, knownParsed);
      return;
    case "select":
      await handleSelectDisambiguationCallback(db, botToken, cb, chatId, { ...knownParsed, action: "select" });
      return;
    case "help":
      await handleHelpActionCallback(db, botToken, cb, chatId, { ...knownParsed, action: "help" });
      return;
    case "tz":
      await handleTimezoneCallback(db, botToken, cb, chatId, knownParsed);
      return;
    case "settings":
      // Settings are handled before the allowlist check, but keep the switch
      // exhaustive for CallbackAction.
      return;
  }
}

async function handleHelpActionCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData<"help">,
): Promise<void> {
  if (parsed.arg !== "commands" || !hasExactParts(parsed.parts, 2)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  await sendAuditedTelegramReply(db, chatId, HELP_MESSAGE, botToken, {
    actionDetail: "callback_help",
  });
  await answerCallbackQuery(cb.id, botToken, { text: "Command reference sent." });
}

async function handleSelectDisambiguationCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData<"select">,
): Promise<void> {
  if (!hasExactParts(parsed.parts, 2)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  const pendingRow = await loadPendingDisambiguation(db, chatId);
  if (!pendingRow || unixNow() >= pendingRow.expires_at) {
    if (pendingRow) await clearPendingDisambiguation(db, chatId);
    await answerCallbackQuery(cb.id, botToken, { text: "Selection expired. Re-run the command." });
    return;
  }
  const pendingAction = parsePendingDisambiguation(pendingRow);
  if (!pendingAction || pendingAction.actionType === "confirm-bulk" || pendingAction.actionType === "forget-confirm") {
    await answerCallbackQuery(cb.id, botToken, { text: "No ticker selection is pending." });
    return;
  }
  const actorUserId = callbackActorUserId(cb);
  if (pendingAction.initiatorUserId != null && pendingAction.initiatorUserId !== actorUserId) {
    await answerCallbackQuery(cb.id, botToken, { text: "Only the user who started this selection can choose." });
    return;
  }
  const selectedIndices = parseDisambiguationReply(parsed.arg ?? "", pendingAction.candidates.length);
  if (!selectedIndices) {
    await answerCallbackQuery(cb.id, botToken, { text: "Selection not recognized." });
    return;
  }
  await executePendingDisambiguationSelection(
    db,
    botToken,
    chatId,
    callbackUsername(cb),
    pendingAction,
    selectedIndices,
  );
  await answerCallbackQuery(cb.id, botToken, { text: "Selected." });
}

async function executePendingDisambiguationSelection(
  db: D1Database,
  botToken: string,
  chatId: string,
  username: string | null,
  pending: Exclude<PendingAction, { actionType: "confirm-bulk" | "forget-confirm" }>,
  selectedIndices: readonly number[],
): Promise<void> {
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

async function handleSetupCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  const { arg: subAction = "", parts } = parsed;
  const subArg = parts[2] ?? "";
  const validSetupCallback =
    (subAction === "branch" && hasExactParts(parts, 3) && (subArg === "recommended" || subArg === "custom" || subArg === "skip")) ||
    (subAction === "type-toggle" && hasExactParts(parts, 3)) ||
    (subAction === "target" && hasExactParts(parts, 3)) ||
    ((subAction === "next" || subAction === "confirm" || subAction === "cancel") && parts.length === 2);
  if (!validSetupCallback) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  if (!(await requireAdminForMutatingCallback(db, botToken, cb, chatId))) {
    return;
  }

  const stateRow = await db
    .prepare(
      "SELECT action_type, action_payload, expires_at, initiator_user_id FROM telegram_pending_disambiguation WHERE chat_id = ?",
    )
    .bind(chatId)
    .first<{
      action_type: string | null;
      action_payload: string | null;
      expires_at: number;
      initiator_user_id: string | null;
    }>();
  const isActiveSetup =
    stateRow?.action_type === SETUP_PENDING_ACTION_TYPE && unixNow() < stateRow.expires_at;
  const state = isActiveSetup
    ? parseSetupState(stateRow?.action_payload ?? null, stateRow?.initiator_user_id ?? null)
    : null;
  const context = {
    db,
    botToken,
    chatId,
    actorUserId: callbackActorUserId(cb),
    username: callbackUsername(cb),
  };

  let result: { text: string };
  if (subAction === "branch") {
    result = await handleSetupBranch(context, subArg, state);
  } else if (subAction === "type-toggle") {
    result = await handleSetupTypeToggle(context, subArg, state);
  } else if (subAction === "next") {
    result = await handleSetupNext(context, state);
  } else if (subAction === "target") {
    result = await handleSetupTarget(context, subArg, state);
  } else if (subAction === "confirm") {
    result = await handleSetupConfirm(context, state);
  } else if (subAction === "cancel") {
    result = await handleSetupCancel(context, state);
  } else {
    result = { text: "Action not recognized." };
  }

  await answerCallbackQuery(cb.id, botToken, { text: result.text });
}

async function handleSettingsInlineCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  const { arg: subAction = "", parts } = parsed;
  const subArg = parts.slice(2).join(":");
  const validSettingsCallback =
    (subAction === "home" && parts.length === 2) ||
    ((subAction === "gt" || subAction === "q" || subAction === "o") && parts.length === 3) ||
    (subAction === "sc" && parts.length === 2) ||
    (subAction === "c" && parts.length === 5);
  if (!validSettingsCallback) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  const mutatingSettingsCallback =
    subAction === "gt" ||
    subAction === "q" ||
    subAction === "sc" ||
    subAction === "c";
  if (
    mutatingSettingsCallback &&
    !(await requireAdminForMutatingCallback(db, botToken, cb, chatId))
  ) {
    return;
  }
  await handleSettingsCallback(db, botToken, cb, subAction, subArg);
}

async function handleChatSnoozeCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  const { arg, parts } = parsed;
  if (!hasExactParts(parts, 2) || !isSnoozeArg(arg)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  if (!(await requireAdminForMutatingCallback(db, botToken, cb, chatId))) {
    return;
  }
  const now = unixNow();
  const until = now + SNOOZE_SECONDS[arg];

  // Sequence DB write BEFORE the ack so the toast reflects actual outcome.
  // A concurrent Promise.all would leave the ack in-flight if the write
  // rejects, and the Workers runtime can cancel the pending fetch once the
  // handler throws, producing silent snooze failures from the user's POV.
  try {
    await setSubscriberSnooze(db, chatId, callbackUsername(cb), until);
  } catch (err) {
    logTelegramEvent({
      message: "snooze write failed",
      chatId,
      userId: cb.from?.id ?? null,
      action: "snooze",
      err: err instanceof Error ? err.message : String(err),
    });
    await recordTelegramUsageEvent(db, {
      eventType: "snooze_change",
      actionDetail: "chat",
      outcome: "failure",
      failureClass: "d1_write_failed",
    });
    await answerCallbackQuery(cb.id, botToken, {
      text: "Could not save snooze. Please try again.",
    });
    return;
  }
  await recordTelegramUsageEvent(db, {
    eventType: "snooze_change",
    actionDetail: "chat",
    outcome: "set",
  });
  await answerCallbackQuery(cb.id, botToken, {
    text: `Snoozed for ${arg}. Use /list to verify or tap a longer window.`,
  });
}

async function handleCoinSnoozeCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  const { arg, parts } = parsed;
  const durationToken = parts[2];
  if (!hasExactParts(parts, 3) || !isKnownStablecoinId(arg) || !isSnoozeArg(durationToken)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  if (!(await requireAdminForMutatingCallback(db, botToken, cb, chatId))) {
    return;
  }
  const now = unixNow();
  const until = now + SNOOZE_SECONDS[durationToken];
  try {
    await setSubscriptionSnooze(db, chatId, arg, until);
  } catch (err) {
    logTelegramEvent({
      message: "coinsnooze write failed",
      chatId,
      userId: cb.from?.id ?? null,
      action: "coinsnooze",
      err: err instanceof Error ? err.message : String(err),
    });
    await recordTelegramUsageEvent(db, {
      eventType: "snooze_change",
      actionDetail: "coin",
      outcome: "failure",
      failureClass: "d1_write_failed",
    });
    await answerCallbackQuery(cb.id, botToken, {
      text: "Could not save snooze. Please try again.",
    });
    return;
  }
  const meta = TRACKED_META_BY_ID.get(arg);
  await recordTelegramUsageEvent(db, {
    eventType: "snooze_change",
    actionDetail: "coin",
    outcome: "set",
  });
  await answerCallbackQuery(cb.id, botToken, {
    text: `Snoozed ${meta?.symbol ?? arg} for ${durationToken}.`,
  });
}

async function handleStatusCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  const { arg, parts } = parsed;
  if (!hasExactParts(parts, 2) || !isKnownStablecoinId(arg)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  const meta = TRACKED_META_BY_ID.get(arg);
  const status = await loadStatusForCoin(db, arg);
  const isPrivateChat = callbackChatType(cb) === "private";
  try {
    await sendAuditedTelegramReply(db, chatId, buildStatusMessage(meta?.symbol ?? arg, status), botToken, {
      replyMarkup: buildStatusDiscoveryKeyboard(arg, { includeMiniAppButton: isPrivateChat }),
      actionDetail: "callback_status",
    });
  } finally {
    await answerCallbackQuery(cb.id, botToken, { text: "Status sent." });
  }
}

async function handleWhyCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  const { arg, parts } = parsed;
  if (!hasExactParts(parts, 2) || !isKnownStablecoinId(arg)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  const message = await buildWhyMessage(db, arg);
  const isPrivateChat = callbackChatType(cb) === "private";
  try {
    await sendAuditedTelegramReply(db, chatId, message, botToken, {
      replyMarkup: isPrivateChat
        ? buildStatusDiscoveryKeyboard(arg, {
            includeMiniAppButton: true,
            miniAppPayload: formatWhyPayload(arg),
          })
        : undefined,
      actionDetail: "callback_why",
    });
  } finally {
    await answerCallbackQuery(cb.id, botToken, { text: "Why sent." });
  }
}

async function handleCoverageCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  const { arg, parts } = parsed;
  if (!hasExactParts(parts, 2) || !isKnownStablecoinId(arg)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  const meta = TRACKED_META_BY_ID.get(arg);
  const status = await loadStatusForCoin(db, arg);
  const isPrivateChat = callbackChatType(cb) === "private";
  try {
    await sendAuditedTelegramReply(db, chatId, buildCoverageMessage(meta?.symbol ?? arg, status), botToken, {
      replyMarkup: isPrivateChat
        ? buildStatusDiscoveryKeyboard(arg, {
            includeMiniAppButton: true,
            miniAppPayload: formatCoveragePayload(arg),
          })
        : undefined,
      actionDetail: "callback_coverage",
    });
  } finally {
    await answerCallbackQuery(cb.id, botToken, { text: "Coverage sent." });
  }
}

async function handleQuickSubCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  const { arg, parts } = parsed;
  if (!hasExactParts(parts, 2) || !isKnownStablecoinId(arg)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  const chatType = callbackChatType(cb);
  const isGroup = chatType === "group" || chatType === "supergroup";
  // Group chats route through the same admin gate as the slash commands so
  // a single member cannot rewrite the chat's subscription state.
  if (
    isGroup &&
    !(await requireAdminForMutatingCallback(
      db,
      botToken,
      cb,
      chatId,
      "Only group admins can subscribe.",
    ))
  ) {
    return;
  }
  const meta = TRACKED_META_BY_ID.get(arg);
  try {
    await upsertSubscriberAndSubscriptions(
      db,
      chatId,
      isGroup ? null : cb.from?.username ?? null,
      new Set(["dews", "depeg"]),
      [arg],
    );
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: "quicksub",
      outcome: "success",
    });
  } catch (err) {
    console.error("[telegram-webhook] quicksub write failed:", err);
    await answerCallbackQuery(cb.id, botToken, {
      text: "Could not save subscription. Please try again.",
    });
    return;
  }
  try {
    if (chatType === "private") {
      await sendAuditedTelegramReply(
        db,
        chatId,
        `Subscribed to DEWS + depeg for ${meta?.symbol ?? arg}.`,
        botToken,
        {
          actionDetail: "callback_quicksub",
          replyMarkup: buildMiniAppOnlyKeyboard("Open in app", `coin_${arg}`),
        },
      );
    }
  } finally {
    await answerCallbackQuery(cb.id, botToken, {
      text: `Subscribed to DEWS + depeg for ${meta?.symbol ?? arg}.`,
    });
  }
}

async function handleDepegStepCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  const { arg, parts } = parsed;
  const step = Number(parts[2]);
  if (!hasExactParts(parts, 3) || !isKnownStablecoinId(arg) || !isDepegStepValue(step)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  if (!(await requireAdminForMutatingCallback(db, botToken, cb, chatId))) {
    return;
  }
  try {
    const prepared = prepareCoinSettingStatements(db, chatId, callbackUsername(cb), arg, "ds", String(step));
    await batchExecute(db, prepared.statements);
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: "depegstep",
      outcome: "success",
    });
    await answerCallbackQuery(cb.id, botToken, { text: `Depeg worsening alerts set to ${step} bps.` });
  } catch (err) {
    logTelegramEvent({
      message: "depegstep callback write failed",
      chatId,
      userId: cb.from?.id ?? null,
      action: "depegstep",
      err: err instanceof Error ? err.message : String(err),
    });
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: "depegstep",
      outcome: "failure",
      failureClass: "d1_write_failed",
    });
    await answerCallbackQuery(cb.id, botToken, {
      text: "Could not save setting. Please try again.",
    });
  }
}

async function handleSafetyDownCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  const { arg, parts } = parsed;
  if (!hasExactParts(parts, 2) || !isKnownStablecoinId(arg)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  if (!(await requireAdminForMutatingCallback(db, botToken, cb, chatId))) {
    return;
  }
  try {
    const prepared = prepareCoinSettingStatements(db, chatId, callbackUsername(cb), arg, "sm", "d");
    await batchExecute(db, prepared.statements);
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: "safetydown",
      outcome: "success",
    });
    await answerCallbackQuery(cb.id, botToken, { text: "Safety alerts set to downgrades only." });
  } catch (err) {
    logTelegramEvent({
      message: "safetydown callback write failed",
      chatId,
      userId: cb.from?.id ?? null,
      action: "safetydown",
      err: err instanceof Error ? err.message : String(err),
    });
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: "safetydown",
      outcome: "failure",
      failureClass: "d1_write_failed",
    });
    await answerCallbackQuery(cb.id, botToken, {
      text: "Could not save setting. Please try again.",
    });
  }
}

async function handleBulkActionCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  if (
    (parsed.action !== "confirm" && parsed.action !== "cancel") ||
    !hasExactParts(parsed.parts, 2) ||
    (parsed.arg !== "bulk" && parsed.arg !== "forget")
  ) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  if (parsed.arg === "forget") {
    // /forget is private-chat-only; the command handler enforces that on the
    // outgoing side, but defend in depth in case the keyboard leaks elsewhere.
    if (callbackChatType(cb) !== "private") {
      await answerCallbackQuery(cb.id, botToken, { text: "Open a private chat with PharosWatchBot." });
      return;
    }
    await handleForgetConfirmCallback(db, botToken, cb, parsed.action);
    return;
  }
  if (!(await requireAdminForMutatingCallback(db, botToken, cb, chatId))) {
    return;
  }
  await handleBulkConfirmCallback(db, botToken, cb, parsed.action);
}

async function handleManageActionCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  parsed: ParsedCallbackData,
): Promise<void> {
  if (!hasExactParts(parsed.parts, 3) || parsed.arg !== "page") {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  await handleManagePage(db, botToken, cb);
}

async function handleUnsubscribeActionCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  parsed: ParsedCallbackData,
): Promise<void> {
  if (!hasExactParts(parsed.parts, 2) || !isKnownStablecoinId(parsed.arg)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  await handleManageUnsub(db, botToken, cb, parsed.arg);
}

async function handleTimezoneCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  // Zone strings never legitimately contain `:` (IANA names use `/`), but use
  // a slice instead of split to stay forgiving if Telegram ever introduces
  // multi-segment callback payloads.
  const zone = parsed.parts[1] ?? "";
  if (!hasExactParts(parsed.parts, 2) || !isValidIanaTimezone(zone)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Unknown timezone." });
    return;
  }
  const chatType = callbackChatType(cb);
  const isGroup = chatType === "group" || chatType === "supergroup";
  if (
    isGroup &&
    !(await requireAdminForMutatingCallback(
      db,
      botToken,
      cb,
      chatId,
      "Only group admins can change timezone.",
    ))
  ) {
    return;
  }
  try {
    await setSubscriberTimezone(db, chatId, isGroup ? null : cb.from?.username ?? null, zone);
    await recordTelegramUsageEvent(db, {
      eventType: "timezone_change",
      actionDetail: "quick_pick",
      outcome: "set",
    });
  } catch (err) {
    logTelegramEvent({
      message: "timezone write failed",
      chatId,
      userId: cb.from?.id ?? null,
      action: "tz",
      err: err instanceof Error ? err.message : String(err),
    });
    await answerCallbackQuery(cb.id, botToken, {
      text: "Could not save timezone. Please try again.",
    });
    return;
  }
  const messageId = cb.message?.message_id;
  if (messageId != null) {
    await editMessage(
      chatId,
      messageId,
      [
        `Current timezone: ${escapeHtml(zone)}.`,
        "",
        "Quiet hours from /mute will now be interpreted in this zone.",
      ].join("\n"),
      botToken,
      { disableWebPagePreview: true },
    );
  }
  await answerCallbackQuery(cb.id, botToken, { text: `Timezone set to ${zone}.` });
}

async function loadChatSubscriptions(db: D1Database, chatId: string): Promise<SubscriptionRow[]> {
  const result = await db
    .prepare(
      `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch,
              dews_min_band, safety_mode, depeg_worsening_bps_step, alert_snooze_until_ts
         FROM telegram_subscriptions
        WHERE chat_id = ?
        ORDER BY stablecoin_id`,
    )
    .bind(chatId)
    .all<SubscriptionRow>();
  return result.results ?? [];
}

async function renderManagePage(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  requestedPage: number,
  ackText: string,
): Promise<void> {
  const subscriptions = await loadChatSubscriptions(db, chatId);
  const totalPages = Math.max(1, Math.ceil(subscriptions.length / MANAGE_PAGE_SIZE));
  const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
  const messageId = cb.message?.message_id;
  const text = buildManageWatchlistMessage(subscriptions, page);
  const replyMarkup =
    subscriptions.length === 0 ? undefined : buildManageWatchlistKeyboard(subscriptions, page);

  if (messageId != null) {
    const edited = await editMessage(chatId, messageId, text, botToken, {
      disableWebPagePreview: true,
      replyMarkup,
    });
    if (edited) {
      await answerCallbackQuery(cb.id, botToken, { text: ackText });
      return;
    }
  }
  {
    await sendAuditedTelegramReply(db, chatId, text, botToken, {
      replyMarkup,
      actionDetail: "callback_manage",
    });
  }
  await answerCallbackQuery(cb.id, botToken, { text: ackText });
}

async function handleManagePage(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
): Promise<void> {
  const chatId = cb.message?.chat?.id?.toString();
  if (!chatId) {
    await answerCallbackQuery(cb.id, botToken);
    return;
  }
  const pageRaw = (cb.data ?? "").split(":")[2];
  const page = Number(pageRaw);
  if (!Number.isInteger(page) || page < 0) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  await renderManagePage(db, botToken, cb, chatId, page, "");
}

async function handleManageUnsub(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  stablecoinId: string,
): Promise<void> {
  const chatId = cb.message?.chat?.id?.toString();
  if (!chatId) {
    await answerCallbackQuery(cb.id, botToken);
    return;
  }

  // Apply the same admin gate used by /unsubscribe so a single group member
  // cannot remove subscriptions out from under the rest of the chat.
  const chatType = callbackChatType(cb);
  const isGroup = chatType === "group" || chatType === "supergroup";
  if (
    isGroup &&
    !(await requireAdminForMutatingCallback(
      db,
      botToken,
      cb,
      chatId,
      "Only group admins can unsubscribe.",
    ))
  ) {
    return;
  }

  // Determine the current page from the callback message keyboard so we can
  // re-render at the same page after deletion. Fall back to page 0 if we
  // cannot infer it (e.g. message context missing).
  const currentPage = inferCurrentManagePage(cb);

  try {
    await removeSubscriptions(db, chatId, [stablecoinId]);
    await recordTelegramUsageEvent(db, {
      eventType: "unsubscribe",
      actionDetail: "callback_unsub",
      outcome: "success",
    });
  } catch (err) {
    logTelegramEvent({
      message: "unsub callback write failed",
      chatId,
      userId: cb.from?.id ?? null,
      action: "unsub",
      err: err instanceof Error ? err.message : String(err),
    });
    await recordTelegramUsageEvent(db, {
      eventType: "unsubscribe",
      actionDetail: "callback_unsub",
      outcome: "failure",
      failureClass: "d1_write_failed",
    });
    await answerCallbackQuery(cb.id, botToken, {
      text: "Could not remove subscription. Please try again.",
    });
    return;
  }

  const subscriptions = await loadChatSubscriptions(db, chatId);
  const totalPages = Math.max(1, Math.ceil(subscriptions.length / MANAGE_PAGE_SIZE));
  // If the page we were viewing is now empty (the last row on a tail page was
  // removed), shift one page up so the user sees the remaining items.
  const nextPage = Math.min(currentPage, totalPages - 1);
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  const ackText = `Removed ${meta?.symbol ?? stablecoinId}.`;

  const messageId = cb.message?.message_id;
  const text = buildManageWatchlistMessage(subscriptions, Math.max(0, nextPage));
  const replyMarkup =
    subscriptions.length === 0
      ? undefined
      : buildManageWatchlistKeyboard(subscriptions, Math.max(0, nextPage));

  if (messageId != null) {
    const edited = await editMessage(chatId, messageId, text, botToken, {
      disableWebPagePreview: true,
      replyMarkup,
    });
    if (edited) {
      await answerCallbackQuery(cb.id, botToken, { text: ackText });
      return;
    }
  }
  {
    await sendAuditedTelegramReply(db, chatId, text, botToken, {
      replyMarkup,
      actionDetail: "callback_manage",
    });
  }
  await answerCallbackQuery(cb.id, botToken, { text: ackText });
}

// Best-effort: scan the current message's inline keyboard for the latest
// `manage:page:N` callback (Prev/Next buttons) and infer the active page. The
// active page sits between Prev (N-1) and Next (N+1) when both are present;
// at the edges only one nav button exists. Returns 0 when the message has no
// nav row (single-page state).
function inferCurrentManagePage(cb: TelegramCallbackQuery): number {
  const message = cb.message as
    | { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string; text?: string }>> } }
    | undefined;
  const rows = message?.reply_markup?.inline_keyboard ?? [];
  let prev: number | null = null;
  let next: number | null = null;
  for (const row of rows) {
    for (const button of row) {
      const data = button.callback_data;
      if (!data || !data.startsWith("manage:page:")) continue;
      const pageNum = Number(data.split(":")[2]);
      if (!Number.isFinite(pageNum)) continue;
      if (button.text?.includes("Prev")) prev = pageNum;
      else if (button.text?.includes("Next")) next = pageNum;
    }
  }
  if (prev != null) return prev + 1;
  if (next != null) return next - 1;
  return 0;
}

async function handleForgetConfirmCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  action: "confirm" | "cancel",
): Promise<void> {
  const chatId = cb.message?.chat?.id?.toString();
  if (!chatId) {
    await answerCallbackQuery(cb.id, botToken);
    return;
  }

  const pendingRow = await loadPendingDisambiguation(db, chatId);

  if (!pendingRow || unixNow() >= pendingRow.expires_at) {
    if (pendingRow) {
      await clearPendingDisambiguation(db, chatId);
    }
    await answerCallbackQuery(cb.id, botToken, { text: "This confirmation has expired. Re-run /forget." });
    return;
  }

  const pendingAction = parsePendingDisambiguation(pendingRow);
  if (!pendingAction || pendingAction.actionType !== "forget-confirm") {
    await answerCallbackQuery(cb.id, botToken, { text: "No forget confirmation is pending." });
    return;
  }

  const actorUserId = callbackActorUserId(cb);
  if (pendingAction.initiatorUserId != null && pendingAction.initiatorUserId !== actorUserId) {
    await answerCallbackQuery(cb.id, botToken, {
      text: "Only the user who started this confirmation can complete it.",
    });
    return;
  }

  if (action === "cancel") {
    await clearPendingDisambiguation(db, chatId);
    await sendAuditedTelegramReply(db, chatId, "Cancelled.", botToken, {
      actionDetail: "callback_forget",
    });
    await answerCallbackQuery(cb.id, botToken, { text: "Cancelled." });
    return;
  }

  try {
    await forgetSubscriber(db, chatId);
  } catch (err) {
    logTelegramEvent({
      message: "forget execution failed",
      chatId,
      userId: cb.from?.id ?? null,
      action: "forget-confirm",
      err: err instanceof Error ? err.message : String(err),
    });
    await answerCallbackQuery(cb.id, botToken, { text: "Could not delete data. Please try again." });
    return;
  }
  // `forgetSubscriber` already cleared telegram_pending_disambiguation for the
  // chat, so no extra clearPendingDisambiguation call is required here.
  await recordTelegramUsageEvent(db, {
    eventType: "command_forget",
    actionDetail: "command",
    outcome: "success",
  });
  await sendAuditedTelegramReply(
    db,
    chatId,
    "Your subscriber data has been deleted. Use /start to begin again.",
    botToken,
    { actionDetail: "callback_forget" },
  );
  await answerCallbackQuery(cb.id, botToken, { text: "Deleted." });
}

async function handleBulkConfirmCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  action: "confirm" | "cancel",
): Promise<void> {
  const chatId = cb.message?.chat?.id?.toString();
  if (!chatId) {
    await answerCallbackQuery(cb.id, botToken);
    return;
  }

  const pendingRow = await loadPendingDisambiguation(db, chatId);

  if (!pendingRow || unixNow() >= pendingRow.expires_at) {
    if (pendingRow) {
      await clearPendingDisambiguation(db, chatId);
    }
    await answerCallbackQuery(cb.id, botToken, { text: "This confirmation has expired. Re-run the command." });
    return;
  }

  const pendingAction = parsePendingDisambiguation(pendingRow);
  if (!pendingAction || pendingAction.actionType !== "confirm-bulk") {
    await answerCallbackQuery(cb.id, botToken, { text: "No bulk confirmation is pending." });
    return;
  }

  const actorUserId = cb.from?.id != null ? String(cb.from.id) : null;
  if (pendingAction.initiatorUserId != null && pendingAction.initiatorUserId !== actorUserId) {
    await answerCallbackQuery(cb.id, botToken, {
      text: "Only the user who started this confirmation can complete it.",
    });
    return;
  }

  if (action === "cancel") {
    await clearPendingDisambiguation(db, chatId);
    await sendAuditedTelegramReply(db, chatId, "Cancelled.", botToken, {
      actionDetail: "callback_bulk",
    });
    await answerCallbackQuery(cb.id, botToken, { text: "Cancelled." });
    return;
  }

  // Confirm path: execute the deferred action, then clear pending.
  const chatType = cb.message?.chat?.type ?? "private";
  const username = chatType === "group" || chatType === "supergroup" ? null : cb.from?.username ?? null;
  try {
    await executeConfirmedBulk(db, chatId, username, pendingAction.payload);
  } catch (err) {
    logTelegramEvent({
      message: "bulk confirm execution failed",
      chatId,
      userId: cb.from?.id ?? null,
      action: "confirm-bulk",
      err: err instanceof Error ? err.message : String(err),
    });
    await answerCallbackQuery(cb.id, botToken, { text: "Could not apply changes. Please try again." });
    return;
  }
  await clearPendingDisambiguation(db, chatId);
  await sendAuditedTelegramReply(db, chatId, "Confirmed.", botToken, {
    actionDetail: "callback_bulk",
  });
  await answerCallbackQuery(cb.id, botToken, { text: "Applied." });
}

async function executeConfirmedBulk(
  db: D1Database,
  chatId: string,
  username: string | null,
  payload: ConfirmBulkPayload,
): Promise<void> {
  if (payload.kind === "subscribe") {
    const alertTypes = new Set(payload.alertTypes);
    if (payload.subscribeAll) {
      await upsertGlobalAlertTypes(db, chatId, username, alertTypes);
      await recordTelegramUsageEvent(db, {
        eventType: "subscribe",
        actionDetail: "all",
        outcome: "success",
      });
      await recordTelegramUsageEvent(db, {
        eventType: "global_alert_change",
        actionDetail: "bulk_confirm",
        outcome: "opt_in",
      });
      return;
    }
    await upsertSubscriberAndSubscriptions(db, chatId, username, alertTypes, payload.coinIds, {
      depegWorseningBpsStep: payload.depegWorseningBpsStep,
    });
    if (payload.presetIds.length > 0) {
      await upsertPresetSubscriptions(db, chatId, payload.presetIds, alertTypes, {
        depegWorseningBpsStep: payload.depegWorseningBpsStep,
      });
      await recordTelegramUsageEvent(db, {
        eventType: "preset_follow",
        actionDetail: "preset",
        outcome: "success",
      });
    }
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: payload.presetIds.length > 0 ? "preset" : "coin",
      outcome: "success",
    });
    return;
  }

  // unsubscribe
  if (payload.unsubscribeAll) {
    await unsubscribeAll(db, chatId);
    await recordTelegramUsageEvent(db, {
      eventType: "unsubscribe",
      actionDetail: "all",
      outcome: "success",
    });
    await recordTelegramUsageEvent(db, {
      eventType: "global_alert_change",
      actionDetail: "bulk_confirm",
      outcome: "opt_out",
    });
    return;
  }
  await removeSubscriptions(db, chatId, payload.coinIds);
  if (payload.presetIds.length > 0) {
    await removePresetSubscriptions(db, chatId, payload.presetIds);
    await recordTelegramUsageEvent(db, {
      eventType: "preset_unfollow",
      actionDetail: "preset",
      outcome: "success",
    });
  }
  await recordTelegramUsageEvent(db, {
    eventType: "unsubscribe",
    actionDetail: payload.presetIds.length > 0 ? "preset" : "coin",
    outcome: "success",
  });
}
