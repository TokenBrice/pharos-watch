import { CLIENT_ACTIVE_STABLECOINS as ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import type { PortfolioHolding } from "@/lib/portfolio-codec";

export const PORTFOLIO_COIN_OPTIONS = ACTIVE_STABLECOINS.map((stablecoin) => ({
  id: stablecoin.id,
  name: stablecoin.name,
  symbol: stablecoin.symbol,
}));

const usdFormatterDetailed = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

export function formatUsd(value: number): string {
  return `$${usdFormatterDetailed.format(value)}`;
}

function isDigitString(value: string): boolean {
  if (value.length === 0) return false;
  for (const char of value) {
    if (char < "0" || char > "9") return false;
  }
  return true;
}

function isPlainDecimal(value: string): boolean {
  let hasDigit = false;
  let seenDecimal = false;

  for (const char of value) {
    if (char >= "0" && char <= "9") {
      hasDigit = true;
      continue;
    }
    if (char === "." && !seenDecimal) {
      seenDecimal = true;
      continue;
    }
    return false;
  }

  return hasDigit;
}

function isGroupedDecimal(value: string): boolean {
  const parts = value.split(".");
  if (parts.length > 2) return false;
  const [integerPart, fractionPart] = parts;
  if (!integerPart) return false;
  if (fractionPart !== undefined && fractionPart !== "" && !isDigitString(fractionPart)) {
    return false;
  }

  const groups = integerPart.split(",");
  if (groups.length < 2) return false;
  if (groups[0].length < 1 || groups[0].length > 3 || !isDigitString(groups[0])) {
    return false;
  }

  return groups.slice(1).every((group) => group.length === 3 && isDigitString(group));
}

export function parseUsdInput(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;

  const withoutCurrency = trimmed.startsWith("$") ? trimmed.slice(1).trimStart() : trimmed;
  if (!isPlainDecimal(withoutCurrency) && !isGroupedDecimal(withoutCurrency)) {
    return 0;
  }

  const num = Number(withoutCurrency.replaceAll(",", ""));
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

export function buildHeldCardIds(holdings: readonly PortfolioHolding[]): Set<string> {
  return new Set(holdings.map((holding) => holding.coinId));
}
