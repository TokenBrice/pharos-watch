import { DEWS_THREAT_BANDS, dewsBandRanges } from "@shared/lib/dews-config";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import {
  TELEGRAM_ALERT_FAMILY_SHORT_LABELS,
  TELEGRAM_MINI_APP_ALERT_DESCRIPTIONS,
  TELEGRAM_MINI_APP_ALERT_LABELS,
  TELEGRAM_MINI_APP_GLOBAL_ALERT_DESCRIPTIONS,
  TELEGRAM_PRESET_ALERT_TYPES,
} from "@shared/lib/telegram-alert-families";
import { TELEGRAM_ALERT_POLICY } from "@shared/lib/telegram-delivery-policy";
import { TELEGRAM_PRESET_DEFINITION_BY_ID, type TelegramPresetId } from "@shared/lib/telegram-presets";
import { TELEGRAM_ALERT_TYPES, TELEGRAM_LIVE_ALERT_TYPES } from "@shared/types/status/telegram";
import type {
  TelegramAlertType,
  TelegramDepegStepBps,
  TelegramDewsBand,
  TelegramMiniAppOperation,
  TelegramSnoozeDurationToken,
} from "./types";

/** Plain-language family names; retired launch keeps a label for legacy rows only. */
export const ALERT_LABELS = TELEGRAM_MINI_APP_ALERT_LABELS;

/** One-line explanation shown under each per-coin/preset family switch. */
export const ALERT_DESCRIPTIONS = TELEGRAM_MINI_APP_ALERT_DESCRIPTIONS;

/** One-line explanation shown under each All stablecoins family switch. */
export const GLOBAL_ALERT_DESCRIPTIONS = TELEGRAM_MINI_APP_GLOBAL_ALERT_DESCRIPTIONS;

/** Compact names for one-line coin summaries. */
export const ALERT_SHORT_LABELS = Object.fromEntries(
  TELEGRAM_ALERT_TYPES.map((type) => [type, TELEGRAM_ALERT_FAMILY_SHORT_LABELS[type]]),
) as Record<TelegramAlertType, string>;

/** Families with switches; retired launch alerts are neither shown nor written. */
export const LIVE_ALERT_TYPES = TELEGRAM_LIVE_ALERT_TYPES;

export const PRESET_ALERT_TYPES = TELEGRAM_PRESET_ALERT_TYPES;
export type PresetAlertType = (typeof PRESET_ALERT_TYPES)[number];

/** Derived from shared delivery policy (ADR-32/R5). */
export const DAILY_LIVE_ALERT_CAP = TELEGRAM_ALERT_POLICY.chatCap.maxRealtimeMessages;
export const DAILY_CHANGES_HOUR = `${String(TELEGRAM_ALERT_POLICY.rollup.localHour).padStart(2, "0")}:00`;

const DEWS_RANGES = dewsBandRanges();
const DEWS_FLOOR_BY_BAND = Object.fromEntries(
  DEWS_THREAT_BANDS.map(({ band }, index) => [band, DEWS_RANGES[index]![0]]),
) as Record<(typeof DEWS_THREAT_BANDS)[number]["band"], number>;
const DEWS_MAX_SCORE = DEWS_THREAT_BANDS[DEWS_THREAT_BANDS.length - 1]!.upper;

/** Null keeps the default; each option is distinct (no "Default" duplicate of a real value). */
export const DEPEG_STEP_OPTIONS = [
  { value: null, label: "Start and recovery" },
  { value: 100, label: "Each 1% step" },
  { value: 250, label: "Each 2.5% step" },
  { value: 500, label: "Each 5% step" },
] as const satisfies readonly { value: TelegramDepegStepBps | null; label: string }[];

export function depegStepSubtitle(step: TelegramDepegStepBps | null, subject: string): string {
  switch (step) {
    case 100:
      return "An alert at the start, again at 2%, 3% and each further 1%, and on recovery.";
    case 250:
      return "Alerts at 2.5%, 5%, 7.5% and on recovery. Depegs that stay under 2.5% send nothing.";
    case 500:
      return "Alerts at 5%, 10%, 15% and on recovery. Depegs that stay under 5% send nothing.";
    default:
      return `One alert when ${subject} leaves its peg and one when it recovers.`;
  }
}

/** Default (null) DEWS means ALERT or higher, so ALERT is not offered twice. */
export const DEWS_BAND_OPTIONS = [
  { value: null, label: `Alert (${DEWS_FLOOR_BY_BAND.ALERT}+)` },
  { value: "WARNING", label: `Warning (${DEWS_FLOOR_BY_BAND.WARNING}+)` },
  { value: "DANGER", label: `Danger (${DEWS_FLOOR_BY_BAND.DANGER}+)` },
] as const satisfies readonly { value: TelegramDewsBand | null; label: string }[];

export const DEWS_SCORE_SUBTITLE = `DEWS scores stress from 0 to ${DEWS_MAX_SCORE}.`;

export const RECOMMENDED_OPERATION = { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] } as const satisfies TelegramMiniAppOperation;

/** Alerts a newly added coin starts with. */
export const DEFAULT_COIN_ALERTS = { dews: true, depeg: true } as const;

export const SNOOZE_DURATION_TOKENS = ["1h", "4h", "24h"] as const satisfies readonly TelegramSnoozeDurationToken[];

export const SNOOZE_DURATION_LABELS = { "1h": "1 hour", "4h": "4 hours", "24h": "24 hours" } as const satisfies Record<TelegramSnoozeDurationToken, string>;

/** Server-side ceiling for one bulk watchlist edit. */
export const BULK_SELECTION_LIMIT = 20;

export const PHAROS_COIN_PAGE_PREFIX = `${SITE_ORIGIN}/stablecoin/`;

export function presetLabel(id: string, fallback?: string): string {
  return TELEGRAM_PRESET_DEFINITION_BY_ID.get(id as TelegramPresetId)?.label ?? fallback ?? id;
}

export function presetDescription(id: string, fallback?: string | null): string | null {
  return TELEGRAM_PRESET_DEFINITION_BY_ID.get(id as TelegramPresetId)?.description ?? fallback ?? null;
}

export function presetCategory(id: string): "By peg" | "By size" {
  return TELEGRAM_PRESET_DEFINITION_BY_ID.get(id as TelegramPresetId)?.category === "peg-leaders"
    ? "By peg"
    : "By size";
}
