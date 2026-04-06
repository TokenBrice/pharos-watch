import { formatSignedPercent as sharedFormatSignedPercent } from "@shared/lib/format";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ALT_SOURCE_INITIAL_COUNT = 6;

export const DATA_SOURCE_BADGES: Record<string, { label: string; badge: string }> = {
  onchain: {
    label: "On-chain",
    badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  },
  defillama: {
    label: "DeFiLlama",
    badge: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20",
  },
  "defillama-auto": {
    label: "DeFiLlama",
    badge: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20",
  },
  "protocol-api": {
    label: "Protocol-native",
    badge: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20",
  },
  "price-derived": {
    label: "Price-derived",
    badge: "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20",
  },
  "rate-derived": {
    label: "Rate-derived",
    badge: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20",
  },
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Wrapper that returns an em-dash for null instead of "-". */
export function formatSignedPercent(value: number | null) {
  if (value === null) return "\u2014";
  return sharedFormatSignedPercent(value);
}
