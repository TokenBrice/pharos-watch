import type { StablecoinMeta } from "../../shared/types";

export interface OneLinerCoverageResult {
  total: number;
  withOneLiner: number;
  withoutOneLiner: number;
  missingIds: string[];
  /** Fraction (0..1) of in-scope coins missing oneLiner. */
  missingRatio: number;
}

function isInScope(coin: StablecoinMeta): boolean {
  const status = coin.status ?? "active";
  return status === "active" || status === "pre-launch";
}

export function analyzeOneLinerCoverage(coins: readonly StablecoinMeta[]): OneLinerCoverageResult {
  const inScope = coins.filter(isInScope);
  const missingIds = inScope
    .filter((coin) => !coin.oneLiner || coin.oneLiner.trim() === "")
    .map((coin) => coin.id)
    .sort((a, b) => a.localeCompare(b));

  const total = inScope.length;
  const withoutOneLiner = missingIds.length;
  const withOneLiner = total - withoutOneLiner;
  const missingRatio = total === 0 ? 0 : withoutOneLiner / total;

  return { total, withOneLiner, withoutOneLiner, missingIds, missingRatio };
}
