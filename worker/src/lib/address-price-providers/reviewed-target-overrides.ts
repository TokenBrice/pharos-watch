import { resolveChainId } from "@shared/lib/chains";
import { normalizeAddressForKey } from "./shared";
import type { AddressPriceProviderKey } from "./types";

interface AddressPriceDeploymentLike {
  chain: string;
  address: string;
}

interface ReviewedAddressPriceTargetOverride extends AddressPriceDeploymentLike {
  provider: AddressPriceProviderKey;
  stablecoinId: string;
}

export const REVIEWED_ADDRESS_PRICE_TARGET_OVERRIDES = [
  {
    provider: "coingecko-onchain-address",
    stablecoinId: "vusd-virtue",
    chain: "iota-evm",
    address: "0x10740259a1860af3327dd0642ee35d6e8e7143ff",
  },
] as const satisfies readonly ReviewedAddressPriceTargetOverride[];

function matchesDeployment(
  deployment: AddressPriceDeploymentLike,
  chain: string,
  address: string,
): boolean {
  return resolveChainId(deployment.chain) === chain &&
    normalizeAddressForKey(deployment.address) === address;
}

/**
 * A reviewed override may narrow one asset/provider to a known deployment, but
 * it may never introduce a target. Stale metadata or provider support fails
 * closed to no targets for that asset/provider.
 */
export function applyReviewedAddressPriceTargetOverride<T extends AddressPriceDeploymentLike>(params: {
  provider: AddressPriceProviderKey;
  stablecoinId: string;
  deployments: readonly T[];
  metadataDeployments: readonly AddressPriceDeploymentLike[];
  providerChainMap: Readonly<Record<string, string>>;
}): T[] {
  const override = REVIEWED_ADDRESS_PRICE_TARGET_OVERRIDES.find(
    (entry) => entry.provider === params.provider && entry.stablecoinId === params.stablecoinId,
  );
  if (!override) return [...params.deployments];

  const chain = resolveChainId(override.chain);
  const address = normalizeAddressForKey(override.address);
  if (!chain || !address || !params.providerChainMap[chain]) return [];
  if (!params.metadataDeployments.some((deployment) => matchesDeployment(deployment, chain, address))) {
    return [];
  }

  return params.deployments.filter((deployment) => matchesDeployment(deployment, chain, address));
}
