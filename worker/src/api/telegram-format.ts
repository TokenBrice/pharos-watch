import { formatCompactUsdWithOptions } from "@shared/lib/format";
import { TELEGRAM_USD_PROFILE, TELEGRAM_SIGNED_USD_PROFILE } from "../lib/telegram/usd-profile";

export function formatTelegramCompactUsd(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return formatCompactUsdWithOptions(value, TELEGRAM_USD_PROFILE);
}

/**
 * Compact USD with an explicit sign for net-flow display ("+$12.3M" / "-$4.0M" / "$0").
 * Returns null for non-finite input so callers can drop the line.
 */
export function formatTelegramSignedCompactUsd(value: number | null | undefined): string | null {
  if (!Number.isFinite(value)) return null;
  return formatCompactUsdWithOptions(value as number, TELEGRAM_SIGNED_USD_PROFILE);
}
