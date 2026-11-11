import { formatCurrency } from "@shared/lib/format";
import type { BlacklistValuationCoverage } from "@shared/types/blacklist";

/**
 * Keep unavailable and partially priced cohorts visible beside their subtotal.
 * `markPartial: false` drops only the `(partial)` qualifier (the FreezeWatch
 * headline cards, by owner decision); unavailable and unknown-coverage values
 * keep their wording.
 */
export function formatBlacklistValuation(
  amount: number | null | undefined,
  coverage: BlacklistValuationCoverage | undefined,
  formatter: (value: number) => string = formatCurrency,
  { markPartial = true }: { markPartial?: boolean } = {},
): string {
  if (amount == null || !Number.isFinite(amount)) return "Unavailable";
  const value = formatter(amount);
  if (!coverage) return `${value} (coverage unknown)`;
  return markPartial && coverage.unavailableCount > 0 ? `${value} (partial)` : value;
}
