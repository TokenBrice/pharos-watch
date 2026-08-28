import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import {
  decodeStablecoinUrlToken,
  encodeStablecoinUrlToken,
} from "@/lib/stablecoin-url-codec";

export interface PortfolioHolding {
  coinId: string;
  amount: number;
}

export function normalizePortfolioAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function canonicalPortfolioCoinId(coinId: string): string | null {
  return CLIENT_TRACKED_META_BY_ID.get(coinId)?.id ?? null;
}

export function normalizePortfolioHolding(value: unknown): PortfolioHolding | null {
  if (
    typeof value !== "object"
    || value === null
    || typeof (value as PortfolioHolding).coinId !== "string"
  ) {
    return null;
  }

  const amount = normalizePortfolioAmount((value as PortfolioHolding).amount);
  if (amount === null) return null;

  const coinId = canonicalPortfolioCoinId((value as PortfolioHolding).coinId);
  return coinId ? { coinId, amount } : null;
}

export function parsePortfolioUrlParam(param: string): PortfolioHolding[] {
  if (!param) return [];

  const holdings: PortfolioHolding[] = [];
  for (const part of param.split(",")) {
    const pieces = part.split(":");
    if (pieces.length !== 2) continue;
    const [token, amountRaw] = pieces;
    if (!token || amountRaw === undefined || amountRaw === "") continue;

    const coinId = decodeStablecoinUrlToken(token);
    if (!coinId) continue;
    const amount = Number(amountRaw);
    const holding = normalizePortfolioHolding({ coinId, amount });
    if (holding) holdings.push(holding);
  }

  return migratePortfolioIds(holdings);
}

export function encodePortfolioHoldings(
  holdings: readonly PortfolioHolding[],
): string {
  return migratePortfolioIds(holdings)
    .map((holding) => {
      const token = encodeStablecoinUrlToken(holding.coinId);
      return token ? `${token}:${holding.amount}` : null;
    })
    .filter((x): x is string => x !== null)
    .join(",");
}

export function migratePortfolioIds(
  holdings: readonly PortfolioHolding[],
): PortfolioHolding[] {
  let changed = false;
  const migrated: PortfolioHolding[] = [];

  for (const holding of holdings) {
    const normalized = normalizePortfolioHolding(holding);
    if (!normalized) {
      changed = true;
      continue;
    }

    if (normalized.coinId !== holding.coinId || normalized.amount !== holding.amount) {
      changed = true;
    }

    const existing = migrated.find(
      (migratedHolding) => migratedHolding.coinId === normalized.coinId,
    );
    if (existing) {
      existing.amount += normalized.amount;
      changed = true;
      continue;
    }

    migrated.push(normalized);
  }

  return changed ? migrated : [...holdings];
}

export function isPortfolioHolding(value: unknown): value is PortfolioHolding {
  return normalizePortfolioHolding(value) !== null;
}
