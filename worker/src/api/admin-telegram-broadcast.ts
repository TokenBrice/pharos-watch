import {
  adminJsonResponse,
  type AdminRouteContext,
  makeIdempotentAdminRoute,
} from "../lib/route-wrappers";
import { parseRequestJsonWithSchema } from "../lib/api-utils";
import { logAdminAction } from "../lib/admin-action-audit";
import {
  enqueuePendingAlerts,
  estimateTelegramDrainTimeSec,
  readPendingCapacitySnapshot,
  TELEGRAM_PENDING_DRAIN_BUDGET,
  TELEGRAM_PENDING_PRIORITY,
} from "../cron/telegram-pending";
import { TELEGRAM_ALERT_TTL_SEC } from "../lib/telegram-constants";
import { splitMessage } from "../lib/telegram-alerts";
import { loadBroadcastTargetChatIds, type TelegramBroadcastScope } from "../cron/dispatch-telegram-subscribers";
import type { BatchMessage } from "../lib/telegram";
import { z } from "zod";
import {
  readTelegramDeliveryPause,
  readTelegramTransportCircuit,
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
  for (const match of html.matchAll(tagPattern)) {
    const raw = match[0];
    const position = match.index ?? 0;
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
  return {
    currentPendingActive,
    projectedPendingMessages,
    drainBudgetPerRun: TELEGRAM_PENDING_DRAIN_BUDGET,
    adminBroadcastTtlSec,
    estimatedDrainTimeSec,
    requiresAcknowledgement: estimatedDrainTimeSec > adminBroadcastTtlSec,
    fitsWithinMinutes: {
      5: estimatedDrainTimeSec <= 5 * 60,
      15: estimatedDrainTimeSec <= 15 * 60,
      30: estimatedDrainTimeSec <= 30 * 60,
      60: estimatedDrainTimeSec <= 60 * 60,
    },
  };
}

export const handleAdminTelegramBroadcast = makeIdempotentAdminRoute<AdminRouteContext>(
  "route-admin-telegram-broadcast",
  "admin-telegram-broadcast",
  async ({ db, request }) => {
    const parsed = await parseBody(request);
    if (parsed instanceof Response) return parsed;
    const { messageHtml, scope, dryRun } = parsed;
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
    const targetMessageCount = chatIds.length * chunks.length;
    const nowSec = Math.floor(Date.now() / 1000);
    const pendingCapacity = await readPendingCapacitySnapshot(db, nowSec);
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
          sample: chatIds.slice(0, SAMPLE_SIZE),
        },
        { status: 200 },
      );
    }

    if (deliveryEstimate.requiresAcknowledgement && !parsed.acknowledgeBacklogRisk) {
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
            rejectedReason: "backlog-risk",
          },
        },
        request,
      );
      return adminJsonResponse(
        {
          error: "Projected admin broadcast backlog exceeds the admin broadcast TTL window",
          targetChatCount: chatIds.length,
          chunkCount: chunks.length,
          targetMessageCount,
          pendingCapacity,
          deliveryEstimate,
        },
        { status: 409 },
      );
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

    const messages: BatchMessage[] = [];
    for (const chatId of chatIds) {
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
          messageLength: messageHtml.length,
        },
      },
      request,
    );

    return adminJsonResponse({ enqueued: messages.length, deliveryEstimate }, { status: 200 });
  },
);
