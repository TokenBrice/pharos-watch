/**
 * One rounding for a chain's share of observed global supply (`dominanceShare`), shared by `/chains/`, chain profiles
 * and the Worker OG card: a nonzero share never prints as 0.0%.
 */
export function formatChainShare(share: number | null): string {
  if (share == null || !Number.isFinite(share)) return "Unavailable";
  if (share > 0 && share < 0.0005) return "<0.1%";
  return `${(share * 100).toFixed(1)}%`;
}
