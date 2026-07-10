import type { ZodType } from "zod";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM,
  TelegramMiniAppMutationRequestSchema,
  TelegramMiniAppSessionRequestSchema,
  createTelegramMiniAppSnapshot,
  telegramMiniAppVersionCompatibility,
  type TelegramMiniAppErrorCode,
  type TelegramMiniAppMutableState,
  type TelegramMiniAppOperation,
  type TelegramMiniAppVersionCompatibility,
} from "@shared/lib/telegram-mini-app-contract";
import { TELEGRAM_MINI_APP_CATALOG } from "@shared/lib/telegram-mini-app-catalog";
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
  recordTelegramUsageEvents,
  type TelegramUsageEventInput,
  type TelegramUsageEventType,
} from "../lib/telegram-usage-analytics";
import { acquireTelegramCommandCooldown, unixNow } from "./telegram-webhook-store";
import { TelegramMiniAppMutationError, applyTelegramMiniAppMutation, mutationActionDetail } from "./telegram-mini-app-mutations";
import { acquireTelegramMiniAppMutationBurst } from "./telegram-mini-app-rate-limit";
import { loadTelegramMiniAppState } from "./telegram-mini-app-state";
import { logWorkerEvent } from "../lib/structured-log";

export const TELEGRAM_MINI_APP_SESSION_AUTH_MAX_AGE_SEC = 24 * 60 * 60;
// 5-min mutation window per community consensus; 24h session window preserved for reads.
export const TELEGRAM_MINI_APP_MUTATION_AUTH_MAX_AGE_SEC = 5 * 60;
const SESSION_COOLDOWN_SEC = 2;
const MUTATION_AUTH_FAILURE_COOLDOWN_SEC = 5;
const MUTATION_AUTH_FAILURE_COOLDOWN_KEY = "mini-app:mutation-auth-failure";
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const NO_STORE = { noStore: true };

function miniAppError(
  status: number,
  code: TelegramMiniAppErrorCode,
  message: string,
  options?: JsonResponseOptions,
  details?: { contractVersion?: string; catalogVersion?: string },
): Response {
  const retryAfterSec = options?.retryAfterSec == null
    ? null
    : Math.max(1, Math.ceil(options.retryAfterSec));
  return jsonResponse(
    { error: message, code, ...(retryAfterSec == null ? {} : { retryAfterSec }), ...details },
    { ...NO_STORE, ...options, status, ...(retryAfterSec == null ? {} : { retryAfterSec }) },
  );
}

function versionMismatchResponse(
  compatibility: Exclude<TelegramMiniAppVersionCompatibility, "legacy" | "compatible">,
): Response {
  const message = compatibility === "contract-version-mismatch"
    ? "Telegram Mini App contract version changed"
    : "Telegram Mini App catalog version changed";
  return miniAppError(409, compatibility, message, undefined, {
    contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
    catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
  });
}

function stateResponse(
  state: TelegramMiniAppMutableState,
  compatibility: Extract<TelegramMiniAppVersionCompatibility, "legacy" | "compatible">,
): Response {
  if (compatibility === "legacy") {
    return jsonResponse({ ...state, catalog: TELEGRAM_MINI_APP_CATALOG }, NO_STORE);
  }
  return jsonResponse(createTelegramMiniAppSnapshot(state), NO_STORE);
}

function requestVersionCompatibility(
  request: Request,
  parsed: { contractVersion?: string; catalogVersion?: string },
): TelegramMiniAppVersionCompatibility {
  const query = new URL(request.url).searchParams;
  return telegramMiniAppVersionCompatibility({
    contractVersion: parsed.contractVersion ?? query.get(TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM) ?? undefined,
    catalogVersion: parsed.catalogVersion ?? query.get(TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM) ?? undefined,
  });
}

type MiniAppHandler<T extends unknown[]> = (...args: T) => Promise<Response>;

function miniAppErrorHandler<T extends unknown[]>(endpoint: string, handler: MiniAppHandler<T>): MiniAppHandler<T> {
  return async (...args: T): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      logWorkerEvent({
        scope: "api",
        level: "error",
        event: "telegram_mini_app_handler_error",
        route: endpoint,
        source: "telegram-mini-app",
        message: "Telegram Mini App handler error",
        error: err,
      });
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
  request: Request,
  schema: ZodType<T>,
  invalidPayloadMessage: string,
): Promise<T | Response> {
  const text = await readBoundedRequestText(request);
  if (text instanceof Response) {
    return text;
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return miniAppError(400, "validation-error", invalidPayloadMessage);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return miniAppError(400, "validation-error", invalidPayloadMessage);
  }
  return parsed.data;
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
  await recordTelegramUsageEvent(db, toUsageEventInput(input));
}

function toUsageEventInput(input: {
  eventType: TelegramUsageEventType;
  auth?: TelegramMiniAppAuthContext | null;
  startParam?: string | null;
  actionDetail?: string | null;
  outcome?: string | null;
  failureClass?: string | null;
  latencyMs?: number | null;
}): TelegramUsageEventInput {
  return {
    eventType: input.eventType,
    sourceCategory: sourceCategory(input.auth, input.startParam),
    actionDetail: input.actionDetail,
    outcome: input.outcome,
    failureClass: input.failureClass,
    latencyBucket: bucketTelegramCommandLatency(input.latencyMs ?? null),
  };
}

/**
 * Batch several Mini App telemetry events into one D1 round-trip. The session
 * response path emits up to two independent writes (session_valid plus an
 * optional group_readonly); batching avoids sequential awaited inserts while
 * respecting the shared 6-connection pool (db.batch, never Promise.all).
 */
