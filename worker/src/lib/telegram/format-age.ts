import { formatRelativeAgeSeconds } from "@shared/lib/relative-time";

const NOW_THRESHOLD_SEC = 90;
const DAY_THRESHOLD_SEC = 48 * 3600;

export interface TelegramFormatAgeOptions {
  /** Value returned when `ts` is null/undefined/non-finite. */
  invalidFallback?: string;
  suffix?: "ago" | "old" | "";
  nowLabel?: string;
  unitStyle?: "compact" | "short" | "long";
}

/**
 * Shared seconds-to-human-age formatter for the Telegram layer.
 *
 * Centralizes the 90s "now" cutoff and 48h day threshold so the bot's
 * freshness strings stay consistent across insight, message, and health
 * surfaces. Per-surface wording (fallback text, suffix, "now" label) stays
 * configurable so callers keep their existing copy.
 */
export function formatTelegramAge(
  ts: number | null | undefined,
  nowSec = Math.floor(Date.now() / 1000),
  options: TelegramFormatAgeOptions = {},
): string {
  const {
    invalidFallback = "",
    suffix = "old",
    nowLabel = "fresh",
    unitStyle,
  } = options;
  if (ts == null || !Number.isFinite(ts)) return invalidFallback;
  const ageSec = Math.max(0, nowSec - ts);
  return formatRelativeAgeSeconds(ageSec, {
    suffix,
    nowLabel,
    nowThresholdSec: NOW_THRESHOLD_SEC,
    rounding: "round",
    dayThresholdSec: DAY_THRESHOLD_SEC,
    ...(unitStyle ? { unitStyle } : {}),
  });
}
