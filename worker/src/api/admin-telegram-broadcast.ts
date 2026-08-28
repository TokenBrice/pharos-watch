import {
  adminErrorResponse,
  adminJsonResponse,
  type AdminRouteContext,
  makeIdempotentAdminRoute,
} from "../lib/route-wrappers";
import { parseRequestJsonWithSchema } from "../lib/api-json-body";
import { logAdminAction } from "../lib/admin-action-audit";
import {
  enqueuePendingAlerts,
} from "../lib/telegram-pending-queue";
import {
  estimateTelegramDrainTimeSec,
  readTelegramPendingCapacitySnapshot,
} from "../lib/telegram-pending-capacity";
import {
  TELEGRAM_PENDING_DRAIN_BUDGET,
  TELEGRAM_PENDING_PRIORITY,
} from "../lib/telegram-constants";
import {
  PENDING_NEAR_TTL_WINDOW_SEC,
  TELEGRAM_ALERT_TTL_SEC,
} from "../lib/telegram-constants";
import { splitMessage } from "../lib/telegram-alerts";
import { loadBroadcastTargetChatIds, type TelegramBroadcastScope } from "../lib/telegram-broadcast-targets";
import { sendToChat, type BatchMessage } from "../lib/telegram";
import { z } from "zod";
import {
  claimTelegramTransportPermit,
  readTelegramDeliveryPause,
  readTelegramTransportCircuit,
  recordTelegramTransportOutcomes,
} from "../lib/telegram-transport-control";

const SCOPES = ["all", "deliverable-watchers", "global-subscribers"] as const;
type BroadcastScope = TelegramBroadcastScope;

const SAMPLE_SIZE = 5;
const MESSAGE_HTML_MAX_LENGTH = 16_000;
const TELEGRAM_HTML_ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "code",
  "del",
  "em",
  "i",
  "ins",
  "pre",
  "s",
  "strike",
  "strong",
  "tg-spoiler",
  "u",
]);
const TELEGRAM_HTML_VOID_TAGS = new Set<string>();

interface BroadcastRequestBody {
  messageHtml: string;
  scope: BroadcastScope;
  dryRun: boolean;
  acknowledgeBacklogRisk: boolean;
  canaryChatId?: string;
}

interface BroadcastContext extends AdminRouteContext {
  telegramBotToken?: string;
}

const BroadcastRequestBodySchema = z.object({
  messageHtml: z.string()
    .refine((value) => value.trim().length > 0, "messageHtml must be a non-empty string")
    .max(MESSAGE_HTML_MAX_LENGTH, `messageHtml must be ${MESSAGE_HTML_MAX_LENGTH.toLocaleString("en-US")} characters or fewer`),
  scope: z.enum(SCOPES, { message: `scope must be one of: ${SCOPES.join(", ")}` }),
  dryRun: z.boolean({ message: "dryRun must be a boolean" }),
  acknowledgeBacklogRisk: z
    .boolean({ message: "acknowledgeBacklogRisk must be a boolean when provided" })
    .optional()
    .default(false),
  canaryChatId: z.string().regex(/^[1-9]\d*$/, "canaryChatId must identify a private Telegram chat").optional(),
});

async function parseBody(request: Request): Promise<BroadcastRequestBody | Response> {
  return parseRequestJsonWithSchema(request, BroadcastRequestBodySchema, {
    formatSchemaError: (issues) => {
      const first = issues[0];
      return first?.path.length === 0
        ? "Body must be a JSON object"
        : first?.message ?? "Invalid broadcast request body";
    },
  });
}

