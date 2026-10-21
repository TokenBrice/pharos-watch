import {
  PENDING_MAX_ATTEMPTS,
  SEND_BATCH_SIZE,
  isTelegramSnoozeActive,
} from "@shared/lib/telegram-delivery-policy";
import { buildInClause, chunkArray, executeAtomicBatch } from "../../lib/db";
import { D1_BATCH_SIZE } from "../../lib/constants";
import { logTelegramEvent } from "../common/log";
import { isQuietHoursActive } from "../common/quiet-hours";
import { recordTelegramDeliveryOutcomes } from "../store/usage-analytics";
import {
  flushChatSuccessResets,
  handleBlockedChat,
} from "../../cron/telegram/delivery/lifecycle";
import {
  pendingBackoffSec,
  readTelegramGlobalBackoff,
  setTelegramGlobalBackoff,
} from "../../cron/telegram/delivery/backoff";
import {
  parseTelegramDeliveryOptions,
  type TelegramDeliveryAudience,
  type TelegramDeliveryState,
  type TelegramJobKind,
} from "./jobs";
import {
  schedulePerChatBatches,
  sendPhotoToChat,
  sendToChat,
  type BatchResult,
  type PreSendBatchResult,
  type SendToChatResult,
} from "./telegram";

/** A row left in `sending` past this claim window ends as `unknown`, never replayed. */
export const TELEGRAM_DELIVERY_CLAIM_TTL_SEC = 10 * 60;
/** Rows claimed per page; a run claims pages until the soft deadline or empty queue. */
const CLAIM_PAGE_SIZE = 100;
/** Distinct chats rate-limited in one wave that we treat as a bot-wide flood. */
const GLOBAL_RATE_LIMIT_MIN_CHATS = 2;

/** Terminal outcomes Telegram can return without a successful delivery. */
const UNKNOWN_ERROR_CLASSES = new Set(["timeout", "network", "unknown"]);

export interface ClaimedTelegramDelivery {
  id: number;
  job_id: string;
  kind: TelegramJobKind;
  chat_id: string;
  seq: number;
  audience: TelegramDeliveryAudience;
  method: "sendMessage" | "sendPhoto";
  body: string | null;
  options_json: string | null;
  coin_ids: string | null;
  attempts: number;
  expires_at: number;
}

export interface TelegramDeliveryDrainResult {
  claimed: number;
  attempted: number;
  sent: number;
  retried: number;
  failed: number;
  blocked: number;
  unknown: number;
  cancelled: number;
  deferred: number;
  blockedChatsDisabled: number;
  /** Distinct chats with at least one Bot API-accepted message. */
  acceptedChats: number;
  globalBackoffUntil: number | null;
  stoppedReason: "empty" | "deadline" | "aborted" | "global-backoff" | null;
}

function emptyTelegramDeliveryDrainResult(): TelegramDeliveryDrainResult {
  return {
    claimed: 0,
    attempted: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    blocked: 0,
    unknown: 0,
    cancelled: 0,
    deferred: 0,
    blockedChatsDisabled: 0,
    acceptedChats: 0,
    globalBackoffUntil: null,
    stoppedReason: null,
  };
}

export interface TelegramDeliveryDrainOptions {
  nowSec?: () => number;
  softDeadlineAtMs?: number | null;
  signal?: AbortSignal;
  /** Kinds held back this run (claimed by a later run); e.g. freeze when retraction checks failed. */
  holdKinds?: readonly string[];
  /** Restrict the drain to one job (inline digest delivery). */
  jobId?: string;
  /** Upper bound on claimed rows for this call. */
  maxRows?: number;
  sendMessage?: typeof sendToChat;
  sendPhoto?: typeof sendPhotoToChat;
  onDeliveryStarted?: () => void;
}

/**
 * Claim due rows. A row is claimable only when every lower chunk of the same
 * (job, chat) is already sent or is itself due, and the ordering keeps those
 * chunks together, so a chat's chunks never send out of order and two
 * overlapping runs can never claim the same row (the UPDATE is atomic).
 */
