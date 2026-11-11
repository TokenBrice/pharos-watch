import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { TELEGRAM_MINI_APP_ALERT_LABELS, TELEGRAM_MINI_APP_ALERT_DESCRIPTIONS, TELEGRAM_ALERT_FAMILY_SHORT_LABELS, TELEGRAM_PRESET_ALERT_TYPES } from "@shared/lib/telegram-alert-families";
import { TELEGRAM_ALERT_TYPES, TELEGRAM_LIVE_ALERT_TYPES } from "@shared/types/status/telegram";
import type {
  TelegramAlertType,
  TelegramDepegStepBps,
  TelegramDewsBand,
  TelegramMiniAppOperation,
  TelegramSafetyMode,
  TelegramSnoozeDurationToken,
} from "./types";

/** Plain-language family names; retired launch keeps a label for legacy rows only. */
export const ALERT_LABELS = TELEGRAM_MINI_APP_ALERT_LABELS;

/** One-line explanation shown under each family switch. */
export const ALERT_DESCRIPTIONS = TELEGRAM_MINI_APP_ALERT_DESCRIPTIONS;

/** Compact names for one-line coin summaries. */
export const ALERT_SHORT_LABELS = Object.fromEntries(
  TELEGRAM_ALERT_TYPES.map((type) => [type, TELEGRAM_ALERT_FAMILY_SHORT_LABELS[type]]),
) as Record<TelegramAlertType, string>;

/** Families with switches; retired launch alerts are neither shown nor written. */
export const LIVE_ALERT_TYPES = TELEGRAM_LIVE_ALERT_TYPES;

export const PRESET_ALERT_TYPES = TELEGRAM_PRESET_ALERT_TYPES;
export type PresetAlertType = (typeof PRESET_ALERT_TYPES)[number];

/** Null keeps the default; each option is distinct (no "Default" duplicate of a real value). */
export const DEPEG_STEP_OPTIONS = [
  { value: null, label: "Any new low" },
  { value: 100, label: "Every +1%" },
  { value: 250, label: "Every +2.5%" },
  { value: 500, label: "Every +5%" },
] as const satisfies readonly { value: TelegramDepegStepBps | null; label: string }[];

/** Default (null) DEWS means ALERT or higher, so ALERT is not offered twice. */
export const DEWS_BAND_OPTIONS = [
  { value: null, label: "Alert or higher" },
  { value: "WARNING", label: "Warning or higher" },
  { value: "DANGER", label: "Danger only" },
] as const satisfies readonly { value: TelegramDewsBand | null; label: string }[];

/** Default (null) safety means all changes, so "all" is not offered twice. */
export const SAFETY_MODE_OPTIONS = [
  { value: null, label: "All changes" },
  { value: "downgrade-only", label: "Downgrades only" },
  { value: "upgrade-only", label: "Upgrades only" },
] as const satisfies readonly { value: TelegramSafetyMode | null; label: string }[];

export const RECOMMENDED_OPERATION = { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] } as const satisfies TelegramMiniAppOperation;

/** Alerts a newly added coin starts with. */
export const DEFAULT_COIN_ALERTS = { dews: true, depeg: true } as const;

export const SNOOZE_DURATION_TOKENS = ["1h", "4h", "24h"] as const satisfies readonly TelegramSnoozeDurationToken[];

export const SNOOZE_DURATION_LABELS = { "1h": "1 hour", "4h": "4 hours", "24h": "24 hours" } as const satisfies Record<TelegramSnoozeDurationToken, string>;

/** Server-side ceiling for one bulk watchlist edit. */
export const BULK_SELECTION_LIMIT = 20;

export const PHAROS_COIN_PAGE_PREFIX = `${SITE_ORIGIN}/stablecoin/`;

/** Friendly preset names and one-line descriptions (no raw ">= $1B" labels, no trailing periods). */
export const PRESET_COPY: Record<string, { label: string; description: string; category: "By peg" | "By size" }> = {
  "usd-top10": { label: "USD Top 10", description: "The 10 largest USD stablecoins", category: "By peg" },
  "usd-top25": { label: "USD Top 25", description: "The 25 largest USD stablecoins", category: "By peg" },
  "usd-top50": { label: "USD Top 50", description: "The 50 largest USD stablecoins", category: "By peg" },
  "non-usd-top10": { label: "Non-USD Top 10", description: "The 10 largest stablecoins not pegged to USD", category: "By peg" },
  "non-usd-top25": { label: "Non-USD Top 25", description: "The 25 largest stablecoins not pegged to USD", category: "By peg" },
  "non-usd-top50": { label: "Non-USD Top 50", description: "The 50 largest stablecoins not pegged to USD", category: "By peg" },
  "eur-top10": { label: "EUR Top 10", description: "The 10 largest euro stablecoins", category: "By peg" },
  "gold-top5": { label: "Gold Top 5", description: "The 5 largest gold-backed stablecoins", category: "By peg" },
  "mcap-ge-1b": { label: "Over $1B", description: "Every stablecoin worth $1 billion or more", category: "By size" },
  "mcap-ge-100m": { label: "Over $100M", description: "Every stablecoin worth $100 million or more", category: "By size" },
};

export function presetLabel(id: string, fallback?: string): string {
  return PRESET_COPY[id]?.label ?? fallback ?? id;
}
