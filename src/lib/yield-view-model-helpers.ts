import { abbreviateNumberParts } from "@shared/lib/format";
import { CURRENCY_TAB_ENUMERATED_PEGS, type YieldPegFilter } from "@/lib/yield-view-config";
import type { PegCurrency } from "@shared/types";

/**
 * TVL filter thresholds are curated round numbers, so the abbreviated value is
 * rendered unrounded ("$1B+", "$250M+"); anything below a million keeps the
 * grouped integer form.
 */
export function formatTvlOption(value: number): string {
  const { short, suffix } = abbreviateNumberParts(value);
  if (value > 0 && (suffix === "T" || suffix === "B" || suffix === "M")) return `$${short}${suffix}+`;
  return `$${value.toLocaleString()}+`;
}

export function matchesYieldSearch(row: { symbol: string; name: string }, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    row.symbol.toLowerCase().includes(normalized) ||
    row.name.toLowerCase().includes(normalized)
  );
}

export function matchesYieldPeg(peg: PegCurrency | null, filter: YieldPegFilter): boolean {
  if (filter === "all") return true;
  if (!peg) return false;
  if (filter === "non-usd") return peg !== "USD";
  if (filter === "aud-cad") return peg === "AUD" || peg === "CAD";
  if (filter === "other") return !CURRENCY_TAB_ENUMERATED_PEGS.has(peg);
  return peg === filter;
}
