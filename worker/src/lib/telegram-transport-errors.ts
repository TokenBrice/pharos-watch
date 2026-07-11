export type TelegramTransportErrorClass =
  | "blocked"
  | "chat_not_found"
  | "chat_migrated"
  | "formatting_error"
  | "payload_too_large"
  | "rate_limit"
  | "server_error"
  | "bad_request"
  | "auth_error"
  | "timeout"
  | "network"
  | "unknown";

export interface TelegramTransportFailure {
  errorClass: TelegramTransportErrorClass;
  retryable: boolean;
  permanentFailure: boolean;
  blocked: boolean;
  delivery: "blocked" | "retryable_failure" | "permanent_failure";
  retryAfterSec: number | null;
  rateLimitScope?: "chat" | "global";
  migrateToChatId?: string;
}

interface TelegramErrorPayload {
  description: string | null;
  retryAfterSec: number | null;
  migrateToChatId: string | null;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function numericChatId(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  return null;
}

function parseTelegramErrorPayload(responseBody: string): TelegramErrorPayload {
  if (!responseBody.trim()) {
    return { description: null, retryAfterSec: null, migrateToChatId: null };
  }
  try {
    const parsed = parseJsonObject<{
      description?: unknown;
      parameters?: { retry_after?: unknown; migrate_to_chat_id?: unknown };
      response_parameters?: { retry_after?: unknown; migrate_to_chat_id?: unknown };
    }>(responseBody);
    if (!parsed) return { description: null, retryAfterSec: null, migrateToChatId: null };
    const parameters = parsed.parameters ?? parsed.response_parameters;
    return {
      description: typeof parsed.description === "string" ? parsed.description : null,
      retryAfterSec: finiteNonNegativeInteger(parameters?.retry_after),
      migrateToChatId: numericChatId(parameters?.migrate_to_chat_id),
    };
  } catch {
    return { description: null, retryAfterSec: null, migrateToChatId: null };
  }
}

function isFormattingDescription(description: string): boolean {
  return /(?:can't parse entities|cannot parse entities|unsupported start tag|unsupported end tag|wrong entity|entity.*(?:offset|length)|parse mode)/i.test(
    description,
  );
}

function isPayloadTooLargeDescription(description: string): boolean {
  return /(?:message is too long|request entity too large|payload too large|text is too long)/i.test(description);
}

function isChatNotFoundDescription(description: string): boolean {
  return /(?:chat not found|user not found|peer_id_invalid|chat_id.*(?:invalid|empty)|recipient.*not found)/i.test(
    description,
  );
}

function isBlockedLifecycleDescription(description: string): boolean {
  return /(?:bot was blocked|user is deactivated|bot was kicked|bot is not a member|forbidden: bot can't initiate)/i.test(
    description,
  );
}

function failure(
  errorClass: TelegramTransportErrorClass,
  options: Partial<Omit<TelegramTransportFailure, "errorClass">> = {},
): TelegramTransportFailure {
  const retryable = options.retryable ?? false;
  const blocked = options.blocked ?? false;
  return {
    errorClass,
    retryable,
    permanentFailure: options.permanentFailure ?? !retryable,
    blocked,
    delivery: options.delivery ?? (blocked ? "blocked" : retryable ? "retryable_failure" : "permanent_failure"),
    retryAfterSec: options.retryAfterSec ?? null,
    ...(options.rateLimitScope ? { rateLimitScope: options.rateLimitScope } : {}),
    ...(options.migrateToChatId ? { migrateToChatId: options.migrateToChatId } : {}),
  };
}

/** Parse a bounded Telegram Bot API error body without inferring global scope from delay length. */
export function classifyTelegramResponseFailure(
  statusCode: number,
  responseBody: string,
  retryAfterHeaderSec: number | null,
): TelegramTransportFailure {
  const payload = parseTelegramErrorPayload(responseBody);
  const description = payload.description ?? responseBody;
  const retryAfterSec = payload.retryAfterSec ?? retryAfterHeaderSec;

  if (statusCode === 401) return failure("auth_error");
  if (payload.migrateToChatId != null) {
    return failure("chat_migrated", { migrateToChatId: payload.migrateToChatId });
  }
  if (statusCode === 429) {
    return failure("rate_limit", {
      retryable: true,
      permanentFailure: false,
      retryAfterSec,
      // Telegram does not provide a documented machine-readable global-scope
      // flag. Individual 429s therefore stay chat-local; only the durable
      // distinct-chat controller may infer a bot-wide flood condition.
      rateLimitScope: "chat",
    });
  }
  if (statusCode >= 500) return failure("server_error", { retryable: true, permanentFailure: false });
  if (statusCode === 413 || isPayloadTooLargeDescription(description)) return failure("payload_too_large");
  if (isFormattingDescription(description)) return failure("formatting_error");
  if (isChatNotFoundDescription(description)) return failure("chat_not_found");
  if (statusCode === 403 || isBlockedLifecycleDescription(description)) {
    return failure("blocked", { blocked: true, delivery: "blocked" });
  }
  if (statusCode >= 400 && statusCode < 500) return failure("bad_request");
  return failure("unknown", { retryable: true, permanentFailure: false });
}

export function classifyTelegramCaughtFailure(error: unknown): TelegramTransportFailure {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return failure("timeout", { retryable: true, permanentFailure: false });
  }
  if (error instanceof TypeError) {
    return failure("network", { retryable: true, permanentFailure: false });
  }
  return failure("unknown", { retryable: true, permanentFailure: false });
}

export function isBotWideTelegramFailure(
  result: Pick<TelegramTransportFailure, "errorClass" | "rateLimitScope">,
): boolean {
  return result.errorClass === "auth_error"
    || (result.errorClass === "rate_limit" && result.rateLimitScope === "global");
}

export function isTransientTelegramOutageFailure(
  result: Pick<TelegramTransportFailure, "errorClass">,
): boolean {
  return result.errorClass === "server_error"
    || result.errorClass === "timeout"
    || result.errorClass === "network"
    || result.errorClass === "unknown";
}
import { parseJsonObject } from "./json-parse";
