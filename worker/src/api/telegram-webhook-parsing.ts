import type { ResolvedCoin } from "../lib/telegram-alerts";
import { dedupeCoins } from "../lib/telegram-coin-dedupe";
import { isDepegStepValue } from "../lib/telegram-constants";
import { toErrorMessage } from "../lib/error-utils";
import {
  TELEGRAM_MINI_APP_PAYLOAD_PATTERN,
  TELEGRAM_START_PAYLOAD_MAX_LENGTH,
} from "@shared/lib/telegram-mini-app-payloads";
import type {
  ConfirmBulkPayload,
  ParsedSetCommand,
  PendingAction,
  PendingActionType,
  PendingDisambiguationRow,
  PendingSetupSentinel,
} from "./telegram-webhook-shared";
import { SETUP_PENDING_ACTION_TYPE, STABLECOIN_BY_ID } from "./telegram-webhook-shared";

function logPendingParseWarning(pending: PendingDisambiguationRow, field: string, error: unknown): void {
  const actionType = pending.action_type ?? "unknown";
  const message = toErrorMessage(error);
  console.warn(
    `[telegram-webhook] malformed pending field action=${actionType} ambiguous=${pending.ambiguous_ticker} field=${field} error=${message}`,
  );
}

function parsePendingActionType(value: string | null | undefined): PendingActionType | null {
  if (
    value === "subscribe"
    || value === "unsubscribe"
    || value === "set"
    || value === "confirm-bulk"
    || value === "forget-confirm"
  ) {
    return value;
  }
  return null;
}

function parseImportPreview(value: unknown): Extract<ConfirmBulkPayload, { kind: "watchlist-import-v2" }>["preview"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const preview = value as Record<string, unknown>;
  const parsed = {
    directAdds: parseStringArray(preview.directAdds),
    directRemoves: parseStringArray(preview.directRemoves),
    directChanges: parseStringArray(preview.directChanges),
    directChangeBefore: parseStringArray(preview.directChangeBefore),
    presetAdds: parseStringArray(preview.presetAdds),
    presetRemoves: parseStringArray(preview.presetRemoves),
    presetChanges: parseStringArray(preview.presetChanges),
    presetChangeBefore: parseStringArray(preview.presetChangeBefore),
  };
  const inputLengths = [
    preview.directAdds,
    preview.directRemoves,
    preview.directChanges,
    preview.directChangeBefore,
    preview.presetAdds,
    preview.presetRemoves,
    preview.presetChanges,
    preview.presetChangeBefore,
  ].map((entry) => Array.isArray(entry) ? entry.length : -1);
  const outputLengths = Object.values(parsed).map((entry) => entry.length);
  return inputLengths.every((length, index) => length >= 0 && length === outputLengths[index])
      && parsed.directChangeBefore.length === parsed.directChanges.length
      && parsed.presetChangeBefore.length === parsed.presetChanges.length
    ? parsed
    : null;
}

export function parseStoredConfirmBulkPayload(payload: Record<string, unknown>): ConfirmBulkPayload | null {
  const kind = typeof payload.kind === "string" ? payload.kind : null;
  if (kind === "subscribe") {
    const depegWorseningBpsStep =
      isDepegStepValue(payload.depegWorseningBpsStep) ||
      payload.depegWorseningBpsStep === null
        ? (payload.depegWorseningBpsStep as 100 | 250 | 500 | null)
        : undefined;
    return {
      kind,
      alertTypes: parseStringArray(payload.alertTypes),
      presetIds: parseStringArray(payload.presetIds),
      depegWorseningBpsStep,
      coinIds: parseStringArray(payload.coinIds),
      subscribeAll: payload.subscribeAll === true,
    };
  }
  if (kind === "unsubscribe") {
    return {
      kind,
      presetIds: parseStringArray(payload.presetIds),
      coinIds: parseStringArray(payload.coinIds),
      unsubscribeAll: payload.unsubscribeAll === true,
    };
  }
  if (kind === "watchlist-import-v2") {
    const preview = parseImportPreview(payload.preview);
    const directEntries = parseStringArray(payload.directEntries);
    const presetEntries = parseStringArray(payload.presetEntries);
    if (
      !preview
      || !Array.isArray(payload.directEntries)
      || directEntries.length !== payload.directEntries.length
      || !Array.isArray(payload.presetEntries)
      || presetEntries.length !== payload.presetEntries.length
      || typeof payload.registryVersion !== "string"
      || payload.registryVersion.length < 1
      || payload.registryVersion.length > 64
      || !Number.isSafeInteger(payload.expectedPreferenceGeneration)
      || Number(payload.expectedPreferenceGeneration) < 0
      || !Number.isSafeInteger(payload.generationLease)
      || Number(payload.generationLease) < 1_000_000_000_000_000
    ) {
      return null;
    }
    return {
      kind,
      registryVersion: payload.registryVersion,
      directEntries,
      presetEntries,
      expectedPreferenceGeneration: Number(payload.expectedPreferenceGeneration),
      generationLease: Number(payload.generationLease),
      preview,
    };
  }
  return null;
}

