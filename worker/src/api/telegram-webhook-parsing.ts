import type { ResolvedCoin } from "../lib/telegram-alerts";
import type {
  ParsedSetCommand,
  PendingAction,
  PendingActionType,
  PendingDisambiguationRow,
} from "./telegram-webhook-shared";
import { STABLECOIN_BY_ID } from "./telegram-webhook-shared";

function logPendingParseWarning(pending: PendingDisambiguationRow, field: string, error: unknown): void {
  const actionType = pending.action_type ?? "unknown";
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[telegram-webhook] malformed pending field action=${actionType} ambiguous=${pending.ambiguous_ticker} field=${field} error=${message}`,
  );
}

function parsePendingActionType(value: string | null | undefined): PendingActionType | null {
  if (value === "subscribe" || value === "unsubscribe" || value === "set") {
    return value;
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

export function parseCommand(text: string): { command: string; args: string } {
  const spaceIdx = text.indexOf(" ");
  const command = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase().replace(/@\w+$/, "");
  const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
  return { command, args };
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
        step: payload.step === 100 || payload.step === 250 || payload.step === 500 ? payload.step : null,
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

export function dedupeCoins(coins: ResolvedCoin[]): ResolvedCoin[] {
  const deduped: ResolvedCoin[] = [];
  const seenIds = new Set<string>();

  for (const coin of coins) {
    if (seenIds.has(coin.id)) continue;
    seenIds.add(coin.id);
    deduped.push(coin);
  }

  return deduped;
}

export function parsePendingDisambiguation(pending: PendingDisambiguationRow): PendingAction | null {
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
    return {
      actionType,
      alertTypes: actionAlertTypes,
      resolvedCoins,
      ambiguousTicker: pending.ambiguous_ticker,
      candidates,
      remainingTickers,
    };
  }

  if (actionType === "unsubscribe") {
    return {
      actionType,
      resolvedCoins,
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
      if (value === "alert") {
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
      if (value === "all") {
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
    case "depeg-step": {
      if (value === "off") {
        return { ticker, setting: "depeg-step", enabled: true, step: null };
      }
      const step = Number(value);
      if (step === 100 || step === 250 || step === 500) {
        return { ticker, setting: "depeg-step", enabled: true, step };
      }
      return { error: "Depeg-step values: off, 100, 250, 500" };
    }
    default:
      return { error: "Supported settings: dews, safety, depeg, depeg-step" };
  }
}

export function parseQuietHours(args: string): { startHourUtc: number; endHourUtc: number } | { error: string } {
  const match = args.trim().match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return { error: "Usage: /mute <start>-<end> in UTC, e.g. /mute 22-07" };
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
    return { error: "Quiet hours must be two different UTC hours between 0 and 23." };
  }

  return { startHourUtc, endHourUtc };
}
