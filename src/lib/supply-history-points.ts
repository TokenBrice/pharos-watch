import type { SupplyHistoryPoint } from "@shared/types";

export interface DetailHistoryTokenPoint {
  date: number;
  totalCirculatingUSD?: Record<string, number>;
}

export function toSupplyHistoryPoints(
  tokens: readonly DetailHistoryTokenPoint[],
): SupplyHistoryPoint[] {
  return tokens
    .map((token) => ({
      date: token.date,
      circulatingUsd: Object.values(token.totalCirculatingUSD ?? {}).reduce(
        (sum, value) => sum + (value ?? 0),
        0,
      ),
      price: null,
    }))
    .filter((point) => Number.isFinite(point.date) && point.circulatingUsd > 0)
    .sort((left, right) => left.date - right.date);
}
