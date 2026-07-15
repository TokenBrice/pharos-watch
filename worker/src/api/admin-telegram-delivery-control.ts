import { z } from "zod";
import { parseRequestJsonWithSchema } from "../lib/api-utils";
import { logAdminAction } from "../lib/admin-action-audit";
import {
  adminJsonResponse,
  makeConditionalIdempotentAdminRoute,
  type AdminRouteContext,
} from "../lib/route-wrappers";
import {
  readTelegramDeliveryPauses,
  readTelegramTransportCircuit,
  resumeTelegramDelivery,
  setTelegramDeliveryPause,
  TELEGRAM_DELIVERY_MODES,
} from "../lib/telegram-transport-control";
import { acknowledgeExecutionUnknownPendingAlertsForAdmin } from "../cron/telegram-pending";

const PauseRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("pause"),
    mode: z.enum(TELEGRAM_DELIVERY_MODES),
    expectedGeneration: z.number().int().min(0),
    durationSec: z.number().int().min(60).max(86_400),
    reason: z.string().trim().min(1).max(240),
  }),
  z.object({
    action: z.literal("resume"),
    mode: z.enum(TELEGRAM_DELIVERY_MODES),
    expectedGeneration: z.number().int().min(1),
  }),
  z.object({
    action: z.literal("acknowledge_execution_unknown"),
    pendingIds: z.array(z.number().int().positive()).min(1).max(100)
      .refine((ids) => new Set(ids).size === ids.length, "pendingIds must be unique"),
    operatorReason: z.string().trim().min(8).max(500),
  }),
]);

async function stateResponse(db: D1Database, nowSec: number): Promise<Response> {
  const [circuit, pauses] = await Promise.all([
    readTelegramTransportCircuit(db),
    readTelegramDeliveryPauses(db, nowSec),
  ]);
  return adminJsonResponse({ now: nowSec, circuit, pauses });
}

export const handleAdminTelegramDeliveryControl = makeConditionalIdempotentAdminRoute<AdminRouteContext>(
  "route-admin-telegram-delivery-control",
  "admin-telegram-delivery-control",
  ({ request }) => request.method === "POST",
  async ({ db, request }) => {
    const nowSec = Math.floor(Date.now() / 1000);
    if (request.method === "GET" || request.method === "HEAD") {
      return await stateResponse(db, nowSec);
    }

    const parsed = await parseRequestJsonWithSchema(request, PauseRequestSchema, {
      formatSchemaError: (issues) => issues[0]?.message ?? "Invalid Telegram delivery control request",
    });
    if (parsed instanceof Response) return parsed;

    if (parsed.action === "acknowledge_execution_unknown") {
      const acknowledgement = await acknowledgeExecutionUnknownPendingAlertsForAdmin(
        db,
        parsed.pendingIds,
        nowSec,
      );
      if (acknowledgement.missingIds.length > 0) {
        await logAdminAction(db, {
          action: "telegram-execution-unknown-acknowledge",
          target: parsed.pendingIds.join(","),
          result: "error",
          httpStatus: 409,
          details: {
            pendingIds: parsed.pendingIds,
            missingIds: acknowledgement.missingIds,
            operatorReason: parsed.operatorReason,
            reason: "execution-unknown-row-changed",
          },
        }, request);
        return adminJsonResponse({
          error: "Telegram execution-unknown rows changed; inspect current state before retrying",
          missingIds: acknowledgement.missingIds,
        }, { status: 409 });
      }
      await logAdminAction(db, {
        action: "telegram-execution-unknown-acknowledge",
        target: acknowledgement.acknowledgedIds.join(","),
        result: "ok",
        httpStatus: 200,
        details: {
          pendingIds: acknowledgement.acknowledgedIds,
          operatorReason: parsed.operatorReason,
          disposition: "execution_unknown_archived",
        },
      }, request);
      return adminJsonResponse({
        now: nowSec,
        acknowledgement: {
          pendingIds: acknowledgement.acknowledgedIds,
          disposition: "execution_unknown_archived",
        },
      });
    }

    const actor = (request.headers.get("Cf-Access-Authenticated-User-Email")?.trim() || "internal").slice(0, 320);
    const pause = parsed.action === "pause"
      ? await setTelegramDeliveryPause(db, {
          mode: parsed.mode,
          expectedGeneration: parsed.expectedGeneration,
          expiresAt: nowSec + parsed.durationSec,
          reason: parsed.reason,
          actor,
          nowSec,
          auditAction: "telegram-delivery-pause",
        })
      : await resumeTelegramDelivery(db, {
          mode: parsed.mode,
          expectedGeneration: parsed.expectedGeneration,
          actor,
          nowSec,
          auditAction: "telegram-delivery-resume",
        });

    if (!pause) {
      await logAdminAction(
        db,
        {
          action: `telegram-delivery-${parsed.action}`,
          target: parsed.mode,
          result: "error",
          httpStatus: 409,
          details: {
            mode: parsed.mode,
            expectedGeneration: parsed.expectedGeneration,
            reason: "generation-conflict",
          },
        },
        request,
      );
      return adminJsonResponse(
        { error: "Telegram delivery control changed; reload state before retrying" },
        { status: 409 },
      );
    }

    return await stateResponse(db, nowSec);
  },
);
