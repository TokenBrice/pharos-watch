import { isTelegramAlertType, type TelegramAlertType } from "@shared/types/status";
import {
  adminErrorResponse,
  adminJsonResponse,
  type AdminRouteContext,
  makeIdempotentAdminRoute,
} from "../lib/route-wrappers";
import { parseRequestJsonWithSchema } from "../lib/api-utils";
import { logAdminAction } from "../lib/admin-action-audit";
import { sha256Hex } from "../lib/hash";
import { parsePendingMarkupPolicy } from "../lib/telegram-pending-provenance";
import {
  enqueuePendingAlerts,
  TELEGRAM_PENDING_PRIORITY,
} from "../cron/telegram-pending";
import {
  readyTargetMatchesPlan,
  type ReadyTargetRow,
} from "../cron/telegram-alert-target-plans/delivery";
import { parseTelegramTargetPlan } from "../cron/telegram-alert-target-plan-contract";
import { TELEGRAM_ALERT_TTL_SEC } from "../lib/telegram-constants";
import type { BatchMessage } from "../lib/telegram";
import { z } from "zod";

interface ResendContext extends AdminRouteContext {
  // Retained for route-context compatibility. Replay is queued, never sent inline.
  telegramBotToken?: string;
}

const boundedIdentity = z.string().min(1).max(512).refine(
  (value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value),
  "historical identity contains unsupported characters",
);

const ResendRequestBodySchema = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("target"),
      jobId: boundedIdentity,
      targetKey: boundedIdentity,
    }),
    z.object({
      kind: z.literal("dead-letter"),
      deadLetterId: z.number().int().positive(),
    }),
  ]),
  dryRun: z.boolean({ message: "dryRun must be a boolean" }).optional().default(true),
  operatorReason: z.string().trim().min(8).max(500).optional(),
});

type ResendRequestBody = z.infer<typeof ResendRequestBodySchema>;

interface TargetPayloadRow extends ReadyTargetRow {
  status: string;
  effect_state: string;
  final_delivery_state: string | null;
  final_delivery_at: number | null;
  final_delivery_error: string | null;
}

interface DeadLetterRow {
  id: number;
  chat_id: string;
  message_html: string;
  source_type: string | null;
  alert_type: string | null;
  reason: string;
  expired_at: number;
  dedupe_key: string | null;
  chunk_index: number | null;
  delivery_state: string | null;
  markup_policy_json: string | null;
  source_event_id: string | null;
}

interface HistoricalReplayPayload {
  sourceIdentity: ResendRequestBody["source"];
  chatId: string;
  messageHtml: string;
  disableNotification: boolean;
  disableWebPagePreview: boolean;
  replyMarkup: Record<string, unknown> | null;
  linkPreviewOptions: BatchMessage["linkPreviewOptions"] | null;
  chunkIndex: number;
  alertType: TelegramAlertType | null;
  sourceEventId: string | null;
  historicalOutcome: Record<string, unknown>;
}

async function parseBody(request: Request): Promise<ResendRequestBody | Response> {
  return parseRequestJsonWithSchema(request, ResendRequestBodySchema, {
    formatSchemaError: (issues) => {
      const first = issues[0];
      return first?.path.length === 0
        ? "Body must be a JSON object"
        : first?.message ?? "Invalid historical replay request body";
    },
  });
}

async function validateTargetPayload(
  sourceIdentity: ResendRequestBody["source"],
  target: TargetPayloadRow,
  expectedMessageHtml?: string,
): Promise<HistoricalReplayPayload | null> {
  const parsedPlan = await parseTelegramTargetPlan(target.plan_payload_json, target.plan_payload_digest);
  if (
    !readyTargetMatchesPlan(target, parsedPlan)
    || (expectedMessageHtml != null && target.message_html !== expectedMessageHtml)
  ) {
    return null;
  }
  const markup = parsePendingMarkupPolicy(target.markup_policy_json);
  if (markup.kind !== "ok") return null;
  return {
    sourceIdentity,
    chatId: target.chat_id,
    messageHtml: target.message_html,
    disableNotification: target.disable_notification === 1,
    disableWebPagePreview: markup.value.disableWebPagePreview,
    replyMarkup: markup.value.replyMarkup,
    linkPreviewOptions: markup.value.linkPreviewOptions,
    chunkIndex: target.chunk_index,
    alertType: isTelegramAlertType(target.alert_type) ? target.alert_type : null,
    sourceEventId: target.source_event_id,
    historicalOutcome: {
      targetStatus: target.status,
      effectState: target.effect_state,
      finalDeliveryState: target.final_delivery_state,
      finalDeliveryAt: target.final_delivery_at,
      finalDeliveryError: target.final_delivery_error,
    },
  };
}

