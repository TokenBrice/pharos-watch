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
} from "../cron/telegram-pending-queue";
import { TELEGRAM_ALERT_TTL_SEC } from "../lib/telegram-constants";
import { splitMessage } from "../lib/telegram-alerts";
import type { BatchMessage } from "../lib/telegram";
import { z } from "zod";

const SCOPES = ["all", "deliverable-watchers", "global-subscribers"] as const;
type BroadcastScope = (typeof SCOPES)[number];

const SAMPLE_SIZE = 5;

interface BroadcastRequestBody {
  messageHtml: string;
  scope: BroadcastScope;
  dryRun: boolean;
  acknowledgeBacklogRisk: boolean;
}

const BroadcastRequestBodySchema = z.object({
  messageHtml: z.string()
    .refine((value) => value.trim().length > 0, "messageHtml must be a non-empty string"),
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

async function loadTargetChatIds(db: D1Database, scope: BroadcastScope): Promise<string[]> {
  const sql = scope === "global-subscribers"
    ? `SELECT chat_id FROM telegram_subscribers
        WHERE global_alert_dews = 1
           OR global_alert_depeg = 1
           OR global_alert_safety = 1
           OR global_alert_launch = 1
        ORDER BY chat_id`
    : scope === "deliverable-watchers"
      ? `SELECT s.chat_id
           FROM telegram_subscribers s
          WHERE s.global_alert_dews = 1
             OR s.global_alert_depeg = 1
             OR s.global_alert_safety = 1
             OR s.global_alert_launch = 1
             OR EXISTS (
               SELECT 1 FROM telegram_subscriptions ts
                WHERE ts.chat_id = s.chat_id
                  AND (ts.alert_dews = 1 OR ts.alert_depeg = 1 OR ts.alert_safety = 1 OR ts.alert_launch = 1)
             )
             OR EXISTS (
               SELECT 1 FROM telegram_preset_subscriptions ps
                WHERE ps.chat_id = s.chat_id
                  AND (ps.alert_dews = 1 OR ps.alert_depeg = 1 OR ps.alert_safety = 1 OR ps.alert_launch = 1)
             )
          ORDER BY s.chat_id`
    : `SELECT chat_id FROM telegram_subscribers ORDER BY chat_id`;
  const rows = await db.prepare(sql).all<{ chat_id: string }>();
  return (rows.results ?? []).map((row) => row.chat_id);
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

    const chatIds = await loadTargetChatIds(db, scope);
    const chunks = splitMessage(messageHtml);
    const targetMessageCount = chatIds.length * chunks.length;
    const nowSec = Math.floor(Date.now() / 1000);
    const pendingCapacity = await readPendingCapacitySnapshot(db, nowSec);
    const deliveryEstimate = buildDeliveryEstimate(pendingCapacity.active, targetMessageCount);

    if (dryRun) {
      return adminJsonResponse(
        {
          targetChatCount: chatIds.length,
          chunkCount: chunks.length,
          targetMessageCount,
          pendingCapacity,
          deliveryEstimate,
          sample: chatIds.slice(0, SAMPLE_SIZE),
        },
        { status: 200 },
      );
    }

    if (deliveryEstimate.requiresAcknowledgement && !parsed.acknowledgeBacklogRisk) {
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
