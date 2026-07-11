import {
  FROZEN_IDS,
  TRACKED_META_BY_ID,
  TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/registry";

/**
 * Coins eligible for new Telegram alert state. Pre-launch assets stay eligible
 * for launch alerts; frozen assets remain addressable only by cleanup paths.
 */
export const TELEGRAM_SUBSCRIBABLE_STABLECOINS = Object.freeze(
  TRACKED_STABLECOINS.filter((coin) => !FROZEN_IDS.has(coin.id)),
);

export function isSubscribableCoin(stablecoinId: string | undefined): stablecoinId is string {
  return typeof stablecoinId === "string"
    && TRACKED_META_BY_ID.has(stablecoinId)
    && !FROZEN_IDS.has(stablecoinId);
}

export function assertSubscribableCoin(stablecoinId: string): void {
  if (!isSubscribableCoin(stablecoinId)) {
    throw new RangeError(`Stablecoin is not subscribable: ${stablecoinId}`);
  }
}