async function loadTarget(
  db: D1Database,
  jobId: string,
  targetKey: string,
): Promise<TargetPayloadRow | null> {
  return db.prepare(
    `SELECT target.job_id, target.target_key, target.target_ordinal,
            target.chat_id, target.chunk_index, target.alert_type, target.status,
            target.effect_state, target.final_delivery_state, target.final_delivery_at,
            target.final_delivery_error, target.message_html,
            target.disable_notification, target.alert_scope_json,
            target.preference_generation, target.markup_policy_json,
            target.target_expires_at, plan.source_event_id, plan.plan_generation,
            plan.plan_key, plan.plan_ordinal, plan.plan_payload_json,
            plan.plan_payload_digest
       FROM telegram_alert_job_targets target
       JOIN telegram_alert_target_plans plan
         ON plan.source_event_id = target.source_event_id
        AND plan.plan_generation = target.plan_generation
        AND plan.plan_key = target.plan_key
      WHERE target.job_id = ? AND target.target_key = ?
        AND target.plan_generation IS NOT NULL`,
  ).bind(jobId, targetKey).first<TargetPayloadRow>();
}

async function loadHistoricalPayload(
  db: D1Database,
  source: ResendRequestBody["source"],
): Promise<{ kind: "ok"; payload: HistoricalReplayPayload } | { kind: "missing" | "incomplete" }> {
  if (source.kind === "target") {
    const target = await loadTarget(db, source.jobId, source.targetKey);
    if (!target) return { kind: "missing" };
    const payload = await validateTargetPayload(source, target);
    return payload ? { kind: "ok", payload } : { kind: "incomplete" };
  }

  const deadLetter = await db.prepare(
    `SELECT id, chat_id, message_html, source_type, alert_type, reason,
            expired_at, dedupe_key, chunk_index, delivery_state,
            markup_policy_json, source_event_id
       FROM telegram_alert_dead_letters
      WHERE id = ?`,
  ).bind(source.deadLetterId).first<DeadLetterRow>();
  if (!deadLetter) return { kind: "missing" };

  const target = deadLetter.dedupe_key == null || deadLetter.source_event_id == null
    ? null
    : await db.prepare(
      `SELECT target.job_id, target.target_key, target.target_ordinal,
              target.chat_id, target.chunk_index, target.alert_type, target.status,
              target.effect_state, target.final_delivery_state, target.final_delivery_at,
              target.final_delivery_error, target.message_html,
              target.disable_notification, target.alert_scope_json,
              target.preference_generation, target.markup_policy_json,
              target.target_expires_at, plan.source_event_id, plan.plan_generation,
              plan.plan_key, plan.plan_ordinal, plan.plan_payload_json,
              plan.plan_payload_digest
         FROM telegram_alert_job_targets target
         JOIN telegram_alert_target_plans plan
           ON plan.source_event_id = target.source_event_id
          AND plan.plan_generation = target.plan_generation
          AND plan.plan_key = target.plan_key
        WHERE target.chat_id = ?
          AND target.source_event_id = ?
          AND target.pending_dedupe_key = ?
          AND target.plan_generation IS NOT NULL
        LIMIT 1`,
    ).bind(deadLetter.chat_id, deadLetter.source_event_id, deadLetter.dedupe_key).first<TargetPayloadRow>();
  if (!target) return { kind: "incomplete" };
  const payload = await validateTargetPayload(source, target, deadLetter.message_html);
  if (!payload) return { kind: "incomplete" };
  payload.historicalOutcome = {
    ...payload.historicalOutcome,
    deadLetterId: deadLetter.id,
    deadLetterReason: deadLetter.reason,
    deadLetterExpiredAt: deadLetter.expired_at,
    deadLetterDeliveryState: deadLetter.delivery_state,
  };
  return { kind: "ok", payload };
}

function normalizedIdempotencyKey(request: Request): string | null {
  const value = request.headers.get("Idempotency-Key")?.trim() ?? "";
  return value.length >= 8 && value.length <= 128 ? value : null;
}