function parsePendingJsonField<T>(
  pending: PendingDisambiguationRow,
  field: keyof Pick<
    PendingDisambiguationRow,
    "action_payload" | "alert_types" | "resolved_ids" | "candidates" | "remaining_tickers"
  >,
  fallback: T,
  transform: (value: unknown) => T,
): T {
  const rawValue = pending[field];
  if (!rawValue) {
    return fallback;
  }

  try {
    return transform(JSON.parse(rawValue));
  } catch (error) {
    logPendingParseWarning(pending, field, error);
    return fallback;
  }
}

export function parseCommand(text: string): { command: string; args: string; botMention: string | null } {
  const spaceIdx = text.indexOf(" ");
  const commandToken = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
  const mentionIdx = commandToken.indexOf("@");
  const rawCommand = mentionIdx === -1 ? commandToken : commandToken.slice(0, mentionIdx);
  const rawMention = mentionIdx === -1 ? "" : commandToken.slice(mentionIdx + 1);
  const command = rawCommand.toLowerCase();
  const botMention = rawMention ? rawMention.toLowerCase() : null;
  const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
  return { command, args, botMention };
}

export function parseStoredSetCommand(payload: Record<string, unknown>): ParsedSetCommand | null {
  const ticker = typeof payload.ticker === "string" ? payload.ticker : "unknown";
  const setting = typeof payload.setting === "string" ? payload.setting : null;
  switch (setting) {
    case "dews":
      return {
        ticker,
        setting,
        enabled: payload.enabled !== false,
        minBand: payload.minBand === "WARNING" || payload.minBand === "DANGER" ? payload.minBand : null,
      };
    case "safety":
      return {
        ticker,
        setting,
        enabled: payload.enabled !== false,
        mode: payload.mode === "downgrade-only" || payload.mode === "upgrade-only" ? payload.mode : null,
      };
    case "launch":
      return {
        ticker,
        setting,
        enabled: payload.enabled !== false,
      };
    case "reserve":
      return {
        ticker,
        setting,
        enabled: payload.enabled !== false,
      };
    case "depeg":
      return {
        ticker,
        setting,
        enabled: payload.enabled !== false,
      };
    case "depeg-step":
      return {
        ticker,
        setting,
        enabled: true,
        step: isDepegStepValue(payload.step) ? (payload.step as 100 | 250 | 500) : null,
      };
    default:
      return null;
  }
}

export function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function parseResolvedCoins(value: unknown): ResolvedCoin[] {
  if (!Array.isArray(value)) return [];

  const coins: ResolvedCoin[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const coin = item as Partial<ResolvedCoin>;
    if (typeof coin.id !== "string" || typeof coin.symbol !== "string" || typeof coin.name !== "string") {
      continue;
    }
    coins.push({ id: coin.id, symbol: coin.symbol, name: coin.name });
  }
  return coins;
}

// Re-exported from worker/src/lib/telegram-coin-dedupe.ts so existing API-layer
// importers keep their import path; the store layer imports it from lib directly.
export { dedupeCoins };

