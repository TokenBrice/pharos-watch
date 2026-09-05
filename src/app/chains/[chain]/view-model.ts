import type { ChainStablecoin } from "@/hooks/use-chains";

function buildCompositionLayout(coins: ChainStablecoin[]) {
  const totalCoins = coins.length;
  if (totalCoins === 0) {
    return { displayCoins: [], rest: [], restTotal: 0, cols: 2, rows: 1 };
  }

  let cols: number;
  let rows: number;
  let maxDisplay: number;

  if (totalCoins <= 3) {
    cols = 2;
    rows = totalCoins <= 2 ? 1 : 2;
    maxDisplay = totalCoins;
  } else if (totalCoins <= 6) {
    cols = 3;
    rows = 2;
    maxDisplay = totalCoins;
  } else if (totalCoins <= 8) {
    cols = 4;
    rows = 2;
    maxDisplay = totalCoins;
  } else if (totalCoins <= 11) {
    cols = 4;
    rows = 3;
    maxDisplay = totalCoins;
  } else {
    cols = 4;
    rows = 3;
    maxDisplay = 11;
  }

  const needsOthers = totalCoins > maxDisplay;
  const displayCount = needsOthers ? Math.min(maxDisplay - 1, totalCoins) : totalCoins;
  const displayCoins = coins.slice(0, displayCount);
  const rest = coins.slice(displayCount);
  const restTotal = rest.reduce((sum, coin) => sum + coin.supplyOnChain, 0);

  return { displayCoins, rest, restTotal, cols, rows };
}

function buildBackingTotals(coins: ChainStablecoin[]) {
  const totals: Record<string, number> = {
    "rwa-backed": 0,
    "crypto-backed": 0,
    other: 0,
  };

  for (const coin of coins) {
    const key = coin.backing && coin.backing in totals ? coin.backing : "other";
    totals[key] += coin.supplyOnChain;
  }

  return totals;
}

export interface ChainRouteViewModel {
  coins: ChainStablecoin[];
  totalUsd: number;
  backingTotals: ReturnType<typeof buildBackingTotals>;
  compositionLayout: ReturnType<typeof buildCompositionLayout>;
}

export function buildChainRouteViewModel(
  coins: ChainStablecoin[],
  totalUsd: number,
): ChainRouteViewModel {
  return {
    coins,
    totalUsd,
    backingTotals: buildBackingTotals(coins),
    compositionLayout: buildCompositionLayout(coins),
  };
}
