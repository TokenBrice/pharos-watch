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
