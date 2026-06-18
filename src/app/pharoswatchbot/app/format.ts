import type { FollowedPreset, SubscribedCoin, TelegramAlertType, TelegramMiniAppState } from "./types";

/** Effective alert source for a single alert type, per the per-coin > preset > all-stablecoins precedence. */
export type EffectiveAlertSource = "per-coin" | "preset" | "global" | "off-override";

const ALERT_TYPES: readonly TelegramAlertType[] = ["dews", "depeg", "safety", "launch"];

/**
 * Pure C74 display helper: classify each alert type's effective source for a followed coin,
 * using only already-projected session state (no extra reads, no preset→coin expansion).
 *
 * Precedence is per-coin > preset > all-stablecoins. A `SubscribedCoin` always represents an
 * explicit per-coin row, so:
 * - a type the coin enables resolves to `per-coin` (it wins over preset/global);
 * - a type the coin leaves off resolves to `off-override` when a followed preset or the global
 *   default would otherwise cover it (the C02 per-coin `off` suppression), or to `global` as the
 *   default lane when nothing else applies.
 */
export function computeEffectiveSource(
  coin: SubscribedCoin,
  globalAlerts: TelegramMiniAppState["subscriber"]["globalAlerts"],
  presets: readonly FollowedPreset[],
): Record<TelegramAlertType, EffectiveAlertSource> {
  const presetCovers = (type: TelegramAlertType): boolean =>
    type !== "launch" && presets.some((preset) => Boolean(preset.alertTypes[type as "dews" | "depeg" | "safety"]));

  const result = {} as Record<TelegramAlertType, EffectiveAlertSource>;
  for (const type of ALERT_TYPES) {
    if (coin.alertTypes[type]) {
      result[type] = "per-coin";
    } else if (presetCovers(type) || globalAlerts[type]) {
      result[type] = "off-override";
    } else {
      result[type] = "global";
    }
  }
  return result;
}

// Hoisted so render paths (StatusPanel) don't re-allocate the formatter on every render.
const HEALTH_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

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