export const handleAdminTelegramResend = makeIdempotentAdminRoute<ResendContext>(
  "route-admin-telegram-resend",
  "admin-telegram-resend",
  async ({ db, request }) => {
    const parsed = await parseBody(request);
    if (parsed instanceof Response) return parsed;
    const loaded = await loadHistoricalPayload(db, parsed.source);
    if (loaded.kind !== "ok") {
      const status = loaded.kind === "missing" ? 404 : 422;
      const reason = loaded.kind === "missing" ? "historical-source-not-found" : "historical-payload-incomplete";
      await logAdminAction(db, {
        action: "admin-telegram-resend",
        target: parsed.source.kind,
        result: "error",
        httpStatus: status,
        details: { source: parsed.source, dryRun: parsed.dryRun, reason },
      }, request);
      return adminErrorResponse(
        status,
        loaded.kind === "missing"
          ? "Historical Telegram target was not found"
          : "Historical target cannot be replayed exactly because its persisted payload policy is incomplete",
      );
    }

    const { payload } = loaded;
    const payloadSha256 = await sha256Hex(JSON.stringify({
      chatId: payload.chatId,
      messageHtml: payload.messageHtml,
      disableNotification: payload.disableNotification,
      disableWebPagePreview: payload.disableWebPagePreview,
      replyMarkup: payload.replyMarkup,
      linkPreviewOptions: payload.linkPreviewOptions,
    }));
    const payloadSummary = {
      sha256: payloadSha256,
      messageLength: payload.messageHtml.length,
      disableNotification: payload.disableNotification,
      disableWebPagePreview: payload.disableWebPagePreview,
      hasReplyMarkup: payload.replyMarkup != null,
      hasLinkPreviewOptions: payload.linkPreviewOptions != null,
      chunkIndex: payload.chunkIndex,
      alertType: payload.alertType,
      sourceEventId: payload.sourceEventId,
    };

    if (parsed.dryRun) {
      await logAdminAction(db, {
        action: "admin-telegram-resend",
        target: payload.chatId,
        result: "ok",
        httpStatus: 200,
        details: { source: parsed.source, dryRun: true, payload: payloadSummary },
      }, request);
      return adminJsonResponse({
        mode: "exact_historical_outbox_replay",
        dryRun: true,
        enqueued: 0,
        chatId: payload.chatId,
        source: parsed.source,
        payload: payloadSummary,
        historicalOutcome: payload.historicalOutcome,
      });
    }

    if (!parsed.operatorReason) {
      return adminErrorResponse(400, "Live historical replay requires operatorReason with at least 8 characters");
    }

    const finalDeliveryState = payload.historicalOutcome.finalDeliveryState;
    if (finalDeliveryState === "accepted" || finalDeliveryState === "execution_unknown") {
      await logAdminAction(db, {
        action: "admin-telegram-resend",
        target: payload.chatId,
        result: "error",
        httpStatus: 409,
        details: {
          source: parsed.source,
          dryRun: false,
          operatorReason: parsed.operatorReason,
          reason: "terminal-state-replay-refused",
          finalDeliveryState,
        },
      }, request);
      return adminErrorResponse(
        409,
        `Historical target final state ${String(finalDeliveryState)} requires separate effect reconciliation; replay refused`,
      );
    }

    const idempotencyKey = normalizedIdempotencyKey(request);
    if (!idempotencyKey) {
      return adminErrorResponse(400, "Live historical replay requires an Idempotency-Key header between 8 and 128 characters");
    }
    const subscriber = await db.prepare(
      "SELECT chat_id FROM telegram_subscribers WHERE chat_id = ?",
    ).bind(payload.chatId).first<{ chat_id: string }>();
    if (!subscriber) {
      return adminErrorResponse(409, "Historical target chat is no longer a registered Telegram subscriber");
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const replayIdentity = parsed.source.kind === "target"
      ? `target:${parsed.source.jobId}:${parsed.source.targetKey}`
      : `dead-letter:${parsed.source.deadLetterId}`;
    const message: BatchMessage = {
      chatId: payload.chatId,
      html: payload.messageHtml,
      canonicalHtml: `admin-replay:${replayIdentity}:${idempotencyKey}:${payloadSha256}`,
      chunkIndex: payload.chunkIndex,
      disableNotification: payload.disableNotification,
      disableWebPagePreview: payload.disableWebPagePreview,
      replyMarkup: payload.replyMarkup ?? undefined,
      linkPreviewOptions: payload.linkPreviewOptions ?? undefined,
      alertType: payload.alertType ?? undefined,
    };
    await enqueuePendingAlerts(db, [message], nowSec, {
      sourceType: "admin_replay",
      priority: TELEGRAM_PENDING_PRIORITY.adminBroadcast,
      ttlSec: TELEGRAM_ALERT_TTL_SEC.adminBroadcast,
    });
    await logAdminAction(db, {
      action: "admin-telegram-resend",
      target: payload.chatId,
      result: "ok",
      httpStatus: 202,
      details: {
        source: parsed.source,
        dryRun: false,
        operatorReason: parsed.operatorReason,
        enqueued: 1,
        payload: payloadSummary,
      },
    }, request);
    return adminJsonResponse({
      mode: "exact_historical_outbox_replay",
      dryRun: false,
      enqueued: 1,
      chatId: payload.chatId,
      source: parsed.source,
      payload: payloadSummary,
      historicalOutcome: payload.historicalOutcome,
    }, { status: 202 });
  },
);
