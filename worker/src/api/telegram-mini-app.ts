import { jsonResponse, parseRequestJsonWithSchema } from "../lib/api-utils";
import type { JsonResponseOptions } from "../lib/api-response";
import {
  MINI_APP_MUTATION_INIT_DATA_CACHE_PREFIX,
  TelegramMiniAppAuthError,
  claimTelegramMiniAppMutationInitData,
  validateTelegramMiniAppInitData,
  type TelegramMiniAppAuthContext,
} from "../lib/telegram-mini-app-auth";
import { recordTelegramUsageEvent, type TelegramUsageEventType } from "../lib/telegram-usage-analytics";
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
}): Promise<void> {
  await recordTelegramUsageEvent(db, {
    eventType: input.eventType,
    sourceCategory: sourceCategory(input.auth, input.startParam),
    actionDetail: input.actionDetail,
    outcome: input.outcome,
    failureClass: input.failureClass,
  });
}

function authResponse(err: TelegramMiniAppAuthError): Response {
  if (err.code === "stale-auth") {
    return miniAppError(401, "stale-auth", "Telegram Mini App session expired");
  }
  return miniAppError(401, "validation-error", "Invalid Telegram Mini App session");
}

async function validateOrResponse(
  initData: string,
  botToken: string,
  options: { maxAgeSec: number },
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
    if (!botToken?.trim()) return miniAppError(503, "not-configured", "Telegram Mini App auth is not configured");
    const oversize = rejectOversizedBody(request);
    if (oversize) return oversize;
    const parsed = await parseRequestJsonWithSchema(request, TelegramMiniAppSessionRequestSchema, { responseOptions: NO_STORE });
    if (parsed instanceof Response) {
      // parseRequestJsonWithSchema returns a plain `{ error }` payload. Replay that
      // through the local wrapper so the response carries a stable `code` field.
      return miniAppError(400, "validation-error", "Invalid Mini App session payload");
    }

    const auth = await validateOrResponse(parsed.initData, botToken, {
      maxAgeSec: TELEGRAM_MINI_APP_SESSION_AUTH_MAX_AGE_SEC,
    }, botTokenPrevious);
    if (auth instanceof Response) return auth;

    const cooldown = await acquireTelegramCommandCooldown(db, {
      chatId: auth.userId,
      commandKey: "mini-app:session",
      nowSec: nowSec(),
      cooldownSec: SESSION_COOLDOWN_SEC,
    });
    if (!cooldown.allowed) {
      return miniAppError(429, "rate-limited", "Mini App session rate limited", {
        retryAfterSec: cooldown.retryAfterSec,
      });
    }

    await recordMiniAppEvent(db, { eventType: "mini_app_open", auth, outcome: "success" });
    await recordMiniAppEvent(db, { eventType: "mini_app_session_valid", auth, outcome: "success" });
    if (!auth.canMutatePrivateChat) await recordMiniAppEvent(db, { eventType: "mini_app_group_readonly", auth, outcome: "readonly" });

    return jsonResponse(await loadTelegramMiniAppState(db, auth, {
      nowSec: nowSec(),
      mutationMaxAgeSec: TELEGRAM_MINI_APP_MUTATION_AUTH_MAX_AGE_SEC,
    }), NO_STORE);
  },
);

export const handleTelegramMiniAppMutation = miniAppErrorHandler(
  "telegram-mini-app-mutation",
  async (db: D1Database, request: Request, botToken: string | undefined, botTokenPrevious?: string | undefined): Promise<Response> => {
    if (!botToken?.trim()) return miniAppError(503, "not-configured", "Telegram Mini App auth is not configured");
    const oversize = rejectOversizedBody(request);
    if (oversize) return oversize;
    const parsed = await parseRequestJsonWithSchema(request, TelegramMiniAppMutationRequestSchema, { responseOptions: NO_STORE });
    if (parsed instanceof Response) {
      // parseRequestJsonWithSchema returns a plain `{ error }` payload. Replay through
      // the local wrapper so the response carries a stable `code` field.
      return miniAppError(400, "validation-error", "Invalid Mini App mutation payload");
    }

    const auth = await validateOrResponse(parsed.initData, botToken, {
      maxAgeSec: TELEGRAM_MINI_APP_MUTATION_AUTH_MAX_AGE_SEC,
    }, botTokenPrevious);
    if (auth instanceof Response) return auth;

    const cooldown = await acquireTelegramCommandCooldown(db, {
      chatId: auth.userId,
      commandKey: MUTATION_COOLDOWN_KEY,
      nowSec: nowSec(),
      cooldownSec: MUTATION_COOLDOWN_SEC,
    });
    if (!cooldown.allowed) {
      return miniAppError(429, "rate-limited", "Mini App mutation rate limited", {
        retryAfterSec: cooldown.retryAfterSec,
      });
    }

    const replayClaimed = await claimTelegramMiniAppMutationInitData(
      db,
      auth,
      nowSec(),
      TELEGRAM_MINI_APP_MUTATION_AUTH_MAX_AGE_SEC,
    );
    if (!replayClaimed) {
      await recordMiniAppEvent(db, {
        eventType: "mini_app_mutation_denied",
        auth,
        actionDetail: mutationActionDetail(parsed.operation),
        outcome: "denied",
        failureClass: "replayed-auth",
      });
      return miniAppError(
        409,
        "replay-claimed",
        "Telegram Mini App mutation already used; relaunch the Mini App and try again",
      );
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
        });
        return miniAppError(err.status, mutationErrorResponseCode(err.code), mutationErrorMessage(err));
      }
      // Non-domain failure: roll back the replay claim so the user can retry with the same initData.
      await db
        .prepare("DELETE FROM cache WHERE key = ?")
        .bind(`${MINI_APP_MUTATION_INIT_DATA_CACHE_PREFIX}${auth.initDataHash}`)
        .run()
        .catch((deleteErr) => {
          console.error("[api] Error in telegram-mini-app-mutation replay-claim rollback:", deleteErr);
        });
      throw err;
    }

    await recordMiniAppEvent(db, {
      eventType: mutationEventType(parsed.operation),
      auth,
      actionDetail: mutationActionDetail(parsed.operation),
      outcome: "success",
    });
    return jsonResponse(await loadTelegramMiniAppState(db, auth, {
      nowSec: nowSec(),
      mutationMaxAgeSec: TELEGRAM_MINI_APP_MUTATION_AUTH_MAX_AGE_SEC,
    }), NO_STORE);
  },
);
