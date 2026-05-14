import type { ZodType } from "zod";
import { jsonResponse } from "../lib/api-utils";
import type { JsonResponseOptions } from "../lib/api-response";
import {
  TelegramMiniAppAuthError,
  validateTelegramMiniAppInitData,
  type TelegramMiniAppAuthContext,
} from "../lib/telegram-mini-app-auth";
import {
  bucketTelegramCommandLatency,
  recordTelegramUsageEvent,
  type TelegramUsageEventType,
} from "../lib/telegram-usage-analytics";
import { acquireTelegramCommandCooldown } from "./telegram-webhook-store";
import { TelegramMiniAppMutationRequestSchema, TelegramMiniAppSessionRequestSchema, type TelegramMiniAppOperation } from "./telegram-mini-app-schemas";
import { TelegramMiniAppMutationError, applyTelegramMiniAppMutation, mutationActionDetail } from "./telegram-mini-app-mutations";
import { loadTelegramMiniAppState } from "./telegram-mini-app-state";

export const TELEGRAM_MINI_APP_SESSION_AUTH_MAX_AGE_SEC = 24 * 60 * 60;
// 5-min mutation window per community consensus; 24h session window preserved for reads.
export const TELEGRAM_MINI_APP_MUTATION_AUTH_MAX_AGE_SEC = 5 * 60;
const SESSION_COOLDOWN_SEC = 2;
const MUTATION_COOLDOWN_SEC = 5;
const MUTATION_COOLDOWN_KEY = "mini-app:mutation:any";
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const NO_STORE = { noStore: true };

/**
 * Stable machine-readable error codes the Mini App frontend can switch on
 * without parsing free-form messages. Add new codes when extending the
 * mutation surface and update the consuming clients in lockstep.
 */
type MiniAppErrorCode =
  | "stale-auth"
  | "replay-claimed"
  | "not-private"
  | "rate-limited"
  | "validation-error"
  | "body-too-large"
  | "internal"
  | "not-configured"
  | "preset-unavailable"
  | "unknown-coin"
  | "unknown-preset"
  | "invalid-coin-patch"
  | "invalid-alert-types"
  | "invalid-timezone";

function miniAppError(
  status: number,
  code: MiniAppErrorCode,
  message: string,
  options?: JsonResponseOptions,
): Response {
  return jsonResponse({ error: message, code }, { ...NO_STORE, ...options, status });
}

type MiniAppHandler<T extends unknown[]> = (...args: T) => Promise<Response>;

function miniAppErrorHandler<T extends unknown[]>(endpoint: string, handler: MiniAppHandler<T>): MiniAppHandler<T> {
  return async (...args: T): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error(`[api] Error in ${endpoint}:`, err);
      return miniAppError(500, "internal", "Internal Server Error");
    }
  };
}

function rejectOversizedBody(request: Request): Response | null {
  const header = request.headers.get("content-length");
  if (header == null) return null;
  const length = Number(header);
  if (!Number.isFinite(length)) return null;
  if (length > MAX_REQUEST_BODY_BYTES) {
    return miniAppError(413, "body-too-large", "Request body too large");
  }
  return null;
}

type PreAuthDenialReason = "body-too-large" | "validation-error";

async function recordPreAuthDenial(
  db: D1Database,
  deniedEventType: TelegramUsageEventType,
  failureClass: PreAuthDenialReason,
  latencyMs: number,
): Promise<void> {
  // Body-cap / JSON-parse denials fire BEFORE HMAC validation, so no auth
  // context is available. recordTelegramUsageEvent aggregates by event_type /
  // source / outcome / failure_class only (no chat_id key), so we can still
  // emit a count for abuse-signal visibility.
  await recordMiniAppEvent(db, {
    eventType: deniedEventType,
    outcome: "rejected",
    failureClass,
    latencyMs,
  });
}

