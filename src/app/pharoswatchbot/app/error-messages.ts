"use client";

/**
 * Unified Mini App error-message formatter.
 *
 * Both session loads and mutation calls share the same `stale-auth` / 401 / 429 / 503
 * error arms with near-identical copy. The `context` parameter selects the surface
 * (session bootstrap vs. in-session mutation) so we can route to the right default
 * fallback and expose mutation-specific codes only where they apply.
 */

export const MINI_APP_ERROR_CODES = [
  "stale-auth",
  "not-private",
  "rate-limited",
  "validation-error",
  "body-too-large",
  "internal",
  "not-configured",
  "preset-unavailable",
  "unknown-coin",
  "unknown-preset",
  "invalid-coin-patch",
  "invalid-alert-types",
  "invalid-timezone",
] as const;

export type MiniAppErrorCode = (typeof MINI_APP_ERROR_CODES)[number];

const MINI_APP_ERROR_CODE_SET: ReadonlySet<string> = new Set(MINI_APP_ERROR_CODES);

export class MiniAppRequestError extends Error {
  readonly status: number;
  readonly code: MiniAppErrorCode | null;
  readonly retryAfterSec: number | null;

  constructor(status: number, code: MiniAppErrorCode | null = null, retryAfterSec: number | null = null) {
    super(`Request failed with ${status}`);
    this.name = "MiniAppRequestError";
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

export function isMiniAppErrorCode(value: unknown): value is MiniAppErrorCode {
  return typeof value === "string" && MINI_APP_ERROR_CODE_SET.has(value);
}

export type MiniAppErrorContext = "session" | "mutation";

export function miniAppErrorMessage(err: unknown, context: MiniAppErrorContext): string {
  if (err instanceof MiniAppRequestError) {
    // Shared arm: stale auth produces the same copy in both surfaces.
    if (err.code === "stale-auth") {
      return "Telegram authorization expired. Close and reopen from PharosWatchBot.";
    }

    if (context === "session") {
      if (err.status === 401) return "Telegram launch authorization was rejected. Close and reopen from PharosWatchBot.";
      if (err.status === 429) return "Telegram is still opening your session. Wait a moment, then retry.";
      if (err.status === 503) return "Telegram Mini App auth is temporarily unavailable. Try again shortly.";
      return "Could not load Mini App settings. Reopen from Telegram or try again.";
    }

    // context === "mutation"
    switch (err.code) {
      case "rate-limited":
        return "Pharos edit limit reached. Wait for the countdown before editing again.";
      case "not-private":
        return "This Mini App can only edit personal alerts. Use the bot commands in groups.";
      case "validation-error":
      case "unknown-coin":
      case "unknown-preset":
      case "invalid-coin-patch":
      case "invalid-alert-types":
      case "invalid-timezone":
        return "Change was rejected by the server.";
      case "body-too-large":
        return "Request was too large to send.";
      case "not-configured":
      case "preset-unavailable":
        return "Mini App backend is temporarily unavailable. Try again shortly.";
      case "internal":
        return "Something went wrong. Try again or reopen Telegram.";
      default:
        break;
    }
    if (err.status >= 500) return "Something went wrong. Try again or reopen Telegram.";
    return "Change was not saved. Reopen from Telegram if authorization expired.";
  }

  return context === "session"
    ? "Could not load Mini App settings. Reopen from Telegram or try again."
    : "Change was not saved. Reopen from Telegram if authorization expired.";
}
