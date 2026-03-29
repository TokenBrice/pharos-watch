import {
  getTrackedStablecoin,
  resolveTrackedContractConfig,
  type ResolveTrackedContractConfigOptions,
  type ResolvedTrackedContractConfig,
} from "@shared/lib/tracked-stablecoin-utils";

export function resolveRequiredTrackedContractConfig(
  stablecoinId: string,
  chainId: string,
  options?: ResolveTrackedContractConfigOptions,
): ResolvedTrackedContractConfig {
  const stablecoin = getTrackedStablecoin(stablecoinId);
  if (!stablecoin) {
    throw new Error(`Unknown tracked stablecoin: ${stablecoinId}`);
  }

  const resolvedContract = resolveTrackedContractConfig(stablecoinId, chainId, options);
  if (!resolvedContract) {
    throw new Error(`Missing tracked contract for ${stablecoinId} on ${chainId}`);
  }

  return resolvedContract;
}
