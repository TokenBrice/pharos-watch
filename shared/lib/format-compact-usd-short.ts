const COMPACT_USD_SHORT_TIERS = [
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "K"],
] as const;

export function formatCompactUsdShort(value: number): string {
  if (!Number.isFinite(value)) return "N/A";
  const tier = COMPACT_USD_SHORT_TIERS.find(([minimum]) => Math.abs(value) >= minimum);
  if (!tier) return `$${Math.round(value)}`;
  const [minimum, suffix] = tier;
  return `$${(value / minimum).toFixed(1)}${suffix}`;
}

/**
 * Like formatCompactUsdShort but rounds the thousands tier to a whole number with
 * a lowercase "k" suffix (B/M keep 1 decimal, uppercase). Used by the tape feed,
 * which renders thousands as e.g. "$5k". Returns "$0" for non-finite input.
 */
export function formatCompactUsdShortLowerK(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}
