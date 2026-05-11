/**
 * callback_query router for inline-keyboard taps.
 *
 * Data format: `action:arg` (≤64 bytes per the Bot API limit).
 * Currently supported:
 *   - `snooze:1h | 4h | 24h` — sets alert_snooze_until_ts on telegram_subscribers
 *   - `status:<stablecoinId>` — sends the current one-coin status card
 *   - `depegstep:<stablecoinId>:250` — enables per-coin depeg worsening alerts
 *   - `safetydown:<stablecoinId>` — enables per-coin safety downgrade-only alerts
 *   - `why:<stablecoinId>` — sends the safety Why explainer (P1-U11)
 *   - `coverage:<stablecoinId>` — sends the coverage card (P1-U11)
 *   - `quicksub:<stablecoinId>` — enables DEWS+depeg for one coin (P1-U11)
 *
 * Unknown action codes receive a silent ack so the bot stays forward-compatible
 * with future keyboard changes.
 */

import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { answerCallbackQuery, sendToChat } from "../lib/telegram";
import { getCachedChatMember } from "../lib/telegram-chat-member";
import {
  clearPendingDisambiguation,
  removePresetSubscriptions,
  removeSubscriptions,
  unixNow,
  upsertGlobalAlertTypes,
  upsertPresetSubscriptions,
  upsertSubscriberAndSubscriptions,
} from "./telegram-webhook-store";
import { loadStatusForCoin } from "./telegram-webhook-status";
import {
  buildStatusDiscoveryKeyboard,
  buildStatusMessage,
} from "./telegram-webhook-messages";
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
import { parsePendingDisambiguation } from "./telegram-webhook-parsing";
import {
  SETUP_PENDING_ACTION_TYPE,
  type ConfirmBulkPayload,
  type PendingDisambiguationRow,
} from "./telegram-webhook-shared";
import { SNOOZE_SECONDS, isDepegStepValue } from "../lib/telegram-constants";
import { logTelegramEvent } from "../lib/telegram-log";

// Re-export so any caller importing `SNOOZE_SECONDS` from this module keeps working.
export { SNOOZE_SECONDS };

// Allowlist of known callback action codes. Validated at the top of the
// dispatcher so that an unknown action can never reach a D1 read/write.
// `setup` is handled separately above. `confirm`/`cancel` are used by the
// P0-C1 bulk-confirmation gate (action data `confirm:bulk` / `cancel:bulk`).
const KNOWN_ACTIONS = new Set([
  "snooze",
  "status",
  "depegstep",
  "safetydown",
  "why",
  "coverage",
  "quicksub",
  "confirm",
  "cancel",
]);

type SnoozeArg = keyof typeof SNOOZE_SECONDS;

function isSnoozeArg(arg: string | undefined): arg is SnoozeArg {
  return arg === "1h" || arg === "4h" || arg === "24h";
}

