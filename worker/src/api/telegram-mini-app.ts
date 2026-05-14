import { errorResponse, jsonResponse, parseRequestJsonWithSchema } from "../lib/api-utils";
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

type MiniAppHandler<T extends unknown[]> = (...args: T) => Promise<Response>;

function miniAppErrorHandler<T extends unknown[]>(endpoint: string, handler: MiniAppHandler<T>): MiniAppHandler<T> {
  return async (...args: T): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error(`[api] Error in ${endpoint}:`, err);
      return errorResponse(500, "Internal Server Error", NO_STORE);
    }
  };
}

function rejectOversizedBody(request: Request): Response | null {
  const header = request.headers.get("content-length");
  if (header == null) return null;
  const length = Number(header);
  if (!Number.isFinite(length)) return null;
  if (length > MAX_REQUEST_BODY_BYTES) {
    return errorResponse(413, "Request body too large", NO_STORE);
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
  return errorResponse(401, err.code === "stale-auth" ? "Telegram Mini App session expired" : "Invalid Telegram Mini App session", NO_STORE);
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
  return "mini_app_mutation";
}

function mutationErrorMessage(err: TelegramMiniAppMutationError): string {
  if (err.code === "not-private") return "Mini App mutations are private-chat only";
  if (err.code === "unknown-coin") return "Unknown stablecoin";
  if (err.code === "unknown-preset") return "Unknown Telegram preset";
  if (err.code === "empty-alert-types") return "Choose at least one alert type";
  if (err.code === "preset-unavailable") return "Preset data is temporarily unavailable";
  return "Invalid Mini App mutation";
}

export const handleTelegramMiniAppSession = miniAppErrorHandler(
  "telegram-mini-app-session",
  async (db: D1Database, request: Request, botToken: string | undefined, botTokenPrevious?: string | undefined): Promise<Response> => {
    if (!botToken?.trim()) return errorResponse(503, "Telegram Mini App auth is not configured", NO_STORE);
    const oversize = rejectOversizedBody(request);
    if (oversize) return oversize;
    const parsed = await parseRequestJsonWithSchema(request, TelegramMiniAppSessionRequestSchema, { responseOptions: NO_STORE });
    if (parsed instanceof Response) return parsed;

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
    if (!cooldown.allowed) return errorResponse(429, "Mini App session rate limited", { noStore: true, retryAfterSec: cooldown.retryAfterSec });

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
    if (!botToken?.trim()) return errorResponse(503, "Telegram Mini App auth is not configured", NO_STORE);
    const oversize = rejectOversizedBody(request);
    if (oversize) return oversize;
    const parsed = await parseRequestJsonWithSchema(request, TelegramMiniAppMutationRequestSchema, { responseOptions: NO_STORE });
    if (parsed instanceof Response) return parsed;

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
    if (!cooldown.allowed) return errorResponse(429, "Mini App mutation rate limited", { noStore: true, retryAfterSec: cooldown.retryAfterSec });

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
      return errorResponse(409, "Telegram Mini App mutation already used; relaunch the Mini App and try again", NO_STORE);
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
        return errorResponse(err.status, mutationErrorMessage(err), NO_STORE);
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
