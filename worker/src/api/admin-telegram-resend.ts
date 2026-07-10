import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  adminErrorResponse,
  adminJsonResponse,
  type AdminRouteContext,
  makeIdempotentAdminRoute,
} from "../lib/route-wrappers";
import { parseRequestJsonWithSchema } from "../lib/api-utils";
import { logAdminAction } from "../lib/admin-action-audit";
import { recordTelegramDeliveryOutcomes } from "../lib/telegram-usage-analytics";
import { sendToChat, type SendToChatResult } from "../lib/telegram";
import {
  buildAlertReplyMarkup,
  formatConsolidatedMessage,
  splitMessage,
  type ConsolidatedAlerts,
  type DepegAlertPayload,
  type DewsChange,
  type LaunchAlert,
  type ReserveAlert,
  type SafetyChange,
} from "../lib/telegram-alerts";
import { emptyAlerts } from "../cron/dispatch-telegram-routing";
import { extractTopSignals } from "../cron/telegram-alert-snapshots";
import { z } from "zod";
import { loadStressSignalCurrentRowForCoin } from "../lib/stress-signals-current-rows";

const ALERT_TYPES = ["dews", "depeg", "safety", "launch", "reserve"] as const;
type AlertType = (typeof ALERT_TYPES)[number];

interface ResendRequestBody {
  chatId: string;
  alertType: AlertType;
  stablecoinId: string;
}

interface ResendContext extends AdminRouteContext {
  telegramBotToken: string | undefined;
}

