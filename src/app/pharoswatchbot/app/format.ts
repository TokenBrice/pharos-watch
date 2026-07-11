import type { FollowedPreset, SubscribedCoin, TelegramAlertType, TelegramMiniAppState } from "./types";
import { PRESET_ALERT_TYPES as PRESET_ALERT_TYPES_ARRAY } from "./constants";

/** Effective alert source for a followed coin after per-coin rows suppress inherited defaults. */
export type EffectiveAlertSource = "per-coin" | "global" | "off-override";

const ALERT_TYPES: readonly TelegramAlertType[] = ["dews", "depeg", "safety", "launch", "reserve", "freeze"];
const PRESET_ALERT_TYPES = new Set<TelegramAlertType>(PRESET_ALERT_TYPES_ARRAY);

/**
 * Pure C74 display helper: classify each alert type's effective source for a followed coin,
 * using only already-projected session state (no extra reads, no preset→coin expansion).
 *
 * A `SubscribedCoin` represents a direct/local preference row, so:
 * - a type the coin enables resolves to `per-coin` (it wins over preset/global);
 * - a type with an explicit local-off marker resolves to `off-override` when a followed preset
 *   or the global default would otherwise cover it;
 * - an unmarked off flag does not suppress inherited preset/global coverage.
 */
export function computeEffectiveSource(
  coin: SubscribedCoin,
  globalAlerts: TelegramMiniAppState["subscriber"]["globalAlerts"],
  presets: readonly FollowedPreset[],
): Record<TelegramAlertType, EffectiveAlertSource> {
  const presetCovers = (type: TelegramAlertType): boolean =>
    PRESET_ALERT_TYPES.has(type) && presets.some((preset) => Boolean(preset.alertTypes[type as "dews" | "depeg" | "safety"]));

  const result = {} as Record<TelegramAlertType, EffectiveAlertSource>;
  for (const type of ALERT_TYPES) {
    if (coin.alertTypes[type]) {
      result[type] = "per-coin";
    } else if (coin.alertOverrides?.[type] && (presetCovers(type) || globalAlerts[type])) {
      result[type] = "off-override";
    } else {
      result[type] = "global";
    }
  }
  return result;
}

// Hoisted so render paths (StatusPanel) don't re-allocate the formatter on every render.
const HEALTH_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Far-future sentinel marking a durably "Paused" chat (`/pause`). Mirrors
 * `PAUSE_SENTINEL_TS` in `worker/src/lib/telegram-constants.ts` (2100-01-01 UTC);
 * kept as a local literal so the Mini App bundle stays free of worker imports.
 */
export const PAUSE_SENTINEL_TS = 4102444800;

/** True when a snooze timestamp is the durable Paused sentinel (exact match). */
export function isPausedSentinel(ts: number | null | undefined): boolean {
  return ts === PAUSE_SENTINEL_TS;
}

export function formatSnoozePill(snoozeUntilTs: number): string {
  const date = new Date(snoozeUntilTs * 1000);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

export function formatTime(ts: number | null): string {
  if (ts == null) return "Not recorded";
  return HEALTH_TIME_FORMATTER.format(new Date(ts * 1000));
}

export function formatHour(hour: number | null | undefined): string {
  if (hour == null) return "--";
  return `${String(hour).padStart(2, "0")}:00`;
}

export function formatQuietHoursTimezone(timezone: string | null | undefined): string {
  return timezone?.trim() || "UTC";
}

export function formatQuietHoursRange(
  startHour: number | null | undefined,
  endHour: number | null | undefined,
  timezone: string | null | undefined,
): string {
  return `${formatHour(startHour)}–${formatHour(endHour)} ${formatQuietHoursTimezone(timezone)}`;
}
