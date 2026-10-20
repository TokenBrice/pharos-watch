import type { DeploymentAmountEncoding } from "../../types/deployment-amounts";
import { normalizeDeploymentId } from "../../types/deployment-id";

interface FindTrackedContractOptions {
  source?: "primary" | "traded" | "any";
}

export interface ResolveTrackedContractConfigOptions extends FindTrackedContractOptions {
  addressOverride?: string;
  decimalsOverride?: number;
}

/** Minimal deployment shape the selection core needs from either runtime registry. */
export interface TrackedContractDeploymentLike {
  chain: string;
  address: string;
  decimals: number | null;
  amountEncoding?: DeploymentAmountEncoding;
}

export interface TrackedStablecoinDeploymentsLike<TDeployment extends TrackedContractDeploymentLike> {
  contracts?: readonly TDeployment[];
  tradedContracts?: readonly TDeployment[];
}

function findTrackedContract<TDeployment extends TrackedContractDeploymentLike>(
  stablecoin: TrackedStablecoinDeploymentsLike<TDeployment>,
  chainId: string,
  options?: ResolveTrackedContractConfigOptions,
): TDeployment | undefined {
  const source = options?.source ?? "primary";
  const overrideIdentity = options?.addressOverride
    ? normalizeDeploymentId(`${chainId}:${options.addressOverride}`)
    : undefined;
  const matches = (deployment: TDeployment) => deployment.chain === chainId
    && (overrideIdentity === undefined
      || normalizeDeploymentId(`${deployment.chain}:${deployment.address}`) === overrideIdentity);
  if (source !== "traded") {
    const contract = stablecoin.contracts?.find(matches);
    if (contract) return contract;
  }

  if (source === "primary") return undefined;
  return stablecoin.tradedContracts?.find(matches);
}

/**
 * Selection and decimal resolution shared by both runtimes; only the failure
 * policy (null vs throw) and the registry differ per caller. Contract address
 * and decimals drive event-unit interpretation, so the two runtimes must not
 * drift. Kept registry-free so memory-constrained Worker lanes can reuse it
 * without pulling in the full stablecoin registry.
 */
export function resolveTrackedContractConfigCore<TDeployment extends TrackedContractDeploymentLike>(
  stablecoin: TrackedStablecoinDeploymentsLike<TDeployment>,
  chainId: string,
  options?: ResolveTrackedContractConfigOptions,
): { contractAddress: string; decimals: number } | null {
  const deployment = findTrackedContract(stablecoin, chainId, options);
  // This selector interprets fixed raw event units, never native XRPL issued values.
  // Overrides cannot turn an issued-currency amount into a fixed-decimal amount.
  if (chainId === "xrpl" || deployment?.amountEncoding?.kind === "xrpl-issued-currency" || deployment?.decimals === null) return null;
  const decimals = options?.decimalsOverride ?? deployment?.decimals;
  const contractAddress = options?.addressOverride ?? deployment?.address;
  if (!contractAddress || decimals == null) return null;

  return {
    contractAddress,
    decimals,
  };
}