async function claimDueDeliveries(
  db: D1Database,
  owner: string,
  nowSec: number,
  limit: number,
  jobId: string | undefined,
  holdKinds: readonly string[] = [],
): Promise<ClaimedTelegramDelivery[]> {
  const result = await db.prepare(
    `UPDATE telegram_deliveries
        SET state = 'sending',
            claim_owner = ?1,
            claim_expires_at = ?2 + ${TELEGRAM_DELIVERY_CLAIM_TTL_SEC},
            sending_at = ?2
      WHERE id IN (
        SELECT d.id FROM telegram_deliveries d
         WHERE d.state IN ('pending', 'retry')
           AND d.next_attempt_at <= ?2
           AND d.expires_at > ?2
           AND (?3 IS NULL OR d.job_id = ?3)
           AND d.kind NOT IN (SELECT value FROM json_each(?5))
           AND NOT EXISTS (
             SELECT 1 FROM telegram_deliveries prev
              WHERE prev.job_id = d.job_id
                AND prev.chat_id = d.chat_id
                AND prev.seq < d.seq
                AND prev.state <> 'sent'
                AND NOT (prev.state IN ('pending', 'retry') AND prev.next_attempt_at <= ?2)
           )
         ORDER BY d.priority ASC, d.created_at ASC, d.job_id ASC, d.chat_id ASC, d.seq ASC
         LIMIT ?4
      )
        AND state IN ('pending', 'retry')
      RETURNING id, job_id, kind, chat_id, seq, audience, method, body, options_json,
                coin_ids, attempts, expires_at`,
  ).bind(owner, nowSec, jobId ?? null, limit, JSON.stringify(holdKinds)).all<ClaimedTelegramDelivery>();
  return (result.results ?? []).sort((a, b) =>
    a.job_id.localeCompare(b.job_id) || a.chat_id.localeCompare(b.chat_id) || a.seq - b.seq);
}

interface ChatGate {
  /** Row outcome decided before any send. */
  verdict: Map<number, { state: "cancelled" | "retry"; reason: string; notBefore?: number }>;
  silentChats: Set<string>;
}

interface GateSubscriberRow {
  chat_id: string;
  alert_snooze_until_ts: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  timezone: string | null;
}

/**
 * Chat-level revalidation at send time (one query per 90 chats, one for coin
 * snoozes): a forgotten chat cancels, a chat snooze/pause defers to its end
 * (the TTL sweep expires it), a delivery whose every coin is snoozed cancels,
 * and quiet hours send silently. Family toggles are not re-checked: fan-out
 * ran minutes ago against current preferences.
 */
