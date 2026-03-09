import { REGISTRY_BY_ID, REGISTRY_BY_LLAMA_ID } from "@shared/lib/stablecoin-id-registry";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";

export interface PortfolioHolding {
  coinId: string;
  amount: number;
}

const SYMBOL_TO_ID = new Map<string, string>();
const ID_TO_SYMBOL = new Map<string, string>();

for (const stablecoin of TRACKED_STABLECOINS) {
  const lowerSymbol = stablecoin.symbol.toLowerCase();
  SYMBOL_TO_ID.set(lowerSymbol, stablecoin.id);
  ID_TO_SYMBOL.set(stablecoin.id, lowerSymbol);
}

export function parsePortfolioUrlParam(param: string): PortfolioHolding[] {
  if (!param) return [];

  const holdings: PortfolioHolding[] = [];
  for (const part of param.split(",")) {
    const [symbol, amountRaw] = part.split(":");
    if (!symbol || !amountRaw) continue;

    const coinId = SYMBOL_TO_ID.get(symbol.toLowerCase());
    const amount = Number(amountRaw);
    if (coinId && Number.isFinite(amount) && amount > 0) {
      holdings.push({ coinId, amount });
    }
  }

  return holdings;
}

export function encodePortfolioHoldings(
  holdings: readonly PortfolioHolding[],
): string {
  return holdings
    .map((holding) => {
      const symbol = ID_TO_SYMBOL.get(holding.coinId);
      return symbol ? `${symbol}:${holding.amount}` : null;
    })
    .filter(Boolean)
    .join(",");
}

export function migratePortfolioIds(
  holdings: readonly PortfolioHolding[],
): PortfolioHolding[] {
  let changed = false;
  const migrated: PortfolioHolding[] = [];

  for (const holding of holdings) {
    const meta =
      REGISTRY_BY_ID.get(holding.coinId)
      ?? REGISTRY_BY_LLAMA_ID.get(holding.coinId);
    if (!meta) {
      changed = true;
      continue;
    }

    const canonicalId = meta.id;
    if (canonicalId !== holding.coinId) {
      changed = true;
    }

    const existing = migrated.find(
      (migratedHolding) => migratedHolding.coinId === canonicalId,
    );
    if (existing) {
      existing.amount += holding.amount;
      changed = true;
      continue;
    }

    migrated.push({ coinId: canonicalId, amount: holding.amount });
  }

  return changed ? migrated : [...holdings];
}

export function isPortfolioHolding(value: unknown): value is PortfolioHolding {
  return (
    typeof value === "object"
    && value !== null
    && typeof (value as PortfolioHolding).coinId === "string"
    && typeof (value as PortfolioHolding).amount === "number"
    && (value as PortfolioHolding).amount > 0
  );
}
