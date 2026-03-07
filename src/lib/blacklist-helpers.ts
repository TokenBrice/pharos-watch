import { THIRTY_DAYS_SECONDS } from "@/lib/constants";
import type { BlacklistEvent, StablecoinData } from "@shared/types";

/** Returns true if the symbol is a gold-pegged stablecoin (XAUT or PAXG). */
export function isGoldStablecoin(symbol: string): symbol is "PAXG" | "XAUT" {
  return symbol === "PAXG" || symbol === "XAUT";
}

/** Extracts gold stablecoin prices from the pegged assets list, keyed by symbol. */
export function extractGoldPrices(peggedAssets: StablecoinData[]): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const coin of peggedAssets) {
    if (isGoldStablecoin(coin.symbol)) {
      if (typeof coin.price === "number") prices[coin.symbol] = coin.price;
    }
  }
  return prices;
}

interface BlacklistStatsResult {
  usdcBlacklisted: number;
  usdtBlacklisted: number;
  eurcBlacklisted: number;
  goldBlacklisted: number;
  frozenAddresses: number;
  destroyedTotal: number;
  recentCount: number;
}

/**
 * Computes aggregate blacklist statistics from a list of events.
 * Returns per-stablecoin blacklisted address counts, total destroyed value (USD),
 * total frozen addresses across all stablecoins, and recent event count (last 30 days).
 */
export function computeBlacklistStats(
  events: BlacklistEvent[],
  goldPrices: Record<string, number>,
): BlacklistStatsResult {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = nowSeconds - THIRTY_DAYS_SECONDS;

  const usdcAddresses = new Map<string, number>();
  const usdtAddresses = new Map<string, number>();
  const eurcAddresses = new Map<string, number>();
  const goldAddresses = new Map<string, number>();
  // Combined map counts unique addresses across all stablecoins (used by summary card)
  const allAddresses = new Map<string, number>();

  let destroyedTotal = 0;
  let recentCount = 0;

  for (const evt of events) {
    const isGold = isGoldStablecoin(evt.stablecoin);
    const map = isGold
      ? goldAddresses
      : evt.stablecoin === "USDC"
        ? usdcAddresses
        : evt.stablecoin === "USDT"
          ? usdtAddresses
          : eurcAddresses;

    if (evt.eventType === "blacklist") {
      map.set(evt.address, (map.get(evt.address) ?? 0) + 1);
      allAddresses.set(evt.address, (allAddresses.get(evt.address) ?? 0) + 1);
    } else if (evt.eventType === "unblacklist") {
      map.set(evt.address, (map.get(evt.address) ?? 0) - 1);
      allAddresses.set(evt.address, (allAddresses.get(evt.address) ?? 0) - 1);
    } else if (evt.eventType === "destroy" && evt.amount != null) {
      const usdMultiplier = isGold ? (goldPrices[evt.stablecoin] ?? 0) : 1;
      destroyedTotal += evt.amount * usdMultiplier;
    }

    if (evt.timestamp >= thirtyDaysAgo) {
      recentCount++;
    }
  }

  const usdcBlacklisted = Array.from(usdcAddresses.values()).filter((v) => v > 0).length;
  const usdtBlacklisted = Array.from(usdtAddresses.values()).filter((v) => v > 0).length;
  const eurcBlacklisted = Array.from(eurcAddresses.values()).filter((v) => v > 0).length;
  const goldBlacklisted = Array.from(goldAddresses.values()).filter((v) => v > 0).length;
  const frozenAddresses = Array.from(allAddresses.values()).filter((v) => v > 0).length;

  return {
    usdcBlacklisted,
    usdtBlacklisted,
    eurcBlacklisted,
    goldBlacklisted,
    frozenAddresses,
    destroyedTotal,
    recentCount,
  };
}
