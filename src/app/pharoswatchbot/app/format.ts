import { isPausedSentinel } from "@shared/lib/telegram-delivery-policy";
import { LIVE_ALERT_TYPES, PRESET_ALERT_TYPES, presetLabel } from "./constants";
import type { FollowedPreset, SubscribedCoin, TelegramAlertType, TelegramMiniAppState } from "./types";

type GlobalAlerts = TelegramMiniAppState["subscriber"]["globalAlerts"];

/**
 * Effective coverage of one alert family for one coin, mirroring the `/list`
 * precedence (this coin > followed group > all stablecoins):
 * - `on`: this coin's own row enables the family;
 * - `via`: inherited from a group the coin currently belongs to, or from All stablecoins;
 * - `muted`: an explicit per-coin off marker suppresses coverage that is known to exist;
 * - `unknown`: a followed preset might cover it but its membership could not be read, so
 *   neither coverage nor a mute of it is claimed (rule R1/R2);
 * - `off`: nothing covers it.
 */
export type FamilyCoverage =
  | { kind: "on" }
  | { kind: "via"; source: string }
  | { kind: "muted"; source: string }
  | { kind: "unknown"; source: string }
  | { kind: "off" };

const PRESET_FAMILIES = new Set<TelegramAlertType>(PRESET_ALERT_TYPES);
export const ALL_STABLECOINS_LABEL = "All stablecoins";

/** The inherited source (group or All stablecoins) for a family, before per-coin rows apply. */
function inheritedSource(
  stablecoinId: string,
  type: TelegramAlertType,
  globalAlerts: GlobalAlerts,
  presets: readonly FollowedPreset[],
): FamilyCoverage {
  let unknownSource: string | null = null;
  if (PRESET_FAMILIES.has(type)) {
    for (const preset of presets) {
      if (!preset.alertTypes[type as keyof FollowedPreset["alertTypes"]]) continue;
      if (preset.memberIds == null) unknownSource ??= presetLabel(preset.id, preset.label);
      else if (preset.memberIds.includes(stablecoinId)) return { kind: "via", source: presetLabel(preset.id, preset.label) };
    }
  }
  if (globalAlerts[type]) return { kind: "via", source: ALL_STABLECOINS_LABEL };
  if (unknownSource) return { kind: "unknown", source: unknownSource };
  return { kind: "off" };
}

export function familyCoverage(
  stablecoinId: string,
  coin: SubscribedCoin | null,
  type: TelegramAlertType,
  globalAlerts: GlobalAlerts,
  presets: readonly FollowedPreset[],
): FamilyCoverage {
  if (coin?.alertTypes[type]) return { kind: "on" };
  const inherited = inheritedSource(stablecoinId, type, globalAlerts, presets);
  if (coin?.alertOverrides?.[type] && inherited.kind === "via") return { kind: "muted", source: inherited.source };
  return inherited;
}

export function coinCoverage(
  stablecoinId: string,
  coin: SubscribedCoin | null,
  state: Pick<TelegramMiniAppState, "subscriber" | "presets">,
): Record<TelegramAlertType, FamilyCoverage> {
  return Object.fromEntries(
    LIVE_ALERT_TYPES.map((type) => [type, familyCoverage(stablecoinId, coin, type, state.subscriber.globalAlerts, state.presets)]),
  ) as Record<TelegramAlertType, FamilyCoverage>;
}

export function isCoverageActive(coverage: FamilyCoverage): boolean {
  return coverage.kind === "on" || coverage.kind === "via";
}

/** True when any family, group or coin can deliver an alert. */
export function hasAnyCoverage(state: TelegramMiniAppState): boolean {
  return state.subscriber.exists && (
    LIVE_ALERT_TYPES.some((type) => state.subscriber.globalAlerts[type])
    || state.subscriptions.some((coin) => LIVE_ALERT_TYPES.some((type) => coin.alertTypes[type]))
    || state.presets.some((preset) => PRESET_ALERT_TYPES.some((type) => preset.alertTypes[type]))
  );
}

/** Device timezone when the user has not confirmed one. */
function displayTimeZone(timezone: string | null | undefined): string | undefined {
  return timezone?.trim() || undefined;
}

/** "14:32", or "Tue 14:32" when the moment is not today, in the user's timezone. */
export function formatClock(ts: number, timezone: string | null | undefined, nowSec: number): string {
  const timeZone = displayTimeZone(timezone);
  const date = new Date(ts * 1000);
  const dayKey = (value: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  if (nowSec > 0 && dayKey(date) === dayKey(new Date(nowSec * 1000))) return time;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  return `${weekday} ${time}`;
}

export function formatSnoozeUntil(snoozeUntilTs: number, timezone: string | null | undefined, nowSec: number): string {
  if (isPausedSentinel(snoozeUntilTs)) return "Paused until you resume";
  return `Snoozed until ${formatClock(snoozeUntilTs, timezone, nowSec)}`;
}

/** "3 min ago", "5 h ago", "2 days ago"; null means never recorded. */
export function formatAgo(ts: number | null, nowSec: number): string {
  if (ts == null) return "Not yet";
  const seconds = Math.max(0, nowSec - ts);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86_400);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

export function formatHour(hour: number | null | undefined): string {
  if (hour == null) return "--";
  return `${String(hour).padStart(2, "0")}:00`;
}

export function formatQuietHoursRange(startHour: number | null | undefined, endHour: number | null | undefined): string {
  return `${formatHour(startHour)}–${formatHour(endHour)}`;
}

/** "Europe/Paris" → "Paris"; null → "UTC". */
export function formatTimeZoneCity(timezone: string | null | undefined): string {
  const zone = timezone?.trim();
  if (!zone) return "UTC";
  return zone.split("/").pop()?.replace(/_/g, " ") ?? zone;
}

/** "Early warning, Depeg" style list, or null when nothing is on. */
export function joinLabels(labels: readonly string[]): string | null {
  return labels.length > 0 ? labels.join(" · ") : null;
}
