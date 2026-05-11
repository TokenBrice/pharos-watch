import {
  adminErrorResponse,
  adminJsonResponse,
  type AdminRouteContext,
  makeIdempotentAdminRoute,
} from "../lib/route-wrappers";
import { logAdminAction } from "../lib/admin-action-audit";
import { enqueuePendingAlerts } from "../cron/telegram-pending-queue";
import { splitMessage } from "../lib/telegram-alerts";
import type { BatchMessage } from "../lib/telegram";

const SCOPES = ["all", "deliverable-watchers", "global-subscribers"] as const;
type BroadcastScope = (typeof SCOPES)[number];

const SAMPLE_SIZE = 5;

interface BroadcastRequestBody {
  messageHtml: string;
  scope: BroadcastScope;
  dryRun: boolean;
}

function isScope(value: unknown): value is BroadcastScope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

async function parseBody(request: Request): Promise<BroadcastRequestBody | Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return adminErrorResponse(400, "Invalid JSON body");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return adminErrorResponse(400, "Body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  const messageHtml = body.messageHtml;
  if (typeof messageHtml !== "string" || messageHtml.trim().length === 0) {
    return adminErrorResponse(400, "messageHtml must be a non-empty string");
  }
  if (!isScope(body.scope)) {
    return adminErrorResponse(400, `scope must be one of: ${SCOPES.join(", ")}`);
  }
  if (typeof body.dryRun !== "boolean") {
    return adminErrorResponse(400, "dryRun must be a boolean");
  }
  return { messageHtml, scope: body.scope, dryRun: body.dryRun };
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

export const handleAdminTelegramBroadcast = makeIdempotentAdminRoute<AdminRouteContext>(
  "route-admin-telegram-broadcast",
  "admin-telegram-broadcast",
  async ({ db, request }) => {
    const parsed = await parseBody(request);
    if (parsed instanceof Response) return parsed;
    const { messageHtml, scope, dryRun } = parsed;

    const chatIds = await loadTargetChatIds(db, scope);

    if (dryRun) {
      return adminJsonResponse(
        {
          targetChatCount: chatIds.length,
          sample: chatIds.slice(0, SAMPLE_SIZE),
        },
        { status: 200 },
      );
    }

    const chunks = splitMessage(messageHtml);
    const nowSec = Math.floor(Date.now() / 1000);
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

    await enqueuePendingAlerts(db, messages, nowSec);

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
          enqueued: messages.length,
          messageLength: messageHtml.length,
        },
      },
      request,
    );

    return adminJsonResponse({ enqueued: messages.length }, { status: 200 });
  },
);