async function gateClaimedRows(
  db: D1Database,
  rows: readonly ClaimedTelegramDelivery[],
  nowSec: number,
): Promise<ChatGate> {
  const gate: ChatGate = { verdict: new Map(), silentChats: new Set() };
  const gated = rows.filter((row) => row.audience !== "channel");
  if (gated.length === 0) return gate;
  const chatIds = [...new Set(gated.map((row) => row.chat_id))];
  const subscribers = new Map<string, GateSubscriberRow>();
  for (const chunk of chunkArray(chatIds)) {
    const clause = buildInClause(chunk);
    const result = await db.prepare(
      `SELECT chat_id, alert_snooze_until_ts, quiet_hours_enabled, quiet_hours_start_utc,
              quiet_hours_end_utc, timezone
         FROM telegram_subscribers WHERE chat_id IN (${clause.sql})`,
    ).bind(...clause.binds).all<GateSubscriberRow>();
    for (const row of result.results ?? []) subscribers.set(row.chat_id, row);
  }
  const coinRows = gated.filter((row) => row.audience === "alert" && row.coin_ids);
  const snoozedPairs = new Set<string>();
  const coinChatIds = [...new Set(coinRows.map((row) => row.chat_id))];
  for (const chunk of chunkArray(coinChatIds)) {
    const clause = buildInClause(chunk);
    const result = await db.prepare(
      `SELECT chat_id, stablecoin_id FROM telegram_subscriptions
        WHERE chat_id IN (${clause.sql}) AND alert_snooze_until_ts > ?`,
    ).bind(...clause.binds, nowSec).all<{ chat_id: string; stablecoin_id: string }>();
    for (const row of result.results ?? []) snoozedPairs.add(`${row.chat_id}\0${row.stablecoin_id}`);
  }

  for (const row of gated) {
    const subscriber = subscribers.get(row.chat_id);
    if (!subscriber) {
      gate.verdict.set(row.id, { state: "cancelled", reason: "subscriber_missing" });
      continue;
    }
    if (row.audience !== "alert") continue;
    const snoozeUntil = subscriber.alert_snooze_until_ts;
    if (isTelegramSnoozeActive(snoozeUntil, nowSec)) {
      gate.verdict.set(row.id, { state: "retry", reason: "chat_snoozed", notBefore: Number(snoozeUntil) });
      continue;
    }
    const coins = row.coin_ids ? row.coin_ids.split(",") : [];
    if (coins.length > 0 && coins.every((coin) => snoozedPairs.has(`${row.chat_id}\0${coin}`))) {
      gate.verdict.set(row.id, { state: "cancelled", reason: "coin_snoozed" });
      continue;
    }
    if (isQuietHoursActive(
      nowSec,
      Boolean(subscriber.quiet_hours_enabled),
      subscriber.quiet_hours_start_utc,
      subscriber.quiet_hours_end_utc,
      subscriber.timezone,
    )) {
      gate.silentChats.add(row.chat_id);
    }
  }
  return gate;
}

interface Settlement {
  row: ClaimedTelegramDelivery;
  state: TelegramDeliveryState;
  attempted: boolean;
  nextAttemptAt?: number;
  errorClass?: string | null;
  statusCode?: number | null;
  reason?: string | null;
}

function settleStatement(db: D1Database, settlement: Settlement, nowSec: number, owner: string): D1PreparedStatement {
  const terminal = settlement.state !== "retry";
  return db.prepare(
    `UPDATE telegram_deliveries
        SET state = ?,
            attempts = attempts + ?,
            next_attempt_at = COALESCE(?, next_attempt_at),
            claim_owner = NULL,
            claim_expires_at = NULL,
            done_at = ?,
            body = CASE WHEN ? = 1 THEN NULL ELSE body END,
            error_class = ?,
            status_code = ?,
            reason = ?
      WHERE id = ? AND state = 'sending' AND claim_owner = ?`,
  ).bind(
    settlement.state,
    settlement.attempted ? 1 : 0,
    settlement.nextAttemptAt ?? null,
    terminal ? nowSec : null,
    terminal ? 1 : 0,
    settlement.errorClass ?? null,
    settlement.statusCode ?? null,
    settlement.reason ?? null,
    settlement.row.id,
    owner,
  );
}

async function persistSettlements(
  db: D1Database,
  settlements: readonly Settlement[],
  nowSec: number,
  owner: string,
): Promise<void> {
  for (const chunk of chunkArray(settlements, D1_BATCH_SIZE)) {
    await executeAtomicBatch(db, chunk.map((settlement) => settleStatement(db, settlement, nowSec, owner)));
  }
}

