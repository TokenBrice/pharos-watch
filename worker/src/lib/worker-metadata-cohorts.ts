import { filterCoreAggregateStablecoins } from "@shared/lib/stablecoins/aggregate-universe";
import { isActiveStablecoinMeta, isPreLaunchStablecoinMeta } from "@shared/lib/stablecoins/status";
import { WORKER_ACTIVE_STABLECOINS, WORKER_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";

/** Chart reconciliation owns this projected cohort; other owners retain full metadata. */
export const WORKER_CORE_AGGREGATE_ACTIVE_STABLECOINS = filterCoreAggregateStablecoins(WORKER_ACTIVE_STABLECOINS);

/** Yield configuration includes pre-launch assets, matching the full source cohort. */
export const WORKER_YIELD_BEARING_STABLECOINS = WORKER_TRACKED_STABLECOINS.filter(
  (coin) => coin.flags.yieldBearing && (isActiveStablecoinMeta(coin) || isPreLaunchStablecoinMeta(coin)),
);
