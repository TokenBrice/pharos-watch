"use client";

import {
  isTelegramMiniAppErrorCode,
  type TelegramMiniAppErrorCode,
} from "@shared/lib/telegram-mini-app-contract";

/**
 * Unified Mini App error-message formatter.
 *
 * Both session loads and mutation calls share the same `stale-auth` / 401 / 429 / 503
 * error arms with near-identical copy. The `context` parameter selects the surface
 * (session bootstrap vs. in-session mutation) so we can route to the right default
 * fallback and expose mutation-specific codes only where they apply.
 */

export type MiniAppErrorCode = TelegramMiniAppErrorCode;

export class MiniAppRequestError extends Error {
  readonly status: number;
  readonly code: MiniAppErrorCode | null;
  readonly retryAfterSec: number | null;
  readonly serverContractVersion: string | null;
  readonly serverCatalogVersion: string | null;

  constructor(
    status: number,
    code: MiniAppErrorCode | null = null,
    retryAfterSec: number | null = null,
    versions: { contractVersion?: string | null; catalogVersion?: string | null } = {},
  ) {
    super(`Request failed with ${status}`);
    this.name = "MiniAppRequestError";
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
    this.serverContractVersion = versions.contractVersion ?? null;
    this.serverCatalogVersion = versions.catalogVersion ?? null;
  }
}

export function isMiniAppErrorCode(value: unknown): value is MiniAppErrorCode {
  return isTelegramMiniAppErrorCode(value);
}

export type MiniAppErrorContext = "session" | "mutation";

export function miniAppErrorMessage(err: unknown, context: MiniAppErrorContext): string {
  if (err instanceof MiniAppRequestError) {
    // Shared arm: stale auth produces the same copy in both surfaces.
    if (err.code === "stale-auth") {
      return "This window has expired. Reopen it from PharosWatchBot to keep editing.";
    }
    if (err.code === "contract-version-mismatch" || err.code === "catalog-version-mismatch") {
      return "Pharos was updated. Close and reopen it from PharosWatchBot.";
    }

    if (context === "session") {
      if (err.status === 401) return "Telegram couldn't confirm this window. Close and reopen it from PharosWatchBot.";
      if (err.status === 429) return "Still opening. Wait a moment, then try again.";
      if (err.status === 503) return "Pharos is busy right now. Try again in a minute.";
      return "Couldn't load your alerts. Try again.";
    }

    // context === "mutation"
    switch (err.code) {
      case "rate-limited":
        return "Too many changes in a row. Wait a few seconds, then try again.";
      case "not-private":
        return "Group alerts are managed in the group chat with /settings.";
      case "validation-error":
      case "unknown-coin":
      case "unknown-preset":
      case "invalid-coin-patch":
      case "invalid-alert-types":
      case "invalid-timezone":
        return "That change wasn't accepted. Nothing was saved.";
      case "body-too-large":
        return "That change was too large to send. Nothing was saved.";
      case "not-configured":
      case "preset-unavailable":
        return "Pharos is busy right now. Nothing was saved; try again in a minute.";
      case "stale-bulk-preview":
        return "Your coins changed in the meantime. Nothing was saved; check the list and try again.";
      case "internal":
        return "Something went wrong. We couldn't confirm that change; reopen from PharosWatchBot to check.";
      default:
        break;
    }
    if (err.status >= 500) {
      return "Something went wrong. We couldn't confirm that change; reopen from PharosWatchBot to check.";
    }
    return "Change not saved. Try again.";
  }

  return context === "session"
    ? "Couldn't load your alerts. Check your connection and try again."
    : "Change not confirmed. Check the list before retrying.";
}
