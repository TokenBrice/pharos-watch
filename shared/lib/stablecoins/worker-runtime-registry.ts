import workerRuntimeAsset from "../../data/stablecoins/coins.worker-runtime.generated.json";
import type { StablecoinStatus } from "../../types/stablecoin-taxonomy";
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

export const WORKER_TRACKED_STABLECOINS = workerRuntimeAsset as WorkerRuntimeStablecoinMeta[];

export const WORKER_TRACKED_META_BY_ID: ReadonlyMap<string, WorkerRuntimeStablecoinMeta> = new Map(
  WORKER_TRACKED_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);

export const WORKER_ACTIVE_STABLECOINS: readonly WorkerRuntimeStablecoinMeta[] =
  WORKER_TRACKED_STABLECOINS.filter(isActiveStablecoinMeta);

export const WORKER_ACTIVE_IDS: ReadonlySet<string> = new Set(
  WORKER_ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id),
);

export const WORKER_FROZEN_IDS: ReadonlySet<string> = new Set(
  WORKER_TRACKED_STABLECOINS.filter(isFrozenStablecoinMeta).map((stablecoin) => stablecoin.id),
);

export const WORKER_ACTIVE_LIVE_RESERVE_CIRCUIT_SOURCES: readonly string[] = [
  ...new Set(
    WORKER_ACTIVE_STABLECOINS
      .map((stablecoin) => stablecoin.liveReserveCircuitSource)
      .filter((source): source is string => source != null),
  ),
];
