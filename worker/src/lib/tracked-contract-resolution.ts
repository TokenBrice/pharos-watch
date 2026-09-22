import {
  resolveTrackedContractConfigCore,
  type ResolveTrackedContractConfigOptions,
} from "@shared/lib/stablecoins/tracked-contract-selection";
import {
  WORKER_TRACKED_META_BY_ID,
  type WorkerRuntimeStablecoinMeta,
} from "@shared/lib/stablecoins/worker-runtime-registry";

export type { ResolveTrackedContractConfigOptions } from "@shared/lib/stablecoins/tracked-contract-selection";

export interface ResolvedTrackedContractConfig {
  stablecoin: WorkerRuntimeStablecoinMeta;
  contractAddress: string;
  decimals: number;
}

export function resolveRequiredTrackedContractConfig(
  stablecoinId: string,
  chainId: string,
  options?: ResolveTrackedContractConfigOptions,
): ResolvedTrackedContractConfig {
  const stablecoin = WORKER_TRACKED_META_BY_ID.get(stablecoinId);
  if (!stablecoin) {
    throw new Error(`Unknown tracked stablecoin: ${stablecoinId}`);
  }

  const resolved = resolveTrackedContractConfigCore(stablecoin, chainId, options);
  if (!resolved) {
    throw new Error(`Missing tracked contract for ${stablecoinId} on ${chainId}`);
  }

  return { stablecoin, ...resolved };
}
