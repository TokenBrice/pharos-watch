import { formatIsoDate } from "@shared/lib/format";

export type TelegramUsageEventType =
  | "start"
  | "deep_link"
  | "setup_choice"
  | "setup_complete"
  | "subscribe"
  | "unsubscribe"
  | "preset_follow"
  | "preset_unfollow"
  | "global_alert_change"
  | "quiet_hours_change"
  | "snooze_change"
  | "timezone_change"
  | "recap_change"
  | "group_admin_denial"
  | "unknown_command"
  | "command"
  | "reply_failure"
  | "mini_app_session_valid"
  | "mini_app_session_invalid"
  | "mini_app_portability"
  | "mini_app_mutation"
  | "mini_app_mutation_denied"
  | "mini_app_recommended_setup"
  | "mini_app_coin_add"
  | "mini_app_coin_remove"
  | "mini_app_quiet_hours"
  | "mini_app_recap"
  | "mini_app_snooze"
  | "mini_app_coin_snooze"
  | "mini_app_forget"
  | "mini_app_group_readonly"
  | "command_forget"
  | "re_engagement_warning"
  | "inline_query"
  | "inline_result_chosen";

export interface TelegramUsageEventInput {
  nowSec?: number;
  eventType: TelegramUsageEventType;
  sourceCategory?: string | null;
  actionDetail?: string | null;
  outcome?: string | null;
  latencyMs?: number | null;
  latencyBucket?: string | null;
  failureClass?: string | null;
}

export const UNKNOWN_COMMAND_ACTION_DETAIL = "unknown";

const DELIVERY_DIAGNOSTIC_BATCH_SIZE = 100;

function clampDimension(value: string | null | undefined, fallback: string, maxLength = 64): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  const safe = normalized.replace(/[^a-z0-9_./:-]/g, "_");
  return safe.slice(0, maxLength) || fallback;
}

function usageActionDetail(input: TelegramUsageEventInput): string {
  if (input.eventType === "unknown_command") return UNKNOWN_COMMAND_ACTION_DETAIL;
  return clampDimension(input.actionDetail, "");
}

export function bucketTelegramCommandLatency(latencyMs: number | null | undefined): string {
  if (latencyMs == null || !Number.isFinite(latencyMs) || latencyMs < 0) return "unknown";
  if (latencyMs < 250) return "lt_250ms";
  if (latencyMs < 1_000) return "250ms_1s";
  if (latencyMs < 3_000) return "1s_3s";
  if (latencyMs < 10_000) return "3s_10s";
  return "gte_10s";
}

export function classifyTelegramStartSource(args: string): string {
  const token = args.trim().split(/\s+/)[0] ?? "";
  if (!token) return "none";
  const lower = token.toLowerCase();
  if (lower === "setup") return "setup";
  if (lower === "sample") return "sample";
  if (lower.startsWith("sub_")) return "subscribe";
  if (lower.startsWith("status_")) return "status";
  if (lower.startsWith("why_")) return "why";
  if (lower.startsWith("coverage_")) return "coverage";
  return "unknown";
}

function prepareTelegramUsageEventStatement(
  db: D1Database,
  input: TelegramUsageEventInput,
): D1PreparedStatement {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const day = formatIsoDate(nowSec);
  const latencyBucket = input.latencyBucket ?? bucketTelegramCommandLatency(input.latencyMs);
  return db
    .prepare(
      `INSERT INTO telegram_usage_daily (
           day, event_type, source_category, action_detail, outcome,
           latency_bucket, failure_class, count, first_seen_at, last_seen_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(
           day, event_type, source_category, action_detail, outcome,
           latency_bucket, failure_class
         ) DO UPDATE SET
           count = telegram_usage_daily.count + 1,
           last_seen_at = excluded.last_seen_at`,
    )
    .bind(
      day,
      input.eventType,
      clampDimension(input.sourceCategory, "unknown"),
      usageActionDetail(input),
      clampDimension(input.outcome, "unknown"),
      clampDimension(latencyBucket, "unknown"),
      clampDimension(input.failureClass, ""),
      nowSec,
      nowSec,
    );
}

export async function recordTelegramUsageEvent(
  db: D1Database,
  input: TelegramUsageEventInput,
): Promise<void> {
  try {
    await prepareTelegramUsageEventStatement(db, input).run();
  } catch {
    // Usage telemetry must never block a user-facing bot command.
  }
}