function preflightTelegramHtml(html: string): { ok: true } | { ok: false; error: string; position: number } {
  const stack: Array<{ tag: string; position: number }> = [];
  const tagPattern = /<[^>]*>/g;
  let textCursor = 0;
  for (const match of html.matchAll(tagPattern)) {
    const raw = match[0];
    const position = match.index ?? 0;
    const strayOpen = html.slice(textCursor, position).indexOf("<");
    if (strayOpen >= 0) {
      return { ok: false, error: "Raw < must be escaped as &lt; in Telegram HTML", position: textCursor + strayOpen };
    }
    textCursor = position + raw.length;
    if (/^<!--/.test(raw) || /^<!\[CDATA\[/i.test(raw) || /^<!DOCTYPE/i.test(raw)) {
      return { ok: false, error: "Comments, CDATA, and doctypes are not supported by Telegram HTML", position };
    }
    const parsed = raw.match(/^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>$/);
    if (!parsed) return { ok: false, error: "Malformed HTML tag", position };
    const closing = /^<\//.test(raw);
    const tag = parsed[1].toLowerCase();
    const attrs = parsed[2] ?? "";
    const selfClosing = /\/\s*>$/.test(raw);
    if (!TELEGRAM_HTML_ALLOWED_TAGS.has(tag)) {
      return { ok: false, error: `Unsupported Telegram HTML tag <${tag}>`, position };
    }
    if (attrs.trim().length > 0 && !selfClosing) {
      if (tag === "a") {
        const allowed = attrs.trim().match(/^href=(?:"[^"]+"|'[^']+')$/i);
        if (!allowed) return { ok: false, error: "Only href is allowed on Telegram <a> tags", position };
      } else if (tag === "blockquote") {
        const allowed = attrs.trim() === "expandable";
        if (!allowed) return { ok: false, error: "Only expandable is allowed on Telegram <blockquote> tags", position };
      } else {
        return { ok: false, error: `Attributes are not allowed on Telegram <${tag}> tags`, position };
      }
    }
    if (selfClosing && !TELEGRAM_HTML_VOID_TAGS.has(tag)) {
      return { ok: false, error: `Telegram HTML tag <${tag}> must be closed explicitly`, position };
    }
    if (closing) {
      const last = stack.pop();
      if (!last || last.tag !== tag) {
        return { ok: false, error: `Unbalanced closing tag </${tag}>`, position };
      }
    } else if (!selfClosing) {
      stack.push({ tag, position });
    }
  }
  const trailingStrayOpen = html.slice(textCursor).indexOf("<");
  if (trailingStrayOpen >= 0) {
    return { ok: false, error: "Raw < must be escaped as &lt; in Telegram HTML", position: textCursor + trailingStrayOpen };
  }
  if (stack.length > 0) {
    const last = stack[stack.length - 1];
    return { ok: false, error: `Unclosed Telegram HTML tag <${last.tag}>`, position: last.position };
  }

  const badEntity = html.match(/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/);
  if (badEntity?.index != null) {
    return { ok: false, error: "Malformed or unsupported HTML entity", position: badEntity.index };
  }
  return { ok: true };
}

function buildDeliveryEstimate(currentPendingActive: number, targetMessageCount: number) {
  const projectedPendingMessages = currentPendingActive + targetMessageCount;
  const estimatedDrainTimeSec = estimateTelegramDrainTimeSec(
    projectedPendingMessages,
    TELEGRAM_PENDING_DRAIN_BUDGET,
  );
  const adminBroadcastTtlSec = TELEGRAM_ALERT_TTL_SEC.adminBroadcast;
  const minimumTtlReserveSec = PENDING_NEAR_TTL_WINDOW_SEC;
  const remainingTtlReserveSec = adminBroadcastTtlSec - estimatedDrainTimeSec;
  return {
    currentPendingActive,
    projectedPendingMessages,
    drainBudgetPerRun: TELEGRAM_PENDING_DRAIN_BUDGET,
    adminBroadcastTtlSec,
    estimatedDrainTimeSec,
    minimumTtlReserveSec,
    remainingTtlReserveSec,
    hasMaterialTtlReserve: remainingTtlReserveSec >= minimumTtlReserveSec,
    fitsWithinMinutes: {
      5: estimatedDrainTimeSec <= 5 * 60,
      15: estimatedDrainTimeSec <= 15 * 60,
      30: estimatedDrainTimeSec <= 30 * 60,
      60: estimatedDrainTimeSec <= 60 * 60,
    },
  };
}

export const handleAdminTelegramBroadcast = makeIdempotentAdminRoute<BroadcastContext>(
  "route-admin-telegram-broadcast",
  "admin-telegram-broadcast",
  async ({ db, request, telegramBotToken }) => {
    const parsed = await parseBody(request);
    if (parsed instanceof Response) return parsed;
    const { messageHtml, scope, dryRun, canaryChatId } = parsed;
    const htmlPreflight = preflightTelegramHtml(messageHtml);
    if (!htmlPreflight.ok) {
      await logAdminAction(
        db,
        {
          action: "admin-telegram-broadcast",
          target: scope,
          result: "error",
          httpStatus: 422,
          details: {
            scope,
            dryRun,
            messageLength: messageHtml.length,
            rejectedReason: "html-preflight",
            htmlError: htmlPreflight.error,
            htmlErrorPosition: htmlPreflight.position,
          },
        },
        request,
      );
      return adminJsonResponse(
        {
          error: htmlPreflight.error,
          position: htmlPreflight.position,
        },
        { status: 422 },
      );
    }

    const chatIds = await loadBroadcastTargetChatIds(db, scope);
    const chunks = splitMessage(messageHtml);
    const fleetChatIds = canaryChatId == null ? chatIds : chatIds.filter((chatId) => chatId !== canaryChatId);
    const targetMessageCount = fleetChatIds.length * chunks.length;
    const nowSec = Math.floor(Date.now() / 1000);
    const pendingCapacity = await readTelegramPendingCapacitySnapshot(db, nowSec);
    const deliveryEstimate = buildDeliveryEstimate(pendingCapacity.active, targetMessageCount);

    if (dryRun) {
      await logAdminAction(
        db,
        {
          action: "admin-telegram-broadcast",
          target: scope,
          result: "ok",
          httpStatus: 200,
          details: {
            scope,
            dryRun: true,
            targetChatCount: chatIds.length,
            chunkCount: chunks.length,
            targetMessageCount,
            deliveryEstimate,
            messageLength: messageHtml.length,
          },
        },
        request,
      );
      return adminJsonResponse(
        {
          targetChatCount: chatIds.length,
          chunkCount: chunks.length,
          targetMessageCount,
          pendingCapacity,
          deliveryEstimate,
          htmlPreflight: "ok",
          canary: {
            requiredForLive: true,
            chatId: canaryChatId ?? null,
            wouldSendChunkCount: chunks.length,
          },
          sample: chatIds.slice(0, SAMPLE_SIZE),
        },
        { status: 200 },
      );
    }

    if (!deliveryEstimate.hasMaterialTtlReserve) {
      await logAdminAction(
        db,
        {
          action: "admin-telegram-broadcast",
          target: scope,
          result: "error",
          httpStatus: 409,
          details: {
            scope,
            dryRun: false,
            targetChatCount: chatIds.length,
            chunkCount: chunks.length,
            targetMessageCount,
            deliveryEstimate,
            messageLength: messageHtml.length,
            rejectedReason: "insufficient-ttl-reserve",
          },
        },
        request,
      );
      return adminJsonResponse(
        {
          error: "Projected admin broadcast backlog does not retain the required TTL reserve",
          targetChatCount: chatIds.length,
          chunkCount: chunks.length,
          targetMessageCount,
          pendingCapacity,
          deliveryEstimate,
        },
        { status: 409 },
      );
    }

    if (!canaryChatId) {
      return adminErrorResponse(400, "Live broadcast requires canaryChatId for a private Telegram parse/send canary");
    }
    if (!telegramBotToken) {
      return adminErrorResponse(500, "TELEGRAM_BOT_TOKEN is not configured");
    }

    const [adminPause, transportCircuit] = await Promise.all([
      readTelegramDeliveryPause(db, "admin", nowSec),
      readTelegramTransportCircuit(db),
    ]);
    if (adminPause?.active || transportCircuit.state !== "closed") {
      const rejectedReason = adminPause?.active ? "admin-delivery-paused" : "transport-outage";
      const deferUntil = adminPause?.active ? adminPause.expiresAt : transportCircuit.nextProbeAt;
      await logAdminAction(
        db,
        {
          action: "admin-telegram-broadcast",
          target: scope,
          result: "error",
          httpStatus: 409,
          details: {
            scope,
            dryRun: false,
            targetChatCount: chatIds.length,
            targetMessageCount,
            rejectedReason,
            deferUntil,
          },
        },
        request,
      );
      return adminJsonResponse(
        {
          error: "Telegram admin delivery is temporarily unavailable",
          reason: rejectedReason,
          deferUntil,
        },
        { status: 409 },
      );
    }

    const permit = await claimTelegramTransportPermit(db, {
      mode: "admin",
      owner: `admin-broadcast-canary:${crypto.randomUUID()}`,
      nowSec,
      requestedDistinctChats: 1,
    });
    if (!permit.allowed) {
      return adminJsonResponse({
        error: "Telegram canary delivery is temporarily unavailable",
        reason: permit.reason,
        deferUntil: permit.deferUntil,
      }, { status: permit.reason === "operator_pause" ? 409 : 503 });
    }
    const canaryResults = [];
    for (const chunk of chunks) {
      const result = await sendToChat(canaryChatId, chunk, telegramBotToken, {
        disableWebPagePreview: true,
        disableNotification: true,
      });
      canaryResults.push(result);
      if (!result.ok) break;
    }
    await recordTelegramTransportOutcomes(
      db,
      permit,
      canaryResults.map((result) => ({ chatId: canaryChatId, result })),
      Math.floor(Date.now() / 1000),
    );
    const canaryFailure = canaryResults.find((result) => !result.ok);
    if (canaryFailure || canaryResults.length !== chunks.length) {
      const status = canaryFailure?.errorClass === "bad_request"
          || canaryFailure?.errorClass === "formatting_error"
        ? 422
        : 503;
      await logAdminAction(db, {
        action: "admin-telegram-broadcast",
        target: scope,
        result: "error",
        httpStatus: status,
        details: {
          scope,
          dryRun: false,
          rejectedReason: "telegram-canary-failed",
          canaryChunksAttempted: canaryResults.length,
          canaryErrorClass: canaryFailure?.errorClass ?? "incomplete",
        },
      }, request);
      return adminJsonResponse({
        error: "Telegram rejected the private broadcast canary; fleet fanout was not enqueued",
        errorClass: canaryFailure?.errorClass ?? "incomplete",
        canaryChunksAttempted: canaryResults.length,
        fleetEnqueued: 0,
      }, { status });
    }

    const messages: BatchMessage[] = [];
    for (const chatId of fleetChatIds) {
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        messages.push({
          chatId,
          html: chunks[chunkIndex] as string,
          disableNotification: false,
          canonicalHtml: messageHtml,
          chunkIndex,
        });
      }
    }

    await enqueuePendingAlerts(db, messages, nowSec, {
      sourceType: "admin_broadcast",
      priority: TELEGRAM_PENDING_PRIORITY.adminBroadcast,
      ttlSec: TELEGRAM_ALERT_TTL_SEC.adminBroadcast,
    });

    await logAdminAction(
      db,
      {
        action: "admin-telegram-broadcast",
        target: scope,
        result: "ok",
        httpStatus: 200,
        details: {
          scope,
          targetChatCount: chatIds.length,
          chunkCount: chunks.length,
          targetMessageCount,
          deliveryEstimate,
          enqueued: messages.length,
          canaryChatId,
          canaryChunksSent: canaryResults.length,
          messageLength: messageHtml.length,
        },
      },
      request,
    );

    return adminJsonResponse({
      enqueued: messages.length,
      deliveryEstimate,
      canary: { chatId: canaryChatId, chunksSent: canaryResults.length },
    }, { status: 200 });
  },
);