export function parsePendingDisambiguation(
  pending: PendingDisambiguationRow,
): PendingAction | PendingSetupSentinel | null {
  // Setup-wizard rows share this table but are not disambiguation actions.
  // Return a typed sentinel so callers must branch on it explicitly rather than
  // mistaking a live setup session for "no pending action".
  if (pending.action_type === SETUP_PENDING_ACTION_TYPE) {
    return { actionType: SETUP_PENDING_ACTION_TYPE };
  }

  const actionType = parsePendingActionType(pending.action_type ?? "subscribe");
  if (!actionType) {
    console.warn(
      `[telegram-webhook] malformed pending action_type ambiguous=${pending.ambiguous_ticker} value=${String(pending.action_type)}`,
    );
    return null;
  }

  const payload = parsePendingJsonField<Record<string, unknown>>(pending, "action_payload", {}, (value) =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {},
  );

  if (actionType === "confirm-bulk") {
    const bulkPayload = parseStoredConfirmBulkPayload(payload);
    if (!bulkPayload) return null;
    return {
      actionType,
      payload: bulkPayload,
      initiatorUserId: pending.initiator_user_id ?? null,
    };
  }

  if (actionType === "forget-confirm") {
    // No payload required; presence of the row + non-expired TTL is the gate.
    return {
      actionType,
      initiatorUserId: pending.initiator_user_id ?? null,
    };
  }

  const legacyAlertTypes = new Set(parsePendingJsonField(pending, "alert_types", [], parseStringArray));
  const resolvedIds = parsePendingJsonField(pending, "resolved_ids", [], parseStringArray);
  const candidates = parsePendingJsonField(pending, "candidates", [], parseResolvedCoins);
  const remainingTickers = parsePendingJsonField(pending, "remaining_tickers", [], parseStringArray);

  if (candidates.length === 0) return null;

  const resolvedCoins = dedupeCoins(resolvedIds.map((id) => STABLECOIN_BY_ID.get(id) ?? { id, symbol: id, name: id }));

  if (actionType === "subscribe") {
    const actionAlertTypes = new Set(
      Array.isArray(payload.alertTypes) ? parseStringArray(payload.alertTypes) : Array.from(legacyAlertTypes),
    );
    const depegWorseningBpsStep =
      isDepegStepValue(payload.depegWorseningBpsStep) ||
      payload.depegWorseningBpsStep === null
        ? (payload.depegWorseningBpsStep as 100 | 250 | 500 | null)
        : undefined;
    return {
      actionType,
      alertTypes: actionAlertTypes,
      presetIds: parseStringArray(payload.presetIds),
      depegWorseningBpsStep,
      resolvedCoins,
      initiatorUserId: pending.initiator_user_id ?? null,
      ambiguousTicker: pending.ambiguous_ticker,
      candidates,
      remainingTickers,
    };
  }

  if (actionType === "unsubscribe") {
    return {
      actionType,
      presetIds: parseStringArray(payload.presetIds),
      resolvedCoins,
      initiatorUserId: pending.initiator_user_id ?? null,
      ambiguousTicker: pending.ambiguous_ticker,
      candidates,
      remainingTickers,
    };
  }

  const setCommand = parseStoredSetCommand(payload);
  if (!setCommand) return null;
  return {
    actionType: "set",
    command: setCommand,
    resolvedCoins,
    initiatorUserId: pending.initiator_user_id ?? null,
    ambiguousTicker: pending.ambiguous_ticker,
    candidates,
    remainingTickers,
  };
}

export function parseSetCommand(args: string): ParsedSetCommand | { error: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) {
    return { error: "Usage: /set <ticker> <setting> <value>" };
  }

  const [ticker, rawSetting, ...valueParts] = tokens;
  const setting = rawSetting.toLowerCase();
  const value = valueParts.join(" ").toLowerCase();

  switch (setting) {
    case "dews": {
      if (value === "off") {
        return { ticker, setting: "dews", enabled: false, minBand: null };
      }
      if (value === "alert" || value === "on") {
        return { ticker, setting: "dews", enabled: true, minBand: null };
      }
      if (value === "warning") {
        return { ticker, setting: "dews", enabled: true, minBand: "WARNING" };
      }
      if (value === "danger") {
        return { ticker, setting: "dews", enabled: true, minBand: "DANGER" };
      }
      return { error: "DEWS values: off, ALERT, WARNING, DANGER" };
    }
    case "safety": {
      if (value === "off") {
        return { ticker, setting: "safety", enabled: false, mode: null };
      }
      if (value === "all" || value === "on") {
        return { ticker, setting: "safety", enabled: true, mode: null };
      }
      if (value === "downgrade-only" || value === "upgrade-only") {
        return { ticker, setting: "safety", enabled: true, mode: value };
      }
      return { error: "Safety values: off, all, downgrade-only, upgrade-only" };
    }
    case "depeg": {
      if (value === "on") {
        return { ticker, setting: "depeg", enabled: true };
      }
      if (value === "off") {
        return { ticker, setting: "depeg", enabled: false };
      }
      return { error: "Depeg values: on, off" };
    }
    case "launch": {
      if (value === "on") {
        return { ticker, setting: "launch", enabled: true };
      }
      if (value === "off") {
        return { ticker, setting: "launch", enabled: false };
      }
      return { error: "Launch values: on, off" };
    }
    case "reserve": {
      if (value === "on") {
        return { ticker, setting: "reserve", enabled: true };
      }
      if (value === "off") {
        return { ticker, setting: "reserve", enabled: false };
      }
      return { error: "Reserve values: on, off" };
    }
    case "depeg-step": {
      if (value === "off") {
        return { ticker, setting: "depeg-step", enabled: true, step: null };
      }
      const step = Number(value);
      if (isDepegStepValue(step)) {
        return { ticker, setting: "depeg-step", enabled: true, step };
      }
      return { error: "Depeg-step values: off, 100, 250, 500" };
    }
    default:
      return { error: "Supported settings: dews, safety, depeg, depeg-step, launch, reserve" };
  }
}