const ResendRequestBodySchema = z.object({
  chatId: z.string().regex(/^-?\d+$/, "chatId must be a numeric string"),
  alertType: z.enum(ALERT_TYPES, {
    message: `alertType must be one of: ${ALERT_TYPES.join(", ")}`,
  }),
  stablecoinId: z.string().min(1, "stablecoinId must be a non-empty string")
    .superRefine((stablecoinId, ctx) => {
      if (!TRACKED_META_BY_ID.has(stablecoinId)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown stablecoinId: ${stablecoinId}`,
        });
      }
    }),
});

async function parseBody(request: Request): Promise<ResendRequestBody | Response> {
  return parseRequestJsonWithSchema(request, ResendRequestBodySchema, {
    formatSchemaError: (issues) => {
      const first = issues[0];
      return first?.path.length === 0
        ? "Body must be a JSON object"
        : first?.message ?? "Invalid resend request body";
    },
  });
}

function getSymbol(stablecoinId: string): string {
  return TRACKED_META_BY_ID.get(stablecoinId)?.symbol ?? stablecoinId;
}

async function buildDewsEvent(
  db: D1Database,
  stablecoinId: string,
): Promise<DewsChange | null> {
  const row = await loadStressSignalCurrentRowForCoin(
    db,
    stablecoinId,
    Math.floor(Date.now() / 1000),
    { staleAfterSec: 30 * 60 },
  );
  if (!row) return null;
  return {
    stablecoinId,
    symbol: getSymbol(stablecoinId),
    oldBand: row.band,
    newBand: row.band,
    score: row.score,
    topSignals: extractTopSignals(row.signals_json),
  };
}

async function buildDepegEvent(
  db: D1Database,
  stablecoinId: string,
): Promise<DepegAlertPayload | null> {
  const row = await db
    .prepare(
      `SELECT stablecoin_id, symbol, direction, peak_deviation_bps, start_price, peg_reference
         FROM depeg_events
         WHERE stablecoin_id = ?
         ORDER BY ended_at IS NULL DESC, started_at DESC
         LIMIT 1`,
    )
    .bind(stablecoinId)
    .first<{
      stablecoin_id: string;
      symbol: string;
      direction: "above" | "below";
      peak_deviation_bps: number;
      start_price: number;
      peg_reference: number;
    }>();
  if (!row) return null;
  return {
    stablecoinId: row.stablecoin_id,
    symbol: row.symbol,
    direction: row.direction,
    deviationBps: Math.abs(Number(row.peak_deviation_bps ?? 0)),
    price: Number(row.start_price ?? 0),
    pegReference: Number(row.peg_reference ?? 1),
  };
}

async function buildSafetyEvent(
  db: D1Database,
  stablecoinId: string,
): Promise<SafetyChange | null> {
  const row = await db
    .prepare(
      `SELECT grade, score, prev_grade, prev_score
         FROM safety_grade_history
         WHERE stablecoin_id = ?
         ORDER BY recorded_at DESC
         LIMIT 1`,
    )
    .bind(stablecoinId)
    .first<{ grade: string; score: number | null; prev_grade: string | null; prev_score: number | null }>();
  if (!row) return null;
  return {
    stablecoinId,
    symbol: getSymbol(stablecoinId),
    oldGrade: row.prev_grade ?? row.grade,
    newGrade: row.grade,
    oldScore: row.prev_score ?? null,
    newScore: row.score ?? null,
  };
}

function buildLaunchEvent(stablecoinId: string): LaunchAlert | null {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) return null;
  return {
    stablecoinId,
    symbol: meta.symbol,
    name: meta.name,
  };
}

function buildReserveEvent(stablecoinId: string): ReserveAlert | null {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) return null;
  return {
    stablecoinId,
    symbol: meta.symbol,
    name: meta.name,
  };
}

async function buildSyntheticAlerts(
  db: D1Database,
  alertType: AlertType,
  stablecoinId: string,
): Promise<ConsolidatedAlerts | null> {
  const alerts = emptyAlerts();
  if (alertType === "dews") {
    const event = await buildDewsEvent(db, stablecoinId);
    if (!event) return null;
    alerts.dews.push(event);
  } else if (alertType === "depeg") {
    const event = await buildDepegEvent(db, stablecoinId);
    if (!event) return null;
    alerts.depegTriggered.push(event);
  } else if (alertType === "safety") {
    const event = await buildSafetyEvent(db, stablecoinId);
    if (!event) return null;
    alerts.safety.push(event);
  } else if (alertType === "launch") {
    const event = buildLaunchEvent(stablecoinId);
    if (!event) return null;
    alerts.launch.push(event);
  } else if (alertType === "reserve") {
    const event = buildReserveEvent(stablecoinId);
    if (!event) return null;
    alerts.reserve.push(event);
  }
  return alerts;
}

export const handleAdminTelegramResend = makeIdempotentAdminRoute<ResendContext>(
  "route-admin-telegram-resend",
  "admin-telegram-resend",
  async ({ db, request, telegramBotToken }) => {
    const parsed = await parseBody(request);
    if (parsed instanceof Response) return parsed;
    const { chatId, alertType, stablecoinId } = parsed;

    if (!telegramBotToken) {
      return adminErrorResponse(500, "TELEGRAM_BOT_TOKEN is not configured");
    }

    const subscriber = await db
      .prepare("SELECT chat_id FROM telegram_subscribers WHERE chat_id = ?")
      .bind(chatId)
      .first<{ chat_id: string }>();
    if (!subscriber) {
      await logAdminAction(
        db,
        {
          action: "admin-telegram-resend",
          target: chatId,
          result: "error",
          httpStatus: 404,
          details: { chatId, alertType, stablecoinId, reason: "subscriber-not-found" },
        },
        request,
      );
      return adminErrorResponse(404, `No telegram_subscribers row for chatId=${chatId}`);
    }

    const alerts = await buildSyntheticAlerts(db, alertType, stablecoinId);
    if (!alerts) {
      await logAdminAction(
        db,
        {
          action: "admin-telegram-resend",
          target: chatId,
          result: "error",
          httpStatus: 422,
          details: { chatId, alertType, stablecoinId, reason: "no-source-data" },
        },
        request,
      );
      return adminErrorResponse(
        422,
        `No source data available to build a ${alertType} alert for ${stablecoinId}`,
      );
    }

    const canonicalHtml = formatConsolidatedMessage(alerts);
    const chunks = splitMessage(canonicalHtml);
    const sendResults: SendToChatResult[] = [];
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const result = await sendToChat(chatId, chunk, telegramBotToken, {
        disableWebPagePreview: true,
        disableNotification: false,
        replyMarkup: buildAlertReplyMarkup(alerts, chunkIndex),
      });
      sendResults.push(result);
      if (!result.ok) break;
    }
    const firstFailure = sendResults.find((result) => !result.ok);
    const result = firstFailure ?? sendResults[sendResults.length - 1];
    if (!result) {
      return adminErrorResponse(500, "Could not render Telegram alert chunks");
    }
    await recordTelegramDeliveryOutcomes(db, [{
      chatId,
      ok: result.ok,
      errorClass: result.errorClass,
      nowSec: Math.floor(Date.now() / 1000),
    }]);

    const httpStatus = result.ok ? 200 : 502;
    const responseBody = {
      ok: result.ok,
      mode: "synthetic_current_state",
      chunkCount: chunks.length,
      chunksAttempted: sendResults.length,
      statusCode: result.statusCode,
      errorClass: result.errorClass,
      retryAfterSec: result.retryAfterSec,
    };

    await logAdminAction(
      db,
      {
        action: "admin-telegram-resend",
        target: chatId,
        result: result.ok ? "ok" : "error",
        httpStatus,
        details: {
          chatId,
          alertType,
          stablecoinId,
          mode: "synthetic_current_state",
          chunkCount: chunks.length,
          chunksAttempted: sendResults.length,
          delivery: result.delivery,
          statusCode: result.statusCode,
          errorClass: result.errorClass,
        },
      },
      request,
    );

    return adminJsonResponse(responseBody, { status: httpStatus });
  },
);
