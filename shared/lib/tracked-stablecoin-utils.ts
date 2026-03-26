import type { ContractDeployment, StablecoinMeta } from "../types";
import {
  ACTIVE_STABLECOINS,
  TRACKED_META_BY_ID,
  TRACKED_STABLECOINS,
} from "./stablecoins";

export const YIELD_BEARING_STABLECOINS = TRACKED_STABLECOINS.filter(
  (stablecoin) => stablecoin.flags.yieldBearing,
);

export const ACTIVE_YIELD_BEARING_STABLECOINS = ACTIVE_STABLECOINS.filter(
  (stablecoin) => stablecoin.flags.yieldBearing,
);

export function getTrackedStablecoin(
  stablecoinId: string,
): StablecoinMeta | undefined {
  return TRACKED_META_BY_ID.get(stablecoinId);
}

interface FindTrackedContractOptions {
  source?: "primary" | "traded" | "any";
}

export interface ResolveTrackedContractConfigOptions extends FindTrackedContractOptions {
  addressOverride?: string;
  decimalsOverride?: number;
}

export interface ResolvedTrackedContractConfig {
  stablecoin: StablecoinMeta;
  contractAddress: string;
  decimals: number;
}

export function findTrackedContract(
  stablecoinOrId: StablecoinMeta | string,
  chainId: string,
  options?: FindTrackedContractOptions,
): ContractDeployment | undefined {
  const stablecoin =
    typeof stablecoinOrId === "string"
      ? TRACKED_META_BY_ID.get(stablecoinOrId)
      : stablecoinOrId;
  if (!stablecoin) return undefined;

  const source = options?.source ?? "primary";
  if (source !== "traded") {
    const contract = stablecoin.contracts?.find(
      (deployment) => deployment.chain === chainId,
    );
    if (contract) return contract;
  }

  if (source === "primary") return undefined;
  return stablecoin.tradedContracts?.find(
    (deployment) => deployment.chain === chainId,
  );
}

export function resolveTrackedContractConfig(
  stablecoinId: string,
  chainId: string,
  options?: ResolveTrackedContractConfigOptions,
): ResolvedTrackedContractConfig | null {
  const stablecoin = TRACKED_META_BY_ID.get(stablecoinId);
  if (!stablecoin) return null;

  const resolvedContract = options?.addressOverride
    ? {
        address: options.addressOverride,
        decimals:
          options.decimalsOverride
          ?? findTrackedContract(stablecoin, chainId, { source: options.source ?? "primary" })?.decimals
          ?? stablecoin.contracts?.[0]?.decimals
          ?? 18,
      }
    : findTrackedContract(stablecoin, chainId, {
        source: options?.source ?? "primary",
      });

  if (!resolvedContract) return null;

  return {
    stablecoin,
    contractAddress: resolvedContract.address,
    decimals: options?.decimalsOverride ?? resolvedContract.decimals,
  };
}