export async function recordTelegramUsageEvents(
  db: D1Database,
  inputs: TelegramUsageEventInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  if (inputs.length === 1) {
    await recordTelegramUsageEvent(db, inputs[0]);
    return;
  }
  try {
    await db.batch(inputs.map((input) => prepareTelegramUsageEventStatement(db, input)));
  } catch {
    // Usage telemetry must never block a user-facing bot command.
  }
}

function buildChatDeliveryDiagnosticsUpsert(
  db: D1Database,
  input: {
    chatId: string;
    ok: boolean;
    errorClass?: string | null;
    at: number;
    mode: "reply" | "delivery";
  },
): D1PreparedStatement {
  const failureClass = input.ok ? null : input.errorClass ?? "unknown";
  if (input.mode === "reply") {
    return db
      .prepare(
        `INSERT INTO telegram_chat_delivery_diagnostics (
           chat_id, last_successful_delivery_at, last_successful_reply_at,
           last_delivery_attempt_at, recent_failure_class, updated_at
         )
         VALUES (?, NULL, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           last_successful_delivery_at = COALESCE(
             excluded.last_successful_delivery_at,
             telegram_chat_delivery_diagnostics.last_successful_delivery_at
           ),
           last_successful_reply_at = COALESCE(
             excluded.last_successful_reply_at,
             telegram_chat_delivery_diagnostics.last_successful_reply_at
           ),
           last_delivery_attempt_at = excluded.last_delivery_attempt_at,
           recent_failure_class = excluded.recent_failure_class,
           updated_at = excluded.updated_at`,
      )
      .bind(input.chatId, input.ok ? input.at : null, input.at, failureClass, input.at);
  }

  return db
    .prepare(
      `INSERT INTO telegram_chat_delivery_diagnostics (
         chat_id, last_successful_delivery_at, last_successful_reply_at,
         last_delivery_attempt_at, recent_failure_class, updated_at
       )
       VALUES (?, ?, NULL, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         last_successful_delivery_at = COALESCE(
           excluded.last_successful_delivery_at,
           telegram_chat_delivery_diagnostics.last_successful_delivery_at
         ),
         last_delivery_attempt_at = excluded.last_delivery_attempt_at,
         recent_failure_class = excluded.recent_failure_class,
         updated_at = excluded.updated_at`,
    )
    .bind(input.chatId, input.ok ? input.at : null, input.at, failureClass, input.at);
}

export async function recordTelegramReplyOutcome(
  db: D1Database,
  input: { chatId: string; ok: boolean; errorClass?: string | null; nowSec?: number },
): Promise<void> {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  try {
    await buildChatDeliveryDiagnosticsUpsert(db, { ...input, at: nowSec, mode: "reply" }).run();
  } catch {
    // Diagnostics must not block command replies.
  }
}

export async function recordTelegramDeliveryOutcomes(
  db: D1Database,
  inputs: Array<{ chatId: string; ok: boolean; errorClass?: string | null; nowSec?: number }>,
): Promise<void> {
  if (inputs.length === 0) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const inputsByChat = new Map<string, typeof inputs[number]>();
  for (const input of inputs) {
    const existing = inputsByChat.get(input.chatId);
    if (!existing) {
      inputsByChat.set(input.chatId, input);
      continue;
    }
    inputsByChat.set(input.chatId, {
      chatId: input.chatId,
      ok: existing.ok || input.ok,
      errorClass: existing.ok || input.ok ? null : input.errorClass ?? existing.errorClass ?? null,
      nowSec: Math.max(existing.nowSec ?? nowSec, input.nowSec ?? nowSec),
    });
  }
  const coalescedInputs = [...inputsByChat.values()];
  try {
    for (let offset = 0; offset < coalescedInputs.length; offset += DELIVERY_DIAGNOSTIC_BATCH_SIZE) {
      const chunk = coalescedInputs.slice(offset, offset + DELIVERY_DIAGNOSTIC_BATCH_SIZE);
      await db.batch(chunk.map((input) => buildChatDeliveryDiagnosticsUpsert(db, {
        ...input,
        at: input.nowSec ?? nowSec,
        mode: "delivery",
      })));
    }
  } catch {
    // Diagnostics must not block alert delivery.
  }
}
