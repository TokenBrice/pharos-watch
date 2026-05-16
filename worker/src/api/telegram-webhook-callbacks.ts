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

import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
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
import {
  recordTelegramUsageEvent,
  type TelegramUsageEventType,
} from "../lib/telegram-usage-analytics";
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

/**
 * Envelope shared by every mutating callback handler:
 *   1. Validate the parsed callback data; if invalid, ack with "Action not
 *      recognized." (or a custom toast) and bail without touching D1.
 *   2. Optionally gate on group-admin status.
 *   3. Run the D1 write inside a try/catch:
 *      - success → record a `recordTelegramUsageEvent("...success")` row and
 *        ack with `successText`.
 *      - failure → `logTelegramEvent`, record `recordTelegramUsageEvent(
 *        "...failure", failureClass: "d1_write_failed")`, ack `failureText`.
 *
 * Per-handler bodies shrink to: validate → write → success text.
 *
 * Outliers that don't fit the envelope (read-only callbacks, callbacks with
 * post-success follow-up messages, callbacks with their own state machine)
 * stay as bespoke handlers.
 */
async function runCallbackMutation<TValid>(params: {
  db: D1Database;
  botToken: string;
  cb: TelegramCallbackQuery;
  chatId: string;
  /** Return the parsed/validated payload, or `null` to short-circuit with `invalidText`. */
  validate: () => TValid | null;
  /** If true, gate the write on `requireAdminForMutatingCallback`. */
  requireAdmin?: boolean;
  /** Telemetry rows + log envelope. */
  eventType: TelegramUsageEventType;
  actionDetail: string;
  /** `action` field used by `logTelegramEvent` on failure. */
  logAction: string;
  /** First-line message field used by `logTelegramEvent` on failure. */
  logMessage: string;
  /** Outcome label on the success row (defaults to "success"). */
  successOutcome?: string;
  /** D1 write. */
  write: (validated: TValid) => Promise<void>;
  /** Toast text on success. */
  successText: string | ((validated: TValid) => string);
  /** Toast text when validation fails (defaults to "Action not recognized."). */
  invalidText?: string;
  /** Toast text when the D1 write throws. */
  failureText: string;
}): Promise<void> {
  const validated = params.validate();
  if (validated == null) {
    await answerCallbackQuery(params.cb.id, params.botToken, {
      text: params.invalidText ?? "Action not recognized.",
    });
    return;
  }
  if (
    params.requireAdmin &&
    !(await requireAdminForMutatingCallback(
      params.db,
      params.botToken,
      params.cb,
      params.chatId,
    ))
  ) {
    return;
  }
  try {
    await params.write(validated);
  } catch (err) {
    logTelegramEvent({
      message: params.logMessage,
      chatId: params.chatId,
      userId: params.cb.from?.id ?? null,
      action: params.logAction,
      err: err instanceof Error ? err.message : String(err),
    });
    await recordTelegramUsageEvent(params.db, {
      eventType: params.eventType,
      actionDetail: params.actionDetail,
      outcome: "failure",
      failureClass: "d1_write_failed",
    });
    await answerCallbackQuery(params.cb.id, params.botToken, { text: params.failureText });
    return;
  }
  await recordTelegramUsageEvent(params.db, {
    eventType: params.eventType,
    actionDetail: params.actionDetail,
    outcome: params.successOutcome ?? "success",
  });
  const text =
    typeof params.successText === "function"
      ? params.successText(validated)
      : params.successText;
  await answerCallbackQuery(params.cb.id, params.botToken, { text });
}

/**
 * Envelope for read-only coin callbacks (`status:<id>`, `why:<id>`,
 * `coverage:<id>`) that share the same shape:
 *   1. Validate `<id>` against the tracked allowlist; bail with "Action not
 *      recognized." otherwise.
 *   2. Run a `send` callback that posts the card (may throw — the ack still
 *      fires in the `finally`, see P1.16).
 *   3. Ack with a fixed "X sent." toast.
 */
async function runReadOnlyCoinCallback(params: {
  botToken: string;
  cb: TelegramCallbackQuery;
  parsed: ParsedCallbackData;
  send: (id: string, isPrivateChat: boolean) => Promise<void>;
  ackText: string;
}): Promise<void> {
  const { arg, parts } = params.parsed;
  if (!hasExactParts(parts, 2) || !isKnownStablecoinId(arg)) {
    await answerCallbackQuery(params.cb.id, params.botToken, { text: "Action not recognized." });
    return;
  }
  const isPrivateChat = callbackChatType(params.cb) === "private";
  try {
    await params.send(arg, isPrivateChat);
  } finally {
    await answerCallbackQuery(params.cb.id, params.botToken, { text: params.ackText });
  }
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from?: { id?: number; username?: string };
  message?: { chat?: { id?: number; type?: string }; message_id?: number };
}

/**
 * Context passed to every `CallbackActionHandler.run`. The dispatcher resolves
 * `chatId` and validates `parsed.action` against the allowlist before dispatch,
 * so handlers can rely on both being well-formed.
 */