function classifyAttempt(
  row: ClaimedTelegramDelivery,
  result: BatchResult,
  nowSec: number,
  /** Job of the chat's failed head this run; tails of other jobs are independent messages. */
  failedHeadJob?: string,
): Settlement {
  const base = {
    row,
    attempted: result.attempted !== false,
    errorClass: result.errorClass ?? null,
    statusCode: result.statusCode ?? null,
  };
  if (result.attempted === false) {
    // Never crossed the send boundary: predecessor failure, deadline, abort,
    // global stop. A blocked chat or a terminal head of the same message
    // cancels the tail; anything else (including other jobs queued behind a
    // failed head of this chat) is retried.
    const predecessor = result.skippedReason === "predecessor_failure";
    if (predecessor && result.blocked) {
      return { ...base, state: "cancelled", reason: "predecessor_failed" };
    }
    if (predecessor && failedHeadJob === row.job_id && result.permanentFailure) {
      return { ...base, state: "cancelled", reason: "predecessor_failed" };
    }
    if (predecessor && failedHeadJob === row.job_id && UNKNOWN_ERROR_CLASSES.has(result.errorClass ?? "")) {
      return { ...base, state: "cancelled", reason: "predecessor_unknown" };
    }
    const delaySec = result.retryAfterSec ?? 0;
    return {
      ...base,
      state: "retry",
      nextAttemptAt: nowSec + delaySec,
      reason: result.skippedReason ?? "not_attempted",
    };
  }
  if (result.ok) return { ...base, state: "sent", errorClass: null, reason: null };
  if (UNKNOWN_ERROR_CLASSES.has(result.errorClass ?? "")) {
    // Ambiguous: Telegram may have delivered it. At-most-once: never replay.
    return { ...base, state: "unknown", reason: "ambiguous_send" };
  }
  if (result.blocked) return { ...base, state: "blocked", reason: result.errorClass ?? "blocked" };
  const attempts = row.attempts + 1;
  if (result.retryable && attempts < PENDING_MAX_ATTEMPTS) {
    return {
      ...base,
      state: "retry",
      nextAttemptAt: nowSec + pendingBackoffSec(row.attempts, result.retryAfterSec),
      reason: result.errorClass ?? "retryable",
    };
  }
  return {
    ...base,
    state: "failed",
    reason: result.retryable ? "max_attempts" : (result.errorClass ?? "permanent_failure"),
  };
}

function sendClaimedRow(
  row: ClaimedTelegramDelivery,
  botToken: string,
  silent: boolean,
  options: TelegramDeliveryDrainOptions,
): Promise<SendToChatResult> {
  const stored = parseTelegramDeliveryOptions(row.options_json);
  const opts = {
    disableNotification: silent || stored.disableNotification === true,
    ...(stored.disableWebPagePreview ? { disableWebPagePreview: true } : {}),
    ...(stored.linkPreviewOptions ? { linkPreviewOptions: stored.linkPreviewOptions } : {}),
    ...(stored.replyMarkup != null ? { replyMarkup: stored.replyMarkup } : {}),
    signal: options.signal,
  };
  if (row.method === "sendPhoto") {
    return (options.sendPhoto ?? sendPhotoToChat)(row.chat_id, stored.photoUrl ?? "", row.body ?? "", botToken, opts);
  }
  return (options.sendMessage ?? sendToChat)(row.chat_id, row.body ?? "", botToken, opts);
}

/**
 * Drain due deliveries: claim -> chat gate -> send (SEND_BATCH_SIZE distinct
 * chats per wave, chunks serial per chat) -> settle each wave in one batch.
 * Every claimed row is settled; a crash leaves it `sending` and the sweep turns
 * it into `unknown` (no auto-replay).
 */
