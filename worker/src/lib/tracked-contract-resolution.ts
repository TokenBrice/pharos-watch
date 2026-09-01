import {
  WORKER_TRACKED_META_BY_ID,
  type WorkerRuntimeContractDeployment,
  type WorkerRuntimeStablecoinMeta,
} from "@shared/lib/stablecoins/worker-runtime-registry";

interface FindTrackedContractOptions {
  source?: "primary" | "traded" | "any";
}

export interface ResolveTrackedContractConfigOptions extends FindTrackedContractOptions {
  addressOverride?: string;
  decimalsOverride?: number;
}

export interface ResolvedTrackedContractConfig {
  stablecoin: WorkerRuntimeStablecoinMeta;
  contractAddress: string;
  decimals: number;
}

function findTrackedContract(
  stablecoin: WorkerRuntimeStablecoinMeta,
  chainId: string,
  options?: FindTrackedContractOptions,
): WorkerRuntimeContractDeployment | undefined {
  const source = options?.source ?? "primary";
  if (source !== "traded") {
    const contract = stablecoin.contracts?.find((deployment) => deployment.chain === chainId);
    if (contract) return contract;
  }

  if (source === "primary") return undefined;
  return stablecoin.tradedContracts?.find((deployment) => deployment.chain === chainId);
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

  const resolvedContract = options?.addressOverride
    ? {
        address: options.addressOverride,
        decimals:
          options.decimalsOverride
          ?? findTrackedContract(stablecoin, chainId, { source: options.source ?? "primary" })?.decimals
          ?? stablecoin.contracts?.[0]?.decimals
          ?? 18,
      }
    : findTrackedContract(stablecoin, chainId, { source: options?.source ?? "primary" });
  if (!resolvedContract) {
    throw new Error(`Missing tracked contract for ${stablecoinId} on ${chainId}`);
  }

  return {
    stablecoin,
    contractAddress: resolvedContract.address,
    decimals: options?.decimalsOverride ?? resolvedContract.decimals,
  };
}
