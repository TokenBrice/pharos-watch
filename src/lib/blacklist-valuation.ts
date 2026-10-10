import { formatCurrency } from "@shared/lib/format";
import type { BlacklistValuationCoverage } from "@shared/types/market";

/** Keep unavailable and partially priced cohorts visible beside their subtotal. */
export function formatBlacklistValuation(
  amount: number | null | undefined,
  coverage: BlacklistValuationCoverage | undefined,
  formatter: (value: number) => string = formatCurrency,
): string {
  if (amount == null || !Number.isFinite(amount)) return "Unavailable";
  const value = formatter(amount);
  if (!coverage) return `${value} (coverage unknown)`;
  return coverage.unavailableCount > 0 ? `${value} (partial)` : value;
}