export async function drainTelegramDeliveries(
  db: D1Database,
  botToken: string,
  options: TelegramDeliveryDrainOptions = {},
): Promise<TelegramDeliveryDrainResult> {
  const now = options.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const result = emptyTelegramDeliveryDrainResult();
  const owner = `telegram-drain:${crypto.randomUUID()}`;
  const blockedChatsThisRun = new Set<string>();
  const sentChats = new Set<string>();
  // Per-chat delivery diagnostics shown by /status, /list and the Mini App.
  const deliveryOutcomes: Array<{ chatId: string; ok: boolean; errorClass: string | null; nowSec: number }> = [];
  const globalBackoff = await readTelegramGlobalBackoff(db, now());
  if (globalBackoff != null) {
    result.globalBackoffUntil = globalBackoff;
    result.stoppedReason = "global-backoff";
    return result;
  }

  while (true) {
    if (options.signal?.aborted) {
      result.stoppedReason = "aborted";
      break;
    }
    if (options.softDeadlineAtMs != null && Date.now() >= options.softDeadlineAtMs) {
      result.stoppedReason = "deadline";
      break;
    }
    const remaining = options.maxRows == null ? CLAIM_PAGE_SIZE : Math.min(CLAIM_PAGE_SIZE, options.maxRows - result.claimed);
    if (remaining <= 0) break;
    const claimNow = now();
    const claimed = await claimDueDeliveries(db, owner, claimNow, remaining, options.jobId, options.holdKinds);
    if (claimed.length === 0) {
      result.stoppedReason = "empty";
      break;
    }
    result.claimed += claimed.length;

    const gate = await gateClaimedRows(db, claimed, claimNow);
    const preSettled: Settlement[] = [];
    const sendable: ClaimedTelegramDelivery[] = [];
    for (const row of claimed) {
      const verdict = gate.verdict.get(row.id);
      if (verdict) {
        preSettled.push({
          row,
          attempted: false,
          state: verdict.state,
          reason: verdict.reason,
          ...(verdict.notBefore != null ? { nextAttemptAt: verdict.notBefore } : {}),
        });
        if (verdict.state === "cancelled") result.cancelled += 1;
        else result.deferred += 1;
        continue;
      }
      if (blockedChatsThisRun.has(row.chat_id)) {
        preSettled.push({ row, attempted: false, state: "cancelled", reason: "chat_blocked_this_run" });
        result.cancelled += 1;
        continue;
      }
      sendable.push(row);
    }
    await persistSettlements(db, preSettled, claimNow, owner);
    if (sendable.length > 0) options.onDeliveryStarted?.();

    let globalStop: number | null = null;
    const attemptedIds = new Set<number>();
    const failedHeadJobByChat = new Map<string, string>();
    const settledIds = new Set<number>();
    const items = sendable.map((row) => ({ chatId: row.chat_id, row }));
    let scheduled: BatchResult[];
    try {
      scheduled = await schedulePerChatBatches(
      items,
      SEND_BATCH_SIZE,
      (item) => {
        attemptedIds.add(item.row.id);
        return sendClaimedRow(item.row, botToken, gate.silentChats.has(item.row.chat_id), options);
      },
      {
        signal: options.signal,
        softDeadlineAtMs: options.softDeadlineAtMs ?? null,
        beforeSendBatch: async (entries) => {
          if (globalStop == null) return;
          return new Map<number, PreSendBatchResult>(entries.map((entry) => [entry.index, {
            ok: false,
            blocked: false,
            retryable: true,
            permanentFailure: false,
            statusCode: 429,
            errorClass: "rate_limit",
            delivery: "retryable_failure",
            retryAfterSec: Math.max(0, globalStop! - now()),
            skippedReason: "global_rate_limit",
          }]));
        },
        afterSendBatch: async (entries, waveResults) => {
          const settleNow = now();
          const settlements = entries.map((entry, index) =>
            classifyAttempt(entry.item.row, waveResults[index]!, settleNow, failedHeadJobByChat.get(entry.item.row.chat_id)));
          for (const settlement of settlements) {
            if (settlement.attempted && settlement.state !== "sent") {
              failedHeadJobByChat.set(settlement.row.chat_id, settlement.row.job_id);
            }
          }
          await persistSettlements(db, settlements, settleNow, owner);
          for (const settlement of settlements) settledIds.add(settlement.row.id);
          const rateLimited = waveResults.filter((wave) => wave.attempted !== false && wave.errorClass === "rate_limit");
          const rateLimitedChats = new Set(rateLimited.map((wave) => wave.chatId));
          const chatBackoffs: D1PreparedStatement[] = [];
          settlements.forEach((settlement, index) => {
            if (!settlement.attempted) return;
            deliveryOutcomes.push({
              chatId: settlement.row.chat_id,
              ok: settlement.state === "sent",
              errorClass: waveResults[index]!.errorClass,
              nowSec: settleNow,
            });
          });
          for (const settlement of settlements) {
            if (settlement.attempted) result.attempted += 1;
            if (settlement.state === "sent") {
              result.sent += 1;
              sentChats.add(settlement.row.chat_id);
            } else if (settlement.state === "retry") {
              result.retried += 1;
            } else if (settlement.state === "failed") {
              result.failed += 1;
            } else if (settlement.state === "unknown") {
              result.unknown += 1;
            } else if (settlement.state === "cancelled") {
              result.cancelled += 1;
            } else if (settlement.state === "blocked") {
              result.blocked += 1;
              const cascade = await handleBlockedChat(db, settlement.row.chat_id, settleNow, blockedChatsThisRun);
              if (cascade.disabled) result.blockedChatsDisabled += 1;
            }
          }
          // Chat Retry-After applies to every queued row for that chat, even
          // when the 429 was the attempt that exhausted its own row.
          for (const wave of rateLimited) {
            chatBackoffs.push(db.prepare(
              `UPDATE telegram_deliveries SET next_attempt_at = MAX(next_attempt_at, ?)
                WHERE chat_id = ? AND state IN ('pending', 'retry')`,
            ).bind(settleNow + pendingBackoffSec(0, wave.retryAfterSec), wave.chatId));
          }
          if (chatBackoffs.length > 0) await executeAtomicBatch(db, chatBackoffs);
          if (rateLimitedChats.size >= GLOBAL_RATE_LIMIT_MIN_CHATS) {
            const until = settleNow + Math.max(1, ...rateLimited.map((wave) => wave.retryAfterSec ?? 1));
            globalStop = until;
            result.globalBackoffUntil = until;
            await setTelegramGlobalBackoff(db, until);
          }
        },
      },
      );
    } catch (error) {
      // Rows that never crossed the send boundary go back to the queue; rows
      // that did stay `sending` and the sweep records them as `unknown`.
      const releaseNow = now();
      await persistSettlements(db, sendable
        .filter((row) => !settledIds.has(row.id) && !attemptedIds.has(row.id))
        .map((row) => ({ row, attempted: false, state: "retry" as const, nextAttemptAt: releaseNow, reason: "drain_aborted" })),
      releaseNow, owner).catch(() => undefined);
      throw error;
    }
    // Tails skipped after a failed predecessor, the soft deadline or an abort
    // never reach `afterSendBatch`; settle them as unattempted here.
    const tailNow = now();
    const tails = items.flatMap((item, index) =>
      settledIds.has(item.row.id)
        ? []
        : [classifyAttempt(item.row, scheduled[index]!, tailNow, failedHeadJobByChat.get(item.row.chat_id))]);
    await persistSettlements(db, tails, tailNow, owner);
    for (const settlement of tails) {
      if (settlement.state === "cancelled") result.cancelled += 1;
      else result.deferred += 1;
    }
    // `beforeSendBatch` short-circuits once a flood is inferred; those rows
    // are settled as unattempted retries by `afterSendBatch` above.
    if (globalStop != null) {
      result.stoppedReason = "global-backoff";
      break;
    }
    if (claimed.length < remaining) {
      result.stoppedReason = "empty";
      break;
    }
  }

  result.acceptedChats = sentChats.size;
  if (sentChats.size > 0) await flushChatSuccessResets(db, sentChats);
  await recordTelegramDeliveryOutcomes(db, deliveryOutcomes);
  if (result.attempted > 0 || result.unknown > 0) {
    logTelegramEvent({
      level: "info",
      message: "telegram delivery drain",
      action: "telegram-delivery-drain",
      module: "telegram-job-drain",
      attemptedCount: result.attempted,
      sentCount: result.sent,
      queuedCount: result.retried,
      permanentFailureCount: result.failed + result.blocked + result.unknown,
    });
  }
  return result;
}