function isKnownStablecoinId(id: string | undefined): id is string {
  return typeof id === "string" && TRACKED_META_BY_ID.has(id);
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

  const data = cb.data ?? "";
  const [action, arg] = data.split(":");

  if (action === "setup") {
    const subAction = arg ?? "";
    const subArg = data.split(":").slice(2).join(":");
    const chatType = cb.message?.chat?.type ?? "private";
    const username = chatType === "group" || chatType === "supergroup" ? null : cb.from?.username ?? null;
    const actorUserId = cb.from?.id != null ? String(cb.from.id) : null;
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

    const context = { db, botToken, chatId, actorUserId, username };
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
    return;
  }

  // Reject unknown actions before any handler can touch D1. Per-action arg
  // validation (isSnoozeArg, isKnownStablecoinId, ...) still runs below.
  if (!KNOWN_ACTIONS.has(action)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }

  if (action === "snooze" && isSnoozeArg(arg)) {
    const now = unixNow();
    const until = now + SNOOZE_SECONDS[arg];
    const chatType = cb.message?.chat?.type ?? "private";
    const username = chatType === "group" || chatType === "supergroup" ? null : cb.from?.username ?? null;

    // Sequence DB write BEFORE the ack so the toast reflects actual outcome.
    // A concurrent Promise.all would leave the ack in-flight if the write
    // rejects, and the Workers runtime can cancel the pending fetch once the
    // handler throws, producing silent snooze failures from the user's POV.
    try {
      await db
        .prepare(
          `INSERT INTO telegram_subscribers (
             chat_id, username,
             alert_dews, alert_depeg, alert_safety, alert_launch,
             global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch,
             quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
             alert_snooze_until_ts,
             created_at, last_active_at
           )
           VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             username = COALESCE(excluded.username, telegram_subscribers.username),
             alert_snooze_until_ts = excluded.alert_snooze_until_ts,
             last_active_at = excluded.last_active_at`,
        )
        .bind(chatId, username, until, now, now)
        .run();
    } catch (err) {
      logTelegramEvent({
        message: "snooze write failed",
        chatId,
        userId: cb.from?.id ?? null,
        action: "snooze",
        err: err instanceof Error ? err.message : String(err),
      });
      await answerCallbackQuery(cb.id, botToken, {
        text: "Could not save snooze. Please try again.",
      });
      return;
    }
    await answerCallbackQuery(cb.id, botToken, {
      text: `Snoozed for ${arg}. Use /list to verify or tap a longer window.`,
    });
    return;
  }

  if (action === "status" && isKnownStablecoinId(arg)) {
    const meta = TRACKED_META_BY_ID.get(arg);
    const status = await loadStatusForCoin(db, arg);
    await sendToChat(chatId, buildStatusMessage(meta?.symbol ?? arg, status), botToken, {
      disableWebPagePreview: true,
      replyMarkup: buildStatusDiscoveryKeyboard(arg),
    });
    await answerCallbackQuery(cb.id, botToken, { text: "Status sent." });
    return;
  }

  if (action === "why" && isKnownStablecoinId(arg)) {
    const message = await buildWhyMessage(db, arg);
    await sendToChat(chatId, message, botToken, { disableWebPagePreview: true });
    await answerCallbackQuery(cb.id, botToken, { text: "Why sent." });
    return;
  }

  if (action === "coverage" && isKnownStablecoinId(arg)) {
    const meta = TRACKED_META_BY_ID.get(arg);
    const status = await loadStatusForCoin(db, arg);
    await sendToChat(chatId, buildCoverageMessage(meta?.symbol ?? arg, status), botToken, {
      disableWebPagePreview: true,
    });
    await answerCallbackQuery(cb.id, botToken, { text: "Coverage sent." });
    return;
  }

  if (action === "quicksub" && isKnownStablecoinId(arg)) {
    const chatType = cb.message?.chat?.type ?? "private";
    const isGroup = chatType === "group" || chatType === "supergroup";
    const actorUserId = cb.from?.id != null ? String(cb.from.id) : null;
    // Group chats route through the same admin gate as the slash commands so
    // a single member cannot rewrite the chat's subscription state.
    if (isGroup) {
      if (!actorUserId) {
        await answerCallbackQuery(cb.id, botToken, { text: "Only group admins can subscribe." });
        return;
      }
      const member = await getCachedChatMember(db, botToken, chatId, actorUserId);
      const isAdmin = member?.status === "creator" || member?.status === "administrator";
      if (!isAdmin) {
        await answerCallbackQuery(cb.id, botToken, { text: "Only group admins can subscribe." });
        return;
      }
    }
    const username = isGroup ? null : cb.from?.username ?? null;
    const meta = TRACKED_META_BY_ID.get(arg);
    try {
      await upsertSubscriberAndSubscriptions(
        db,
        chatId,
        username,
        new Set(["dews", "depeg"]),
        [arg],
      );
    } catch (err) {
      console.error("[telegram-webhook] quicksub write failed:", err);
      await answerCallbackQuery(cb.id, botToken, {
        text: "Could not save subscription. Please try again.",
      });
      return;
    }
    await answerCallbackQuery(cb.id, botToken, {
      text: `Subscribed to DEWS + depeg for ${meta?.symbol ?? arg}.`,
    });
    return;
  }

  if (action === "depegstep" && isKnownStablecoinId(arg)) {
    const step = Number((cb.data ?? "").split(":")[2]);
    if (isDepegStepValue(step)) {
      const now = unixNow();
      await db
        .prepare(
          `INSERT INTO telegram_subscriptions (
             chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, depeg_worsening_bps_step
           )
           VALUES (?, ?, 0, 1, 0, 0, ?)
           ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
             alert_depeg = 1,
             depeg_worsening_bps_step = excluded.depeg_worsening_bps_step`,
        )
        .bind(chatId, arg, step)
        .run();
      await db
        .prepare("UPDATE telegram_subscribers SET last_active_at = ? WHERE chat_id = ?")
        .bind(now, chatId)
        .run();
      await answerCallbackQuery(cb.id, botToken, { text: `Depeg worsening alerts set to ${step} bps.` });
      return;
    }
  }

  if (action === "safetydown" && isKnownStablecoinId(arg)) {
    const now = unixNow();
    await db
      .prepare(
        `INSERT INTO telegram_subscriptions (
           chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, safety_mode
         )
         VALUES (?, ?, 0, 0, 1, 0, 'downgrade-only')
         ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
           alert_safety = 1,
           safety_mode = 'downgrade-only'`,
      )
      .bind(chatId, arg)
      .run();
    await db
      .prepare("UPDATE telegram_subscribers SET last_active_at = ? WHERE chat_id = ?")
      .bind(now, chatId)
      .run();
    await answerCallbackQuery(cb.id, botToken, { text: "Safety alerts set to downgrades only." });
    return;
  }

  if ((action === "confirm" || action === "cancel") && arg === "bulk") {
    await handleBulkConfirmCallback(db, botToken, cb, action);
    return;
  }

  await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
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

  const pendingRow = await db
    .prepare(
      "SELECT action_type, action_payload, alert_types, resolved_ids, ambiguous_ticker, candidates, remaining_tickers, expires_at, initiator_user_id FROM telegram_pending_disambiguation WHERE chat_id = ?",
    )
    .bind(chatId)
    .first<PendingDisambiguationRow>();

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
    await sendToChat(chatId, "Cancelled.", botToken, { disableWebPagePreview: true });
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
  await sendToChat(chatId, "Confirmed.", botToken, { disableWebPagePreview: true });
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
      return;
    }
    await upsertSubscriberAndSubscriptions(db, chatId, username, alertTypes, payload.coinIds, {
      depegWorseningBpsStep: payload.depegWorseningBpsStep,
    });
    if (payload.presetIds.length > 0) {
      await upsertPresetSubscriptions(db, chatId, payload.presetIds, alertTypes, {
        depegWorseningBpsStep: payload.depegWorseningBpsStep,
      });
    }
    return;
  }

  // unsubscribe
  if (payload.unsubscribeAll) {
    const now = unixNow();
    await db.batch([
      db.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?").bind(chatId),
      db.prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?").bind(chatId),
      db
        .prepare(
          `UPDATE telegram_subscribers
            SET alert_dews = 0,
                alert_depeg = 0,
                alert_safety = 0,
                alert_launch = 0,
                global_alert_dews = 0,
                global_alert_depeg = 0,
                global_alert_safety = 0,
                global_alert_launch = 0,
                global_depeg_worsening_bps_step = NULL,
                last_active_at = ?
          WHERE chat_id = ?`,
        )
        .bind(now, chatId),
    ]);
    return;
  }
  await removeSubscriptions(db, chatId, payload.coinIds);
  if (payload.presetIds.length > 0) {
    await removePresetSubscriptions(db, chatId, payload.presetIds);
  }
}