async function recordMiniAppEvents(
  db: D1Database,
  inputs: Parameters<typeof toUsageEventInput>[0][],
): Promise<void> {
  await recordTelegramUsageEvents(db, inputs.map(toUsageEventInput));
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
  options: { maxAgeSec: number; start: number; cooldownKey: string; cooldownSec: number },
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
        const staleAuth = err.authContext;
        if (staleAuth) {
          const cooldown = await acquireTelegramCommandCooldown(db, {
            chatId: staleAuth.userId,
            commandKey: options.cooldownKey,
            nowSec: unixNow(),
            cooldownSec: options.cooldownSec,
          });
          if (!cooldown.allowed) {
            return miniAppError(429, "rate-limited", "Mini App auth rate limited", {
              retryAfterSec: cooldown.retryAfterSec,
            });
          }
        }
        // Stale-auth requires the HMAC signature to have already validated; emit
        // a usage event so operators can distinguish expired sessions from
        // invalid-signature / invalid-auth (which stay silent to avoid an
        // unauthenticated-write gate). Signed stale-auth carries user context,
        // so acquire the per-user cooldown before the analytics write.
        await recordMiniAppEvent(db, {
          eventType: "mini_app_session_invalid",
          auth: staleAuth,
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

function mutationErrorResponseCode(code: TelegramMiniAppMutationError["code"]): TelegramMiniAppErrorCode {
  if (code === "empty-alert-types") return "invalid-alert-types";
  return code;
}

export const handleTelegramMiniAppSession = miniAppErrorHandler(
  "telegram-mini-app-session",
  async (db: D1Database, request: Request, botToken: string | undefined, botTokenPrevious?: string | undefined): Promise<Response> => {
    const start = Date.now();
    if (!botToken?.trim()) return miniAppError(503, "not-configured", "Telegram Mini App auth is not configured");
    const parsed = await parseMiniAppRequestJson(
      request,
      TelegramMiniAppSessionRequestSchema,
      "Invalid Mini App session payload",
    );
    if (parsed instanceof Response) {
      return parsed;
    }
    const compatibility = requestVersionCompatibility(request, parsed);
    if (compatibility === "contract-version-mismatch" || compatibility === "catalog-version-mismatch") {
      return versionMismatchResponse(compatibility);
    }

    const auth = await validateOrResponse(db, parsed.initData, botToken, {
      maxAgeSec: TELEGRAM_MINI_APP_SESSION_AUTH_MAX_AGE_SEC,
      start,
      cooldownKey: "mini-app:session",
      cooldownSec: SESSION_COOLDOWN_SEC,
    }, botTokenPrevious);
    if (auth instanceof Response) return auth;

    const cooldown = await acquireTelegramCommandCooldown(db, {
      chatId: auth.userId,
      commandKey: "mini-app:session",
      nowSec: unixNow(),
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

    const latencyMs = Date.now() - start;
    const sessionEvents: Parameters<typeof recordMiniAppEvents>[1] = [
      { eventType: "mini_app_session_valid", auth, outcome: "success", latencyMs },
    ];
    if (!auth.canMutatePrivateChat) {
      sessionEvents.push({ eventType: "mini_app_group_readonly", auth, outcome: "readonly", latencyMs });
    }
    await recordMiniAppEvents(db, sessionEvents);

    const state = await loadTelegramMiniAppState(db, auth, {
      nowSec: unixNow(),
      mutationMaxAgeSec: TELEGRAM_MINI_APP_MUTATION_AUTH_MAX_AGE_SEC,
    });
    return stateResponse(state, compatibility);
  },
);

export const handleTelegramMiniAppMutation = miniAppErrorHandler(
  "telegram-mini-app-mutation",
  async (db: D1Database, request: Request, botToken: string | undefined, botTokenPrevious?: string | undefined): Promise<Response> => {
    const start = Date.now();
    if (!botToken?.trim()) return miniAppError(503, "not-configured", "Telegram Mini App auth is not configured");
    const parsed = await parseMiniAppRequestJson(
      request,
      TelegramMiniAppMutationRequestSchema,
      "Invalid Mini App mutation payload",
    );
    if (parsed instanceof Response) {
      return parsed;
    }
    const compatibility = requestVersionCompatibility(request, parsed);
    if (compatibility === "contract-version-mismatch" || compatibility === "catalog-version-mismatch") {
      return versionMismatchResponse(compatibility);
    }

    const auth = await validateOrResponse(db, parsed.initData, botToken, {
      maxAgeSec: TELEGRAM_MINI_APP_MUTATION_AUTH_MAX_AGE_SEC,
      start,
      cooldownKey: MUTATION_AUTH_FAILURE_COOLDOWN_KEY,
      cooldownSec: MUTATION_AUTH_FAILURE_COOLDOWN_SEC,
    }, botTokenPrevious);
    if (auth instanceof Response) return auth;

    const burst = await acquireTelegramMiniAppMutationBurst(db, {
      userId: auth.userId,
      nowSec: unixNow(),
    });
    if (!burst.allowed) {
      await recordMiniAppEvent(db, {
        eventType: "mini_app_mutation_denied",
        auth,
        actionDetail: mutationActionDetail(parsed.operation),
        outcome: "rate_limited",
        failureClass: "rate_limited",
        latencyMs: Date.now() - start,
      });
      return miniAppError(429, "rate-limited", "Pharos Mini App edit limit reached", {
        retryAfterSec: burst.retryAfterSec,
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
    const state = await loadTelegramMiniAppState(db, auth, {
      nowSec: unixNow(),
      mutationMaxAgeSec: TELEGRAM_MINI_APP_MUTATION_AUTH_MAX_AGE_SEC,
    });
    return stateResponse(state, compatibility);
  },
);