interface CallbackContext {
  db: D1Database;
  botToken: string;
  cb: TelegramCallbackQuery;
  chatId: string;
  parsed: ParsedCallbackData<CallbackAction>;
}

/**
 * Registry-driven dispatch for `callback_query` taps. Each handler owns its own
 * argument validation, optional admin gating, and ack flow. The dispatcher only
 * resolves the chat id, validates `action` against the allowlist, and delegates.
 */
interface CallbackActionHandler {
  readonly action: CallbackAction;
  readonly run: (ctx: CallbackContext) => Promise<void>;
}

const CALLBACK_ACTION_HANDLERS: Record<CallbackAction, CallbackActionHandler> = {
  snooze: {
    action: "snooze",
    run: ({ db, botToken, cb, chatId, parsed }) =>
      handleChatSnoozeCallback(db, botToken, cb, chatId, parsed),
  },
  coinsnooze: {
    action: "coinsnooze",
    run: ({ db, botToken, cb, chatId, parsed }) =>
      handleCoinSnoozeCallback(db, botToken, cb, chatId, parsed),
  },
  status: {
    action: "status",
    run: ({ db, botToken, cb, chatId, parsed }) =>
      handleStatusCallback(db, botToken, cb, chatId, parsed),
  },
  why: {
    action: "why",
    run: ({ db, botToken, cb, chatId, parsed }) =>
      handleWhyCallback(db, botToken, cb, chatId, parsed),
  },
  coverage: {
    action: "coverage",
    run: ({ db, botToken, cb, chatId, parsed }) =>
      handleCoverageCallback(db, botToken, cb, chatId, parsed),
  },
  quicksub: {
    action: "quicksub",
    run: ({ db, botToken, cb, chatId, parsed }) =>
      handleQuickSubCallback(db, botToken, cb, chatId, parsed),
  },
  depegstep: {
    action: "depegstep",
    run: ({ db, botToken, cb, chatId, parsed }) =>
      handleDepegStepCallback(db, botToken, cb, chatId, parsed),
  },
  safetydown: {
    action: "safetydown",
    run: ({ db, botToken, cb, chatId, parsed }) =>
      handleSafetyDownCallback(db, botToken, cb, chatId, parsed),
  },
  confirm: {
    action: "confirm",
    run: ({ db, botToken, cb, chatId, parsed }) =>
      handleBulkActionCallback(db, botToken, cb, chatId, parsed),
  },
  cancel: {
    action: "cancel",
    run: ({ db, botToken, cb, chatId, parsed }) =>
      handleBulkActionCallback(db, botToken, cb, chatId, parsed),
  },
  manage: {
    action: "manage",
    run: ({ db, botToken, cb, parsed }) =>
      handleManageActionCallback(db, botToken, cb, parsed),
  },
  unsub: {
    action: "unsub",
    run: ({ db, botToken, cb, parsed }) =>
      handleUnsubscribeActionCallback(db, botToken, cb, parsed),
  },
  select: {
    action: "select",
    run: ({ db, botToken, cb, chatId, parsed }) =>
      handleSelectDisambiguationCallback(db, botToken, cb, chatId, { ...parsed, action: "select" }),
  },
  help: {
    action: "help",
    run: ({ db, botToken, cb, chatId, parsed }) =>
      handleHelpActionCallback(db, botToken, cb, chatId, { ...parsed, action: "help" }),
  },
  tz: {
    action: "tz",
    run: ({ db, botToken, cb, chatId, parsed }) =>
      handleTimezoneCallback(db, botToken, cb, chatId, parsed),
  },
  // `settings` is short-circuited before the registry lookup; the entry here
  // keeps the Record exhaustive over CallbackAction and is unreachable in
  // practice.
  settings: {
    action: "settings",
    run: async () => undefined,
  },
};

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
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }

  const knownParsed: ParsedCallbackData<CallbackAction> = { ...parsed, action };
  const handler = CALLBACK_ACTION_HANDLERS[knownParsed.action];
  await handler.run({ db, botToken, cb, chatId, parsed: knownParsed });
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
  // Sequence DB write BEFORE the ack so the toast reflects actual outcome.
  // A concurrent Promise.all would leave the ack in-flight if the write
  // rejects, and the Workers runtime can cancel the pending fetch once the
  // handler throws, producing silent snooze failures from the user's POV.
  await runCallbackMutation<SnoozeArg>({
    db,
    botToken,
    cb,
    chatId,
    validate: () =>
      hasExactParts(parsed.parts, 2) && isSnoozeArg(parsed.arg) ? parsed.arg : null,
    requireAdmin: true,
    eventType: "snooze_change",
    actionDetail: "chat",
    logAction: "snooze",
    logMessage: "snooze write failed",
    successOutcome: "set",
    write: async (arg) =>
      setSubscriberSnooze(db, chatId, callbackUsername(cb), unixNow() + SNOOZE_SECONDS[arg]),
    successText: (arg) => `Snoozed for ${arg}. Use /list to verify or tap a longer window.`,
    failureText: "Could not save snooze. Please try again.",
  });
}

