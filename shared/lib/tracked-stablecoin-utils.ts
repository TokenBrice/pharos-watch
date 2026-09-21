import type { StablecoinMeta } from "../types";
import {
  ACTIVE_STABLECOINS,
  TRACKED_META_BY_ID,
  TRACKED_STABLECOINS,
} from "./stablecoins/registry";
import { isActiveStablecoinMeta, isPreLaunchStablecoinMeta } from "./stablecoins/status";

export const YIELD_BEARING_STABLECOINS = TRACKED_STABLECOINS.filter(
  (stablecoin) =>
    stablecoin.flags.yieldBearing
    && (isActiveStablecoinMeta(stablecoin) || isPreLaunchStablecoinMeta(stablecoin)),
);

export const ACTIVE_YIELD_BEARING_STABLECOINS = ACTIVE_STABLECOINS.filter(
  (stablecoin) => stablecoin.flags.yieldBearing,
);

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

/** Minimal deployment shape the selection core needs from either runtime registry. */
export interface TrackedContractDeploymentLike {
  chain: string;
  address: string;
  decimals: number;
}

export interface TrackedStablecoinDeploymentsLike<TDeployment extends TrackedContractDeploymentLike> {
  contracts?: readonly TDeployment[];
  tradedContracts?: readonly TDeployment[];
}

function findTrackedContract<TDeployment extends TrackedContractDeploymentLike>(
  stablecoin: TrackedStablecoinDeploymentsLike<TDeployment>,
  chainId: string,
  options?: FindTrackedContractOptions,
): TDeployment | undefined {
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

/**
 * Selection and decimal resolution shared by both runtimes; only the failure
 * policy (null vs throw) and the registry differ per caller. Contract address
 * and decimals drive event-unit interpretation, so the two runtimes must not
 * drift.
 */
export function resolveTrackedContractConfigCore<TDeployment extends TrackedContractDeploymentLike>(
  stablecoin: TrackedStablecoinDeploymentsLike<TDeployment>,
  chainId: string,
  options?: ResolveTrackedContractConfigOptions,
): { contractAddress: string; decimals: number } | null {
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
    contractAddress: resolvedContract.address,
    decimals: options?.decimalsOverride ?? resolvedContract.decimals,
  };
}

export function resolveTrackedContractConfig(
  stablecoinId: string,
  chainId: string,
  options?: ResolveTrackedContractConfigOptions,
): ResolvedTrackedContractConfig | null {
  const stablecoin = TRACKED_META_BY_ID.get(stablecoinId);
  if (!stablecoin) return null;

  const resolved = resolveTrackedContractConfigCore(stablecoin, chainId, options);
  return resolved ? { stablecoin, ...resolved } : null;
}

