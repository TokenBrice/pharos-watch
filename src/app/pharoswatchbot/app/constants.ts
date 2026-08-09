import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import type { TelegramAlertType, TelegramDepegStepBps, TelegramMiniAppOperation, TelegramSnoozeDurationToken } from "./types";

export const ALERT_LABELS = {
  dews: "DEWS",
  depeg: "Depeg",
  safety: "Safety",
  launch: "Launch",
  reserve: "Reserve",
  freeze: "Freeze",
} as const satisfies Record<TelegramAlertType, string>;

export const PRESET_ALERT_TYPES = ["dews", "depeg", "safety"] as const satisfies readonly TelegramAlertType[];

export const DEPEG_STEP_OPTIONS = [
  { value: null, label: "Any depeg", caption: "No gate" },
  { value: 100, label: "+100 bps", caption: "Tighter" },
  { value: 250, label: "+250 bps", caption: "Balanced" },
  { value: 500, label: "+500 bps", caption: "Quieter" },
] as const satisfies readonly { value: TelegramDepegStepBps | null; label: string; caption: string }[];

export const SUGGESTED_SEARCH_IDS = ["usdt-tether", "usdc-circle", "dai-makerdao"] as const;

export const RECOMMENDED_OPERATION = { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] } as const satisfies TelegramMiniAppOperation;

export const SNOOZE_DURATION_TOKENS = ["1h", "4h", "24h"] as const satisfies readonly TelegramSnoozeDurationToken[];

export const PHAROS_COIN_PAGE_PREFIX = `${SITE_ORIGIN}/stablecoin/`;

export const DEWS_BAND_OPTIONS = [
  { value: "ALERT" as const, label: "ALERT", caption: "Light yellow" },
  { value: "WARNING" as const, label: "WARNING", caption: "Orange" },
  { value: "DANGER" as const, label: "DANGER", caption: "Red only" },
] as const;

export const SAFETY_MODE_OPTIONS = [
  { value: "all" as const, label: "All changes" },
  { value: "downgrade-only" as const, label: "Downgrades" },
  { value: "upgrade-only" as const, label: "Upgrades" },
] as const;