export type ParsedStartPayload =
  | { kind: "none" }
  | { kind: "setup" }
  | { kind: "sample" }
  | { kind: "app" }
  | { kind: "subscribe"; args: string }
  | { kind: "status"; coinId: string }
  | { kind: "why"; coinId: string }
  | { kind: "coverage"; coinId: string };

/**
 * Parse a Telegram `/start <payload>` deep-link payload into a typed action.
 * Payload schemes (all lowercase, no spaces):
 * - `sub_<types>_<targets>` (e.g. `sub_dews-depeg_usd-top25`) → subscribe
 * - `status_<id>` / `why_<id>` / `coverage_<id>` → read-only insights
 * - `setup` → setup wizard placeholder
 * - `sample` → synthetic `/sample` preview (private-chat-only)
 * - `app` / `home` → Mini App launch nudge (see registry in
 *   `@shared/lib/telegram-mini-app-payloads`)
 * Unknown or malformed payloads return `{ kind: "none" }`.
 *
 * Charset/length constraints are sourced from
 * `@shared/lib/telegram-mini-app-payloads` so the worker `?start=` parser and
 * the Mini App `?startapp=` parser stay aligned.
 */
export function parseStartPayload(args: string): ParsedStartPayload {
  const payload = args.trim();
  if (!payload) return { kind: "none" };
  if (payload.length > TELEGRAM_START_PAYLOAD_MAX_LENGTH) return { kind: "none" };
  if (!TELEGRAM_MINI_APP_PAYLOAD_PATTERN.test(payload)) return { kind: "none" };

  const lower = payload.toLowerCase();
  if (lower === "setup") return { kind: "setup" };
  if (lower === "sample") return { kind: "sample" };
  if (lower === "app" || lower === "home") return { kind: "app" };

  const firstSep = lower.indexOf("_");
  if (firstSep === -1) return { kind: "none" };
  const prefix = lower.slice(0, firstSep);
  const rest = lower.slice(firstSep + 1);
  if (!rest) return { kind: "none" };

  if (prefix === "sub") {
    const typesSep = rest.indexOf("_");
    if (typesSep === -1) return { kind: "none" };
    const types = rest.slice(0, typesSep);
    const targets = rest.slice(typesSep + 1);
    if (!types || !targets) return { kind: "none" };
    const subscribeArgs = `${types.split("-").join(" ")} ${targets}`.trim();
    return { kind: "subscribe", args: subscribeArgs };
  }

  if (prefix === "status" || prefix === "why" || prefix === "coverage") {
    return { kind: prefix, coinId: rest };
  }

  return { kind: "none" };
}

export function parseQuietHours(args: string): { startHourUtc: number; endHourUtc: number } | { error: string } {
  const match = args.trim().match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return { error: "Usage: /mute <start>-<end>, e.g. /mute 22-07. Hours use this chat's /timezone (UTC by default)." };
  }

  const startHourUtc = Number(match[1]);
  const endHourUtc = Number(match[2]);
  if (
    !Number.isInteger(startHourUtc) ||
    !Number.isInteger(endHourUtc) ||
    startHourUtc < 0 ||
    startHourUtc > 23 ||
    endHourUtc < 0 ||
    endHourUtc > 23 ||
    startHourUtc === endHourUtc
  ) {
    return {
      error:
        "Quiet hours must be two different whole hours between 0 and 23. For all-day silence, turn alert toggles off or unsubscribe instead.",
    };
  }

  return { startHourUtc, endHourUtc };
}
