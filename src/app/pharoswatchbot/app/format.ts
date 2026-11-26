import { THREAT_BAND_LABELS } from "@shared/lib/classification/risk";
import { formatUsdPriceAdaptive } from "@shared/lib/format";
import { isPausedSentinel } from "@shared/lib/telegram-delivery-policy";
import { LIVE_ALERT_TYPES, PRESET_ALERT_TYPES, presetLabel } from "./constants";
import type {
  FollowedPreset,
  SubscribedCoin,
  TelegramAlertType,
  TelegramMiniAppActiveDepeg,
  TelegramMiniAppCoinSignal,
  TelegramMiniAppContextProvenance,
  TelegramMiniAppPresetSummary,
  TelegramMiniAppState,
} from "./types";

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

/** Index every readable followed preset's member IDs into Sets once per snapshot for O(1) lookups. */
export function buildPresetMemberSetById(
  presets: readonly FollowedPreset[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const byId = new Map<string, ReadonlySet<string>>();
  for (const preset of presets) {
    if (preset.memberIds != null) {
      byId.set(preset.id, new Set(preset.memberIds));
    }
  }
  return byId;
}

/** The inherited source (group or All stablecoins) for a family, before per-coin rows apply. */
function inheritedSource(
  stablecoinId: string,
  type: TelegramAlertType,
  globalAlerts: GlobalAlerts,
  presets: readonly FollowedPreset[],
  presetMemberSetById?: ReadonlyMap<string, ReadonlySet<string>>,
): FamilyCoverage {
  let unknownSource: string | null = null;
  if (PRESET_FAMILIES.has(type)) {
    for (const preset of presets) {
      if (!preset.alertTypes[type as keyof FollowedPreset["alertTypes"]]) continue;
      if (preset.memberIds == null) unknownSource ??= presetLabel(preset.id, preset.label);
      else {
        const memberSet = presetMemberSetById?.get(preset.id);
        const isMember = memberSet ? memberSet.has(stablecoinId) : preset.memberIds.includes(stablecoinId);
        if (isMember) return { kind: "via", source: presetLabel(preset.id, preset.label) };
      }
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
  presetMemberSetById?: ReadonlyMap<string, ReadonlySet<string>>,
): FamilyCoverage {
  if (coin?.alertTypes[type]) return { kind: "on" };
  const inherited = inheritedSource(stablecoinId, type, globalAlerts, presets, presetMemberSetById);
  if (coin?.alertOverrides?.[type] && inherited.kind === "via") return { kind: "muted", source: inherited.source };
  return inherited;
}

export function coinCoverage(
  stablecoinId: string,
  coin: SubscribedCoin | null,
  state: Pick<TelegramMiniAppState, "subscriber" | "presets">,
  presetMemberSetById?: ReadonlyMap<string, ReadonlySet<string>>,
): Record<TelegramAlertType, FamilyCoverage> {
  return Object.fromEntries(
    LIVE_ALERT_TYPES.map((type) => [type, familyCoverage(stablecoinId, coin, type, state.subscriber.globalAlerts, state.presets, presetMemberSetById)]),
  ) as Record<TelegramAlertType, FamilyCoverage>;
}

export function isCoverageActive(coverage: FamilyCoverage): boolean {
  return coverage.kind === "on" || coverage.kind === "via";
}

/** True when the coin's own row directly enables at least one live alert family. */
export function hasOwnEnabledFamily(coin: SubscribedCoin): boolean {
  return LIVE_ALERT_TYPES.some((type) => coin.alertTypes[type]);
}

/** First preset or All stablecoins source covering any live family for this coin, ignoring own flags/overrides. */
export function coinInheritedCoverSource(
  stablecoinId: string,
  state: Pick<TelegramMiniAppState, "subscriber" | "presets">,
  presetMemberSetById?: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  for (const type of LIVE_ALERT_TYPES) {
    const inherited = inheritedSource(stablecoinId, type, state.subscriber.globalAlerts, state.presets, presetMemberSetById);
    if (inherited.kind === "via") return inherited.source;
  }
  return null;
}

/** Case-insensitive check so coins like DAI ("Dai") don't repeat their symbol as a subtitle. */
export function displayCoinName(symbol: string, name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase() === symbol.trim().toLowerCase() ? null : trimmed;
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
  return `${formatHour(startHour)}-${formatHour(endHour)}`;
}

/** True when quiet hours are enabled and `nowSec` falls inside the configured local hour window. */
export function isQuietHoursActiveNow(
  quietHours: TelegramMiniAppState["subscriber"]["quietHours"],
  nowSec: number,
): boolean {
  if (!quietHours.enabled || quietHours.startHourUtc == null || quietHours.endHourUtc == null || nowSec <= 0) {
    return false;
  }
  const start = quietHours.startHourUtc;
  const end = quietHours.endHourUtc;
  if (start === end) return false;
  const timeZone = quietHours.timezone?.trim() || "UTC";
  try {
    const hourText = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(nowSec * 1000));
    const hour = Number(hourText);
    if (!Number.isFinite(hour)) return false;
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  } catch {
    return false;
  }
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

/**
 * Format an active depeg's deviation honestly: live current deviation when
 * available (paired with currentDirection or signed bps), otherwise peak
 * deviation (marked `peak`), or `"Off peg"` when peak basis is unavailable;
 * preserves peer-relative caveats.
 */
function formatDepegDeviation(
  depeg: TelegramMiniAppActiveDepeg,
  options: { withPegWord?: boolean } = {},
): string {
  const { withPegWord = false } = options;
  if (depeg.currentDeviationBps == null && depeg.peakBasisUnavailable) {
    return depeg.peerRelative ? "Off peg (vs peers)" : "Off peg";
  }
  const usingCurrent = depeg.currentDeviationBps != null;
  const bps = usingCurrent ? depeg.currentDeviationBps! : depeg.peakDeviationBps;
  const isNeutralZero = usingCurrent && (Math.abs(bps) < 5 || depeg.currentDirection === null);
  const direction = usingCurrent
    ? (depeg.currentDirection ?? (bps > 0 ? "above" : bps < 0 ? "below" : null))
    : depeg.direction;
  const pct = (Math.abs(bps) / 100).toFixed(1);
  const base = isNeutralZero || direction == null
    ? (withPegWord ? "0.0% from peg" : "0.0%")
    : (withPegWord ? `${pct}% ${direction} peg` : `${pct}% ${direction}`);
  const peerQualifier = usingCurrent ? depeg.currentPeerRelative === true : depeg.peerRelative === true;
  const qualifiers = [
    !usingCurrent ? "peak" : null,
    peerQualifier ? "vs peers" : null,
  ].filter((part): part is string => part != null);
  return qualifiers.length > 0 ? `${base} (${qualifiers.join(", ")})` : base;
}

/** Format a Home `Off peg now` trailing value, e.g. `$0.9871 · 1.3% below`. */
export function formatOffPegRowValue(depeg: TelegramMiniAppActiveDepeg): string {
  const priceText = depeg.priceUsd != null ? `$${formatUsdPriceAdaptive(depeg.priceUsd)}` : null;
  const deviationText = formatDepegDeviation(depeg, { withPegWord: false });
  return priceText ? `${priceText} · ${deviationText}` : deviationText;
}

/**
 * Format the single quiet live-status line for Coin detail header:
 * `$0.9998 · On peg · DEWS Calm 12 · Safety A-` (or `1.3% below peg`),
 * omitting the peg segment for unmonitored coins (NAV/pre-launch), showing
 * per-lane `—` on partial failure, `Safety Held` when a rated/scored card is
 * held, `Safety <grade> (partial)` on partial evidence, and
 * `Live data unavailable.` when every lane is unavailable/omitted.
 */
export function formatCoinLiveHeaderLine(
  input: {
    status: "idle" | "ok" | "unavailable";
    signal: TelegramMiniAppCoinSignal | null;
    depeg: TelegramMiniAppActiveDepeg | null;
    depegProvenance: TelegramMiniAppContextProvenance | null;
  },
  coinMeta?: { status?: string | null; pegLabel?: string | null } | null,
): string | null {
  if (input.status === "idle") return null;
  if (input.status === "unavailable" || !input.signal) return "Live data unavailable.";
  const { signal, depeg, depegProvenance } = input;

  const priceOk = signal.price.provenance.status === "ok" && signal.price.priceUsd != null;
  const rawPegStatus = signal.pegStatus ?? (
    depeg != null && depegProvenance?.status === "ok"
      ? "off-peg"
      : (coinMeta?.status != null && coinMeta.status !== "active") || Boolean(coinMeta?.pegLabel)
        ? "not-monitored"
        : depegProvenance?.status === "ok" && priceOk
          ? "on-peg"
          : "unavailable"
  );
  const pegStatus = rawPegStatus === "off-peg" && depegProvenance != null && depegProvenance.status !== "ok"
    ? "unavailable"
    : rawPegStatus;
  const pegAvailable = pegStatus === "off-peg" || pegStatus === "on-peg";
  const dewsOk = signal.dews.provenance.status === "ok" && signal.dews.band != null && signal.dews.score != null;
  const safetyHeld = signal.safety.held === true && signal.safety.ratingStatus != null;
  const safetyRated = signal.safety.provenance.status === "ok"
    && signal.safety.ratingStatus === "rated"
    && signal.safety.grade != null;
  const safetyAnyAvailable = safetyHeld || safetyRated;

  if (!priceOk && !pegAvailable && !dewsOk && !safetyAnyAvailable) {
    return "Live data unavailable.";
  }

  const pricePart = priceOk && signal.price.priceUsd != null
    ? `$${formatUsdPriceAdaptive(signal.price.priceUsd)}`
    : "Price —";
  const pegPart = pegStatus === "not-monitored"
    ? null
    : pegStatus === "off-peg"
      ? (depeg ? formatDepegDeviation(depeg, { withPegWord: true }) : "Off peg")
      : pegStatus === "on-peg"
        ? "On peg"
        : "Peg —";
  const dewsPart = dewsOk && signal.dews.band != null && signal.dews.score != null
    ? `DEWS ${THREAT_BAND_LABELS[signal.dews.band]} ${Math.round(signal.dews.score)}`
    : "DEWS —";
  const safetyPart = safetyHeld
    ? "Safety Held"
    : safetyRated && signal.safety.grade != null
      ? signal.safety.partialEvidence === true
        ? `Safety ${signal.safety.grade} (partial)`
        : `Safety ${signal.safety.grade}`
      : "Safety —";

  return [pricePart, pegPart, dewsPart, safetyPart].filter((part): part is string => part != null).join(" · ");
}

/**
 * Format the Follow a preset summary line, e.g.
 * `25 coins: USDT, USDC, USDS and 22 more` or `3 coins: PAXG, XAUT, KAU`.
 */
export function formatPresetSummaryLine(summary: TelegramMiniAppPresetSummary): string | null {
  if (summary.memberCount === 0) return "0 coins right now";
  const countWord = summary.memberCount === 1 ? "coin" : "coins";
  if (summary.topSymbols.length === 0) return `${summary.memberCount} ${countWord}`;
  const remaining = summary.memberCount - summary.topSymbols.length;
  if (remaining > 0) {
    return `${summary.memberCount} ${countWord}: ${summary.topSymbols.join(", ")} and ${remaining} more`;
  }
  return `${summary.memberCount} ${countWord}: ${summary.topSymbols.join(", ")}`;
}