async function readBoundedRequestText(request: Request): Promise<string | Response> {
  const headerRejection = rejectOversizedBody(request);
  if (headerRejection) return headerRejection;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return miniAppError(413, "body-too-large", "Request body too large");
      }
      chunks.push(value);
    }
  } catch {
    return miniAppError(400, "validation-error", "Invalid Mini App request body");
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function parseMiniAppRequestJson<T>(
  db: D1Database,
  request: Request,
  schema: ZodType<T>,
  invalidPayloadMessage: string,
  deniedEventType: TelegramUsageEventType,
  start: number,
): Promise<T | Response> {
  const text = await readBoundedRequestText(request);
  if (text instanceof Response) {
    // 413 body-too-large or read-error path. Surface as an abuse signal so
    // operators see body-cap rejections; emission is keyed on event_type only.
    const failureClass: PreAuthDenialReason = text.status === 413 ? "body-too-large" : "validation-error";
    await recordPreAuthDenial(db, deniedEventType, failureClass, Date.now() - start);
    return text;
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    await recordPreAuthDenial(db, deniedEventType, "validation-error", Date.now() - start);
    return miniAppError(400, "validation-error", invalidPayloadMessage);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    await recordPreAuthDenial(db, deniedEventType, "validation-error", Date.now() - start);
    return miniAppError(400, "validation-error", invalidPayloadMessage);
  }
  return parsed.data;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function sourceCategory(auth?: TelegramMiniAppAuthContext | null, startParam?: string | null): string {
  return (auth?.startParam ?? startParam)?.trim() ? "startapp" : "menu_or_main_app";
}

async function recordMiniAppEvent(db: D1Database, input: {
  eventType: TelegramUsageEventType;
  auth?: TelegramMiniAppAuthContext | null;
  startParam?: string | null;
  actionDetail?: string | null;
  outcome?: string | null;
  failureClass?: string | null;
  latencyMs?: number | null;
}): Promise<void> {
  await recordTelegramUsageEvent(db, {
    eventType: input.eventType,
    sourceCategory: sourceCategory(input.auth, input.startParam),
    actionDetail: input.actionDetail,
    outcome: input.outcome,
    failureClass: input.failureClass,
    latencyBucket: bucketTelegramCommandLatency(input.latencyMs ?? null),
  });
}

function authResponse(err: TelegramMiniAppAuthError): Response {
  if (err.code === "stale-auth") {
    return miniAppError(401, "stale-auth", "Telegram Mini App session expired");
  }
  return miniAppError(401, "validation-error", "Invalid Telegram Mini App session");
}

async function validateOrResponse(
  db: D1Database,
  initData: string,
  botToken: string,
  options: { maxAgeSec: number; start: number },
  botTokenPrevious?: string,
): Promise<TelegramMiniAppAuthContext | Response> {
  try {
    return await validateTelegramMiniAppInitData(
      initData,
      botToken,
      { maxAgeSec: options.maxAgeSec },
      botTokenPrevious,
    );
  } catch (err) {
    if (err instanceof TelegramMiniAppAuthError) {
      if (err.code === "stale-auth") {
        // Stale-auth requires the HMAC signature to have already validated; emit
        // a usage event so operators can distinguish expired sessions from
        // invalid-signature / invalid-auth (which stay silent to avoid an
        // unauthenticated-write gate). See backend audit F5 / T-63.
        await recordMiniAppEvent(db, {
          eventType: "mini_app_session_invalid",
          outcome: err.code,
          failureClass: err.code,
          latencyMs: Date.now() - options.start,
        });
      }
      return authResponse(err);
    }
    throw err;
  }
}

function mutationEventType(operation: TelegramMiniAppOperation): TelegramUsageEventType {
  if (operation.kind === "recommended-setup") return "mini_app_recommended_setup";
  if (operation.kind === "set-coin") return "mini_app_coin_add";
  if (operation.kind === "remove-coin") return "mini_app_coin_remove";
  if (operation.kind === "set-quiet-hours") return "mini_app_quiet_hours";
  if (operation.kind === "set-snooze") return "mini_app_snooze";
  if (operation.kind === "set-coin-snooze") return "mini_app_coin_snooze";
  if (operation.kind === "set-timezone") return "timezone_change";
  if (operation.kind === "unsubscribe-all") return "unsubscribe";
  if (operation.kind === "forget-me") return "mini_app_forget";
  return "mini_app_mutation";
}

function mutationErrorMessage(err: TelegramMiniAppMutationError): string {
  if (err.code === "not-private") return "Mini App mutations are private-chat only";
  if (err.code === "unknown-coin") return "Unknown stablecoin";
  if (err.code === "unknown-preset") return "Unknown Telegram preset";
  if (err.code === "empty-alert-types") return "Choose at least one alert type";
  if (err.code === "preset-unavailable") return "Preset data is temporarily unavailable";
  if (err.code === "invalid-timezone") return "Unknown timezone";
  return "Invalid Mini App mutation";
}

function mutationErrorResponseCode(code: TelegramMiniAppMutationError["code"]): MiniAppErrorCode {
  if (code === "empty-alert-types") return "invalid-alert-types";
  return code;
}

export const handleTelegramMiniAppSession = miniAppErrorHandler(
  "telegram-mini-app-session",
  async (db: D1Database, request: Request, botToken: string | undefined, botTokenPrevious?: string | undefined): Promise<Response> => {
    const start = Date.now();
    if (!botToken?.trim()) return miniAppError(503, "not-configured", "Telegram Mini App auth is not configured");
    const parsed = await parseMiniAppRequestJson(
      db,
      request,
      TelegramMiniAppSessionRequestSchema,
      "Invalid Mini App session payload",
      "mini_app_session_invalid",
      start,
    );
    if (parsed instanceof Response) {
      return parsed;
    }

    const auth = await validateOrResponse(db, parsed.initData, botToken, {
      maxAgeSec: TELEGRAM_MINI_APP_SESSION_AUTH_MAX_AGE_SEC,
      start,
    }, botTokenPrevious);
    if (auth instanceof Response) return auth;

    const cooldown = await acquireTelegramCommandCooldown(db, {
      chatId: auth.userId,
      commandKey: "mini-app:session",
      nowSec: nowSec(),
      cooldownSec: SESSION_COOLDOWN_SEC,
    });
    if (!cooldown.allowed) {
      await recordMiniAppEvent(db, {
        eventType: "mini_app_session_invalid",
        auth,
        outcome: "rate_limited",
        failureClass: "rate_limited",
        latencyMs: Date.now() - start,
      });
      return miniAppError(429, "rate-limited", "Mini App session rate limited", {
        retryAfterSec: cooldown.retryAfterSec,
      });
    }

    await recordMiniAppEvent(db, { eventType: "mini_app_open", auth, outcome: "success", latencyMs: Date.now() - start });
    await recordMiniAppEvent(db, { eventType: "mini_app_session_valid", auth, outcome: "success", latencyMs: Date.now() - start });
    if (!auth.canMutatePrivateChat) await recordMiniAppEvent(db, { eventType: "mini_app_group_readonly", auth, outcome: "readonly", latencyMs: Date.now() - start });

    return jsonResponse(await loadTelegramMiniAppState(db, auth, {
      nowSec: nowSec(),
      mutationMaxAgeSec: TELEGRAM_MINI_APP_MUTATION_AUTH_MAX_AGE_SEC,
    }), NO_STORE);
  },
);

export const handleTelegramMiniAppMutation = miniAppErrorHandler(
  "telegram-mini-app-mutation",
  async (db: D1Database, request: Request, botToken: string | undefined, botTokenPrevious?: string | undefined): Promise<Response> => {
    const start = Date.now();
    if (!botToken?.trim()) return miniAppError(503, "not-configured", "Telegram Mini App auth is not configured");
    const parsed = await parseMiniAppRequestJson(
      db,
      request,
      TelegramMiniAppMutationRequestSchema,
      "Invalid Mini App mutation payload",
      "mini_app_mutation_denied",
      start,
    );
    if (parsed instanceof Response) {
      return parsed;
    }

    const auth = await validateOrResponse(db, parsed.initData, botToken, {
      maxAgeSec: TELEGRAM_MINI_APP_MUTATION_AUTH_MAX_AGE_SEC,
      start,
    }, botTokenPrevious);
    if (auth instanceof Response) return auth;

    const cooldown = await acquireTelegramCommandCooldown(db, {
      chatId: auth.userId,
      commandKey: MUTATION_COOLDOWN_KEY,
      nowSec: nowSec(),
      cooldownSec: MUTATION_COOLDOWN_SEC,
    });
    if (!cooldown.allowed) {
      await recordMiniAppEvent(db, {
        eventType: "mini_app_mutation_denied",
        auth,
        actionDetail: mutationActionDetail(parsed.operation),
        outcome: "rate_limited",
        failureClass: "rate_limited",
        latencyMs: Date.now() - start,
      });
      return miniAppError(429, "rate-limited", "Mini App mutation rate limited", {
        retryAfterSec: cooldown.retryAfterSec,
      });
    }

    try {
      await applyTelegramMiniAppMutation(db, auth, parsed.operation);
    } catch (err) {
      if (err instanceof TelegramMiniAppMutationError) {
        await recordMiniAppEvent(db, {
          eventType: "mini_app_mutation_denied",
          auth,
          actionDetail: mutationActionDetail(parsed.operation),
          outcome: err.code === "not-private" ? "denied" : "validation_error",
          failureClass: err.code,
          latencyMs: Date.now() - start,
        });
        return miniAppError(err.status, mutationErrorResponseCode(err.code), mutationErrorMessage(err));
      }
      throw err;
    }

    await recordMiniAppEvent(db, {
      eventType: mutationEventType(parsed.operation),
      auth,
      actionDetail: mutationActionDetail(parsed.operation),
      outcome: "success",
      latencyMs: Date.now() - start,
    });
    return jsonResponse(await loadTelegramMiniAppState(db, auth, {
      nowSec: nowSec(),
      mutationMaxAgeSec: TELEGRAM_MINI_APP_MUTATION_AUTH_MAX_AGE_SEC,
    }), NO_STORE);
  },
);
