import { WORKER_TRACKED_META_BY_ID, hasWorkerLiveReserves } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { LiveReserveAdapterKey } from "@shared/types/live-reserves";

/** Evidence retention only; these bindings grant no active sync or scoring admission. */
const STAGED_CAPTURE_BINDINGS = [
  { stablecoinId: "jltxx-jpmorgan", status: "quarantined", adapter: "jpmorgan-nav" },
] as const satisfies readonly { stablecoinId: string; status: string; adapter: LiveReserveAdapterKey }[];

export const STAGED_BOOTSTRAP_COINS = STAGED_CAPTURE_BINDINGS.flatMap((binding) => {
  const coin = WORKER_TRACKED_META_BY_ID.get(binding.stablecoinId);
  return coin != null
    && coin.status === binding.status
    && hasWorkerLiveReserves(coin)
    && coin.liveReservesConfig.adapter === binding.adapter
    ? [coin] : [];
});
