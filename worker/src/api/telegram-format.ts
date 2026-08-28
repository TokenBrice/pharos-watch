import { formatCompactUsdWithOptions } from "@shared/lib/format";

const TELEGRAM_USD_PROFILE = {
  decimals: { trillion: 1, billion: 1, million: 1, thousand: 1, unit: 0 },
  invalidFallback: "",
  maximumTier: "billion",
  signPosition: "after-currency",
} as const;

const TELEGRAM_SIGNED_USD_PROFILE = {
  ...TELEGRAM_USD_PROFILE,
  positiveSign: true,
  signPosition: "before-currency",
} as const;

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
