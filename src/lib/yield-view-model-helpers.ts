import { CURRENCY_TAB_ENUMERATED_PEGS, type YieldPegFilter } from "@/lib/yield-view-config";
import type { PegCurrency } from "@shared/types";

export function formatTvlOption(value: number): string {
  if (value >= 1_000_000_000) return `$${value / 1_000_000_000}B+`;
  if (value >= 1_000_000) return `$${value / 1_000_000}M+`;
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
