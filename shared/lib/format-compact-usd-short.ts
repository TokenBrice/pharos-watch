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
