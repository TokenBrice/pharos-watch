import { REGISTRY_BY_ID, REGISTRY_BY_LLAMA_ID } from "@shared/lib/stablecoin-id-registry";
import {
  decodeStablecoinUrlToken,
  encodeStablecoinUrlToken,
} from "@/lib/stablecoin-url-codec";

export interface PortfolioHolding {
  coinId: string;
  amount: number;
}

export function parsePortfolioUrlParam(param: string): PortfolioHolding[] {
  if (!param) return [];

  const holdings: PortfolioHolding[] = [];
  for (const part of param.split(",")) {
    const [token, amountRaw] = part.split(":");
    if (!token || !amountRaw) continue;

    const coinId = decodeStablecoinUrlToken(token);
    const amount = Number(amountRaw);
    if (coinId && Number.isFinite(amount) && amount > 0) {
      holdings.push({ coinId, amount });
    }
  }

  return migratePortfolioIds(holdings);
}

export function encodePortfolioHoldings(
  holdings: readonly PortfolioHolding[],
): string {
  return holdings
    .map((holding) => {
      const token = encodeStablecoinUrlToken(holding.coinId);
      return token ? `${token}:${holding.amount}` : null;
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
