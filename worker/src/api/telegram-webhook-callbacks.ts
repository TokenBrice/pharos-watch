/**
 * callback_query router for inline-keyboard taps.
 *
 * Data format: `action:arg` (≤64 bytes per the Bot API limit).
 * Currently supported:
 *   - `snooze:1h | 4h | 24h` — sets alert_snooze_until_ts on telegram_subscribers
 *   - `status:<stablecoinId>` — sends the current one-coin status card
 *   - `depegstep:<stablecoinId>:250` — enables per-coin depeg worsening alerts
 *   - `safetydown:<stablecoinId>` — enables per-coin safety downgrade-only alerts
 *
 * Unknown action codes receive a silent ack so the bot stays forward-compatible
 * with future keyboard changes.
 */

import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { answerCallbackQuery, sendToChat } from "../lib/telegram";
import { unixNow } from "./telegram-webhook-store";
import { loadStatusForCoin } from "./telegram-webhook-status";
import { buildStatusMessage } from "./telegram-webhook-messages";
import {
  handleSetupBranch,
  handleSetupCancel,
  handleSetupConfirm,
  handleSetupNext,
  handleSetupTarget,
  handleSetupTypeToggle,
  parseSetupState,
} from "./telegram-webhook-setup";
import { SETUP_PENDING_ACTION_TYPE } from "./telegram-webhook-shared";

const SNOOZE_SECONDS = {
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "24h": 24 * 60 * 60,
} as const;

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
      console.error("[telegram-webhook] snooze write failed:", err);
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
    });
    await answerCallbackQuery(cb.id, botToken, { text: "Status sent." });
    return;
  }

  if (action === "depegstep" && isKnownStablecoinId(arg)) {
    const step = Number((cb.data ?? "").split(":")[2]);
    if (step === 100 || step === 250 || step === 500) {
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

  await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
}
