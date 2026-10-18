import type { CompactUsdFormatOptions } from "@shared/lib/format";

// API wrappers return null before this fallback is reachable; alert context renders n/a.
export const TELEGRAM_USD_PROFILE = {
  decimals: { trillion: 1, billion: 1, million: 1, thousand: 1, unit: 0 },
  invalidFallback: "n/a",
  maximumTier: "billion",
  signPosition: "after-currency",
} as const satisfies CompactUsdFormatOptions;

export const TELEGRAM_SIGNED_USD_PROFILE = {
  ...TELEGRAM_USD_PROFILE,
  positiveSign: true,
  signPosition: "before-currency",
} as const satisfies CompactUsdFormatOptions;
