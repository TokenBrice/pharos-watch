import {
  WORKER_TRACKED_META_BY_ID,
  WORKER_TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/worker-runtime-registry";
import { isActiveStablecoinMeta, isPreLaunchStablecoinMeta } from "@shared/lib/stablecoins/status";

/**
 * Coins eligible for new Telegram alert state. Pre-launch assets stay eligible
 * for launch alerts; all other lifecycle states remain addressable only by
 * cleanup paths.
 */
export const TELEGRAM_SUBSCRIBABLE_STABLECOINS = Object.freeze(
  WORKER_TRACKED_STABLECOINS.filter(
    (coin) => isActiveStablecoinMeta(coin) || isPreLaunchStablecoinMeta(coin),
  ),
);

export function isSubscribableCoin(stablecoinId: string | undefined): stablecoinId is string {
  return typeof stablecoinId === "string"
    && (() => {
      const meta = WORKER_TRACKED_META_BY_ID.get(stablecoinId);
      return meta != null && (isActiveStablecoinMeta(meta) || isPreLaunchStablecoinMeta(meta));
    })();
}

export function assertSubscribableCoin(stablecoinId: string): void {
  if (!isSubscribableCoin(stablecoinId)) {
    throw new RangeError(`Stablecoin is not subscribable: ${stablecoinId}`);
  }
}
