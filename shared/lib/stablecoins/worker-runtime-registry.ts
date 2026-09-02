import workerRuntimeAsset from "../../data/stablecoins/coins.worker-runtime.generated.json";
import type { StablecoinStatus } from "../../types/stablecoin-taxonomy";
import { buildStablecoinRegistryIndexes } from "./registry-indexes";
import { isActiveStablecoinMeta, isFrozenStablecoinMeta } from "./status";

export interface WorkerRuntimeContractDeployment {
  chain: string;
  address: string;
  decimals: number;
}

export interface WorkerRuntimeStablecoinMeta {
  id: string;
  symbol: string;
  status?: StablecoinStatus;
  contracts?: WorkerRuntimeContractDeployment[];
  tradedContracts?: WorkerRuntimeContractDeployment[];
  liveReserveCircuitSource?: string;
}

const registry = buildStablecoinRegistryIndexes(workerRuntimeAsset as WorkerRuntimeStablecoinMeta[], {
  isActive: isActiveStablecoinMeta,
  lifecyclePredicates: { frozen: isFrozenStablecoinMeta },
});

export const WORKER_TRACKED_STABLECOINS = registry.tracked.stablecoins as WorkerRuntimeStablecoinMeta[];

export const WORKER_TRACKED_META_BY_ID: ReadonlyMap<string, WorkerRuntimeStablecoinMeta> = registry.tracked.metaById;

export const WORKER_ACTIVE_STABLECOINS: readonly WorkerRuntimeStablecoinMeta[] = registry.active.stablecoins;

export const WORKER_ACTIVE_IDS: ReadonlySet<string> = registry.active.ids;

export const WORKER_FROZEN_IDS: ReadonlySet<string> = registry.lifecycle.frozen.ids;

export const WORKER_ACTIVE_LIVE_RESERVE_CIRCUIT_SOURCES: readonly string[] = [
  ...new Set(
    WORKER_ACTIVE_STABLECOINS
      .map((stablecoin) => stablecoin.liveReserveCircuitSource)
      .filter((source): source is string => source != null),
  ),
];