async function handleCoinSnoozeCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  await runCallbackMutation<{ id: string; duration: SnoozeArg }>({
    db,
    botToken,
    cb,
    chatId,
    validate: () => {
      const durationToken = parsed.parts[2];
      if (
        !hasExactParts(parsed.parts, 3) ||
        !isKnownStablecoinId(parsed.arg) ||
        !isSnoozeArg(durationToken)
      ) {
        return null;
      }
      return { id: parsed.arg, duration: durationToken };
    },
    requireAdmin: true,
    eventType: "snooze_change",
    actionDetail: "coin",
    logAction: "coinsnooze",
    logMessage: "coinsnooze write failed",
    successOutcome: "set",
    write: async ({ id, duration }) =>
      setSubscriptionSnooze(db, chatId, id, unixNow() + SNOOZE_SECONDS[duration]),
    successText: ({ id, duration }) =>
      `Snoozed ${TRACKED_META_BY_ID.get(id)?.symbol ?? id} for ${duration}.`,
    failureText: "Could not save snooze. Please try again.",
  });
}

async function handleStatusCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  await runReadOnlyCoinCallback({
    botToken,
    cb,
    parsed,
    ackText: "Status sent.",
    send: async (id, isPrivateChat) => {
      const status = await loadStatusForCoin(db, id);
      const symbol = TRACKED_META_BY_ID.get(id)?.symbol ?? id;
      await sendAuditedTelegramReply(db, chatId, buildStatusMessage(symbol, status), botToken, {
        replyMarkup: buildStatusDiscoveryKeyboard(id, { includeMiniAppButton: isPrivateChat }),
        actionDetail: "callback_status",
      });
    },
  });
}

async function handleWhyCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  await runReadOnlyCoinCallback({
    botToken,
    cb,
    parsed,
    ackText: "Why sent.",
    send: async (id, isPrivateChat) => {
      const message = await buildWhyMessage(db, id);
      await sendAuditedTelegramReply(db, chatId, message, botToken, {
        replyMarkup: isPrivateChat
          ? buildStatusDiscoveryKeyboard(id, {
              includeMiniAppButton: true,
              miniAppPayload: formatWhyPayload(id),
            })
          : undefined,
        actionDetail: "callback_why",
      });
    },
  });
}

async function handleCoverageCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  await runReadOnlyCoinCallback({
    botToken,
    cb,
    parsed,
    ackText: "Coverage sent.",
    send: async (id, isPrivateChat) => {
      const status = await loadStatusForCoin(db, id);
      const symbol = TRACKED_META_BY_ID.get(id)?.symbol ?? id;
      await sendAuditedTelegramReply(db, chatId, buildCoverageMessage(symbol, status), botToken, {
        replyMarkup: isPrivateChat
          ? buildStatusDiscoveryKeyboard(id, {
              includeMiniAppButton: true,
              miniAppPayload: formatCoveragePayload(id),
            })
          : undefined,
        actionDetail: "callback_coverage",
      });
    },
  });
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
  await runCallbackMutation<{ id: string; step: number }>({
    db,
    botToken,
    cb,
    chatId,
    validate: () => {
      const step = Number(parsed.parts[2]);
      if (
        !hasExactParts(parsed.parts, 3) ||
        !isKnownStablecoinId(parsed.arg) ||
        !isDepegStepValue(step)
      ) {
        return null;
      }
      return { id: parsed.arg, step };
    },
    requireAdmin: true,
    eventType: "subscribe",
    actionDetail: "depegstep",
    logAction: "depegstep",
    logMessage: "depegstep callback write failed",
    write: async ({ id, step }) => {
      const prepared = prepareCoinSettingStatements(
        db,
        chatId,
        callbackUsername(cb),
        id,
        "ds",
        String(step),
      );
      await batchExecute(db, prepared.statements);
    },
    successText: ({ step }) => `Depeg worsening alerts set to ${step} bps.`,
    failureText: "Could not save setting. Please try again.",
  });
}

async function handleSafetyDownCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  await runCallbackMutation<string>({
    db,
    botToken,
    cb,
    chatId,
    validate: () =>
      hasExactParts(parsed.parts, 2) && isKnownStablecoinId(parsed.arg) ? parsed.arg : null,
    requireAdmin: true,
    eventType: "subscribe",
    actionDetail: "safetydown",
    logAction: "safetydown",
    logMessage: "safetydown callback write failed",
    write: async (id) => {
      const prepared = prepareCoinSettingStatements(
        db,
        chatId,
        callbackUsername(cb),
        id,
        "sm",
        "d",
      );
      await batchExecute(db, prepared.statements);
    },
    successText: "Safety alerts set to downgrades only.",
    failureText: "Could not save setting. Please try again.",
  });
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
